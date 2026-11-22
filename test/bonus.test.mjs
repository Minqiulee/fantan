/**
 * 额外奖品（命中特殊数字 → 全员加奖）：配置契约 / 触发与幂等 / 边界。
 *
 * 要钉死的几件事：
 *   1. 配置是全局一份（存 app_config.bonus_prize），只有 admin 能读能写；number 只认 0-9，
 *      非法值 / null / 缺失 → 一律视为「未启用」（number=null），不触发；
 *      注意 0 是合法特殊数字，所以「未启用」只能靠 null/空值表达；
 *   2. 触发**不落库**：/api/state 的 bonus.triggered 按「本轮开奖数字是否命中特殊数字」
 *      现场重算；锁定后开奖数字不再变 → 同一轮重算结果恒定，一轮只锁定一次 → 只触发一次；
 *      重复 confirm 被 already_locked 拒绝，不会二次触发；新一轮 reset 把 number 置 null 自然不触发；
 *   3. 玩家端 /api/state 始终带 bonus 结构（number + title/desc + triggered）；
 *   4. 边界：无参与者照常判定（对象为空但状态正确）；配置缺失不触发。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, makeClient, login, unlock, scan, predict, confirm, resetRound, withDb, resetSchema,
  PLAYER_PASSWORD
} from './helpers.mjs';

let server;
let api;
let sid;
let adminToken;
let ut;
let pid;

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

function playerState() {
  return api.get('/api/state?sid=' + encodeURIComponent(sid) + '&ut=' + encodeURIComponent(ut));
}

/** 登记并提交一个玩家（猜「单」+ 数字 3），返回 pid。 */
async function registerPlayer(memberId) {
  const r = await scan(api, sid, ut, memberId);
  assert.equal(r.body.ok, true, '登记失败：' + JSON.stringify(r.body));
  const p = r.body.pid || memberId;
  await predict(api, sid, ut, p, '单', 3);
  return p;
}

test('默认没有配置：number=null 不触发，state 始终带 bonus 结构', async () => {
  const g = await api.get('/api/bonus-prize?token=' + encodeURIComponent(adminToken));
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.bonus, { number: null, title: '', desc: '' });

  const s = await playerState();
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.bonus, { number: null, title: '', desc: '', triggered: false });
});

test('无 token / 非管理员不能读写额外奖品配置', async () => {
  const noToken = await api.get('/api/bonus-prize');
  assert.equal(noToken.status, 401);

  const badSave = await api.post('/api/bonus-prize', { bonus: { number: 8 } });
  assert.equal(badSave.status, 401);

  const created = await api.post('/api/account-create', {
    token: adminToken, username: 'bonus-staff', password: 'staff-pw-123', role: 'staff'
  });
  assert.equal(created.body.ok, true);
  const staff = await login(api, 'bonus-staff', 'staff-pw-123');
  assert.equal((await api.get('/api/bonus-prize?token=' + encodeURIComponent(staff.token))).status, 401);
  assert.equal((await api.post('/api/bonus-prize', {
    token: staff.token, bonus: { number: 8, title: 'x', desc: '' }
  })).status, 401);
});

test('归一化：number 只认 0-9，非法值视为未启用，超长截断', async () => {
  const longTitle = '奖'.repeat(40);
  const r = await api.post('/api/bonus-prize', {
    token: adminToken,
    bonus: { number: 99, title: ' ' + longTitle + ' ', desc: '说明'.repeat(60), evil: 1 }
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.bonus.number, null);          // 99 非法 → 未启用
  assert.equal(r.body.bonus.title.length, 32);
  assert.equal(r.body.bonus.desc.length, 120);
  assert.deepEqual(Object.keys(r.body.bonus).sort(), ['desc', 'number', 'title']);

  // 0 与 9 都是合法特殊数字；null / 空串明确表示未启用
  for (const n of [0, 9]) {
    const ok = await api.post('/api/bonus-prize', { token: adminToken, bonus: { number: n } });
    assert.equal(ok.body.bonus.number, n, n + ' 应被接受');
  }
  for (const n of [null, '', ' ', 10, -1, 2.5, true]) {
    const off = await api.post('/api/bonus-prize', { token: adminToken, bonus: { number: n } });
    assert.equal(off.body.bonus.number, null, JSON.stringify(n) + ' 应视为未启用');
  }
});

test('命中特殊数字 → 触发且只触发一次，玩家端可见（不落库，现场重算）', async () => {
  pid = await registerPlayer('BONUS-1');
  await api.post('/api/bonus-prize', {
    token: adminToken, bonus: { number: 8, title: '幸运加奖', desc: '全员一瓶饮料' }
  });

  // 开奖 8：命中特殊数字
  const c = await confirm(api, adminToken, sid, 8);
  assert.equal(c.status, 200, '锁定失败：' + JSON.stringify(c.body));
  assert.equal(c.body.bonusTriggered, true, 'confirm 应带回 bonusTriggered=true');

  // 玩家端 state：bonus.triggered=true，且带配置文案
  const s = await playerState();
  assert.equal(s.body.bonus.triggered, true);
  assert.equal(s.body.bonus.title, '幸运加奖');
  assert.equal(s.body.bonus.desc, '全员一瓶饮料');

  // 不落库：round 表没有 bonus_triggered 列（触发态是纯内存展示，靠 number 重算）
  const cols = await withDb(async (c) => {
    const r = await c.query(
      "SELECT column_name FROM information_schema.columns WHERE table_name = 'round'"
    );
    return r.rows.map((x) => x.column_name);
  });
  assert.equal(cols.includes('bonus_triggered'), false, 'round 表不应有 bonus_triggered 列');

  // 重复锁定：被 already_locked 拒绝，不会二次触发（幂等）
  const again = await confirm(api, adminToken, sid, 8);
  assert.equal(again.status, 400);
  assert.equal(again.body.code, 'already_locked');

  // 新一轮：number 置 null → 不再触发
  const rs = await resetRound(api, adminToken, sid);
  assert.equal(rs.status, 200);
  const s2 = await playerState();
  assert.equal(s2.body.bonus.triggered, false, '新一轮 bonus.triggered 应清零');
});

test('开奖数字不命中特殊数字 → 不触发', async () => {
  await api.post('/api/bonus-prize', {
    token: adminToken, bonus: { number: 7, title: '七号加奖', desc: '' }
  });
  await registerPlayer('BONUS-2');
  const c = await confirm(api, adminToken, sid, 3);   // 3 !== 7
  assert.equal(c.status, 200);
  assert.equal(c.body.bonusTriggered, false);

  const s = await playerState();
  assert.equal(s.body.bonus.triggered, false);
});

test('配置缺失/未启用时开奖不触发；无参与者仍正确判定', async () => {
  // 先清掉配置（number=null）
  await api.post('/api/bonus-prize', { token: adminToken, bonus: { number: null, title: '', desc: '' } });
  // 新一轮（上一轮已锁定）
  const rs = await resetRound(api, adminToken, sid);
  assert.equal(rs.status, 200);

  // 无参与者直接开奖 5：配置未启用，不该触发
  const c1 = await confirm(api, adminToken, sid, 5);
  assert.equal(c1.status, 200);
  assert.equal(c1.body.bonusTriggered, false);

  // 启用 5，再开新一轮，仍无参与者，命中 5 → 触发（对象为空但状态正确）
  await api.post('/api/bonus-prize', {
    token: adminToken, bonus: { number: 5, title: '空场加奖', desc: '' }
  });
  await resetRound(api, adminToken, sid);
  const c2 = await confirm(api, adminToken, sid, 5);
  assert.equal(c2.status, 200);
  assert.equal(c2.body.bonusTriggered, true);

  const s = await playerState();
  assert.equal(s.body.bonus.triggered, true);
  assert.equal(s.body.players.length, 0, '本轮无参与者');
});

test('重启后触发态靠开奖数字现场重算（不依赖落库），配置仍在', async () => {
  // 上一轮已命中 5 并触发；开奖数字 5 仍在库里（locked），特殊数字仍是 5
  await server.stop();
  server = await startServer();
  api = makeClient(server.base);
  const admin = await login(api);
  adminToken = admin.token;
  sid = admin.sid;
  const un = await unlock(api, sid, PLAYER_PASSWORD);
  ut = un.body.ut;

  const s = await playerState();
  // 触发态由「开奖数字(5) === 特殊数字(5)」现场重算，无需任何落库标记
  assert.equal(s.body.bonus.triggered, true, '重启后 triggered 应由开奖数字现场重算为 true');
  assert.equal(s.body.bonus.number, 5);

  const g = await api.get('/api/bonus-prize?token=' + encodeURIComponent(adminToken));
  assert.equal(g.body.bonus.number, 5);
  assert.equal(g.body.bonus.title, '空场加奖');
});
