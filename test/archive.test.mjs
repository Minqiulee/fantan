/**
 * 主流程回归：锁定即归档 → 当日聚合 → 三种 CSV → reset 不动归档 → 跨场次分账。
 *
 * 这些断言是「对账契约」的可执行版本：
 *  - 列头顺序即契约，改动 CSV_*_HEADER 会在这里直接失败；
 *  - 聚合口径以 locked_at 为准，reset 之后数字只能增不能减；
 *  - 分场次聚合不能因为 join 明细而把轮次数放大。
 *
 * 用 `npm test`（或 node test/run.mjs）运行。测试按顺序推进同一场次，勿单独跳跑中间用例。
 */
import test, { before, after, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resetSchema, startServer, makeClient, withDb, freePort,
  login, unlock, scan, predict, confirm, resetRound, summary, exportCsv,
  toTable, rowOf
} from './helpers.mjs';

const CSV_DETAIL_HEADER = [
  '场次ID', '场次名称', '场次序号', '轮次号', '开奖数字', '开奖单双',
  '锁定时间', '归档时间', '会员号', '预测单双', '预测数字', '是否提交',
  '单双命中', '数字命中', '登记时间', '提交时间'
];
const CSV_ROUND_HEADER = [
  '场次ID', '场次名称', '场次序号', '轮次号', '开奖数字', '开奖单双',
  '锁定时间', '归档时间', '扫码人数', '提交人数'
];

describe('竞猜归档与对账', () => {
  let srv;
  let api;
  let token;
  let sidA;
  let utA;
  let sidB;

  before(async () => {
    await resetSchema();
    srv = await startServer({ port: await freePort() });
    api = makeClient(srv.base);
  });

  after(async () => {
    if (srv) await srv.stop();
  });

  it('员工登录后绑定默认场次，未登录看不到员工视角列表', async () => {
    const anon = await api.get('/api/sessions');
    assert.equal(anon.status, 200);
    assert.equal(anon.body.ok, true);
    assert.equal(anon.body.sessions.length, 1, '全新库只有默认场次');
    assert.equal(anon.body.needPassword, false, '单场不需要口令');

    const s = await login(api);
    token = s.token;
    sidA = s.sid;
    assert.match(token, /\S+/);
    assert.ok(sidA, '登录应返回默认场次 id');

    const bad = await api.post('/api/staff-login', { password: 'definitely-wrong' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.code, 'wrong_password');
  });

  it('玩家场次口令：错口令 401，正确口令换到绑定令牌', async () => {
    const wrong = await unlock(api, sidA, 'not-the-password');
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.code, 'player_wrong_password');

    const okUnlock = await unlock(api, sidA);
    assert.equal(okUnlock.status, 200);
    assert.equal(okUnlock.body.ok, true);
    assert.equal(okUnlock.body.sid, sidA);
    assert.ok(okUnlock.body.ut, '应返回绑定令牌 ut');
    utA = okUnlock.body.ut;
  });

  it('扫码建档幂等，含带逗号的会员号', async () => {
    for (const code of ['M001', 'M002', 'M,003']) {
      const r = await scan(api, sidA, utA, code);
      assert.equal(r.status, 200, '扫码失败：' + JSON.stringify(r.body));
      assert.equal(r.body.pid, code);
    }
    const again = await scan(api, sidA, utA, 'M001');
    assert.equal(again.status, 200);
    assert.equal(again.body.pid, 'M001', '重复扫码必须回到同一玩家');

    const state = await api.get('/api/state?sid=' + sidA + '&ut=' + encodeURIComponent(utA));
    assert.equal(state.status, 200);
    assert.equal(state.body.players.length, 3, '三人且无重复');
    assert.equal(state.body.locked, false);
  });

  it('提交预测：非法入参与重复提交都被拒', async () => {
    assert.equal((await predict(api, sidA, utA, 'M001', '单', 3)).status, 200);
    assert.equal((await predict(api, sidA, utA, 'M002', '双', 5)).status, 200);

    const dup = await predict(api, sidA, utA, 'M001', '双', 4);
    assert.equal(dup.status, 400);
    assert.equal(dup.body.code, 'predict_duplicate');

    const noScan = await predict(api, sidA, utA, 'M404', '单', 1);
    assert.equal(noScan.status, 400);
    assert.equal(noScan.body.code, 'predict_not_scanned');

    const badOe = await predict(api, sidA, utA, 'M,003', '大', 1);
    assert.equal(badOe.status, 400);
    assert.equal(badOe.body.code, 'predict_invalid_oe');

    const badNum = await predict(api, sidA, utA, 'M,003', '单', 9);
    assert.equal(badNum.status, 400);
    assert.equal(badNum.body.code, 'predict_invalid');
  });

  it('锁定：数字校验、重复锁定、锁定后禁止入场与改预测', async () => {
    const bad = await confirm(api, token, sidA, 9);
    assert.equal(bad.status, 400);
    assert.equal(bad.body.code, 'invalid_number');

    const locked = await confirm(api, token, sidA, 4);
    assert.equal(locked.status, 200);
    assert.equal(locked.body.archived, true, '锁定必须与归档同事务成功');

    const dup = await confirm(api, token, sidA, 4);
    assert.equal(dup.status, 400);
    assert.equal(dup.body.code, 'already_locked');

    const lateScan = await scan(api, sidA, utA, 'M004');
    assert.equal(lateScan.status, 400);
    assert.equal(lateScan.body.code, 'scan_locked');

    const latePredict = await predict(api, sidA, utA, 'M,003', '单', 3);
    assert.equal(latePredict.status, 400);
    assert.equal(latePredict.body.code, 'predict_closed');
  });

  it('当日聚合按 locked_at 计数，按会员号去重', async () => {
    const r = await summary(api, token);
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.equal(r.body.rounds, 1);
    assert.equal(r.body.sessions, 1);
    assert.equal(r.body.entries, 3, '扫码 3 人');
    assert.equal(r.body.submitted, 2, '提交 2 人');
    assert.equal(r.body.members, 3, '按会员号去重');
    assert.equal(r.body.predictedMembers, 2);
    // 聚合里不出现任何「命中总数 / 积分」口径：匹配情况只保留在逐条明细里
    assert.equal(r.body.oddEvenHits, undefined, '不汇总命中数');
    assert.equal(r.body.numberHits, undefined, '不汇总命中数');

    assert.equal(r.body.bySession.length, 1);
    const one = r.body.bySession[0];
    assert.equal(one.sessionId, sidA);
    assert.equal(one.rounds, 1);
    assert.equal(one.entries, 3);
    assert.equal(one.members, 3, '分场次人数不能被明细行放大');
    assert.equal(one.rounds, 1, '轮次数不能被 join 放大');
  });

  it('明细 CSV：列头稳定、逐人命中正确、含逗号的会员号被转义', async () => {
    const r = await exportCsv(api, token, { level: 'detail' });
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /text\/csv/);
    assert.match(r.headers.get('content-disposition'), /attachment/);
    assert.ok(r.text.startsWith('\ufeff'), '必须带 UTF-8 BOM，Excel 才不乱码');
    assert.ok(r.text.includes('\r\n'), '必须用 CRLF');

    const table = toTable(r.text);
    assert.deepEqual(table.header, CSV_DETAIL_HEADER, '列头顺序即契约');
    assert.equal(table.rows.length, 3);
    assert.ok(r.text.includes('"M,003"'), '含逗号的会员号必须加引号');

    const m1 = rowOf(table, 'M001');
    assert.equal(m1['开奖数字'], '4');
    assert.equal(m1['开奖单双'], '双');
    assert.equal(m1['预测单双'], '单');
    assert.equal(m1['是否提交'], '是');
    assert.equal(m1['单双命中'], '未中');
    assert.equal(m1['数字命中'], '未中');

    const m2 = rowOf(table, 'M002');
    assert.equal(m2['单双命中'], '命中', 'M002 猜双，开奖 4');
    assert.equal(m2['数字命中'], '未中');

    const m3 = rowOf(table, 'M,003');
    assert.equal(m3['是否提交'], '否');
    assert.equal(m3['预测单双'], '');
    assert.equal(m3['单双命中'], '未提交');
    assert.equal(m3['数字命中'], '未提交');
  });

  it('只有逐人逐轮明细与轮次核对两种口径，会员汇总口径已移除', async () => {
    const legacy = await exportCsv(api, token, { level: 'member' });
    assert.equal(legacy.status, 400);
    assert.equal(legacy.body.code, 'bad_level');
    assert.deepEqual(legacy.body.levels, ['detail', 'round'], '只保留不聚合的口径');

    for (const level of ['detail', 'round']) {
      const t = toTable((await exportCsv(api, token, { level })).text);
      const joined = t.header.join(',');
      assert.ok(!/积分|总分|得分|命中率/.test(joined), level + ' 不能出现积分/汇总列');
    }
  });

  it('轮次 CSV：一轮一行，含扫码/提交人数', async () => {
    const r = await exportCsv(api, token, { level: 'round' });
    const table = toTable(r.text);
    assert.deepEqual(table.header, CSV_ROUND_HEADER);
    assert.equal(table.rows.length, 1);
    const row = table.records[0];
    assert.equal(row['场次ID'], sidA);
    assert.equal(row['轮次号'], '1');
    assert.equal(row['开奖数字'], '4');
    assert.equal(row['扫码人数'], '3');
    assert.equal(row['提交人数'], '2');
    assert.match(row['锁定时间'], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  });

  it('archive-sync 幂等：重复补齐不产生第二份归档', async () => {
    const s = await api.post('/api/archive-sync', { token });
    assert.equal(s.status, 200);
    assert.equal(s.body.ok, true);
    assert.equal(s.body.checked, 1, '当前只有 1 个已锁定场次');
    assert.equal(s.body.rounds.length, 1);

    const afterSync = await summary(api, token);
    assert.equal(afterSync.body.rounds, 1);
    assert.equal(afterSync.body.entries, 3);

    const det = toTable((await exportCsv(api, token, { level: 'detail' })).text);
    assert.equal(det.rows.length, 3, '明细不能重复');
  });

  it('reset 只清运行态，归档不受影响', async () => {
    const r = await resetRound(api, token, sidA);
    assert.equal(r.status, 200);
    assert.equal(r.body.round, 2);

    const state = await api.get('/api/state?sid=' + sidA + '&ut=' + encodeURIComponent(utA));
    assert.equal(state.body.players.length, 0, '新一轮玩家清空');
    assert.equal(state.body.locked, false);

    const s = await summary(api, token);
    assert.equal(s.body.rounds, 1, '归档不随 reset 清空');
    assert.equal(s.body.members, 3);
  });

  it('0 人轮次：进轮次口径，不进明细口径', async () => {
    const locked = await confirm(api, token, sidA, 7);
    assert.equal(locked.status, 200);
    assert.equal(locked.body.archived, true);

    const s = await summary(api, token);
    assert.equal(s.body.rounds, 2);
    assert.equal(s.body.entries, 3, 'entries 只数真实登记录');
    assert.equal(s.body.members, 3);

    const rounds = toTable((await exportCsv(api, token, { level: 'round' })).text);
    assert.equal(rounds.rows.length, 2);
    const empty = rounds.records.find((x) => x['轮次号'] === '2');
    assert.equal(empty['扫码人数'], '0');
    assert.equal(empty['开奖数字'], '7');

    const detail = toTable((await exportCsv(api, token, { level: 'detail' })).text);
    assert.equal(detail.rows.length, 3, '0 人轮次没有明细行');
  });

  it('跨场次分账：同号在不同场次独立参与，汇总去重', async () => {
    const created = await api.post('/api/session-create', { token, name: 'B 场' });
    assert.equal(created.status, 200);
    sidB = created.body.sid;
    assert.notEqual(sidB, sidA);

    const u = await unlock(api, sidB);
    assert.equal(u.status, 200);
    const utB = u.body.ut;

    assert.equal((await scan(api, sidB, utB, 'M001')).status, 200);
    assert.equal((await predict(api, sidB, utB, 'M001', '双', 2)).status, 200);
    const locked = await confirm(api, token, sidB, 2);
    assert.equal(locked.status, 200);

    const s = await summary(api, token);
    assert.equal(s.body.sessions, 2, '两个场次都有归档轮次');
    assert.equal(s.body.rounds, 3);
    assert.equal(s.body.members, 3, 'M001 跨场只算一个人');
    assert.equal(s.body.entries, 4);
    assert.equal(s.body.bySession.length, 2);
    const bySid = Object.fromEntries(s.body.bySession.map((x) => [x.sessionId, x]));
    assert.equal(bySid[sidB].rounds, 1);
    assert.equal(bySid[sidB].members, 1);
    assert.equal(bySid[sidA].rounds, 2);

    // 按场次筛选导出：只应看到 B 场那一行
    const onlyB = toTable((await exportCsv(api, token, { level: 'detail', query: '&sid=' + sidB })).text);
    assert.equal(onlyB.rows.length, 1);
    assert.equal(onlyB.records[0]['场次ID'], sidB);

    // 跨场导出：同一会员号在 A、B 两场各一行，逐行给出猜测与实际结果，不做合并
    const all = toTable((await exportCsv(api, token, { level: 'detail' })).text);
    const m1Rows = all.records.filter((x) => x['会员号'] === 'M001');
    assert.equal(m1Rows.length, 2, '两个场次各一行，不合并成一行');
    assert.deepEqual(m1Rows.map((x) => x['场次ID']), [sidA, sidB], '按会员聚合展示时同一人的记录连续且按时间排列');
    assert.deepEqual(m1Rows.map((x) => x['开奖数字']), ['4', '2']);
    assert.deepEqual(m1Rows.map((x) => x['单双命中']), ['未中', '命中']);
    assert.deepEqual(m1Rows.map((x) => x['数字命中']), ['未中', '命中']);
    assert.equal(m1Rows[1]['预测单双'], '双');
    assert.equal(m1Rows[1]['预测数字'], '2');
  });

  it('日期与区间筛选：非法日期返回 400，空区间导出只有表头', async () => {
    const empty = await summary(api, token, '&date=2000-01-01');
    assert.equal(empty.status, 200);
    assert.equal(empty.body.rounds, 0);
    assert.equal(empty.body.members, 0);

    const emptyCsv = toTable((await exportCsv(api, token, { query: '&date=2000-01-01' })).text);
    assert.deepEqual(emptyCsv.header, CSV_DETAIL_HEADER);
    assert.equal(emptyCsv.rows.length, 0);

    assert.equal((await summary(api, token, '&date=2026-02-31')).status, 400);
    assert.equal((await summary(api, token, '&from=2026-03-02&to=2026-03-01')).status, 400);
    assert.equal((await exportCsv(api, token, { level: 'nope' })).status, 400);

    const range = await summary(api, token, '&from=2000-01-01&to=2999-12-31');
    assert.equal(range.status, 200);
    assert.equal(range.body.rounds, 3, '闭区间跨年应覆盖今天全部归档');
  });

  it('归档接口必须带员工 token', async () => {
    const s = await api.get('/api/archive/summary');
    assert.equal(s.status, 401);
    const c = await api.get('/api/archive/export.csv?level=detail');
    assert.equal(c.status, 401);
  });

  it('append-only：UPDATE / DELETE / TRUNCATE 全部被数据库拒绝', async () => {
    const rejected = async (sql, label) => {
      await assert.rejects(
        () => withDb((c) => c.query(sql)),
        /append-only/,
        label + ' 必须被触发器拒绝'
      );
    };

    await rejected('UPDATE round_archive SET number = 1', 'UPDATE 归档表头');
    await rejected("UPDATE round_archive_entry SET odd_even = '单'", 'UPDATE 归档明细');
    await rejected('DELETE FROM round_archive_entry', 'DELETE 归档明细');
    await rejected('DELETE FROM round_archive', 'DELETE 归档表头');
    await rejected('TRUNCATE round_archive_entry', 'TRUNCATE 归档明细');
    await rejected('TRUNCATE round_archive CASCADE', 'TRUNCATE 归档表头');

    // 数据没被改动
    const still = await summary(api, token);
    assert.equal(still.body.rounds, 3);
    assert.equal(still.body.entries, 4);
  });
});
