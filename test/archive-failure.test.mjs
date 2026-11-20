/**
 * 故障路径回归：归档写不进去时，系统必须「宁可不开新一轮，也不抹掉留痕」。
 *
 * 场景：
 *  1. 把归档表改名模拟数据库瞬时故障 → 锁定仍生效，但如实返回 archived:false；
 *  2. 此时 reset 必须 409 拦住，不能把这一轮明细清掉；
 *  3. 恢复后 archive-sync 幂等补齐；
 *  4. 重启时对「已锁定但未归档」的轮次自动回填。
 *
 * 注意：测试会临时改名/禁用触发器，仅用于制造故障，生产代码没有这些操作。
 */
import test, { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resetSchema, startServer, makeClient, withDb, freePort,
  login, unlock, scan, predict, confirm, resetRound, summary, exportCsv, toTable
} from './helpers.mjs';

const PAUSE_TABLE = 'round_archive_sim_outage';

describe('归档故障与恢复', () => {
  let srv;
  let api;
  let token;
  let sid;
  let ut;

  const boot = async () => {
    srv = await startServer({ port: await freePort() });
    api = makeClient(srv.base);
    const s = await login(api);
    token = s.token;
    sid = s.sid;
    const u = await unlock(api, sid);
    assert.equal(u.status, 200);
    ut = u.body.ut;
  };

  before(async () => {
    await resetSchema();
    await boot();
  });

  after(async () => {
    if (srv) await srv.stop();
    // 万一断言中途失败，别把改名状态留在库里
    await withDb(async (c) => {
      const r = await c.query("SELECT to_regclass($1) AS t", [PAUSE_TABLE]);
      if (r.rows[0].t) await c.query(`ALTER TABLE ${PAUSE_TABLE} RENAME TO round_archive`);
    });
  });

  it('归档表不可写时：锁定生效但如实告知未归档', async () => {
    assert.equal((await scan(api, sid, ut, 'M9')).status, 200);
    assert.equal((await predict(api, sid, ut, 'M9', '单', 3)).status, 200);

    await withDb((c) => c.query(`ALTER TABLE round_archive RENAME TO ${PAUSE_TABLE}`));

    const locked = await confirm(api, token, sid, 3);
    assert.equal(locked.status, 200, '不能因为写库失败就报错诱导员工重按');
    assert.equal(locked.body.ok, true);
    assert.equal(locked.body.number, 3);
    assert.equal(locked.body.archived, false);
    assert.equal(locked.body.warning, 'archive_write_failed');

    // 锁定在内存与广播里已生效
    const state = await api.get('/api/state?sid=' + sid + '&ut=' + encodeURIComponent(ut));
    assert.equal(state.body.locked, true);
    assert.equal(state.body.number, 3);
  });

  it('归档未落定前，reset 被 409 拦住', async () => {
    const blocked = await resetRound(api, token, sid);
    assert.equal(blocked.status, 409);
    assert.equal(blocked.body.code, 'archive_write_failed');

    const state = await api.get('/api/state?sid=' + sid + '&ut=' + encodeURIComponent(ut));
    assert.equal(state.body.locked, true, '拦住之后本轮必须还在');
    assert.equal(state.body.players.length, 1);
  });

  it('恢复后 archive-sync 补齐，且不重复', async () => {
    await withDb((c) => c.query(`ALTER TABLE ${PAUSE_TABLE} RENAME TO round_archive`));

    const sync = await api.post('/api/archive-sync', { token });
    assert.equal(sync.status, 200);
    assert.equal(sync.body.ok, true);
    assert.equal(sync.body.checked, 1);
    assert.equal(sync.body.failed.length, 0);

    const s = await summary(api, token);
    assert.equal(s.body.rounds, 1, '补回一轮');
    assert.equal(s.body.entries, 1);
    assert.equal(s.body.members, 1);

    const again = await api.post('/api/archive-sync', { token });
    assert.equal(again.body.ok, true);
    const s2 = await summary(api, token);
    assert.equal(s2.body.rounds, 1, '幂等：不能补出第二份');
  });

  it('补齐后 reset 放行，新一轮正常开工', async () => {
    const r = await resetRound(api, token, sid);
    assert.equal(r.status, 200);
    assert.equal(r.body.round, 2);

    assert.equal((await scan(api, sid, ut, 'M9')).status, 200);
    assert.equal((await predict(api, sid, ut, 'M9', '单', 5)).status, 200);
    const locked = await confirm(api, token, sid, 5);
    assert.equal(locked.status, 200);
    assert.equal(locked.body.archived, true);

    const s = await summary(api, token);
    assert.equal(s.body.rounds, 2);
    assert.equal(s.body.entries, 2);
  });

  it('重启时对「已锁定但未归档」的轮次自动回填', async () => {
    // 制造故障现场：绕过触发器删掉第 2 轮的归档，模拟锁定时归档写失败后进程重启
    await withDb(async (c) => {
      await c.query('ALTER TABLE round_archive_entry DISABLE TRIGGER USER');
      await c.query('ALTER TABLE round_archive DISABLE TRIGGER USER');
      await c.query(
        'DELETE FROM round_archive_entry WHERE archive_id IN (SELECT archive_id FROM round_archive WHERE session_id = $1 AND round = 2)',
        [sid]
      );
      await c.query('DELETE FROM round_archive WHERE session_id = $1 AND round = 2', [sid]);
      await c.query('ALTER TABLE round_archive_entry ENABLE TRIGGER USER');
      await c.query('ALTER TABLE round_archive ENABLE TRIGGER USER');
    });

    const beforeRestart = await summary(api, token);
    assert.equal(beforeRestart.body.rounds, 1, '先确认已少一轮');

    await srv.stop();
    await boot();

    const s = await summary(api, token);
    assert.equal(s.body.rounds, 2, '启动回填必须把锁定轮次补回归档');
    assert.equal(s.body.entries, 2);

    const sync = await api.post('/api/archive-sync', { token });
    assert.equal(sync.body.ok, true);
    const s2 = await summary(api, token);
    assert.equal(s2.body.rounds, 2, '回填后再补也不能重复');

    const rounds = toTable((await exportCsv(api, token, { level: 'round' })).text);
    assert.equal(rounds.rows.length, 2);
    assert.deepEqual(rounds.records.map((x) => x['轮次号']).sort(), ['1', '2']);
  });
});
