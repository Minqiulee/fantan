/**
 * 规则版本（奖品四档 + 特殊数字）—— 落库、版本边界、对账可追溯。
 *
 * 要钉死的几件事：
 *   1. 规则按**整体快照**存版本（rule_version，append-only）：一次保存 = 一版，
 *      内容没变不新增版本；历史版本不可改写（UPDATE / DELETE / TRUNCATE 被触发器拒绝）；
 *   2. 场次在**创建时锁定**版本（game_session.rule_version）：改规则不影响进行中的场次，
 *      且同一场次跨轮次始终用同一版（不是每轮重读最新版）；
 *   3. 对账归档记下每轮所用版本（round_archive.rule_version → CSV「规则版本」列），
 *      事后能回答「这一轮按哪一版规则发的奖」；
 *   4. 升级路径：老的 app_config 配置（就地覆盖、无历史）在首次启动时落成 v1，
 *      历史场次挂到 v1 —— 不假装知道更早的历史，也不丢现有配置。
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, makeClient, login, unlock, scan, predict, confirm, resetRound,
  exportCsv, toTable, withDb, resetSchema, PLAYER_PASSWORD
} from './helpers.mjs';

let server;
let api;
let adminToken;
let sid;
let ut;

/* 版本化之前的旧配置：文案是**单语字符串**。升级时不做数据迁移，
 * 读取时归一化成「简体中文有值、其余语言留空」，展示端按语言回退 —— 玩家看到的还是这句。
 * 所以下面断言的是归一化之后的形态，而不是库里那份原始 JSON。 */
const OLD_PRIZES = {
  both: { title: '旧 · 都中', desc: '' },
  number: { title: '旧 · 只中数字', desc: '' },
  oddeven: { title: '旧 · 只中单双', desc: '' },
  miss: { title: '旧 · 都没中', desc: '' }
};
const OLD_BONUS = { number: 4, title: '旧 · 四号加奖', desc: '' };

/** 三语字段：只有简体有值（旧单语数据归一化后的样子） */
function legacyText(v) {
  return { 'zh-CN': v, 'zh-HK': '', 'en-US': '' };
}
function legacyTier(v) {
  return { title: legacyText(v.title), desc: legacyText(v.desc) };
}
function legacyPrizes(prizes) {
  const out = {};
  for (const tier of Object.keys(prizes)) out[tier] = legacyTier(prizes[tier]);
  return out;
}

/** 空的三语字段 / 空档位 */
function noText() {
  return { 'zh-CN': '', 'zh-HK': '', 'en-US': '' };
}
function emptyTier() {
  return { title: noText(), desc: noText() };
}
/** 一档三语文案（说明默认整档留空） */
function tier(zh, hant, en) {
  return { title: { 'zh-CN': zh, 'zh-HK': hant, 'en-US': en }, desc: noText() };
}

/** 昨天：给「历史场次」之类的时间断言留位置（当前用例只用今天，这里保持简单）。 */
function playerState(s = sid, token = ut) {
  return api.get('/api/state?sid=' + encodeURIComponent(s) + '&ut=' + encodeURIComponent(token));
}

after(async () => {
  if (server) await server.stop();
});

test('升级路径：老的 app_config 配置落成 v1，历史场次挂到 v1', async () => {
  await resetSchema();

  // 造一个「版本化之前」的库：只有 app_config，里面是最后一份配置
  await withDb(async (c) => {
    await c.query(`
      CREATE TABLE app_config (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at BIGINT NOT NULL
      );
    `);
    const now = Date.now();
    await c.query('INSERT INTO app_config (key, value, updated_at) VALUES ($1,$2,$3)', [
      'prize_config', JSON.stringify(OLD_PRIZES), now
    ]);
    await c.query('INSERT INTO app_config (key, value, updated_at) VALUES ($1,$2,$3)', [
      'bonus_prize', JSON.stringify(OLD_BONUS), now
    ]);
  });

  server = await startServer();
  api = makeClient(server.base);
  const admin = await login(api);
  adminToken = admin.token;
  sid = admin.sid;
  const un = await unlock(api, sid, PLAYER_PASSWORD);
  assert.equal(un.body.ok, true, '玩家端解锁失败：' + JSON.stringify(un.body));
  ut = un.body.ut;

  // 旧配置没有被丢掉，而是变成了 v1
  const p = await api.get('/api/prize-config?token=' + encodeURIComponent(adminToken));
  assert.equal(p.status, 200);
  assert.equal(p.body.ruleVersion, 1, '首次升级落成 v1');
  assert.deepEqual(p.body.prizes, legacyPrizes(OLD_PRIZES), '旧单语文案落位到简体中文');

  const b = await api.get('/api/bonus-prize?token=' + encodeURIComponent(adminToken));
  assert.equal(b.body.ruleVersion, 1);
  assert.equal(b.body.bonus.number, OLD_BONUS.number, '特殊数字原样保留');
  assert.deepEqual(b.body.bonus.title, legacyText(OLD_BONUS.title));
  assert.deepEqual(b.body.bonus.desc, legacyText(OLD_BONUS.desc));

  // 启动时建出来的第一个场次，以及它读到的规则，都是 v1
  const rows = await withDb(async (c) => {
    const r = await c.query('SELECT session_id, rule_version FROM game_session');
    return r.rows;
  });
  assert.deepEqual(rows.map((x) => x.rule_version), [1], '历史场次挂到 v1');

  const s = await playerState();
  assert.equal(s.body.ruleVersion, 1);
  assert.deepEqual(s.body.prizes, legacyPrizes(OLD_PRIZES));
  assert.equal(s.body.bonus.number, 4);
});

test('保存 = 新增版本：旧版本原样保留，且不可被改写', async () => {
  const v1 = await api.get('/api/prize-config?token=' + encodeURIComponent(adminToken));

  const nextPrizes = {
    both: tier('新 · 都中', '新 · 都中', 'New · both'),
    number: tier('新 · 只中数字', '新 · 只中數字', 'New · number'),
    oddeven: tier('新 · 只中单双', '新 · 只中單雙', 'New · odd/even'),
    miss: tier('新 · 都没中', '新 · 都沒中', 'New · miss')
  };
  const saved = await api.post('/api/prize-config', { token: adminToken, prizes: nextPrizes });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.created, true);
  assert.equal(saved.body.ruleVersion, v1.body.ruleVersion + 1);

  // 库里两行：v1 仍是最初那份（append-only，不是就地覆盖）
  const versions = await withDb(async (c) => {
    const r = await c.query('SELECT version, prizes FROM rule_version ORDER BY version ASC');
    return r.rows;
  });
  assert.equal(versions.length, 2, 'v1 + 新的一版');
  assert.deepEqual(versions[0].prizes, v1.body.prizes, 'v1 原样保留');

  // 历史版本不可改写：DB 层直接挡掉
  for (const sql of [
    "UPDATE rule_version SET prizes = '{}'::jsonb WHERE version = 1",
    'DELETE FROM rule_version WHERE version = 1',
    'TRUNCATE rule_version'
  ]) {
    await assert.rejects(
      () => withDb((c) => c.query(sql)),
      /append-only/,
      sql + ' 应被触发器拒绝'
    );
  }

  // 内容一样再保存一次：不新增版本
  const same = await api.post('/api/prize-config', { token: adminToken, prizes: nextPrizes });
  assert.equal(same.body.created, false);
  assert.equal(same.body.ruleVersion, saved.body.ruleVersion);
});

test('四档与特殊数字是同一套规则：改一块不会清空另一块', async () => {
  const b1 = await api.post('/api/bonus-prize', {
    // 只开特殊数字、不写文案：合法（玩家端用内置文案）
    token: adminToken, bonus: { number: 6 }
  });
  assert.equal(b1.status, 200);
  assert.equal(b1.body.bonus.number, 6);

  const p = await api.get('/api/prize-config?token=' + encodeURIComponent(adminToken));
  const saved = await api.post('/api/prize-config', {
    token: adminToken,
    prizes: { ...p.body.prizes, both: tier('再改一次', '再改一次', 'Changed again') }
  });
  assert.equal(saved.body.ruleVersion, b1.body.ruleVersion + 1);

  // 改四档没有把特殊数字清掉
  const b2 = await api.get('/api/bonus-prize?token=' + encodeURIComponent(adminToken));
  assert.equal(b2.body.bonus.number, 6, '特殊数字应沿用上一版');
  assert.equal(b2.body.ruleVersion, saved.body.ruleVersion);

  // 反向同理：改特殊数字没有把四档清掉
  const b3 = await api.post('/api/bonus-prize', { token: adminToken, bonus: { number: null } });
  const p3 = await api.get('/api/prize-config?token=' + encodeURIComponent(adminToken));
  assert.equal(b3.body.ruleVersion, saved.body.ruleVersion + 1);
  assert.equal(p3.body.prizes.both.title['zh-CN'], '再改一次', '四档文案应沿用上一版');
  assert.equal(p3.body.prizes.both.title['en-US'], 'Changed again');
});

test('对账 CSV 的「规则版本」列记录每轮所用的版本（跨场次、跨轮次都不串）', async () => {
  // 当前场次（main）锁的是 v1；连开两轮都应该是 v1
  const sc = await scan(api, sid, ut, 'RULE-A');
  assert.equal(sc.body.ok, true, '登记失败：' + JSON.stringify(sc.body));
  await predict(api, sid, ut, sc.body.pid || 'RULE-A', '单', 5);

  const c1 = await confirm(api, adminToken, sid, 5);
  assert.equal(c1.status, 200, '锁定失败：' + JSON.stringify(c1.body));
  assert.equal(c1.body.bonusTriggered, false, 'v1 的特殊数字是 4，开 5 不该触发');

  const rs = await resetRound(api, adminToken, sid);
  assert.equal(rs.status, 200);
  const c2 = await confirm(api, adminToken, sid, 4);
  assert.equal(c2.status, 200);
  assert.equal(c2.body.bonusTriggered, true, 'v1 的特殊数字 4 命中，按锁定的 v1 判定');

  // 新建场次：锁定当前最新版
  const latest = await api.get('/api/bonus-prize?token=' + encodeURIComponent(adminToken));
  const created = await api.post('/api/session-create', { token: adminToken, name: '新版场次' });
  assert.equal(created.status, 200, '建场失败：' + JSON.stringify(created.body));
  const sidNew = created.body.sid;
  assert.equal(created.body.session.ruleVersion, latest.body.ruleVersion, '新场次锁定最新版');

  const utNew = (await unlock(api, sidNew, PLAYER_PASSWORD)).body.ut;
  const scNew = await scan(api, sidNew, utNew, 'RULE-B');
  assert.equal(scNew.body.ok, true, '登记失败：' + JSON.stringify(scNew.body));
  await predict(api, sidNew, utNew, scNew.body.pid || 'RULE-B', '双', 2);
  const c3 = await confirm(api, adminToken, sidNew, 2);
  assert.equal(c3.status, 200, '锁定失败：' + JSON.stringify(c3.body));

  // 轮次口径：每轮一行，规则版本逐行可辨
  const roundTable = toTable((await exportCsv(api, adminToken, { level: 'round' })).text);
  const bySession = new Map();
  for (const r of roundTable.records) {
    if (!bySession.has(r['场次ID'])) bySession.set(r['场次ID'], []);
    bySession.get(r['场次ID']).push(r['规则版本']);
  }
  assert.deepEqual(bySession.get(sid), ['1', '1'], 'main 的两轮都用 v1');
  assert.deepEqual(bySession.get(sidNew), [String(latest.body.ruleVersion)], '新场次用它自己锁定的版本');

  // 明细口径同一列也要有值，且与轮次一致
  const detailTable = toTable((await exportCsv(api, adminToken, { level: 'detail' })).text);
  const aRow = detailTable.records.find((r) => r['会员号'] === 'RULE-A');
  assert.ok(aRow, '找不到 RULE-A 的明细行');
  assert.equal(aRow['规则版本'], '1');
  const bRow = detailTable.records.find((r) => r['会员号'] === 'RULE-B');
  assert.ok(bRow, '找不到 RULE-B 的明细行');
  assert.equal(bRow['规则版本'], String(latest.body.ruleVersion));

  // 归档行也落了版本（对账 CSV 只是它的一种展示，库里同样可查）
  const archived = await withDb(async (c) => {
    const r = await c.query(
      'SELECT session_id, round, rule_version FROM round_archive ORDER BY session_id, round'
    );
    return r.rows;
  });
  assert.equal(archived.length, 3, '两轮 + 一轮');
  assert.ok(archived.every((x) => x.rule_version != null), '新归档必须带规则版本');
});

test('规则直查库：另一台实例写入的新版本（没有任何通知）本实例立刻可见', async () => {
  // 绕开接口直接写库 = 模拟「另一台实例保存了规则，但 PUB/SUB 通知没到」。
  // 规则若走进程内缓存，这里会读到旧的一版；直查库则必须立刻是新版。
  const manualPrizes = {
    both: tier('外部实例 · 都中', '外部實例 · 都中', 'Other instance · both'),
    number: tier('外部实例 · 只中数字', '外部實例 · 只中數字', 'Other instance · number'),
    oddeven: tier('外部实例 · 只中单双', '外部實例 · 只中單雙', 'Other instance · odd/even'),
    miss: tier('外部实例 · 都没中', '外部實例 · 都沒中', 'Other instance · miss')
  };
  const manualBonus = {
    number: 3,
    title: { 'zh-CN': '外部实例 · 三号加奖', 'zh-HK': '外部實例 · 三號加獎', 'en-US': 'Other instance · lucky three' },
    desc: noText()
  };
  await withDb(async (c) => {
    const cur = await c.query('SELECT max(version)::int AS v FROM rule_version');
    await c.query(
      `INSERT INTO rule_version (version, prizes, bonus, config_hash, source, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'manual', 'other-instance', $5)`,
      [cur.rows[0].v + 1, JSON.stringify(manualPrizes), JSON.stringify(manualBonus), 'manual-' + Date.now(), Date.now()]
    );
  });

  // 管理端读配置：直查库 → 立刻是新版
  const g = await api.get('/api/prize-config?token=' + encodeURIComponent(adminToken));
  const b = await api.get('/api/bonus-prize?token=' + encodeURIComponent(adminToken));
  assert.deepEqual(g.body.prizes, manualPrizes, '配置读取不能命中旧缓存');
  assert.equal(b.body.bonus.number, 3);
  assert.equal(g.body.ruleVersion, b.body.ruleVersion);

  // 新建场次：锁定的就是这一版，玩家端读到的也是它（快照 SQL 里 JOIN 出来的规则）
  const created = await api.post('/api/session-create', { token: adminToken, name: '直查验证' });
  assert.equal(created.body.ok, true, '建场失败：' + JSON.stringify(created.body));
  const sidNew = created.body.sid;
  assert.equal(created.body.session.ruleVersion, g.body.ruleVersion);

  const utNew = (await unlock(api, sidNew, PLAYER_PASSWORD)).body.ut;
  const s = await api.get('/api/state?sid=' + encodeURIComponent(sidNew) + '&ut=' + encodeURIComponent(utNew));
  assert.equal(s.body.ruleVersion, g.body.ruleVersion);
  assert.deepEqual(s.body.prizes, manualPrizes);
  assert.equal(s.body.bonus.number, 3);
});
