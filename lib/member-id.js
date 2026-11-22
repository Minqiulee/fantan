'use strict';
/**
 * member-id.js — 会员号字段加密（信封加密 + 盲索引）
 * ------------------------------------------------------------------
 * 要解决的问题：会员号（二维码原文）此前以明文存进 player / identity /
 * round_archive_entry，并原样下发给员工端、大屏与对账 CSV。现在要求
 * 「落库是密文、页面不出现明文」，同时不能把「按会员号找人」这件事弄丢。
 *
 * 三个产出，各管一件事：
 *
 *   ref(plain)   盲索引。HMAC-SHA256(pepper, 会员号) 的前 128 位，形如 m_3f2a…
 *                确定性、不可逆，用作**主键与接口里的 pid**：同一会员号在任何
 *                场次、任何一次扫码都得到同一个 ref，重复扫码幂等靠它。
 *                为什么不直接把密文当主键：AES-GCM / RSA-OAEP 都是随机化的，
 *                同一个人每次加密结果不同，做主键会让「幂等扫码」失效。
 *
 *   seal(plain)  密文。`mid:v<版本>:<iv>:<密文>:<tag>`，版本号写在密文里，
 *                读的时候按版本找密钥 —— 轮换就靠这个前缀，不需要回填历史数据。
 *
 *   mask(plain)  脱敏 ID（maskedId）。`****1234`（保留后 4 位）。页面、大屏、对账 CSV
 *                只出现它，不出现明文，也不出现密文（密文 200+ 字符，铺到屏上
 *                既不可读也会把导出文件搞成噪声）。
 *
 * 密钥结构（为什么是「非对称 + 信封」而不是拿 RSA 直接加密字段）：
 *
 *   RSA 只用来**包裹数据密钥**，字段本身用 AES-256-GCM。原因是 commitSnapshot
 *   每次状态变更都会重写整场玩家行，一场几百人时每行做一次 RSA-OAEP 就是几百次
 *   大数模幂（十毫秒级），一次「提交预测」都扛不住；而 RSA 单条明文上限 190 字节、
 *   密文固定 256 字节（base64 后 344 字符），塞进主键和 SSE 负载也不现实。
 *   信封结构保留了非对称的全部好处：私钥留在进程/未来的 KMS 里，env 里只有
 *   被包裹的 DEK；轮换 = 换一把新 RSA 密钥包一把新 DEK，旧版本照样能解。
 *
 *   MEMBER_ID_PEPPER           盲索引密钥（HMAC key），**不参与轮换**。
 *                              它是身份的锚点：换了 pepper，同一个会员号会算出
 *                              不同的 ref，等于把所有人的身份线全部剪断。
 *   MEMBER_ID_KEY_<n>          RSA-OAEP(sha256) 包裹后的 32 字节 DEK（base64）
 *   MEMBER_ID_KEY_<n>_PRIVATE  该版本的 RSA 私钥（base64 的 PKCS#8 PEM）
 *   MEMBER_ID_DEK_<n>          简化模式：直接给 32 字节裸 DEK（base64），跳过 RSA
 *   MEMBER_ID_KEY_VERSION      当前写入用哪一版；不设 = 取最大版本号
 *
 * 缺密钥直接抛错、绝不明文兜底：静默降级会把一次配置疏漏变成一次数据泄露。
 */

const crypto = require('crypto');

/** 密文前缀。改它等于改历史数据格式，不要动。 */
const CIPHER_PREFIX = 'mid';
/** 盲索引前缀：让 ref 在日志/接口里一眼可辨，不会和会员号本身混淆。 */
const REF_PREFIX = 'm_';
/** ref 取 HMAC 前多少位（hex 字符数）。128 位足够，且比完整 64 位短一半。 */
const REF_HEX_LEN = 32;
/** 单条明文上限：与二维码内容的 QR_MAX_LEN(512) 对齐，多留一倍余量。 */
const MAX_PLAIN_LEN = 1024;
/** 进程内缓存上限：按会员号缓存密文，避免整场重写时反复加密同一批人。 */
const CACHE_MAX = 20000;

class KeyConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'KeyConfigError';
    this.code = 'member_id_key_config';
  }
}

function b64ToBuf(raw, name) {
  const s = String(raw || '').trim();
  if (!s) throw new KeyConfigError(name + ' 为空');
  let buf;
  try {
    buf = Buffer.from(s, 'base64');
  } catch (e) {
    throw new KeyConfigError(name + ' 不是合法的 base64');
  }
  if (!buf.length) throw new KeyConfigError(name + ' 解不出字节');
  return buf;
}

/** base64 的 PEM：要么是完整 PEM，要么是去掉头尾后的纯 base64，两种都认。 */
function pemFromB64(raw, name) {
  const s = String(raw || '').trim();
  if (!s) throw new KeyConfigError(name + ' 为空');
  if (s.includes('-----BEGIN')) return s.replace(/\\n/g, '\n');
  const text = b64ToBuf(s, name).toString('utf8');
  if (!text.includes('-----BEGIN')) throw new KeyConfigError(name + ' 里没有 PEM 头');
  return text;
}

/**
 * 把 env 里的密钥解析成 { 版本号 -> DEK }。
 * 每个版本两种来源：包裹模式（RSA 私钥解 MEMBER_ID_KEY_<n>）或裸 DEK 模式。
 */
function loadKeyring(env) {
  const keys = new Map();
  const problems = [];

  const versions = new Set();
  for (const name of Object.keys(env)) {
    const m = /^MEMBER_ID_(?:KEY|DEK)_(\d+)(?:_PRIVATE)?$/.exec(name);
    if (m) versions.add(Number(m[1]));
  }

  for (const v of Array.from(versions).sort((a, b) => a - b)) {
    const wrapped = env['MEMBER_ID_KEY_' + v];
    const privRaw = env['MEMBER_ID_KEY_' + v + '_PRIVATE'];
    const rawDek = env['MEMBER_ID_DEK_' + v];

    try {
      if (rawDek) {
        const dek = b64ToBuf(rawDek, 'MEMBER_ID_DEK_' + v);
        if (dek.length !== 32) throw new KeyConfigError('MEMBER_ID_DEK_' + v + ' 必须是 32 字节');
        keys.set(v, dek);
        continue;
      }
      if (!wrapped || !privRaw) {
        throw new KeyConfigError(
          'v' + v + ' 密钥不完整：需要 MEMBER_ID_KEY_' + v + ' 与 MEMBER_ID_KEY_' + v + '_PRIVATE'
          + '（或改用 MEMBER_ID_DEK_' + v + '）'
        );
      }
      const privateKey = crypto.createPrivateKey(pemFromB64(privRaw, 'MEMBER_ID_KEY_' + v + '_PRIVATE'));
      const dek = crypto.privateDecrypt(
        {
          key: privateKey,
          padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
          oaepHash: 'sha256'
        },
        b64ToBuf(wrapped, 'MEMBER_ID_KEY_' + v)
      );
      if (dek.length !== 32) throw new KeyConfigError('v' + v + ' 解出的 DEK 不是 32 字节');
      keys.set(v, dek);
    } catch (e) {
      problems.push(e.name === 'KeyConfigError' ? e.message : 'v' + v + ' 解密失败：' + e.message);
    }
  }

  if (problems.length) throw new KeyConfigError(problems.join('；'));
  if (!keys.size) {
    throw new KeyConfigError(
      '未配置会员号加密密钥。至少需要：MEMBER_ID_PEPPER + MEMBER_ID_KEY_1 + MEMBER_ID_KEY_1_PRIVATE'
      + '（可用 `node scripts/member-keygen.mjs` 生成）'
    );
  }

  const wanted = Number(env.MEMBER_ID_KEY_VERSION || 0);
  const max = Math.max.apply(null, Array.from(keys.keys()));
  const current = wanted || max;
  if (!keys.has(current)) {
    throw new KeyConfigError(
      'MEMBER_ID_KEY_VERSION=' + current + ' 没有对应的密钥（已配置：' + Array.from(keys.keys()).join(',') + '）'
    );
  }
  return { keys, current, versions: Array.from(keys.keys()).sort((a, b) => a - b) };
}

function createCodec(env) {
  const pepperRaw = String(env.MEMBER_ID_PEPPER || '').trim();
  if (!pepperRaw) {
    throw new KeyConfigError(
      '未配置 MEMBER_ID_PEPPER（盲索引密钥）。可用 `node scripts/member-keygen.mjs` 生成；'
      + '该值一经上线不可更换，务必纳入密钥托管'
    );
  }
  const pepper = b64ToBuf(pepperRaw, 'MEMBER_ID_PEPPER');
  if (pepper.length < 32) throw new KeyConfigError('MEMBER_ID_PEPPER 至少 32 字节');

  const { keys, current, versions } = loadKeyring(env);

  /** 明文 -> 密文：整场重写时同一批人会被反复加密，缓存省掉重复的 AES 开销。 */
  const sealCache = new Map();
  /** 密文 -> 明文：每次提交前都会 fresh 读库，读一次就是几十上百行解密。 */
  const openCache = new Map();

  function cacheSet(map, k, v) {
    if (map.size >= CACHE_MAX) map.clear();
    map.set(k, v);
    return v;
  }

  function assertPlain(plain) {
    if (typeof plain !== 'string' || plain === '') throw new TypeError('会员号必须是非空字符串');
    if (plain.length > MAX_PLAIN_LEN) throw new RangeError('会员号超出长度上限 ' + MAX_PLAIN_LEN);
    return plain;
  }

  function ref(plain) {
    const p = assertPlain(plain);
    return REF_PREFIX + crypto.createHmac('sha256', pepper).update(p, 'utf8').digest('hex').slice(0, REF_HEX_LEN);
  }

  function mask(plain) {
    const p = assertPlain(plain);
    const chars = Array.from(p);
    if (chars.length <= 4) return '****';
    return '****' + chars.slice(-4).join('');
  }

  function isSealed(value) {
    return typeof value === 'string' && value.startsWith(CIPHER_PREFIX + ':v');
  }

  function isRef(value) {
    return typeof value === 'string'
      && value.startsWith(REF_PREFIX)
      && /^[0-9a-f]+$/.test(value.slice(REF_PREFIX.length))
      && value.length === REF_PREFIX.length + REF_HEX_LEN;
  }

  function seal(plain) {
    const p = assertPlain(plain);
    const hit = sealCache.get(p);
    if (hit) return hit;

    const v = current;
    const dek = keys.get(v);
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.from('member_id|v' + v, 'utf8'));
    const ct = Buffer.concat([cipher.update(p, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    const out = [
      CIPHER_PREFIX, 'v' + v, iv.toString('base64url'),
      ct.toString('base64url'), tag.toString('base64url')
    ].join(':');
    return cacheSet(sealCache, p, out);
  }

  function open(encoded) {
    if (!isSealed(encoded)) throw new TypeError('不是本模块产生的密文');
    const hit = openCache.get(encoded);
    if (hit !== undefined) return hit;

    const parts = encoded.split(':');
    if (parts.length !== 5) throw new Error('密文格式不合法');
    const v = Number(parts[1].replace(/^v/, ''));
    const dek = keys.get(v);
    if (!dek) {
      throw new KeyConfigError(
        '缺少 v' + v + ' 的解密密钥：这条密文由旧版本写入，轮换期间必须保留 MEMBER_ID_KEY_' + v
      );
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, Buffer.from(parts[2], 'base64url'), {
      authTagLength: 16
    });
    decipher.setAAD(Buffer.from('member_id|v' + v, 'utf8'));
    decipher.setAuthTag(Buffer.from(parts[4], 'base64url'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(parts[3], 'base64url')),
      decipher.final()
    ]).toString('utf8');
    return cacheSet(openCache, encoded, plain);
  }

  /**
   * 库里一行 → 内存对象。**只接受带密文的行**。
   *
   * 本系统不存在明文历史行（明文从未以「无密文」的形态落库过），所以 member_enc 为空
   * 只可能是代码 bug 或人为改库 —— 这时必须当场报错：宁可这个场次打不开，也不能把 ref
   * 当成会员号再 hash 一遍，凭空造出一个身份、让后面的人数与对账全部错位。
   *
   * 密文版本不同是**正常情况**（轮换期新旧数据共存），由 open() 按前缀挑密钥；
   * 但 ref 必须与密文解出来的会员号一致：不一致说明这行的密文被串到别处了，
   * 继续用会把 maskedId 显示成别人的号。
   */
  function decodeRow(id, enc) {
    if (!isSealed(enc)) {
      throw new Error('会员号行缺少密文（member_enc）：' + String(id == null ? '' : id).slice(0, 16));
    }
    const plain = open(enc);
    if (ref(plain) !== id) {
      throw new Error('会员号行的 ref 与密文不一致：' + String(id).slice(0, 16));
    }
    return { id, enc, maskedId: mask(plain) };
  }

  function describe() {
    return { current, versions, cipher: 'aes-256-gcm', wrap: 'rsa-oaep-sha256', refLen: REF_HEX_LEN };
  }

  return { ref, mask, seal, open, decodeRow, isSealed, isRef, describe };
}

/* ---------------- 默认实例（按进程 env 懒加载） ---------------- */

let singleton = null;

/** 取默认实例。第一次调用时才解析 env —— 配置缺失在这里报错，而不是 require 时就炸。 */
function codec() {
  if (!singleton) singleton = createCodec(process.env);
  return singleton;
}

module.exports = {
  createCodec,
  KeyConfigError,
  CIPHER_PREFIX,
  MAX_PLAIN_LEN,
  ref: (plain) => codec().ref(plain),
  mask: (plain) => codec().mask(plain),
  seal: (plain) => codec().seal(plain),
  open: (enc) => codec().open(enc),
  decodeRow: (id, enc) => codec().decodeRow(id, enc),
  isSealed: (v) => codec().isSealed(v),
  describe: () => codec().describe()
};
