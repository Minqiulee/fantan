/**
 * 奖品配置：四档文案的读写契约 / 权限 / 归一化 / 玩家端可见性 / 审计留痕。
 *
 * 要钉死的几件事：
 *   1. 配置是全局一份（存 app_config），只有 admin 能读能写 —— staff 账号不行；
 *   2. 保存后玩家端 /api/state 立刻带上新 prizes（不依赖轮次、不依赖开奖）；
 *   3. 只认四档 × title/desc 两个字段：未知档位、多余字段一律丢弃，超长按上限截断；
 *   4. 每次保存写一条 prize_config 审计，包含四档文案快照。
 *
 * 四档（都中 / 只中数字 / 只中单双 / 都没中）的归属判定在玩家端完成：
 * 数字与单双是两次独立猜测，命中互不蕴含，四种组合一一对应一档。
 * 这里只保证「配置正确下发」，判定逻辑由前端渲染时按 numHit / oeHit 组合决定。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, makeClient, login, unlock, withDb, resetSchema,
  ADMIN_PASSWORD, PLAYER_PASSWORD
} from './helpers.mjs';

let server;
let api;
let sid;
let adminToken;
let ut;

before(async () => {
  await resetSchema();
  server = await startServer();
  api = makeClient(server.base);
  const admin = await login(api);
  adminToken = admin.token;
  sid = admin.sid;
  const un = await unlock(api, sid, PLAYER_PASSWORD);
  assert.equal(un.body.ok, true, '玩家端口令解锁失败：' + JSON.stringify(un.body));
  ut = un.body.ut;
});

after(async () => {
  if (server) await server.stop();
});

/** 玩家视角的状态快照（权威可见性从这里验，别只看管理接口）。 */
function playerState() {
  return api.get('/api/state?sid=' + encodeURIComponent(sid) + '&ut=' + encodeURIComponent(ut));
}

test('默认没有配置：四档都是空串，玩家端也能拿到结构', async () => {
  const r = await api.get('/api/prize-config?token=' + encodeURIComponent(adminToken));
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.prizes, {
    both: { title: '', desc: '' },
    number: { title: '', desc: '' },
    oddeven: { title: '', desc: '' },
    miss: { title: '', desc: '' }
  });

  const s = await playerState();
  assert.equal(s.status, 200);
  // 结构必须在，哪怕没配置：前端靠它判断「没配就回落内置文案」
  assert.deepEqual(s.body.prizes, r.body.prizes);
});

test('无 token / 非管理员不能读写配置', async () => {
  const noToken = await api.get('/api/prize-config');
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.code, 'unauthorized');

  const badSave = await api.post('/api/prize-config', { prizes: {} });
  assert.equal(badSave.status, 401);

  // 建一个 staff 账号：能登录，但配置接口一律 401（前端隐藏不是唯一防线）
  const created = await api.post('/api/account-create', {
    token: adminToken, username: 'prize-staff', password: 'staff-pw-123', role: 'staff'
  });
  assert.equal(created.body.ok, true, '建 staff 账号失败：' + JSON.stringify(created.body));

  const staff = await login(api, 'prize-staff', 'staff-pw-123');
  const g = await api.get('/api/prize-config?token=' + encodeURIComponent(staff.token));
  assert.equal(g.status, 401);
  const p = await api.post('/api/prize-config', {
    token: staff.token,
    prizes: { number: { title: '偷偷改', desc: '' } }
  });
  assert.equal(p.status, 401);
});

test('保存后玩家端立即看到新文案，落库为同一份 JSON', async () => {
  const prizes = {
    both: { title: '特等奖 · 羊绒围巾', desc: '两项全中，凭本页面到前台领取' },
    number: { title: '一等奖 · 保温杯', desc: '只中数字' },
    oddeven: { title: '二等奖 · 小挂件', desc: '' },
    miss: { title: '谢谢参与', desc: '下一轮再来' }
  };
  const saved = await api.post('/api/prize-config', { token: adminToken, prizes });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.prizes, prizes);

  // 读回（管理端）
  const g = await api.get('/api/prize-config?token=' + encodeURIComponent(adminToken));
  assert.deepEqual(g.body.prizes, prizes);

  // 玩家端 state：不必等下一轮、不必等开奖
  const s = await playerState();
  assert.deepEqual(s.body.prizes, prizes);

  // 落库：app_config 里就是这一份，没有任何多余字段
  const row = await withDb(async (c) => {
    const r = await c.query("SELECT value FROM app_config WHERE key = 'prize_config'");
    return r.rows[0] ? JSON.parse(r.rows[0].value) : null;
  });
  assert.deepEqual(row, prizes);
});

test('归一化：去空白、超长截断、丢弃未知档位与多余字段', async () => {
  const longTitle = '字'.repeat(40);   // 上限 32
  const longDesc = '说'.repeat(200);   // 上限 120
  const r = await api.post('/api/prize-config', {
    token: adminToken,
    prizes: {
      number: { title: '  ' + longTitle + '  ', desc: longDesc, evil: '<script>x</script>' },
      oddeven: { title: '  ' },
      miss: 'not-an-object',
      extra: { title: '不该存在', desc: '' }
    }
  });
  assert.equal(r.status, 200);

  assert.equal(r.body.prizes.number.title.length, 32);
  assert.equal(r.body.prizes.number.title, longTitle.slice(0, 32));
  assert.equal(r.body.prizes.number.desc.length, 120);
  assert.deepEqual(Object.keys(r.body.prizes.number).sort(), ['desc', 'title']);
  assert.deepEqual(r.body.prizes.oddeven, { title: '', desc: '' });
  assert.deepEqual(r.body.prizes.miss, { title: '', desc: '' });
  assert.equal(Object.prototype.hasOwnProperty.call(r.body.prizes, 'extra'), false);

  // 玩家端拿到的同样是归一化后的值（不能出现「管理端截断、玩家端原文」的分裂）
  const s = await playerState();
  assert.deepEqual(s.body.prizes, r.body.prizes);
});

test('保存写审计：prize_config 带四档快照，actor 是管理员', async () => {
  const prizes = {
    both: { title: '审计用 A', desc: '' },
    number: { title: '审计用 B', desc: '' },
    oddeven: { title: '审计用 C', desc: '' },
    miss: { title: '审计用 D', desc: '' }
  };
  await api.post('/api/prize-config', { token: adminToken, prizes });

  const r = await api.get('/api/audit?token=' + encodeURIComponent(adminToken) + '&action=prize_config&limit=5');
  assert.equal(r.status, 200);
  const logs = r.body.logs || r.body.items || r.body.rows || [];
  assert.ok(logs.length > 0, '没有查到 prize_config 日志：' + JSON.stringify(r.body));
  const latest = logs[0];
  assert.equal(latest.action, 'prize_config');
  assert.equal(latest.actor, 'admin');
  const detail = typeof latest.detail === 'string' ? JSON.parse(latest.detail) : latest.detail;
  const tiers = (detail && detail.tiers) || [];
  assert.deepEqual(tiers.map((t) => t.tier), ['both', 'number', 'oddeven', 'miss']);
  assert.deepEqual(tiers.map((t) => t.title), ['审计用 A', '审计用 B', '审计用 C', '审计用 D']);
});

test('重启后配置仍在（管理员不必每次开机重配）', async () => {
  await api.post('/api/prize-config', {
    token: adminToken,
    prizes: {
      both: { title: '', desc: '' },
      number: { title: '重启后仍在', desc: '' },
      oddeven: { title: '', desc: '' },
      miss: { title: '', desc: '' }
    }
  });
  await server.stop();

  server = await startServer();
  api = makeClient(server.base);
  const admin = await login(api);
  adminToken = admin.token;
  sid = admin.sid;
  const un = await unlock(api, sid, PLAYER_PASSWORD);
  ut = un.body.ut;

  const g = await api.get('/api/prize-config?token=' + encodeURIComponent(adminToken));
  assert.equal(g.body.prizes.number.title, '重启后仍在');
});
