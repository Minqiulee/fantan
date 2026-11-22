/**
 * 身份档案：本场次跨轮次的累计行为。
 *
 * 身份（identities）与玩家（players）是两个维度，别混：
 *   - players 是「本轮在场的这批人」，开新一轮整体清空；
 *   - identities 是「本场次见过的人」，键是原始 ID（扫码内容），跨轮保留，
 *     记 lastSeenRound（最近出现的轮次）与 completedRounds（完整走完的轮次）。
 * 前端看到的 isVeteran 就是 completedRounds >= 1，「老玩家」不是布尔翻转。
 *
 * 要钉死的几件事：
 *   1. 扫码建档 → 完成轮次 0，不算老玩家；
 *   2. 只有「提交了预测且该轮开奖」才 +1，草稿 / 旁观都不计；
 *   3. 开新一轮清玩家不清档案 → 同一 ID 回来还是老玩家，累计值不清零；
 *   4. 继续参与并开奖 → 累加成 2、3…，不是重置成 1；
 *   5. 身份按场次隔离：同一会员号在另一个场次从 0 开始；
 *   6. 同轮重复扫码幂等：不重复累计、不新建档案。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';

import {
  resetSchema, startServer, makeClient, withDb,
  login, unlock, scan, predict
} from './helpers.mjs';

let server;
let api;
let token;
let sid;   // 主场次：跨轮累计
let ut;
let sidB;  // 另一场次：验证身份隔离
let utB;

/** 直接读库：identity 是唯一权威，接口只暴露由它派生的 isVeteran。 */
async function identityRow(sessionId, id) {
  return withDb(async (c) => {
    const r = await c.query(
      'SELECT last_seen_round, completed_rounds FROM identity WHERE session_id = $1 AND id = $2',
      [sessionId, id]
    );
    if (!r.rows[0]) return null;
    return {
      lastSeenRound: Number(r.rows[0].last_seen_round),
      completedRounds: Number(r.rows[0].completed_rounds)
    };
  });
}

async function identityCount(sessionId, id) {
  return withDb(async (c) => {
    const r = await c.query(
      'SELECT count(*)::int AS n FROM identity WHERE session_id = $1 AND id = $2',
      [sessionId, id]
    );
    return Number(r.rows[0].n);
  });
}

/** 大屏视图：开奖前也带每个人的 isVeteran，且不受玩家视图的字段裁剪影响。 */
function board(sessionId) {
  return api.get('/api/state?sid=' + encodeURIComponent(sessionId)
    + '&token=' + encodeURIComponent(token) + '&view=bigscreen');
}

function veteranOf(res, pid) {
  const p = res.body.players.find((x) => x.id === pid);
  assert.ok(p, '大屏里必须有 ' + pid + '：' + JSON.stringify(res.body.players));
  return p.isVeteran;
}

before(async () => {
  await resetSchema();
  server = await startServer({ env: { INSTANCE_ID: 'i-identity-1' } });
  api = makeClient(server.base);

  const admin = await login(api);
  token = admin.token;
  sid = admin.sid;

  const u = await unlock(api, sid);
  assert.equal(u.status, 200, '主场次口令：' + JSON.stringify(u.body));
  ut = u.body.ut;

  const created = await api.post('/api/session-create', { token, name: '身份隔离场' });
  assert.equal(created.status, 200, '建隔离场次：' + JSON.stringify(created.body));
  sidB = created.body.sid;

  const uB = await unlock(api, sidB);
  assert.equal(uB.status, 200, '隔离场次口令：' + JSON.stringify(uB.body));
  utB = uB.body.ut;
});

after(async () => {
  if (server) await server.stop();
});

describe('身份档案：本场次跨轮累计', () => {
  it('扫码建档：完成轮次 0，不算老玩家', async () => {
    assert.equal((await scan(api, sid, ut, 'V1')).status, 200);
    assert.equal((await scan(api, sid, ut, 'V2')).status, 200);

    assert.deepEqual(await identityRow(sid, 'V1'), { lastSeenRound: 1, completedRounds: 0 });
    assert.deepEqual(await identityRow(sid, 'V2'), { lastSeenRound: 1, completedRounds: 0 });

    const bs = await board(sid);
    assert.equal(veteranOf(bs, 'V1'), false, '刚扫码的人不是老玩家');
    assert.equal(veteranOf(bs, 'V2'), false);
  });

  it('提交并开奖：完成轮次 +1；只放草稿的不算', async () => {
    assert.equal((await predict(api, sid, ut, 'V1', '单', 3)).status, 200);
    // V2 只放草稿不确认：草稿不等于参赛，开奖后必须仍是新人
    const d = await api.put('/api/pick', { sid, ut, pid: 'V2', oddEven: '双', number: 8, seq: 1 });
    assert.equal(d.status, 200, JSON.stringify(d.body));
    assert.equal(d.body.accepted, true);

    const locked = await api.post('/api/confirm', { token, sid, number: 4, ackPending: true });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));
    assert.equal(locked.body.archived, true, '锁定必须同时落归档');

    assert.deepEqual(await identityRow(sid, 'V1'), { lastSeenRound: 1, completedRounds: 1 },
      '提交且已开奖 → 完成轮次 1');
    assert.deepEqual(await identityRow(sid, 'V2'), { lastSeenRound: 1, completedRounds: 0 },
      '草稿不进完成轮次');

    const bs = await board(sid);
    assert.equal(veteranOf(bs, 'V1'), true, '走完一轮就是老玩家');
    assert.equal(veteranOf(bs, 'V2'), false, '只投票没确认的人不算');
  });

  it('开新一轮：玩家清空，身份档案保留', async () => {
    const r = await api.post('/api/reset', { token, sid });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.round, 2);

    const bs = await board(sid);
    assert.equal(bs.body.players.length, 0, '新一轮必须清空玩家');

    assert.deepEqual(await identityRow(sid, 'V1'), { lastSeenRound: 1, completedRounds: 1 },
      '清的是 player 表，identity 不能被连带清掉');
    assert.deepEqual(await identityRow(sid, 'V2'), { lastSeenRound: 1, completedRounds: 0 });
  });

  it('新一轮再扫码：仍是老玩家，累计值不清零', async () => {
    assert.equal((await scan(api, sid, ut, 'V1')).status, 200);
    assert.equal((await scan(api, sid, ut, 'V2')).status, 200);

    // 重新登记 = 本轮出现：lastSeenRound 跟到 2，completedRounds 原样带过来
    assert.deepEqual(await identityRow(sid, 'V1'), { lastSeenRound: 2, completedRounds: 1 });
    assert.deepEqual(await identityRow(sid, 'V2'), { lastSeenRound: 2, completedRounds: 0 });

    const bs = await board(sid);
    assert.equal(bs.body.players.length, 2);
    assert.equal(veteranOf(bs, 'V1'), true, '跨轮的身份不能被新一轮抹掉');
    assert.equal(veteranOf(bs, 'V2'), false, '上一轮没参赛，这一轮仍是新人');
  });

  it('第二轮再开奖：完成轮次累加，不是重置', async () => {
    assert.equal((await predict(api, sid, ut, 'V1', '双', 6)).status, 200);
    assert.equal((await predict(api, sid, ut, 'V2', '双', 6)).status, 200);

    const locked = await api.post('/api/confirm', { token, sid, number: 6 });
    assert.equal(locked.status, 200, JSON.stringify(locked.body));

    assert.deepEqual(await identityRow(sid, 'V1'), { lastSeenRound: 2, completedRounds: 2 },
      '累计轮次要叠加，不能每轮重置成 1');
    assert.deepEqual(await identityRow(sid, 'V2'), { lastSeenRound: 2, completedRounds: 1 },
      'V2 第二次参与才完成 1 轮');

    const bs = await board(sid);
    assert.equal(veteranOf(bs, 'V2'), true, '补上这一轮后才变老玩家');
  });

  it('同轮重复扫码幂等：不重复累计、不新建档案', async () => {
    const before = await identityRow(sid, 'V1');
    assert.equal((await scan(api, sid, ut, 'V1')).status, 200);

    assert.deepEqual(await identityRow(sid, 'V1'), before, '重复扫码不能动完成轮次');
    assert.equal(await identityCount(sid, 'V1'), 1, '主键 (session_id, id) 只能有一行');

    const bs = await board(sid);
    assert.equal(bs.body.players.length, 2, '重复扫码不能凭空多出玩家');
  });

  it('身份按场次隔离：同一会员号在另一场次从 0 开始', async () => {
    assert.equal((await scan(api, sidB, utB, 'V1')).status, 200);

    assert.deepEqual(await identityRow(sidB, 'V1'), { lastSeenRound: 1, completedRounds: 0 },
      '另一个场次里 V1 是新人');
    assert.deepEqual(await identityRow(sid, 'V1'), { lastSeenRound: 2, completedRounds: 2 },
      '本场次的累计不受另一场次影响');

    const bsB = await board(sidB);
    assert.equal(veteranOf(bsB, 'V1'), false, '老玩家是按场次算的，不跨场继承');
  });
});
