/**
 * 全员额外奖励（命中特殊数字 → 全员加奖）：规则契约 / 三语文案 / 按场次生效 / 触发与幂等 / 边界。
 *
 * 要钉死的几件事：
 *   1. 特殊数字与四档奖品同属一套「规则」，按版本保存在 rule_version 表；只有 admin 能读能写；
 *      number 只认 0-9，非法值 / null / 缺失 → 一律视为「未启用」（number=null），不触发；
 *      注意 0 是合法特殊数字，所以「未启用」只能靠 null/空值表达；
 *   2. 文案 title / desc 与四档同样是**三语对象**：一旦填就必须三语齐全（缺语言 400
 *      bonus_incomplete），都不填则玩家端用内置文案；
 *   3. **保存只影响之后新建的场次**：正在进行的场次读的是它开场时锁定的那一版，
 *      改特殊数字不会把已开奖轮翻成触发，也不会让进行中的场次提前用上新数字；
 *   4. 触发**不落库**：/api/state 的 bonus.triggered 按「本轮开奖数字是否命中该场次版本的特殊数字」
 *      现场重算；锁定后开奖数字不变 → 同一轮重算结果恒定，一轮只锁定一次 → 只触发一次；
 *      重复 confirm 被 already_locked 拒绝，不会二次触发；新一轮 reset 把 number 置 null 自然不触发；
 *   5. 玩家端 /api/state 始终带 bonus 结构（number + 三语 title/desc + triggered）；
 *   6. 边界：无参与者照常判定（对象为空但状态正确）；配置缺失不触发。
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

/** 空的三语字段 */
function noText() {
  return { 'zh-CN': '', 'zh-HK': '', 'en-US': '' };
}

/** 三语文案：不传就是三语全空（玩家端用内置文案） */
function texts(zh, hant, en) {
  if (zh === undefined) return noText();
  return { 'zh-CN': zh, 'zh-HK': hant, 'en-US': en };
}

before(async () => {
  await resetSchema();
  const srv = await startServer();
  server = srv;
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

/** 保存一版新规则（只改额外奖励那一块；四档奖品沿用最新版）。 */
function configureBonus(bonus) {
  return api.post('/api/bonus-prize', { token: adminToken, bonus });
}

function getBonus() {
  return api.get('/api/bonus-prize?token=' + encodeURIComponent(adminToken));
}

/**
 * 关掉当前场次、新建一个并把玩家绑定切过去 —— 新规则的生效边界就在这一步。
 * 先关后建是为了不撞「同时进行 4 场」的上限。
 */
async function openNewSession() {
  if (sid) {
    const closed = await api.post('/api/session-close', { token: adminToken, sid });
    assert.equal(closed.status, 200, '关场失败：' + JSON.stringify(closed.body));
  }
  const created = await api.post('/api/session-create', { token: adminToken, name: '加奖规则' });
  assert.equal(created.status, 200, '建场失败：' + JSON.stringify(created.body));
  sid = created.body.sid;
  const un = await unlock(api, sid, PLAYER_PASSWORD);
  assert.equal(un.body.ok, true, '玩家端解锁失败：' + JSON.stringify(un.body));
  ut = un.body.ut;
}

/** 登记并提交一个玩家（猜「单」+ 数字 3），返回 pid。 */
async function registerPlayer(memberId) {
  const r = await scan(api, sid, ut, memberId);
  assert.equal(r.body.ok, true, '登记失败：' + JSON.stringify(r.body));
  const p = r.body.pid || memberId;
  await predict(api, sid, ut, p, '单', 3);
  return p;
}

test('默认没有配置：number=null 不触发，state 始终带三语 bonus 结构', async () => {
  const g = await getBonus();
  assert.equal(g.status, 200);
  assert.deepEqual(g.body.bonus, { number: null, title: noText(), desc: noText() });
  assert.equal(g.body.ruleVersion, 1, '空库启动就有 v1');

  const s = await playerState();
  assert.equal(s.status, 200);
  assert.deepEqual(s.body.bonus, { number: null, title: noText(), desc: noText(), triggered: false });
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
    token: staff.token, bonus: { number: 8, title: texts('x', 'x', 'x'), desc: noText() }
  })).status, 401);
});

test('归一化：number 只认 0-9，非法值视为未启用，三语各自截断', async () => {
  const longTitle = '奖'.repeat(40);
  const r = await configureBonus({
    number: 99,
    title: texts(' ' + longTitle + ' ', longTitle, longTitle),
    // 英文用无空格长串：带空格的串截断后末尾空格会被 trim 掉，长度断言会差 1 个字
    desc: texts('说明'.repeat(60), '說明'.repeat(60), 'N'.repeat(300)),
    evil: 1
  });
  assert.equal(r.status, 200, '归一化不该报错：' + JSON.stringify(r.body));
  assert.equal(r.body.bonus.number, null);          // 99 非法 → 未启用
  for (const loc of ['zh-CN', 'zh-HK', 'en-US']) {
    assert.equal(r.body.bonus.title[loc].length, 32, loc + ' 的名称应截断到 32');
    assert.equal(r.body.bonus.desc[loc].length, 120, loc + ' 的说明应截断到 120');
  }
  assert.deepEqual(Object.keys(r.body.bonus).sort(), ['desc', 'number', 'title']);

  // 0 与 9 都是合法特殊数字；null / 空串明确表示未启用
  for (const n of [0, 9]) {
    const ok = await configureBonus({ number: n });
    assert.equal(ok.body.bonus.number, n, n + ' 应被接受');
  }
  for (const n of [null, '', ' ', 10, -1, 2.5, true]) {
    const off = await configureBonus({ number: n });
    assert.equal(off.body.bonus.number, null, JSON.stringify(n) + ' 应视为未启用');
  }
});

test('文案缺语言直接拒绝（400 bonus_incomplete），不落库', async () => {
  const before = await getBonus();
  const r = await configureBonus({
    number: 5,
    title: texts('幸运加奖', '幸運加獎', ''),   // 缺英文
    desc: noText()
  });
  assert.equal(r.status, 400, '缺语言不该被接受：' + JSON.stringify(r.body));
  assert.equal(r.body.code, 'bonus_incomplete');
  assert.deepEqual(r.body.missing, [{ tier: 'bonus', field: 'title', locales: ['en-US'] }]);

  const after = await getBonus();
  assert.equal(after.body.ruleVersion, before.body.ruleVersion, '被拒的保存不能产生新版本');
  assert.equal(after.body.bonus.number, before.body.bonus.number);
});

test('保存只产生新规则版本：当前场次不受影响，改完后新建的场次才吃新数字与三语文案', async () => {
  // 两个版本号要分清：latestVersion 是「之后新建场次会用到的」，pinnedVersion 是当前场次锁定的
  const latestVersion = (await getBonus()).body.ruleVersion;
  const pinnedVersion = (await playerState()).body.ruleVersion;
  assert.ok(pinnedVersion < latestVersion, '前面的用例已经存过好几版，当前场次仍停在开场那一版');

  const bonusTitle = texts('幸运加奖', '幸運加獎', 'Lucky bonus');
  const bonusDesc = texts('全员一瓶饮料', '全員一瓶飲料', 'A drink for everyone');
  const saved = await configureBonus({ number: 8, title: bonusTitle, desc: bonusDesc });
  assert.equal(saved.status, 200, '保存失败：' + JSON.stringify(saved.body));
  assert.equal(saved.body.bonus.number, 8);
  assert.deepEqual(saved.body.bonus.title, bonusTitle, '三语文案要原样保留');
  assert.deepEqual(saved.body.bonus.desc, bonusDesc);
  assert.equal(saved.body.created, true, '内容变了就要新增版本');
  assert.equal(saved.body.ruleVersion, latestVersion + 1);

  // 当前场次仍锁在开场那一版（空配置）：玩家端看不到新特殊数字
  const cur = await playerState();
  assert.equal(cur.body.ruleVersion, pinnedVersion);
  assert.equal(cur.body.bonus.number, null, '进行中的场次不跟着改特殊数字');

  // 新建场次才锁定新版本
  await openNewSession();
  const next = await playerState();
  assert.equal(next.body.ruleVersion, saved.body.ruleVersion);
  assert.equal(next.body.bonus.number, 8);
  assert.equal(next.body.bonus.triggered, false);
  assert.deepEqual(next.body.bonus.title, bonusTitle, '玩家端拿到的也是三语结构，前端自己挑语言');

  // 命中特殊数字：confirm 带回 bonusTriggered=true，玩家端 triggered=true（现场重算，不落库）
  await registerPlayer('BONUS-1');
  const c = await confirm(api, adminToken, sid, 8);
  assert.equal(c.status, 200, '锁定失败：' + JSON.stringify(c.body));
  assert.equal(c.body.bonusTriggered, true, 'confirm 应带回 bonusTriggered=true');

  const s = await playerState();
  assert.equal(s.body.bonus.triggered, true);
  assert.equal(s.body.bonus.title['zh-CN'], '幸运加奖');
  assert.equal(s.body.bonus.title['en-US'], 'Lucky bonus');
  assert.equal(s.body.bonus.desc['zh-HK'], '全員一瓶飲料');

  // 不落库：round 表没有 bonus_triggered 列（触发态是纯展示，靠 number 重算）
  const cols = await withDb(async (c2) => {
    const r = await c2.query(
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
  await configureBonus({ number: 7, title: texts('七号加奖', '七號加獎', 'Lucky seven'), desc: noText() });
  await openNewSession();
  await registerPlayer('BONUS-2');
  const c = await confirm(api, adminToken, sid, 3);   // 3 !== 7
  assert.equal(c.status, 200);
  assert.equal(c.body.bonusTriggered, false);

  const s = await playerState();
  assert.equal(s.body.bonus.triggered, false);
});

test('配置未启用时开奖不触发；0 是合法特殊数字，命中照样触发', async () => {
  // 先清掉配置（number=null），开新场次让这一版生效
  await configureBonus({ number: null, title: noText(), desc: noText() });
  await openNewSession();

  // 无参与者直接开奖 5：配置未启用，不该触发
  const c1 = await confirm(api, adminToken, sid, 5);
  assert.equal(c1.status, 200);
  assert.equal(c1.body.bonusTriggered, false);

  // 启用 0（合法特殊数字，不是「不启用」），再开新一轮，仍无参与者，命中 0 → 触发
  const saved = await configureBonus({ number: 0, title: texts('零号加奖', '零號加獎', 'Lucky zero'), desc: noText() });
  assert.equal(saved.body.bonus.number, 0);
  await openNewSession();
  const c2 = await confirm(api, adminToken, sid, 0);
  assert.equal(c2.status, 200);
  assert.equal(c2.body.bonusTriggered, true);

  const s = await playerState();
  assert.equal(s.body.bonus.triggered, true);
  assert.equal(s.body.bonus.number, 0);
  assert.equal(s.body.players.length, 0, '本轮无参与者');
});

test('重启后触发态按场次锁定的版本现场重算，三语配置仍在', async () => {
  // 上一场已锁定开奖数字 0，且该场次锁定的规则里特殊数字也是 0
  const pinned = (await playerState()).body.ruleVersion;
  await server.stop();
  server = await startServer();
  api = makeClient(server.base);
  const admin = await login(api);
  adminToken = admin.token;
  sid = admin.sid;
  const un = await unlock(api, sid, PLAYER_PASSWORD);
  ut = un.body.ut;

  const s = await playerState();
  // 触发态由「开奖数字(0) === 该场次版本的特殊数字(0)」现场重算，无需任何落库标记
  assert.equal(s.body.bonus.triggered, true, '重启后 triggered 应由开奖数字现场重算为 true');
  assert.equal(s.body.bonus.number, 0);
  assert.equal(s.body.ruleVersion, pinned, '重启不改变场次锁定的版本');

  const g = await getBonus();
  assert.equal(g.body.bonus.number, 0);
  assert.deepEqual(g.body.bonus.title, { 'zh-CN': '零号加奖', 'zh-HK': '零號加獎', 'en-US': 'Lucky zero' });
});
