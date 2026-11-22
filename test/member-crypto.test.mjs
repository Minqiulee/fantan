/**
 * 会员号字段加密：算法层单测 + 落库/出网端到端断言。
 *
 * 前提：系统里**不存在明文历史行**。要处理的只有一种「新旧」：密钥轮换后不同版本的密文
 * 共存（`mid:v1:…` 与 `mid:v2:…`）。所以读取路径不接受缺密文的行，也不做任何明文降级。
 *
 *   A. lib/member-id.js 纯函数行为（不需要数据库、不起服务）
 *      - ref 确定性、不可逆、不同会员号不撞
 *      - mask 只露后 4 位
 *      - seal/open 往返、密文带版本前缀、篡改必失败
 *      - 多版本并存：新写用新版本，旧密文照旧能解；缺旧密钥要明确报错
 *      - 缺密文的行直接报错（不把 ref 当明文再 hash）；ref 与密文不一致也报错
 *   B. 集成：真实 server + Postgres
 *      - 库里 player / identity / round_archive_entry 三张表都没有会员号原文
 *      - 接口负载与对账 CSV 里也没有原文，只有 ref 与 ****1234
 *      - 轮换：v1 行在 v2 实例上照常读；新写入落 v2；同一会员号跨版本归档不重复计数
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  resetSchema, startServer, makeClient, withDb, databaseUrl,
  login, unlock, scan, predict, exportCsv, summary,
  memberRef, memberMaskedId, MEMBER_ENV
} from './helpers.mjs';

const { createCodec, KeyConfigError } = await import('../lib/member-id.js');

/* ---------------- A. 算法层 ---------------- */

/** 造一套指定版本的密钥 env，形状与 scripts/member-keygen.mjs 输出一致。 */
function makeKeyEnv(version, pepper) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  const dek = crypto.randomBytes(32);
  const wrapped = crypto.publicEncrypt(
    { key: publicKey, padding: crypto.constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' },
    dek
  );
  return {
    MEMBER_ID_KEY_VERSION: String(version),
    ['MEMBER_ID_KEY_' + version]: wrapped.toString('base64'),
    ['MEMBER_ID_KEY_' + version + '_PRIVATE']: Buffer.from(
      privateKey.export({ type: 'pkcs8', format: 'pem' }), 'utf8'
    ).toString('base64'),
    MEMBER_ID_PEPPER: pepper || crypto.randomBytes(32).toString('base64url')
  };
}

describe('会员号加密：算法层', () => {
  const pepper = crypto.randomBytes(32).toString('base64url');
  const env1 = makeKeyEnv(1, pepper);
  const codec = createCodec(env1);
  const PLAIN = 'VIP00887766';

  it('ref：确定性、不可逆、带前缀，不同会员号不撞', () => {
    const a = codec.ref(PLAIN);
    assert.equal(a, codec.ref(PLAIN), '同一个会员号必须得到同一个 ref（幂等扫码靠它）');
    assert.match(a, /^m_[0-9a-f]{32}$/);
    assert.ok(!a.includes(PLAIN), 'ref 里不能残留原文');
    assert.notEqual(codec.ref(PLAIN), codec.ref(PLAIN + ' '));
    assert.notEqual(codec.ref(PLAIN), codec.ref('VIP00887767'), '尾号不同必须算出不同 ref');
    assert.ok(codec.isRef(a));
    assert.equal(codec.isRef(PLAIN), false);
  });

  it('pepper 变了 ref 就变：所以 pepper 只能首建、不能随密钥轮换', () => {
    const other = createCodec(makeKeyEnv(1, crypto.randomBytes(32).toString('base64url')));
    assert.notEqual(other.ref(PLAIN), codec.ref(PLAIN));
  });

  it('mask：只露后 4 位，短号全遮', () => {
    assert.equal(codec.mask(PLAIN), '****7766');
    assert.equal(codec.mask('1234'), '****');
    assert.equal(codec.mask('888'), '****');
  });

  it('seal/open：往返一致，密文带版本前缀且不含原文', () => {
    const enc = codec.seal(PLAIN);
    assert.match(enc, /^mid:v1:/);
    assert.ok(!enc.includes(PLAIN));
    assert.ok(enc.length < 200, '密文长度应远小于「每行一次 RSA」的 344 字符：' + enc.length);
    assert.equal(codec.open(enc), PLAIN);
    assert.ok(codec.isSealed(enc));
  });

  it('密文被篡改必须解不出来（GCM 认证）', () => {
    const enc = codec.seal(PLAIN);
    const parts = enc.split(':');
    const ct = Buffer.from(parts[3], 'base64url');
    ct[0] ^= 0xff;
    parts[3] = ct.toString('base64url');
    assert.throws(() => codec.open(parts.join(':')));
  });

  it('轮换：v2 写入、v1 仍可解；只有 v2 密钥时解 v1 密文要明确报错', () => {
    const oldEnc = codec.seal(PLAIN);
    const env2 = makeKeyEnv(2, pepper);
    const both = createCodec({ ...env1, ...env2, MEMBER_ID_KEY_VERSION: '2' });

    assert.match(both.seal('NEW-MEMBER'), /^mid:v2:/, '新写入必须用当前版本');
    assert.equal(both.open(oldEnc), PLAIN, '旧版本密文在过渡期必须还能解');
    assert.deepEqual(both.describe().versions, [1, 2]);

    const v2Only = createCodec(env2);
    assert.throws(() => v2Only.open(oldEnc), (e) => e instanceof KeyConfigError && /v1/.test(e.message));
  });

  it('decodeRow：正常行给出 ref/maskedId，且不返回明文', () => {
    const enc = codec.seal(PLAIN);
    const row = codec.decodeRow(codec.ref(PLAIN), enc);
    assert.deepEqual(Object.keys(row).sort(), ['enc', 'id', 'maskedId']);
    assert.equal(row.id, codec.ref(PLAIN));
    assert.equal(row.maskedId, '****7766');
    assert.ok(!JSON.stringify(row).includes(PLAIN));
  });

  it('decodeRow：缺密文的行直接报错，绝不把 ref 当明文再 hash', () => {
    assert.throws(() => codec.decodeRow(codec.ref(PLAIN), null), /缺少密文/);
    assert.throws(() => codec.decodeRow(codec.ref(PLAIN), undefined), /缺少密文/);
    assert.throws(() => codec.decodeRow(codec.ref(PLAIN), PLAIN), /缺少密文/);
  });

  it('decodeRow：ref 与密文对不上必须报错（防止密文串到别人身上）', () => {
    const enc = codec.seal(PLAIN);
    assert.throws(() => codec.decodeRow(codec.ref('OTHER-MEMBER'), enc), /ref 与密文不一致/);
  });

  it('缺密钥 / 缺 pepper 直接拒绝，不做明文兜底', () => {
    assert.throws(() => createCodec({}), (e) => e instanceof KeyConfigError && /MEMBER_ID_PEPPER/.test(e.message));
    assert.throws(
      () => createCodec({ MEMBER_ID_PEPPER: pepper }),
      (e) => e instanceof KeyConfigError && /未配置会员号加密密钥/.test(e.message)
    );
    assert.throws(
      () => createCodec({ ...makeKeyEnv(1, pepper), MEMBER_ID_KEY_VERSION: '9' }),
      (e) => e instanceof KeyConfigError && /没有对应的密钥/.test(e.message)
    );
  });

  it('裸 DEK 模式（无 RSA）同样可用：同长度 32 字节', () => {
    const raw = crypto.randomBytes(32).toString('base64');
    const c = createCodec({ MEMBER_ID_PEPPER: pepper, MEMBER_ID_DEK_1: raw, MEMBER_ID_KEY_VERSION: '1' });
    assert.equal(c.open(c.seal(PLAIN)), PLAIN);
    assert.throws(
      () => createCodec({ MEMBER_ID_PEPPER: pepper, MEMBER_ID_DEK_1: crypto.randomBytes(16).toString('base64') }),
      (e) => e instanceof KeyConfigError && /32 字节/.test(e.message)
    );
  });
});

/* ---------------- B. 落库 / 出网 / 轮换 ---------------- */

let server;
let server2;       // 轮换用的第二实例（v1+v2 密钥，写入 v2）
let api;
let api2;
let token;
let sid;
let ut;

const A = 'MEMBER0001';
const B = 'MEMBER0002';
const C = 'MEMBER0003';

before(async () => {
  await resetSchema();
  server = await startServer({ databaseUrl: databaseUrl(), env: { INSTANCE_ID: 'i-member-id' } });
  api = makeClient(server.base);

  const admin = await login(api);
  token = admin.token;
  sid = admin.sid;
  const u = await unlock(api, sid);
  assert.equal(u.status, 200, '场次口令：' + JSON.stringify(u.body));
  ut = u.body.ut;

  for (const plain of [A, B]) {
    assert.equal((await scan(api, sid, ut, plain)).status, 200, '登记 ' + plain);
  }
});

after(async () => {
  if (server2) await server2.stop();
  if (server) await server.stop();
});

describe('会员号加密：落库与出网', () => {
  it('扫码建档：接口只给 ref 与 maskedId，明文以密文入库', async () => {
    const r = await scan(api, sid, ut, C);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.pid, memberRef(C));
    assert.equal(r.body.maskedId, memberMaskedId(C));
    assert.ok(!JSON.stringify(r.body).includes(C));

    const row = await withDb(async (c) => {
      const q = await c.query('SELECT id, member_enc FROM player WHERE session_id = $1 AND id = $2',
        [sid, memberRef(C)]);
      return q.rows[0];
    });
    assert.ok(row, '新行以 ref 为主键');
    assert.match(row.member_enc, /^mid:v1:/);
    assert.ok(!row.member_enc.includes(C));
  });

  it('接口负载只含 ref + maskedId，搜不到任何原文', async () => {
    const s = await api.get('/api/state?sid=' + encodeURIComponent(sid) + '&token=' + encodeURIComponent(token));
    assert.equal(s.status, 200);
    assert.equal(s.body.players.length, 3);
    const p = s.body.players.find((x) => x.id === memberRef(A));
    assert.ok(p, '按 ref 找人');
    assert.equal(p.maskedId, memberMaskedId(A));
    const raw = JSON.stringify(s.body);
    for (const plain of [A, B, C]) assert.ok(!raw.includes(plain), '负载里出现明文：' + plain);
  });

  it('库里三张表：主键全是 ref，密文齐全，没有原文', async () => {
    // A 也提交一次：后面「跨轮仍是老玩家」要靠它累计 completedRounds
    assert.equal((await predict(api, sid, ut, A, '双', 2)).status, 200);
    assert.equal((await predict(api, sid, ut, C, '单', 3)).status, 200);
    const locked = await api.post('/api/confirm', { token, sid, number: 3 });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.equal(locked.body.archived, true);

    const dump = await withDb(async (c) => {
      const players = await c.query('SELECT id, member_enc FROM player WHERE session_id = $1', [sid]);
      const idents = await c.query('SELECT id, member_enc FROM identity WHERE session_id = $1', [sid]);
      const entries = await c.query(
        `SELECT e.member_id, e.member_enc FROM round_archive_entry e
           JOIN round_archive a ON a.archive_id = e.archive_id
          WHERE a.session_id = $1 ORDER BY e.member_id`, [sid]
      );
      return { players: players.rows, idents: idents.rows, entries: entries.rows };
    });

    for (const [label, rows] of [['player', dump.players], ['identity', dump.idents], ['archive', dump.entries]]) {
      assert.ok(rows.length >= 2, label + ' 应有数据');
      for (const r of rows) {
        const key = r.id || r.member_id;
        assert.match(key, /^m_[0-9a-f]{32}$/, label + ' 主键必须是 ref：' + key);
        assert.match(r.member_enc, /^mid:v1:/, label + ' 每行都要有密文');
      }
    }
    const raw = JSON.stringify(dump);
    for (const plain of [A, B, C]) assert.ok(!raw.includes(plain), '库里出现明文：' + plain);
  });

  it('CSV 导出：会员号列是 ref，不含原文', async () => {
    const csv = await exportCsv(api, token, { level: 'detail' });
    assert.equal(csv.status, 200);
    for (const plain of [A, B, C]) assert.ok(!csv.text.includes(plain), 'CSV 出现明文：' + plain);
    assert.ok(csv.text.includes(memberRef(A)), 'CSV 输出盲索引令牌');
  });

  it('身份档案跨轮次连续（reset 之后重新扫码仍是老玩家）', async () => {
    assert.equal((await api.post('/api/reset', { token, sid })).status, 200);
    assert.equal((await scan(api, sid, ut, A)).status, 200);
    const s = await api.get('/api/state?sid=' + encodeURIComponent(sid) + '&token=' + encodeURIComponent(token));
    const p = s.body.players.find((x) => x.id === memberRef(A));
    assert.equal(p.isVeteran, true, '跨轮累计按 ref 归并');
  });

  it('轮换：v1 行在 v2 实例上可读，新写入落 v2，同一会员号不重复计数', async () => {
    // 第二实例：v1 + v2 两把密钥都在，写入版本指向 v2（模拟滚动发布的「新实例」）
    const env2 = makeKeyEnv(2, MEMBER_ENV.MEMBER_ID_PEPPER);
    server2 = await startServer({
      databaseUrl: databaseUrl(),
      env: { INSTANCE_ID: 'i-member-id-v2', ...MEMBER_ENV, ...env2 }
    });
    api2 = makeClient(server2.base);

    // 1) 旧版本密文照常读：reset 后重扫的 A 行是第一实例用 v1 写的，
    //    在只认 v2 写入的实例上必须照样解出正确的 maskedId
    const s2 = await api2.get('/api/state?sid=' + encodeURIComponent(sid) + '&token=' + encodeURIComponent(token));
    assert.equal(s2.status, 200, JSON.stringify(s2.body));
    const aRow = s2.body.players.find((x) => x.id === memberRef(A));
    assert.ok(aRow, 'v1 行必须能被 v2 实例读出来');
    assert.equal(aRow.maskedId, memberMaskedId(A), '旧密文解出的 maskedId 必须正确');

    // 2) 新写入用新版本
    assert.equal((await scan(api2, sid, ut, C)).status, 200);
    const cEnc = await withDb(async (c) => {
      const q = await c.query('SELECT member_enc FROM player WHERE session_id = $1 AND id = $2',
        [sid, memberRef(C)]);
      return q.rows[0].member_enc;
    });
    assert.match(cEnc, /^mid:v2:/, '新实例写入必须用 v2');

    // 3) 重扫旧玩家 = 顺手把这一行带到当前版本（非强制，但不能报错）
    assert.equal((await scan(api2, sid, ut, A)).status, 200);
    const aEnc = await withDb(async (c) => {
      const q = await c.query('SELECT member_enc FROM player WHERE session_id = $1 AND id = $2',
        [sid, memberRef(A)]);
      return q.rows[0].member_enc;
    });
    assert.match(aEnc, /^mid:v2:/, '重扫后该行应升到当前版本');

    // 4) 两版密文共存时归档去重仍按 ref：A/B/C 三个人，不是四个
    assert.equal((await predict(api2, sid, ut, C, '单', 1)).status, 200);
    const locked = await api2.post('/api/confirm', { token, sid, number: 1 });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));

    const sum = await summary(api2, token);
    assert.equal(sum.status, 200, JSON.stringify(sum.body));
    assert.equal(sum.body.members, 3, '跨密钥版本按 ref 去重：A/B/C 共 3 人');

    const versions = await withDb(async (c) => {
      const q = await c.query(
        `SELECT substring(member_enc from '^mid:(v[0-9]+):') AS ver, count(*)::int AS n
           FROM round_archive_entry e
           JOIN round_archive a ON a.archive_id = e.archive_id
          WHERE a.session_id = $1 GROUP BY 1 ORDER BY 1`, [sid]
      );
      return q.rows;
    });
    assert.ok(versions.some((v) => v.ver === 'v1'), '归档里应留有 v1 密文（第一轮）');
    assert.ok(versions.some((v) => v.ver === 'v2'), '归档里应出现 v2 密文（第二轮）');
  });

  it('缺密文的行必须让场次读取失败（不做明文降级）', async () => {
    // 人为把一行的密文抹掉：模拟「迁移脚本写错 / 人工改库」
    await withDb(async (c) => {
      await c.query('UPDATE player SET member_enc = NULL WHERE session_id = $1 AND id = $2',
        [sid, memberRef(C)]);
    });

    const s = await api.get('/api/state?sid=' + encodeURIComponent(sid) + '&token=' + encodeURIComponent(token));
    assert.equal(s.status, 500, '缺密文必须报错，而不是拿 ref 当明文继续跑：' + JSON.stringify(s.body));
    assert.ok(!JSON.stringify(s.body).includes(C), '错误响应里也不能带出原文');
    // 本文件最后一个用例：故意把这行留在「坏状态」，同时验证「坏了就是坏了」——
    // 不写任何「猜一个密文补回去」的恢复逻辑，那正是这次要删掉的东西。
  });
});
