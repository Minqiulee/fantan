/**
 * 奖品配置：四档文案的读写契约 / 三语完整性 / 权限 / 归一化 / 玩家端可见性 / 审计留痕。
 *
 * 要钉死的几件事：
 *   1. 配置只有 admin 能读能写（staff 账号不行），读的是「最新一版」规则；
 *   2. **一次保存 = 一个新规则版本**；当前场次锁的是开场时的版本，玩家端一个字都不变，
 *      只有保存之后新建的场次才用新文案（这是规则版本化的核心语义）；
 *   3. 每档的 title / desc 都是三语对象（zh-CN / zh-HK / en-US）：
 *      **保存时必须三语齐全**，缺语言直接 400 且不落库 —— 否则玩家端只能拿别的语言的文案顶着；
 *      整档六格全空仍然合法（玩家端用内置文案）；
 *   4. 只认四档 × title/desc，未知档位、多余字段一律丢弃，超长按上限逐语言截断；
 *   5. 旧的单语数据（字符串）不迁移、不改写：读取时落到简体中文，其余语言由展示端回退；
 *   6. 每次保存写一条 prize_config 审计，包含四档三语文案快照与规则版本号。
 *
 * 四档（都中 / 只中数字 / 只中单双 / 都没中）的归属判定在玩家端完成：
 * 数字与单双是两次独立猜测，命中互不蕴含，四种组合一一对应一档。
 * 这里只保证「配置正确下发」，判定逻辑由前端渲染时按 numHit / oeHit 组合决定。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  startServer, makeClient, login, unlock, withDb, resetSchema,
  ADMIN_PASSWORD, PLAYER_PASSWORD
} from './helpers.mjs';

let server;
let api;
let sid;
let adminToken;
let ut;

const LOCALES = ['zh-CN', 'zh-HK', 'en-US'];

/** 空的三语字段（四档、额外奖励共用） */
function noText() {
  return { 'zh-CN': '', 'zh-HK': '', 'en-US': '' };
}

/** 空档位：合法，玩家端回落内置文案 */
function emptyTier() {
  return { title: noText(), desc: noText() };
}

/** 一档三语文案：名称三语必填，说明按需（不传即整档留空） */
function tier(zh, hant, en, descs) {
  return {
    title: { 'zh-CN': zh, 'zh-HK': hant, 'en-US': en },
    desc: descs ? { 'zh-CN': descs[0], 'zh-HK': descs[1], 'en-US': descs[2] } : noText()
  };
}

/** 一套完整的三语奖品配置 */
function fullPrizes() {
  return {
    both: tier('特等奖 · 羊绒围巾', '特等獎 · 羊絨圍巾', 'Grand prize · Wool scarf',
      ['两项全中，凭本页面到前台领取', '兩項全中，憑本頁面到前台領取', 'Both correct — show this page at the counter']),
    number: tier('一等奖 · 保温杯', '一等獎 · 保溫杯', 'First prize · Thermos',
      ['只中数字', '只中數字', 'Number only']),
    oddeven: tier('二等奖 · 小挂件', '二等獎 · 小掛件', 'Second prize · Keychain'),
    miss: tier('谢谢参与', '謝謝參與', 'Thanks for playing',
      ['下一轮再来', '下一輪再來', 'Try again next round'])
  };
}

before(async () => {
  await resetSchema();
  server = await startServer();
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

/** 玩家视角的状态快照（权威可见性从这里验，别只看管理接口）。 */
function playerState() {
  return api.get('/api/state?sid=' + encodeURIComponent(sid) + '&ut=' + encodeURIComponent(ut));
}

function getConfig() {
  return api.get('/api/prize-config?token=' + encodeURIComponent(adminToken));
}

function saveConfig(prizes) {
  return api.post('/api/prize-config', { token: adminToken, prizes });
}

/**
 * 关掉当前场次、新建一个并把玩家绑定切过去。
 * 「改完规则后新建的场次才用新规则」这条语义只能靠真开一场来验，
 * 先关后建是为了不撞「同时进行 4 场」的上限。
 */
async function openNewSession() {
  const old = sid;
  if (old) {
    const closed = await api.post('/api/session-close', { token: adminToken, sid: old });
    assert.equal(closed.status, 200, '关场失败：' + JSON.stringify(closed.body));
  }
  const created = await api.post('/api/session-create', { token: adminToken, name: '规则版本' });
  assert.equal(created.status, 200, '建场失败：' + JSON.stringify(created.body));
  sid = created.body.sid;
  const un = await unlock(api, sid, PLAYER_PASSWORD);
  assert.equal(un.body.ok, true, '玩家端解锁失败：' + JSON.stringify(un.body));
  ut = un.body.ut;
  return created.body.session;
}

test('默认没有配置：四档都是空的三语结构，玩家端也能拿到结构', async () => {
  const r = await getConfig();
  assert.equal(r.status, 200);
  assert.equal(r.body.ruleVersion, 1, '空库启动就该有 v1（空配置），新建场次才锁得到版本');
  assert.deepEqual(r.body.prizes, {
    both: emptyTier(), number: emptyTier(), oddeven: emptyTier(), miss: emptyTier()
  });

  // 三语字段必须三种语言都在，前端不做「有没有这个键」的猜测
  for (const loc of LOCALES) {
    assert.equal(typeof r.body.prizes.both.title[loc], 'string', '缺语言键：' + loc);
    assert.equal(r.body.prizes.both.title[loc], '');
  }

  const s = await playerState();
  assert.equal(s.status, 200);
  // 结构必须在，哪怕没配置：前端靠它判断「没配就回落内置文案」
  assert.deepEqual(s.body.prizes, r.body.prizes);
});

test('无 token / 非管理员不能读写配置', async () => {
  const noToken = await api.get('/api/prize-config');
  assert.equal(noToken.status, 401);
  assert.equal(noToken.body.code, 'unauthorized');

  const badSave = await api.post('/api/prize-config', { prizes: fullPrizes() });
  assert.equal(badSave.status, 401, '没有 token 的保存必须被拒');

  // 建一个 staff 账号：能登录，但配置接口一律 401（前端隐藏不是唯一防线）
  const created = await api.post('/api/account-create', {
    token: adminToken, username: 'prize-staff', password: 'staff-pw-123', role: 'staff'
  });
  assert.equal(created.body.ok, true, '建 staff 账号失败：' + JSON.stringify(created.body));

  const staff = await login(api, 'prize-staff', 'staff-pw-123');
  const g = await api.get('/api/prize-config?token=' + encodeURIComponent(staff.token));
  assert.equal(g.status, 401);
  const p = await api.post('/api/prize-config', {
    token: staff.token,
    prizes: { number: tier('偷偷改', '偷偷改', 'sneaky') }
  });
  assert.equal(p.status, 401);
});

test('保存三语文案：三种语言原样保留，各语言互不覆盖', async () => {
  const before = await getConfig();
  const beforeVersion = before.body.ruleVersion;

  const prizes = fullPrizes();
  const saved = await saveConfig(prizes);
  assert.equal(saved.status, 200, '保存失败：' + JSON.stringify(saved.body));
  assert.deepEqual(saved.body.prizes, prizes, '三种语言的文案都要一字不差地存回来');
  assert.equal(saved.body.created, true, '内容变了就要新增版本');
  assert.equal(saved.body.ruleVersion, beforeVersion + 1, '保存 = 版本号 +1');

  // 逐语言对照：确认没有「某种语言被另一种覆盖」这种最典型的实现错误
  assert.equal(saved.body.prizes.both.title['zh-CN'], '特等奖 · 羊绒围巾');
  assert.equal(saved.body.prizes.both.title['zh-HK'], '特等獎 · 羊絨圍巾');
  assert.equal(saved.body.prizes.both.title['en-US'], 'Grand prize · Wool scarf');

  // 读回（管理端）：管理员看到的永远是「最新一版」= 之后新建场次会用到的规则
  const g = await getConfig();
  assert.deepEqual(g.body.prizes, prizes);
  assert.equal(g.body.ruleVersion, saved.body.ruleVersion);

  // 正在进行的场次锁的是开场那一版：玩家端一个字都不变
  const cur = await playerState();
  assert.equal(cur.body.ruleVersion, beforeVersion, '进行中的场次不跟着改');
  assert.deepEqual(cur.body.prizes, before.body.prizes, '进行中的场次文案保持不变');

  // 改完之后新建的场次才锁定新版本，玩家端拿到的也是三语结构
  const created = await openNewSession();
  assert.equal(created.ruleVersion, saved.body.ruleVersion, '新场次锁定保存后的最新版');
  const next = await playerState();
  assert.equal(next.body.ruleVersion, saved.body.ruleVersion);
  assert.deepEqual(next.body.prizes, prizes);

  // 落库：版本表一行一版，旧版本原样留着（不是就地覆盖）
  const rows = await withDb(async (c) => {
    const r = await c.query('SELECT version, prizes FROM rule_version ORDER BY version ASC');
    return r.rows;
  });
  assert.equal(rows.length, saved.body.ruleVersion, '每个版本一行');
  assert.deepEqual(rows[rows.length - 1].prizes, prizes);
});

test('内容没变就不新增版本（反复点保存不刷版本号）', async () => {
  const g = await getConfig();
  const again = await saveConfig(g.body.prizes);
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(again.body.ruleVersion, g.body.ruleVersion, '内容一样，版本号不动');
});

test('缺语言直接拒绝：400 prize_incomplete，且不落库、不产生新版本', async () => {
  const before = await getConfig();
  const partial = fullPrizes();
  partial.both.title['en-US'] = '';        // 只填了简繁，缺英文
  partial.number.desc = { 'zh-CN': '只中数字', 'zh-HK': '', 'en-US': '' };  // 说明只填了一种语言

  const r = await saveConfig(partial);
  assert.equal(r.status, 400, '缺语言不该被接受：' + JSON.stringify(r.body));
  assert.equal(r.body.code, 'prize_incomplete');
  assert.ok(Array.isArray(r.body.missing), '要告诉前端缺哪一档/哪种语言，才能定位到具体输入框');
  const titleProblem = r.body.missing.find((x) => x.tier === 'both' && x.field === 'title');
  assert.deepEqual(titleProblem.locales, ['en-US']);
  const descProblem = r.body.missing.find((x) => x.tier === 'number' && x.field === 'desc');
  assert.deepEqual(descProblem.locales, ['zh-HK', 'en-US'], '说明要么三语都填、要么都不填');

  // 没落库：版本号与内容都不动
  const after = await getConfig();
  assert.equal(after.body.ruleVersion, before.body.ruleVersion);
  assert.deepEqual(after.body.prizes, before.body.prizes);
});

test('整档留空仍然合法（回落内置文案）；名称三语齐全而说明全空也合法', async () => {
  const prizes = {
    both: emptyTier(),                                  // 整档不配
    number: tier('一等奖', '一等獎', 'First prize'),      // 只有名称，说明整档留空
    oddeven: emptyTier(),
    miss: emptyTier()
  };
  const r = await saveConfig(prizes);
  assert.equal(r.status, 200, '留空不等于缺语言：' + JSON.stringify(r.body));
  assert.deepEqual(r.body.prizes, prizes);
});

test('归一化：逐语言去空白与截断，未知档位与多余字段丢弃', async () => {
  const long = '字'.repeat(40);       // 上限 32
  const longDesc = '说'.repeat(200);  // 上限 120
  const r = await saveConfig({
    number: {
      title: { 'zh-CN': '  ' + long + '  ', 'zh-HK': long, 'en-US': long },
      desc: { 'zh-CN': longDesc, 'zh-HK': longDesc, 'en-US': longDesc },
      evil: '<script>x</script>'
    },
    oddeven: emptyTier(),
    miss: emptyTier(),
    extra: { title: { 'zh-CN': '不该存在' } }
  });
  assert.equal(r.status, 200, '归一化不该报错：' + JSON.stringify(r.body));

  for (const loc of LOCALES) {
    assert.equal(r.body.prizes.number.title[loc].length, 32, loc + ' 的名称应截断到 32');
    assert.equal(r.body.prizes.number.title[loc], long.slice(0, 32), loc + ' 的值应等于前 32 个字');
    assert.equal(r.body.prizes.number.desc[loc].length, 120, loc + ' 的说明应截断到 120');
  }
  assert.deepEqual(Object.keys(r.body.prizes.number).sort(), ['desc', 'title'], '多余字段必须丢弃');
  assert.deepEqual(r.body.prizes.both, emptyTier(), '没提交的档位按空处理');
  assert.equal(Object.prototype.hasOwnProperty.call(r.body.prizes, 'extra'), false);

  // 玩家端拿到的同样是归一化后的值（不能出现「管理端截断、玩家端原文」的分裂）
  // 归一化后的配置是一个新版本，要看新场次
  await openNewSession();
  const s = await playerState();
  assert.deepEqual(s.body.prizes, r.body.prizes);
});

test('旧版单语数据（字符串）读取时落到简体中文，玩家端仍能显示', async () => {
  // 版本化之前的库直接把文案存成字符串。升级不迁移历史版本，
  // 靠读取时归一化 + 展示端按语言回退，保证升级前后玩家看到的内容一致。
  const legacyPrizes = {
    both: { title: '旧 · 都中', desc: '旧说明' },
    number: { title: '旧 · 只中数字', desc: '' },
    oddeven: { title: '旧 · 只中单双', desc: '' },
    miss: { title: '旧 · 都没中', desc: '' }
  };
  await withDb(async (c) => {
    const cur = await c.query('SELECT max(version)::int AS v FROM rule_version');
    await c.query(
      `INSERT INTO rule_version (version, prizes, bonus, config_hash, source, created_by, created_at)
       VALUES ($1, $2, $3, $4, 'legacy', 'old-instance', $5)`,
      [
        cur.rows[0].v + 1,
        JSON.stringify(legacyPrizes),
        JSON.stringify({ number: null, title: '', desc: '' }),
        'legacy-' + Date.now(),
        Date.now()
      ]
    );
  });

  const g = await getConfig();
  assert.equal(g.body.prizes.both.title['zh-CN'], '旧 · 都中', '旧单语落位到简体中文');
  assert.equal(g.body.prizes.both.title['zh-HK'], '', '不猜它是什么语言，其余留空由展示端回退');
  assert.equal(g.body.prizes.both.title['en-US'], '');
  assert.equal(g.body.prizes.both.desc['zh-CN'], '旧说明');

  // 新建场次锁这一版：玩家端结构一致，展示端按语言回退后不会空白
  await openNewSession();
  const s = await playerState();
  assert.deepEqual(s.body.prizes, g.body.prizes);
});

test('保存写审计：prize_config 带四档三语快照，actor 是管理员', async () => {
  const prizes = {
    both: tier('审计用 A', '審計用 A', 'Audit A'),
    number: tier('审计用 B', '審計用 B', 'Audit B'),
    oddeven: tier('审计用 C', '審計用 C', 'Audit C'),
    miss: tier('审计用 D', '審計用 D', 'Audit D')
  };
  await saveConfig(prizes);

  const r = await api.get('/api/audit?token=' + encodeURIComponent(adminToken) + '&action=prize_config&limit=5');
  assert.equal(r.status, 200);
  const logs = r.body.logs || r.body.items || r.body.rows || [];
  assert.ok(logs.length > 0, '没有查到 prize_config 日志：' + JSON.stringify(r.body));
  const latest = logs[0];
  assert.equal(latest.action, 'prize_config');
  assert.equal(latest.actor, 'admin');
  const detail = typeof latest.detail === 'string' ? JSON.parse(latest.detail) : latest.detail;
  const tiers = (detail && detail.tiers) || [];
  assert.deepEqual(tiers.map((t) => t.tier), ['both', 'number', 'oddeven', 'miss']);
  // 审计里保留完整三语，事后能追「当时三种语言到底写了什么」
  assert.deepEqual(tiers[0].title, { 'zh-CN': '审计用 A', 'zh-HK': '審計用 A', 'en-US': 'Audit A' });
  assert.deepEqual(tiers.map((t) => t.title['en-US']), ['Audit A', 'Audit B', 'Audit C', 'Audit D']);
  assert.ok(detail.ruleVersion >= 1, '审计要能追到这一版规则是几号');
  assert.equal(detail.created, true);
});

test('重启后配置与规则版本都在（管理员不必每次开机重配）', async () => {
  const pinned = (await playerState()).body.ruleVersion;
  const saved = await saveConfig({
    both: emptyTier(),
    number: tier('重启后仍在', '重啟後仍在', 'Still here after restart'),
    oddeven: emptyTier(),
    miss: emptyTier()
  });
  const newVersion = saved.body.ruleVersion;
  assert.ok(newVersion > pinned, '这一版应该在开场那一版之后');

  await server.stop();
  server = await startServer();
  api = makeClient(server.base);
  const admin = await login(api);
  adminToken = admin.token;
  sid = admin.sid;
  const un = await unlock(api, sid, PLAYER_PASSWORD);
  ut = un.body.ut;

  // 最新一版（= 之后新建场次要用的）从库里读得回来，三语都在
  const g = await getConfig();
  assert.deepEqual(g.body.prizes.number.title,
    { 'zh-CN': '重启后仍在', 'zh-HK': '重啟後仍在', 'en-US': 'Still here after restart' });
  assert.equal(g.body.ruleVersion, newVersion);

  // 重启不改变任何场次锁定的版本：场次仍停在开场那一版，不会被「最新版」顶掉
  const list = await api.get('/api/sessions?token=' + encodeURIComponent(adminToken));
  const cur = list.body.sessions.find((x) => x.id === sid);
  assert.equal(cur.ruleVersion, pinned, '重启后场次仍锁定原版本');
  assert.notEqual(cur.ruleVersion, g.body.ruleVersion, '新版只对之后新建的场次生效');
});
