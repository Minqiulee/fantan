/**
 * SSE 重连：Last-Event-ID 与断点位置的对齐。
 *
 * 断点的定义很简单：state 帧的 `id:` 就是场次版本号，客户端把它存成 Last-Event-ID，
 * 重连时浏览器自动带回。本实现的广播一律是全量快照，所以「补齐」不需要事件回放，
 * 只要保证重连后的首帧落在**当前**版本上，客户端就必然与服务器对齐。
 *
 * 这里要钉死的几件事：
 *   1. 首帧 id = 负载 version = /api/state 的 version（三条路径同一个断点）；
 *   2. 断线期间有变更 → 带旧 Last-Event-ID 重连，首帧直接是最新快照，漏掉的变更在里面；
 *   3. 断线期间无变更 → 重连后 id 不虚增（否则客户端会以为自己丢了帧）；
 *   4. Last-Event-ID 超前或非法时照常建连、按当前版本对齐，不能把客户端晾着；
 *   5. 只有 state 帧推进断点：draft / ping 不带 id，草稿不推进版本；
 *   6. 同一条连接上的 state id 严格单调递增，与负载版本一一对应。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  resetSchema, startServer, makeClient, openSse,
  login, unlock, scan, memberRef
} from './helpers.mjs';

let server;
let api;
let base;
let token;
let sid;
let ut;

function streamUrl() {
  return base + '/api/stream?sid=' + encodeURIComponent(sid) + '&ut=' + encodeURIComponent(ut);
}

/** 模拟浏览器重连：带上上次见到的 id。 */
function resume(lastId) {
  return openSse(streamUrl(), { headers: { 'Last-Event-ID': String(lastId) } });
}

/** /api/state 是重连对齐的另一条路径（刷新 / 回到前台），版本必须与 SSE 首帧一致。 */
async function stateVersion() {
  const r = await api.get('/api/state?sid=' + encodeURIComponent(sid) + '&ut=' + encodeURIComponent(ut));
  assert.equal(r.status, 200, '状态查询失败：' + JSON.stringify(r.body));
  return r.body.version;
}

/** 从第 n 条之后找满足条件的事件：避免 waitFor 命中重连前的旧帧。 */
async function waitNew(sse, n, pred, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = sse.events.slice(n).find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 25));
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

before(async () => {
  await resetSchema();
  server = await startServer({ env: { INSTANCE_ID: 'i-sse-1' } });
  base = server.base;
  api = makeClient(base);

  const admin = await login(api);
  token = admin.token;
  sid = admin.sid;

  const u = await unlock(api, sid);
  assert.equal(u.status, 200, '场次口令：' + JSON.stringify(u.body));
  ut = u.body.ut;
});

after(async () => {
  if (server) await server.stop();
});

describe('SSE 重连：Last-Event-ID 与断点对齐', () => {
  it('首帧断点：id 就是版本号，与 /api/state 落在同一处', async () => {
    const sse = openSse(streamUrl());
    try {
      await sse.ready;
      const first = await waitNew(sse, 0, (e) => e.event === 'state');
      assert.ok(first, '连上必须立刻下发首帧');
      assert.equal(sse.retry, 2000, '必须告知客户端断线后 2 秒重连');
      assert.equal(first.id, String(first.data.version), 'id 与负载版本号必须是同一个值');
      assert.equal(first.data.version, await stateVersion(), 'SSE 首帧与 /api/state 不能各说各话');

      // 建连只发一帧：若既回放历史又发快照，客户端会把同一状态处理两次
      await sleep(200);
      assert.equal(sse.events.filter((e) => e.event === 'state').length, 1, '建连只允许一帧 state');
    } finally {
      sse.close();
    }
  });

  it('断线期间有变更：带旧 Last-Event-ID 重连，首帧直接落在当前版本', async () => {
    const v0 = await stateVersion();

    // 断线（没有连接在听）期间发生变更
    assert.equal((await scan(api, sid, ut, 'S1')).status, 200);
    const v1 = await stateVersion();
    assert.ok(v1 > v0, '扫码必须推进版本，否则这个用例没有意义');

    const sse = resume(v0);
    try {
      await sse.ready;
      const first = await waitNew(sse, 0, (e) => e.event === 'state');
      assert.ok(first, '重连必须立刻下发首帧');
      assert.equal(first.id, String(v1), '首帧 id 必须是当前版本，而不是断点那版');
      assert.equal(first.data.version, v1);
      assert.ok(first.data.players.some((p) => p.id === memberRef('S1')),
        '断线期间漏掉的变更必须已经在首帧里（全量快照即补齐）');
    } finally {
      sse.close();
    }
  });

  it('断线期间无变更：重连后 id 不虚增', async () => {
    const v = await stateVersion();
    const sse = resume(v);
    try {
      await sse.ready;
      const first = await waitNew(sse, 0, (e) => e.event === 'state');
      assert.ok(first, '重连必须立刻下发首帧');
      assert.equal(first.id, String(v), '没有变更就不能把断点往前推');
      assert.equal(first.data.version, v);
    } finally {
      sse.close();
    }
  });

  it('Last-Event-ID 超前或非法：照常建连，按当前版本对齐', async () => {
    const v = await stateVersion();
    for (const bad of ['999999', 'not-a-number']) {
      const sse = openSse(streamUrl(), { headers: { 'Last-Event-ID': bad } });
      try {
        await sse.ready;
        const first = await waitNew(sse, 0, (e) => e.event === 'state');
        assert.ok(first, 'Last-Event-ID=' + bad + ' 时仍必须下发首帧');
        assert.equal(first.data.version, v, '断点比服务端还新时不能把客户端晾着等增量');
        assert.equal(first.id, String(v), 'id 以服务端版本为准，不跟着客户端的头走');
      } finally {
        sse.close();
      }
    }
  });

  it('断点只由 state 帧推进：draft 帧不带 id', async () => {
    const sse = openSse(streamUrl());
    try {
      await sse.ready;
      const first = await waitNew(sse, 0, (e) => e.event === 'state');
      assert.ok(first);
      const mark = sse.events.length;

      const picked = await api.put('/api/pick', {
        sid, ut, pid: memberRef('S1'), oddEven: '双', number: 6, seq: 1
      });
      assert.equal(picked.status, 200, JSON.stringify(picked.body));

      const draft = await waitNew(sse, mark, (e) => e.event === 'draft');
      assert.ok(draft, '草稿必须推到同场次的连接，实际事件：' + sse.events.map((e) => e.event).join(','));
      assert.equal(draft.id, null, '草稿帧带 id 会把断点推到没有对应快照的位置');
      assert.equal(await stateVersion(), first.data.version, '草稿不推进版本，断点也不能动');
    } finally {
      sse.close();
    }
  });

  it('同一条连接上 state 的 id 严格递增，末帧与负载版本一致', async () => {
    const sse = openSse(streamUrl());
    try {
      await sse.ready;
      assert.ok(await sse.waitFor((e) => e.event === 'state'));

      assert.equal((await scan(api, sid, ut, 'S2')).status, 200);
      assert.ok(await sse.waitFor((e) => e.event === 'state' && e.data.players.some((p) => p.id === memberRef('S2'))),
        '扫码的变更必须推到已建立的连接上');

      // S1 只有草稿没有提交 → 锁定必须显式 ackPending（草稿不算参赛）
      const locked = await api.post('/api/confirm', { token, sid, number: 4, ackPending: true });
      assert.equal(locked.status, 200, JSON.stringify(locked.body));

      const states = sse.events.filter((e) => e.event === 'state');
      assert.ok(states.length >= 3, '至少 首帧 + 扫码 + 锁定 三帧，实际 ' + states.length);
      const ids = states.map((e) => Number(e.id));
      for (let i = 1; i < ids.length; i += 1) {
        assert.ok(ids[i] > ids[i - 1], 'state id 必须严格递增：' + ids.join(' → '));
      }
      const last = states[states.length - 1];
      assert.equal(last.id, String(last.data.version), '末帧 id 与负载版本必须一致');
      assert.equal(last.data.locked, true, '锁定后的快照必须带已开奖状态');
    } finally {
      sse.close();
    }
  });
});
