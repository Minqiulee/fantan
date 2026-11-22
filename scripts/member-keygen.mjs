#!/usr/bin/env node
/**
 * member-keygen.mjs — 生成会员号字段加密用的环境变量
 * ------------------------------------------------------------------
 * 一把 RSA 密钥 + 一把随机 DEK，RSA 只负责包裹 DEK（见 lib/member-id.js 顶部说明）。
 *
 *   node scripts/member-keygen.mjs            # 生成 v1（含 MEMBER_ID_PEPPER）
 *   node scripts/member-keygen.mjs -v 2       # 轮换：新增 v2，pepper 沿用旧值
 *   node scripts/member-keygen.mjs -v 2 --pepper "$MEMBER_ID_PEPPER"   # 显式复用 pepper
 *
 * 输出直接就是 env 行，粘到部署平台（Fly secrets / K8s Secret / .env）即可。
 * 不要提交进仓库：私钥一旦进 git 历史，等于没有加密。
 */
import crypto from 'node:crypto';

function parseArgs(argv) {
  const out = { version: 1, pepper: '', bits: 3072 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '-v' || a === '--version') out.version = Number(argv[++i]);
    else if (a === '--pepper') out.pepper = String(argv[++i] || '');
    else if (a === '--bits') out.bits = Number(argv[++i]);
    else if (a === '-h' || a === '--help') out.help = true;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log('用法: node scripts/member-keygen.mjs [-v 版本号] [--pepper 现有pepper] [--bits 3072]');
  process.exit(0);
}
if (!Number.isInteger(args.version) || args.version < 1) {
  console.error('版本号必须是 >= 1 的整数');
  process.exit(1);
}
if (![2048, 3072, 4096].includes(args.bits)) {
  console.error('RSA 位数只支持 2048 / 3072 / 4096');
  process.exit(1);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: args.bits });
const dek = crypto.randomBytes(32);
const wrapped = crypto.publicEncrypt(
  { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
  dek
);

const privPem = privateKey.export({ type: 'pkcs8', format: 'pem' });
const pepper = args.pepper ? args.pepper.trim() : crypto.randomBytes(32).toString('base64url');

console.log('# ---- 会员号字段加密密钥（v' + args.version + '） ----');
console.log('# 私钥只用于「解 DEK」，不参与逐字段加解密；DEK 换了旧密文仍可解（版本号写在密文里）');
console.log('MEMBER_ID_KEY_VERSION=' + args.version);
console.log('MEMBER_ID_KEY_' + args.version + '=' + wrapped.toString('base64'));
console.log('MEMBER_ID_KEY_' + args.version + '_PRIVATE=' + Buffer.from(privPem, 'utf8').toString('base64'));
if (args.pepper) {
  console.log('# 复用已有 pepper（轮换场景必须这样做，否则历史 ref 全部失效）');
} else {
  console.log('# 首次上线才生成；此后**永远不要改**，改了等于把所有会员号的身份线剪断');
}
console.log('MEMBER_ID_PEPPER=' + pepper);
