/**
 * SSE 建连路径：什么时候该写库、什么时候不该。
 *
 * 背景（诊断结论见 docs/sse-diagnostics-2026-11-23.txt）：
 *   建连时撤销 leftAt 的逻辑本身是对的，但它被放在**无条件**执行的 mutate 里，
 *   于是每一次刷新页面都排进 withLocalLock 的串行写队列、付一次真实写事务的成本，
 *   而其中绝大多数 mutator 直接 skip（玩家本来就在场）。
 *
 * 修复后仍然保证的三条语义（本文件钉死）：
 *   1. 在场玩家重连：版本号不动、不写库（只读预检直接跳过写路径）；
 *   2. 离开后重连且本轮未锁定：撤销 leftAt，首帧就把人放回名单，版本号推进；
 *   3. 本轮已锁定：名单冻结，重连不撤销（离开的人不能被放回来）。
 * 语义与「每次都 mutate」完全一致 —— 预检只是把「肯定不用写」的情况提前筛掉。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  startServer, makeClient, openSse, withDb, resetSchema, databaseUrl,
  login, unlock, scan, memberRef, ADMIN_PASSWORD, PLAYER_PASSWORD
} from './helpers.mjs';

let server;
let api;
let base;
let token;
let sid;
let ut;

const A = memberRef('L-A');
const B = memberRef('L-B');

function streamUrl(pid) {
  return base + '/api/stream?sid=' + encodeURIComponent(sid)
    + '&ut=' + encodeURIComponent(ut)
    + (pid ? '&pid=' + encodeURIComponent(pid) : '');
}

async function stateOf(pid) {
  const r = await api.get('/api/state?sid=' + encodeURIComponent(sid)
    + '&ut=' + encodeURIComponent(ut) + (pid ? '&pid=' + encodeURIComponent(pid) : ''));
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

async function leftAtOf(pid) {
  return withDb(async (c) => {
    const r = await c.query('SELECT left_at FROM player WHERE session_id = $1 AND id = $2', [sid, pid]);
    return r.rows.length ? r.rows[0].left_at : 'missing';
  });
}

async function leave(pid) {
  return api.post('/api/leave', { sid, ut, pid, reason: 'logout' });
}

/** 建连并等到首帧 state。 */
async function connect(pid) {
  const sse = openSse(streamUrl(pid));
  const res = await sse.ready;
  assert.equal(res.status, 200, 'SSE 建连失败：' + res.status);
  const ok = await sse.waitFor((e) => e.event === 'state');
  assert.ok(ok, '建连必须立刻下发首帧 state');
  return sse;
}

before(async () => {
  await resetSchema();
  server = await startServer({ databaseUrl: databaseUrl(), env: { INSTANCE_ID: 'i-liveness-1' } });
  base = server.base;
  api = makeClient(base);

  const admin = await login(api, undefined, ADMIN_PASSWORD);
  token = admin.token;
  sid = admin.sid;

  const u = await unlock(api, sid, PLAYER_PASSWORD);
  assert.equal(u.body.ok, true, '场次口令：' + JSON.stringify(u.body));
  ut = u.body.ut;

  for (const pid of [A, B]) {
    assert.equal((await scan(api, sid, ut, pid === A ? 'L-A' : 'L-B')).status, 200);
  }
});

after(async () => {
  if (server) await server.stop();
});

describe('SSE 建连：撤销 leftAt 的写库边界', () => {
  it('在场玩家重连：不写库、版本号不推进', async () => {
    const before = await stateOf(A);
    assert.equal(before.counts.total, 2);

    const sse = await connect(A);
    try {
      const first = sse.events.find((e) => e.event === 'state');
      assert.equal(first.data.version, before.version, '在场玩家重连不该产生新版本');
      assert.equal(first.data.counts.total, 2);
    } finally {
      sse.close();
    }

    const after = await stateOf(A);
    assert.equal(after.version, before.version, '只读预检命中时，建连不能推进版本号');
    assert.equal(after.counts.total, 2);
  });

  it('离开后重连（本轮未锁定）：撤销 leftAt，首帧就回到名单', async () => {
    assert.equal((await leave(B)).status, 200);
    assert.equal((await stateOf(A)).counts.total, 1, '离开后先确认名单少了一个');
    assert.notEqual(await leftAtOf(B), null, '离开标记必须落库');

    const before = await stateOf(A);
    const sse = await connect(B);
    try {
      const first = sse.events.find((e) => e.event === 'state');
      assert.equal(first.data.counts.total, 2, '首帧必须已经包含被撤销离开的玩家');
      assert.ok(first.data.players.some((p) => p.id === B));
      assert.ok(first.data.version > before.version, '撤销 leftAt 是真实写库，版本必须推进');
    } finally {
      sse.close();
    }

    assert.equal(await leftAtOf(B), null, '重连后库里的 left_at 必须清掉');
  });

  it('离开且本轮已锁定：重连不撤销，名单冻结', async () => {
    assert.equal((await leave(B)).status, 200, '锁定前先让 B 离开');

    // A 有草稿？没有 —— 直接不带 ackPending 也能锁定；B 已离开不参与
    const locked = await api.post('/api/confirm', { token, sid, number: 6 });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.equal(locked.body.counts.total, 1);

    const before = await stateOf(A);
    const sse = await connect(B);
    try {
      const first = sse.events.find((e) => e.event === 'state');
      assert.equal(first.data.version, before.version, '锁定后重连不能再写库（名单已冻结）');
      assert.deepEqual(first.data.players.map((p) => p.id), [A], '离开的人不能被重连放回名单');
    } finally {
      sse.close();
    }

    assert.notEqual(await leftAtOf(B), null, '锁定后 left_at 不能被撤销');
  });
});
