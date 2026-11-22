/**
 * 草稿（临时选择）与确认提交：接口契约 / 内存语义 / 幂等 / 锁定竞态 / 重启恢复。
 *
 * 这里要钉死的几件事：
 *   1. 草稿只存内存 —— 库里的 player.odd_even 不能因为草稿而变，version 也不能动；
 *   2. seq 单调 —— 旧序号迟到不能把新选择盖回去；
 *   3. 提交幂等 —— 同 Idempotency-Key 重放返回 200，异 key 返回 409 + 终态；
 *   4. 必须确认才算参赛 —— 有草稿时员工锁定必须显式 ackPending，锁定后草稿作废；
 *   5. 草稿不落库 → 实例重启后丢失，客户端用更大 seq 重发即恢复（最终一致）。
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

const H_KEY = 'Idempotency-Key';

function q(path) {
  return path + (path.includes('?') ? '&' : '?')
    + 'sid=' + encodeURIComponent(sid) + '&ut=' + encodeURIComponent(ut);
}

/** me 视角要带 pid（/api/state 只对请求里声明的 pid 生成 me），不带就是纯观众视角。 */
function state(pid) {
  return api.get(q('/api/state') + (pid ? '&pid=' + encodeURIComponent(pid) : ''));
}

function board() {
  return api.get('/api/state?sid=' + encodeURIComponent(sid)
    + '&token=' + encodeURIComponent(token) + '&view=bigscreen');
}

function pick(pid, oddEven, number, seq) {
  return api.put('/api/pick', { sid, ut, pid, oddEven, number, seq });
}

function drop(pid, seq) {
  return api.del('/api/pick', { sid, ut, pid, seq });
}

/** 提交需要自定义 header，makeClient 只封了 body，这里直接 fetch。 */
async function submit(pid, oddEven, number, idemKey) {
  const r = await fetch(base + '/api/submit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', [H_KEY]: idemKey },
    body: JSON.stringify({ sid, ut, pid, oddEven, number }),
    signal: AbortSignal.timeout(15000)
  });
  return { status: r.status, body: await r.json() };
}

async function playerRow(pid) {
  return withDb(async (c) => {
    const r = await c.query(
      'SELECT id, odd_even, number FROM player WHERE session_id = $1 AND id = $2',
      [sid, pid]
    );
    return r.rows[0] || null;
  });
}

before(async () => {
  await resetSchema();
  server = await startServer({ databaseUrl: databaseUrl(), env: { INSTANCE_ID: 'i-pick-1' } });
  base = server.base;
  api = makeClient(base);

  const admin = await login(api, undefined, ADMIN_PASSWORD);
  assert.equal(admin.ok, true, '管理员登录：' + JSON.stringify(admin));
  token = admin.token;
  sid = admin.sid;

  const u = await unlock(api, sid, PLAYER_PASSWORD);
  assert.equal(u.body.ok, true, '场次口令：' + JSON.stringify(u.body));
  ut = u.body.ut;

  for (const pid of ['M1', 'M2']) {
    const r = await scan(api, sid, ut, pid);
    assert.equal(r.body.ok, true, '登记 ' + pid);
  }
});

after(async () => {
  if (server) await server.stop();
});

test('草稿只写内存：不推进 version，也不碰 player.odd_even', async () => {
  const before = await state('M1');
  const v0 = before.body.version;

  const r = await pick('M1', '单', 3, 1);
  assert.equal(r.status, 200);
  assert.equal(r.body.accepted, true);

  const afterState = await state('M1');
  assert.equal(afterState.body.version, v0, '草稿不落库 → version 不能变');
  const me = afterState.body.players.find((p) => p.id === 'M1');
  assert.equal(me.status, 'draft');
  assert.equal(me.submitted, false, '草稿不算已提交');

  const row = await playerRow('M1');
  assert.equal(row.odd_even, null, '库里 odd_even 必须仍为 null');
  assert.equal(row.number, null);

  const self = afterState.body.me;
  assert.equal(self.draft.oe, '单', 'me.draft 要能把选择恢复出来');
  assert.equal(self.draft.seq, 1);
});

test('玩家视图不泄露他人选项，大屏视图才带具体值', async () => {
  const pv = await state('M1');
  const other = pv.body.players.find((p) => p.id === 'M1');
  assert.equal(other.oe, undefined, '玩家视图不能出现 oe');
  assert.equal(other.num, undefined, '玩家视图不能出现 num');

  const bs = await board();
  const onBoard = bs.body.players.find((p) => p.id === 'M1');
  assert.equal(onBoard.status, 'draft');
  assert.equal(onBoard.oe, '单');
  assert.equal(onBoard.num, 3);
  assert.equal(bs.body.counts.draft, 1);
});

test('seq 单调：旧序号迟到不回退，重复 seq 返回当前值', async () => {
  const newer = await pick('M1', '双', 6, 5);
  assert.equal(newer.body.accepted, true);

  const stale = await pick('M1', '单', 7, 3);
  assert.equal(stale.status, 200, '旧序号不是错误，只是忽略');
  assert.equal(stale.body.accepted, false);
  assert.equal(stale.body.ignored, 'stale_seq');
  assert.equal(stale.body.draft.oe, '双', '返回服务端当前值，供客户端覆盖本地');

  const same = await pick('M1', '单', 7, 5);
  assert.equal(same.body.accepted, false);
  assert.equal(same.body.draft.oe, '双', '同 seq 重发视为同一请求，不改值');

  const bs = await board();
  assert.equal(bs.body.players.find((p) => p.id === 'M1').oe, '双');
});

test('撤销草稿：状态回到未选择，旧 seq 不能复活', async () => {
  const r = await drop('M1', 6);
  assert.equal(r.body.accepted, true);

  let bs = await board();
  let m1 = bs.body.players.find((p) => p.id === 'M1');
  assert.equal(m1.status, 'none');
  assert.equal(m1.oe, null);

  const revive = await pick('M1', '单', 1, 2);
  assert.equal(revive.body.accepted, false, '删除用掉了 seq 6，seq 2 必须被忽略');
  bs = await board();
  assert.equal(bs.body.players.find((p) => p.id === 'M1').status, 'none');
});

test('提交幂等：同 key 重放 / 异 key 报已提交 / 提交后草稿清除', async () => {
  await pick('M1', '单', 5, 7);

  const first = await submit('M1', '单', 5, 'idem-key-aaaa1111');
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.ok, true);
  assert.equal(first.body.replay, false);
  assert.equal(first.body.counts.submitted, 1);

  const replay = await submit('M1', '单', 5, 'idem-key-aaaa1111');
  assert.equal(replay.status, 200);
  assert.equal(replay.body.replay, true, '同 key 必须重放而不是报错');

  const dup = await submit('M1', '双', 2, 'idem-key-bbbb2222');
  assert.equal(dup.status, 409);
  assert.equal(dup.body.code, 'already_submitted');
  assert.equal(dup.body.submit.oddEven, '单', '409 要带终态，前端据此转成功态');

  const row = await playerRow('M1');
  assert.equal(row.odd_even, '单', '确认提交才写库');
  assert.equal(Number(row.number), 5);

  const bs = await board();
  assert.equal(bs.body.players.find((p) => p.id === 'M1').draftOddEven, null, '提交后草稿必须清掉');

  const afterSubmit = await pick('M1', '双', 2, 9);
  assert.equal(afterSubmit.status, 409);
  assert.equal(afterSubmit.body.code, 'already_submitted');

  const noKey = await api.post('/api/submit', { sid, ut, pid: 'M2', oddEven: '单', number: 1 });
  assert.equal(noKey.status, 422, '缺幂等键直接拒绝');
  assert.equal(noKey.body.code, 'idempotency_key_required');
});

test('锁定竞态：有草稿必须 ackPending；锁定后草稿作废、不算参赛', async () => {
  // M2 只选了没确认（M1 已提交）
  const d = await pick('M2', '双', 8, 1);
  assert.equal(d.body.accepted, true);

  const blocked = await api.post('/api/confirm', { token, sid, number: 4 });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, 'pending_confirm_required');
  assert.equal(blocked.body.counts.draft, 1);
  assert.equal(blocked.body.pending[0].pid, 'M2', '名单要能指出是谁没确认');

  const ok = await api.post('/api/confirm', { token, sid, number: 4, ackPending: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.ok, true);
  assert.equal(ok.body.counts.submitted, 1, '只有确认提交的人算参赛');

  const row = await playerRow('M2');
  assert.equal(row.odd_even, null, '草稿不因锁定变成提交');

  const bs = await board();
  const m2 = bs.body.players.find((p) => p.id === 'M2');
  assert.equal(m2.status, 'none', '锁定后草稿清空');
  assert.equal(m2.submitted, false);

  const late = await pick('M2', '单', 1, 10);
  assert.equal(late.status, 409);
  assert.equal(late.body.code, 'round_locked');

  const lateSubmit = await submit('M2', '单', 1, 'idem-key-cccc3333');
  assert.equal(lateSubmit.status, 409);
  assert.equal(lateSubmit.body.code, 'round_locked');
});

test('新一轮清空草稿；草稿不跨轮残留', async () => {
  const r = await api.post('/api/reset', { token, sid });
  assert.equal(r.status, 200);
  const bs = await board();
  assert.equal(bs.body.players.length, 0);
  assert.equal(bs.body.counts.draft, 0);
});

test('实例重启：草稿丢失，客户端用更大 seq 重发即恢复（最终一致）', async () => {
  await scan(api, sid, ut, 'M3');
  const r1 = await pick('M3', '单', 7, 4);
  assert.equal(r1.body.accepted, true);

  await server.stop();
  server = await startServer({ databaseUrl: databaseUrl(), env: { INSTANCE_ID: 'i-pick-2' } });
  base = server.base;
  api = makeClient(base);

  const afterRestart = await state('M3');
  assert.equal(afterRestart.body.me.draft, null, '草稿只在内存，重启必然丢');

  // 客户端本地还留着 {oe,num,seq=4}：看到服务端没有就补发（这就是「最终一致」的兜底）
  const replay = await pick('M3', '单', 7, 5);
  assert.equal(replay.body.accepted, true);

  const bs = await board();
  const m3 = bs.body.players.find((p) => p.id === 'M3');
  assert.equal(m3.status, 'draft');
  assert.equal(m3.num, 7);
});
