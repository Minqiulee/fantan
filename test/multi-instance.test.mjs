/**
 * 多实例回归：两台服务进程共用一个 Postgres，验证改造后的三件事。
 *
 *   1. 共享存储：任一台实例写入的状态，另一台立刻读得到；员工 token 跨实例有效
 *   2. 跨实例广播：A 上的变更会经 LISTEN/NOTIFY 推到 B 的 SSE 连接，
 *      场次关闭也会跨实例通知并断开连接
 *   3. 并发控制：同一玩家并发提交、同一场次并发锁定、并发开新一轮、
 *      并发新建场次（集群上限），都只能有一个成功，不出现写覆盖或状态跳变
 *
 * 这里启动的是两个真实子进程（不同端口、同一 DATABASE_URL），不打桩：
 * 多实例的坑基本都在「进程之间」，单进程内测不出来。
 */
import test, { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resetSchema, startServer, makeClient, freePort,
  login, unlock, scan, predict, confirm, resetRound, summary, memberRef
} from './helpers.mjs';

/** 极简 SSE 客户端：收集事件，支持等待某个条件成立。 */
function openSse(url) {
  const events = [];
  const ctrl = new AbortController();

  const ready = (async () => {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error('SSE 连接失败：' + res.status);
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const lines = chunk.split('\n');
            const ev = lines.find((l) => l.startsWith('event: '));
            const data = lines.find((l) => l.startsWith('data: '));
            if (ev) events.push({ event: ev.slice(7), data: data ? JSON.parse(data.slice(6)) : null });
          }
        }
      } catch {
        /* abort 或断连，正常结束 */
      }
    })();
    return res;
  })();

  return {
    events,
    ready,
    close: () => ctrl.abort(),
    async waitFor(pred, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (events.some(pred)) return true;
        await new Promise((r) => setTimeout(r, 25));
      }
      return false;
    }
  };
}

describe('多实例：共享会话存储 / 跨实例广播 / 并发写', () => {
  let a;   // 实例 A
  let b;   // 实例 B
  let apiA;
  let apiB;
  let token;
  let sid;
  let ut;

  before(async () => {
    await resetSchema();
    const [portA, portB] = [await freePort(), await freePort()];
    a = await startServer({ port: portA, env: { INSTANCE_ID: 'test-a' } });
    b = await startServer({ port: portB, env: { INSTANCE_ID: 'test-b' } });
    apiA = makeClient(a.base);
    apiB = makeClient(b.base);
  });

  after(async () => {
    if (a) await a.stop();
    if (b) await b.stop();
  });

  it('员工会话在库里：A 登录的 token 在 B 上同样有效', async () => {
    const s = await login(apiA);
    token = s.token;
    sid = s.sid;

    const check = await apiB.get('/api/staff-check?token=' + encodeURIComponent(token));
    assert.equal(check.status, 200);
    assert.equal(check.body.ok, true, 'B 必须认 A 签发的 token');
    assert.equal(check.body.sid, sid);
  });

  it('状态在共享存储：A 扫码后 B 立刻读得到同一份状态', async () => {
    const u = await unlock(apiA, sid);
    assert.equal(u.status, 200);
    ut = u.body.ut;

    assert.equal((await scan(apiA, sid, ut, 'M001')).status, 200);

    const onB = await apiB.get('/api/state?sid=' + sid + '&ut=' + encodeURIComponent(ut));
    assert.equal(onB.status, 200);
    assert.equal(onB.body.players.length, 1, 'B 上必须看到 A 登记的人');
    assert.equal(onB.body.players[0].id, memberRef('M001'), '另一实例读到的 pid 也是 ref');
    assert.equal(onB.body.session.id, sid);
    assert.ok(onB.body.version >= 2, '版本号来自数据库，跨实例单调递增；实际 ' + onB.body.version);
  });

  it('并发提交同一玩家：只有一条成功，后一条被识别为重复', async () => {
    const [ra, rb] = await Promise.all([
      predict(apiA, sid, ut, 'M001', '单', 3),
      predict(apiB, sid, ut, 'M001', '双', 4)
    ]);
    const okOnes = [ra, rb].filter((r) => r.status === 200);
    assert.equal(okOnes.length, 1, '同一玩家只能有一条预测写进库：' + JSON.stringify([ra.body, rb.body]));

    const loser = [ra, rb].find((r) => r.status !== 200);
    assert.equal(loser.status, 400);
    assert.equal(loser.body.code, 'predict_duplicate', '冲突重试后必须看到「已提交」，而不是再写一次');
  });

  it('并发锁定同一轮：只有一条成功，归档只有一份', async () => {
    // 第二位玩家从 B 实例登记，顺便验证 A/B 写的是同一份状态
    assert.equal((await scan(apiB, sid, ut, 'M002')).status, 200);

    const [ra, rb] = await Promise.all([
      confirm(apiA, token, sid, 4),
      confirm(apiB, token, sid, 6)
    ]);
    const winners = [ra, rb].filter((r) => r.status === 200);
    assert.equal(winners.length, 1, '只允许一台实例锁定：' + JSON.stringify([ra.body, rb.body]));
    assert.equal(winners[0].body.archived, true, '锁定成功就必须有归档凭据');

    const loser = [ra, rb].find((r) => r.status !== 200);
    assert.equal(loser.status, 400);
    assert.equal(loser.body.code, 'already_locked');

    const sum = await summary(apiB, token);
    assert.equal(sum.body.rounds, 1, '只归档一轮');
    assert.equal(sum.body.entries, 2, '明细是两位玩家，没有重复行');
  });

  it('并发开新一轮：只成功一次，轮次不跳号、玩家不被清两次', async () => {
    const [ra, rb] = await Promise.all([
      resetRound(apiA, token, sid),
      resetRound(apiB, token, sid)
    ]);
    const okOnes = [ra, rb].filter((r) => r.status === 200);
    assert.equal(okOnes.length, 1, '只允许开一次新一轮：' + JSON.stringify([ra.body, rb.body]));
    assert.equal(okOnes[0].body.round, 2, '轮次必须是 2，不能被连加');

    const loser = [ra, rb].find((r) => r.status !== 200);
    assert.equal(loser.status, 409);
    assert.equal(loser.body.code, 'round_changed');

    const state = await apiA.get('/api/state?sid=' + sid + '&ut=' + encodeURIComponent(ut));
    assert.equal(state.body.round, 2);
    assert.equal(state.body.players.length, 0, '新一轮必须清空玩家');
  });

  it('场次并发新建：上限是集群口径，第 5 场被任一实例拒绝', async () => {
    // 现在 1 场（main）进行中，再建 3 场正好到上限
    const results = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await apiA.post('/api/session-create', { token, name: 'S' + (i + 2) });
      results.push(r);
    }
    assert.ok(results.every((r) => r.status === 200), '前三场应成功：' + JSON.stringify(results.map((r) => r.body)));

    // 第 5 场：两个实例同时抢，最多只有一个成功（甚至都失败）
    const [ra, rb] = await Promise.all([
      apiA.post('/api/session-create', { token, name: 'S5' }),
      apiB.post('/api/session-create', { token, name: 'S5b' })
    ]);
    const created = [ra, rb].filter((r) => r.status === 200);
    assert.ok(created.length <= 1, '最多只能再建一场');
    const rejected = [ra, rb].filter((r) => r.status === 409);
    assert.ok(rejected.length >= 1, '至少一条必须撞上限：' + JSON.stringify([ra.body, rb.body]));
    if (created.length) assert.equal((await apiB.get('/api/sessions')).body.sessions.filter((s) => s.status !== 'closed').length <= 4, true);
  });

  it('跨实例广播：A 上的写入会推送到 B 的 SSE 连接', async () => {
    const list = await apiA.get('/api/sessions');
    const target = list.body.sessions.find((s) => s.name === 'S2');
    assert.ok(target, '需要 S2 场次');

    const uB = await unlock(apiB, target.id);
    assert.equal(uB.status, 200);

    const sse = openSse(b.base + '/api/stream?sid=' + target.id + '&ut=' + encodeURIComponent(uB.body.ut));
    await sse.ready;
    assert.ok(await sse.waitFor((e) => e.event === 'state'), '首帧必须立即下发全量状态');

    // 写入发生在 A 上，B 的这条连接必须收到（走 PUB/SUB → 重新读库 → 广播）
    assert.equal((await scan(apiA, target.id, uB.body.ut, 'X1')).status, 200);

    const got = await sse.waitFor((e) => e.event === 'state' && e.data && e.data.players.some((p) => p.id === memberRef('X1')));
    assert.ok(got, 'B 的连接没有收到 A 的变更，实际事件：' + sse.events.map((e) => e.event).join(','));

    const last = sse.events.filter((e) => e.event === 'state').pop();
    assert.ok(last.data.version >= 2, '事件 id 用版本号，跨实例连续递增');
    sse.close();
  });

  it('跨实例关闭：A 关闭场次，B 上的连接收到 session_closed 并被断开', async () => {
    const list = await apiA.get('/api/sessions');
    const target = list.body.sessions.find((s) => s.name === 'S3');
    assert.ok(target, '需要 S3 场次');

    const uB = await unlock(apiB, target.id);
    const sse = openSse(b.base + '/api/stream?sid=' + target.id + '&ut=' + encodeURIComponent(uB.body.ut));
    await sse.ready;
    assert.ok(await sse.waitFor((e) => e.event === 'state'));

    const closed = await apiA.post('/api/session-close', { token, sid: target.id });
    assert.equal(closed.status, 200, JSON.stringify(closed.body));

    assert.ok(await sse.waitFor((e) => e.event === 'session_closed'),
      'B 上的玩家端必须收到关闭事件，实际：' + sse.events.map((e) => e.event).join(','));

    // 关闭后再访问必须 409（状态在库里，不是某台实例的内存）
    const after = await apiB.get('/api/state?sid=' + target.id + '&ut=' + encodeURIComponent(uB.body.ut));
    assert.equal(after.status, 409);
    assert.equal(after.body.code, 'session_closed');
    sse.close();
  });

  it('实例重启不掉登录：会话在库里，A 重启后 token 依旧有效', async () => {
    await a.stop();
    a = await startServer({ port: a.port, env: { INSTANCE_ID: 'test-a2' } });
    apiA = makeClient(a.base);

    const check = await apiA.get('/api/staff-check?token=' + encodeURIComponent(token));
    assert.equal(check.status, 200);
    assert.equal(check.body.ok, true, '重启后不能把员工踢回登录页');
    // 归属场次可能因为期间新建/关闭场次被改绑过，只要求仍然指向一个真实场次
    assert.ok(check.body.sid, '必须仍然绑定到某个场次');
    assert.ok(check.body.sessions.some((s) => s.id === check.body.sid), '绑定的场次必须存在');
  });
});
