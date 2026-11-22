/**
 * 在场口径：已登出 / 已离开的玩家不进入任何实时列表、人数与统计。
 *
 * 钉死的契约：
 *   1. /api/leave 后，玩家视图、大屏视图、场次摘要都不再出现这个人，counts 也不再算他；
 *   2. 离开玩家的草稿不能挡住员工开奖（pending_confirm_drafts 只认在场玩家）；
 *   3. 归档与实时名单同口径：锁定那一刻不在场的人，不进 round_archive 的表头计数与明细；
 *   4. 本轮未锁定前，重新扫码 / SSE 重连会把玩家放回名单；锁定后名单冻结，
 *      离开、登出、重新扫码都不能再改写结果表与归档。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, makeClient, login, unlock, scan, withDb, resetSchema, databaseUrl,
  ADMIN_PASSWORD, PLAYER_PASSWORD
} from './helpers.mjs';

let server;
let api;
let base;
let token;
let sid;
let ut;

const A = 'M-A';
const B = 'M-B';

function q(path) {
  return path + (path.includes('?') ? '&' : '?')
    + 'sid=' + encodeURIComponent(sid) + '&ut=' + encodeURIComponent(ut);
}

function state(pid) {
  return api.get(q('/api/state') + (pid ? '&pid=' + encodeURIComponent(pid) : ''));
}

function board() {
  return api.get('/api/state?sid=' + encodeURIComponent(sid)
    + '&token=' + encodeURIComponent(token) + '&view=bigscreen');
}

async function submit(pid, oddEven, number, idemKey) {
  const r = await fetch(base + '/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idemKey },
    body: JSON.stringify({ sid, ut, pid, oddEven, number }),
    signal: AbortSignal.timeout(15000)
  });
  return { status: r.status, body: await r.json() };
}

async function leave(pid) {
  return api.post('/api/leave', { sid, ut, pid, reason: 'logout' });
}

async function playersOf(sessionId) {
  return withDb(async (c) => {
    const r = await c.query(
      'SELECT id, left_at FROM player WHERE session_id = $1 ORDER BY id',
      [sessionId]
    );
    return r.rows;
  });
}

before(async () => {
  await resetSchema();
  server = await startServer({ databaseUrl: databaseUrl(), env: { INSTANCE_ID: 'i-presence-1' } });
  base = server.base;
  api = makeClient(base);

  const admin = await login(api, undefined, ADMIN_PASSWORD);
  assert.equal(admin.ok, true, '管理员登录：' + JSON.stringify(admin));
  token = admin.token;
  sid = admin.sid;

  const u = await unlock(api, sid, PLAYER_PASSWORD);
  assert.equal(u.body.ok, true, '场次口令：' + JSON.stringify(u.body));
  ut = u.body.ut;

  for (const pid of [A, B]) {
    const r = await scan(api, sid, ut, pid);
    assert.equal(r.body.ok, true, '登记 ' + pid);
  }
});

after(async () => {
  if (server) await server.stop();
});

test('离开后：两端列表、人数、场次摘要、库里标记全部同步', async () => {
  // B 先留一个草稿，验证「离开」连草稿也一起从统计里消失（草稿本身不删，回来还在）
  const pick = await api.put('/api/pick', { sid, ut, pid: B, oddEven: '双', number: 8, seq: 1 });
  assert.equal(pick.status, 200, JSON.stringify(pick.body));

  let s = await state(A);
  assert.equal(s.body.counts.total, 2);
  assert.equal(s.body.players.length, 2);

  const lv = await leave(B);
  assert.equal(lv.status, 200, JSON.stringify(lv.body));
  assert.equal(lv.body.ok, true);
  assert.equal(lv.body.ignored, false);

  s = await state(A);
  assert.equal(s.body.counts.total, 1, '人数只算在场玩家');
  assert.equal(s.body.counts.draft, 0, '离开玩家的草稿不计入未确认');
  assert.deepEqual(s.body.players.map((p) => p.id), [A], '员工端列表不再出现离开的人');

  const bs = await board();
  assert.equal(bs.body.counts.total, 1);
  assert.deepEqual(bs.body.players.map((p) => p.id), [A], '大屏不再出现离开的人');
  assert.equal(bs.body.players[0].left, undefined, '大屏投影不再下发 left 字段');

  const list = await api.get('/api/sessions?token=' + encodeURIComponent(token));
  const one = list.body.sessions.find((x) => x.id === sid);
  assert.equal(one.players, 1, '场次摘要的人数同样只算在场玩家');

  const rows = await playersOf(sid);
  const b = rows.find((r) => r.id === B);
  assert.ok(b.left_at != null, '离开标记要落库，重启后仍然有效');
});

test('重新扫码 = 回到现场：名单与统计立刻恢复，草稿仍在', async () => {
  const r = await scan(api, sid, ut, B);
  assert.equal(r.body.ok, true);

  const s = await state(A);
  assert.equal(s.body.counts.total, 2);
  assert.equal(s.body.counts.draft, 1, '离开不清草稿，回来还能接着确认');
  assert.deepEqual(s.body.players.map((p) => p.id).sort(), [A, B].sort());

  const rows = await playersOf(sid);
  assert.equal(rows.find((x) => x.id === B).left_at, null);
});

test('离开幂等：重复上报不推进版本号，也不会把人算回来', async () => {
  assert.equal((await leave(B)).body.ignored, false);

  const v1 = (await state(A)).body.version;
  const again = await leave(B);
  assert.equal(again.status, 200);
  assert.equal(again.body.ignored, true);
  const v2 = (await state(A)).body.version;

  assert.equal(v2, v1, '已离开的人重复上报不应产生新的状态版本');
  assert.equal((await state(A)).body.counts.total, 1);
});

test('离开玩家的草稿不挡开奖；归档只记在场玩家', async () => {
  // 提交与离开竞态：离开标记先到、提交后到 —— 成功提交即视为回到现场，
  // 否则会出现「已提交但两端都看不到、锁定也不归档」。
  assert.equal((await leave(A)).body.ignored, false);
  assert.equal((await state()).body.counts.total, 0);
  const sub = await submit(A, '单', 7, 'idem-presence-aaaa1111');
  assert.equal(sub.status, 200, JSON.stringify(sub.body));
  const back = await state();
  assert.equal(back.body.counts.total, 1, '提交成功要撤销残留的离开标记');
  assert.equal(back.body.counts.submitted, 1);

  // B 已离开且留有草稿：员工不带 ackPending 也应能直接锁定
  const ok = await api.post('/api/confirm', { token, sid, number: 7 });
  assert.equal(ok.status, 200, '离开玩家的草稿不该阻塞锁定：' + JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.counts.total, 1);
  assert.equal(ok.body.counts.submitted, 1);

  const counted = await withDb(async (c) => {
    const h = await c.query(
      'SELECT player_count, submitted_count FROM round_archive WHERE session_id = $1 AND round = $2',
      [sid, 1]
    );
    const e = await c.query(
      `SELECT member_id FROM round_archive_entry
        WHERE archive_id = (SELECT archive_id FROM round_archive WHERE session_id = $1 AND round = $2)
        ORDER BY member_id`,
      [sid, 1]
    );
    return { head: h.rows[0], members: e.rows.map((x) => x.member_id) };
  });
  assert.equal(Number(counted.head.player_count), 1, '归档扫码人数只算在场玩家');
  assert.equal(Number(counted.head.submitted_count), 1);
  assert.deepEqual(counted.members, [A], '归档明细不包含离开的人');

  const bs = await board();
  assert.deepEqual(bs.body.players.map((p) => p.id), [A]);
  assert.equal(bs.body.counts.total, 1);
});

test('锁定后名单冻结：离开/登出与重新扫码都不能改写结果表与归档', async () => {
  const lv = await leave(A);
  assert.equal(lv.status, 200);
  assert.equal(lv.body.ignored, true, '锁定后离开不再生效');
  assert.equal(lv.body.locked, true);

  // B 在锁定前就离开了：锁定后重新扫码也不能被放回本轮名单
  const rs = await scan(api, sid, ut, B);
  assert.equal(rs.body.ok, true);

  const s = await state(A);
  assert.equal(s.body.counts.total, 1, '锁定后名单冻结');
  assert.deepEqual(s.body.players.map((p) => p.id), [A]);

  const bs = await board();
  assert.deepEqual(bs.body.players.map((p) => p.id), [A]);

  const rows = await playersOf(sid);
  assert.ok(rows.find((x) => x.id === B).left_at != null, '锁定后扫码不撤销离开标记');
  assert.equal(rows.find((x) => x.id === A).left_at, null, '锁定后离开不写库');

  const n = await withDb(async (c) => {
    const r = await c.query(
      `SELECT count(*)::int AS n FROM round_archive_entry
        WHERE archive_id = (SELECT archive_id FROM round_archive WHERE session_id = $1 AND round = $2)`,
      [sid, 1]
    );
    return r.rows[0].n;
  });
  assert.equal(Number(n), 1, '归档不被锁定后的状态变化改写');
});
