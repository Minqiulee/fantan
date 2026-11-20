/**
 * db.js — Postgres 持久化层（多场次版）
 * ------------------------------------------------------------
 * 用 pg 连接池替换原 game-data.json 文件持久化，保证应用重启后数据仍在。
 *
 * 数据实体与表结构（均含时间戳）：
 *   - game_session  场次实体（名称、状态、创建/关闭时间）—— 一个实例可并行承载 1–4 场
 *   - round         场次内的当前轮次状态（开奖数字、锁定时间），每场一行
 *   - player        场次内每个玩家的登记与预测，主键 (session_id, id)
 *   - identity      场次内的跨轮次身份档案，主键 (session_id, id)
 *
 * 所有业务表首列都是 session_id：任何读写都必须带 session_id，
 * 场次之间不共享任何可变状态（连「老玩家」累计轮次也按场次独立计数）。
 *
 * 玩家 ID 统一为「二维码内容 / 用户直接提交的原始 ID」（未经 hash）。
 *
 * 老库迁移：initDb() 幂等补齐 session_id 列、把历史数据归到默认场次 main、
 * 并把 player / identity 的单列主键改成 (session_id, id) 复合主键。
 *
 * 连接串来源（优先级从高到低）：
 *   1. PG_HOST / PG_USER / PG_PASS —— Fly.io secrets，拼成
 *      postgresql://PG_USER:PG_PASS@PG_HOST:PG_PORT/PG_DB
 *      （PG_PORT 默认 5432，PG_DB 默认 postgres）
 *   2. DATABASE_URL / PG_URL —— 完整连接串，本地开发用
 *   3. 本地默认值
 */
const { Pool } = require('pg');

/** 历史单场次数据在迁移后归属的场次 ID */
const DEFAULT_SESSION_ID = 'main';

let pool = null;

/** 由 Fly.io secrets 拼接连接串；主机/用户/密码缺一不可，否则返回 null 交由上层回退。 */
function buildConnectionString() {
  const { PG_HOST, PG_USER, PG_PASS, PG_PORT, PG_DB } = process.env;
  if (PG_HOST && PG_USER && PG_PASS) {
    const port = PG_PORT || 5432;
    const database = PG_DB || 'postgres';
    // 密码里可能有 @ / : / 等保留字符，必须转义
    return `postgresql://${encodeURIComponent(PG_USER)}:${encodeURIComponent(PG_PASS)}@${PG_HOST}:${port}/${database}`;
  }
  return null;
}

/** 懒加载连接池。配置允许通过独立环境变量覆盖，方便本地/测试。 */
function getPool() {
  if (pool) return pool;
  const connectionString =
    buildConnectionString() ||
    process.env.DATABASE_URL ||
    process.env.PG_URL ||
    'postgres://postgres:postgres@localhost:5432/oddeven';
  pool = new Pool({ connectionString });
  pool.on('error', (err) => {
    // 空闲连接出错不应导致进程崩溃，仅记录
    console.error('[db] 连接池空闲连接错误:', err.message);
  });
  return pool;
}

/** 读取某表当前主键包含哪些列（按主键内顺序）。表名由调用方硬编码，不接受外部输入。 */
async function pkColumns(p, table) {
  const res = await p.query(
    `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY (i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary`,
    [table]
  );
  return res.rows.map((r) => r.name);
}

/**
 * 把(player / identity)的单列主键升级为 (session_id, id) 复合主键。
 * 已是复合主键时直接返回，可反复执行。
 */
async function ensureCompositePk(p, table) {
  const cols = await pkColumns(p, table);
  if (cols.includes('session_id')) return;

  // 先查出真实的主键约束名再删，避免依赖默认命名
  const con = await p.query(
    `SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = 'p'`,
    [table]
  );
  for (const row of con.rows) {
    await p.query(`ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS "${row.conname}"`);
  }
  await p.query(`ALTER TABLE ${table} ALTER COLUMN session_id SET NOT NULL`);
  await p.query(`ALTER TABLE ${table} ADD PRIMARY KEY (session_id, id)`);
  console.log('[db] 已升级主键: ' + table + '(session_id, id)');
}

/**
 * 幂等建表 + 老库迁移：首次启动时自动创建所需表，已存在的表补齐场次维度。
 * 所有时间戳统一存毫秒（BIGINT），与现有 state 里的 Date.now() 语义一致。
 */
async function initDb() {
  const p = getPool();

  // 场次表
  await p.query(`
    CREATE TABLE IF NOT EXISTS game_session (
      session_id TEXT PRIMARY KEY,          -- 场次 ID（默认场次为 main，新建场次为随机短串）
      name       TEXT NOT NULL,             -- 场次名称（工作人员可命名）
      status     TEXT NOT NULL DEFAULT 'open', -- open | closed
      seq        INTEGER NOT NULL DEFAULT 1,   -- 显示顺序
      created_at BIGINT NOT NULL,           -- 创建时间戳（毫秒）
      closed_at  BIGINT                     -- 关闭时间戳（毫秒，null 表示未关闭）
    );
  `);

  // 轮次表：一场一行
  await p.query(`
    CREATE TABLE IF NOT EXISTS round (
      session_id TEXT PRIMARY KEY,          -- 所属场次
      round      INTEGER NOT NULL,          -- 场次内当前轮次序号
      number     INTEGER,                   -- 开奖数字（null 表示未锁定）
      locked_at  BIGINT                     -- 锁定时间戳（毫秒）
    );
  `);
  // 老库（单场次）补列，随后回填默认场次
  await p.query('ALTER TABLE round ADD COLUMN IF NOT EXISTS session_id TEXT');

  // 玩家表：一场内一个玩家一行
  await p.query(`
    CREATE TABLE IF NOT EXISTS player (
      session_id    TEXT NOT NULL,          -- 所属场次
      id            TEXT NOT NULL,          -- 二维码内容/原始 ID（未经 hash）
      round         INTEGER NOT NULL,       -- 场次内所属轮次
      odd_even      TEXT,                   -- 预测单/双（null 表示未提交）
      number        INTEGER,                -- 预测数字
      registered_at BIGINT NOT NULL,        -- 登记时间戳（毫秒）
      submitted_at  BIGINT,                 -- 提交预测时间戳（毫秒）
      PRIMARY KEY (session_id, id)
    );
  `);
  await p.query('ALTER TABLE player ADD COLUMN IF NOT EXISTS session_id TEXT');

  // 身份档案：一场内一份，跨该场次的轮次累计
  await p.query(`
    CREATE TABLE IF NOT EXISTS identity (
      session_id       TEXT NOT NULL,       -- 所属场次
      id               TEXT NOT NULL,       -- 与 player.id 统一（原始 ID）
      last_seen_round  INTEGER NOT NULL,    -- 最近出现的轮次（场次内）
      completed_rounds INTEGER NOT NULL DEFAULT 0,
      created_at       BIGINT NOT NULL,     -- 首次建档时间戳（毫秒）
      updated_at       BIGINT NOT NULL      -- 最近更新时间戳（毫秒）
    );
  `);
  await p.query('ALTER TABLE identity ADD COLUMN IF NOT EXISTS session_id TEXT');

  // 历史数据归属默认场次
  await p.query(`UPDATE round    SET session_id = $1 WHERE session_id IS NULL`, [DEFAULT_SESSION_ID]);
  await p.query(`UPDATE player   SET session_id = $1 WHERE session_id IS NULL`, [DEFAULT_SESSION_ID]);
  await p.query(`UPDATE identity SET session_id = $1 WHERE session_id IS NULL`, [DEFAULT_SESSION_ID]);

  // 主键升级：同一玩家 ID 可同时存在于多个场次，主键必须带 session_id
  await ensureCompositePk(p, 'player');
  await ensureCompositePk(p, 'identity');

  // 应用级键值配置：目前只存玩家端绑定令牌的 HMAC 签名密钥。
  // 不存任何口令：口令只在进程内存里保留 scrypt 哈希。
  await p.query(`
    CREATE TABLE IF NOT EXISTS app_config (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      updated_at BIGINT NOT NULL
    );
  `);

  await p.query('CREATE INDEX IF NOT EXISTS idx_player_session ON player(session_id, registered_at);');
  await p.query('CREATE INDEX IF NOT EXISTS idx_round_session ON round(session_id);');
  await p.query('CREATE INDEX IF NOT EXISTS idx_session_status ON game_session(status, seq);');

  // 升级场景：老库有单场次数据但没有场次实体时，补一条 main 场次，
  // 否则首次启动会把它当成「空场次」，随后的整表重写会把历史玩家覆盖掉。
  const cnt = await p.query('SELECT count(*)::int AS n FROM game_session');
  if (cnt.rows[0].n === 0) {
    const legacy = await p.query('SELECT 1 FROM round WHERE session_id = $1 LIMIT 1', [DEFAULT_SESSION_ID]);
    const legacyPlayer = await p.query('SELECT 1 FROM player WHERE session_id = $1 LIMIT 1', [DEFAULT_SESSION_ID]);
    if ((legacy.rowCount || 0) > 0 || (legacyPlayer.rowCount || 0) > 0) {
      await p.query(
        `INSERT INTO game_session (session_id, name, status, seq, created_at, closed_at)
         VALUES ($1, $2, 'open', 1, $3, NULL)`,
        [DEFAULT_SESSION_ID, '第 1 场', Date.now()]
      );
      console.log('[db] 检测到历史单场次数据，已归入场次 ' + DEFAULT_SESSION_ID);
    }
  }
}

/** 行 → 场次对象（players / identities 由调用方填充） */
function rowToSession(r) {
  return {
    id: r.session_id,
    name: r.name,
    status: r.status,
    seq: Number(r.seq),
    createdAt: Number(r.created_at),
    closedAt: r.closed_at != null ? Number(r.closed_at) : null,
    round: 1,
    number: null,
    lockedAt: null,
    players: {},
    identities: {}
  };
}

/**
 * 从数据库加载全部场次及其状态。
 * 返回 [{ id, name, status, seq, createdAt, closedAt, round, number, lockedAt, players, identities }]。
 */
async function loadSessions() {
  const p = getPool();

  const sRes = await p.query('SELECT * FROM game_session ORDER BY seq ASC, created_at ASC');
  const list = sRes.rows.map(rowToSession);
  const byId = {};
  for (const s of list) byId[s.id] = s;

  const roundRes = await p.query('SELECT session_id, round, number, locked_at FROM round');
  for (const r of roundRes.rows) {
    const s = byId[r.session_id];
    if (!s) continue; // 没有对应场次的孤儿行：忽略，不参与运行态
    s.round = Number(r.round);
    s.number = r.number != null ? Number(r.number) : null;
    s.lockedAt = r.locked_at != null ? Number(r.locked_at) : null;
  }

  const playersRes = await p.query('SELECT * FROM player ORDER BY session_id, registered_at ASC');
  for (const r of playersRes.rows) {
    const s = byId[r.session_id];
    if (!s) continue;
    s.players[r.id] = {
      id: r.id,
      oddEven: r.odd_even,
      number: r.number != null ? Number(r.number) : null,
      registeredAt: Number(r.registered_at),
      submittedAt: r.submitted_at != null ? Number(r.submitted_at) : null
    };
  }

  const idtRes = await p.query('SELECT * FROM identity');
  for (const r of idtRes.rows) {
    const s = byId[r.session_id];
    if (!s) continue;
    s.identities[r.id] = {
      lastSeenRound: Number(r.last_seen_round),
      completedRounds: Number(r.completed_rounds)
    };
  }

  return list;
}

/**
 * 单个场次的全量落库（事务内）。
 * 只删写本场次的行：round 删除后重插一行，player 本场次清空后重写，
 * identity 按 (session_id, id) upsert（历史累计不能删）。
 */
async function doSaveSession(session) {
  const p = getPool();
  const client = await p.connect();
  const now = Date.now();
  try {
    await client.query('BEGIN');

    await client.query('DELETE FROM round WHERE session_id = $1', [session.id]);
    await client.query(
      'INSERT INTO round (session_id, round, number, locked_at) VALUES ($1,$2,$3,$4)',
      [session.id, session.round, session.number, session.lockedAt]
    );

    await client.query('DELETE FROM player WHERE session_id = $1', [session.id]);
    for (const id of Object.keys(session.players)) {
      const pl = session.players[id];
      await client.query(
        `INSERT INTO player
           (session_id, id, round, odd_even, number, registered_at, submitted_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (session_id, id) DO UPDATE SET
           round=EXCLUDED.round, odd_even=EXCLUDED.odd_even, number=EXCLUDED.number,
           submitted_at=EXCLUDED.submitted_at`,
        [session.id, pl.id, session.round, pl.oddEven, pl.number, pl.registeredAt, pl.submittedAt]
      );
    }

    for (const id of Object.keys(session.identities)) {
      const it = session.identities[id];
      await client.query(
        `INSERT INTO identity
           (session_id, id, last_seen_round, completed_rounds, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (session_id, id) DO UPDATE SET
           last_seen_round=EXCLUDED.last_seen_round,
           completed_rounds=EXCLUDED.completed_rounds,
           updated_at=EXCLUDED.updated_at`,
        [session.id, id, it.lastSeenRound, it.completedRounds, now, now]
      );
    }

    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

/**
 * 写队列：同一场次的写入串行化，避免事务重叠导致旧快照覆盖新快照；
 * 不同场次之间互不阻塞。写入本身仍是「快照重写」，所以快照取的是执行时的实时状态。
 */
const writeChains = new Map();

function enqueueWrite(sessionId, fn) {
  const prev = writeChains.get(sessionId) || Promise.resolve();
  const next = prev.then(fn, fn).catch((e) => {
    console.error('[db] 保存场次失败(' + sessionId + '):', e.message);
  });
  writeChains.set(sessionId, next);
  return next;
}

/** 持久化某个场次的全量状态（round / player / identity）。失败仅记录错误，不阻断请求。 */
function saveSession(session) {
  return enqueueWrite(session.id, () => doSaveSession(session));
}

/** 持久化场次元信息（名称、状态、关闭时间）。新建与关闭时调用。 */
function saveSessionMeta(session) {
  return enqueueWrite(session.id, async () => {
    await getPool().query(
      `INSERT INTO game_session (session_id, name, status, seq, created_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_id) DO UPDATE SET
         name=EXCLUDED.name, status=EXCLUDED.status, seq=EXCLUDED.seq,
         closed_at=EXCLUDED.closed_at`,
      [session.id, session.name, session.status, session.seq, session.createdAt, session.closedAt]
    );
  });
}

/** 读取一个配置项，不存在返回 null。 */
async function getConfig(key) {
  const p = getPool();
  const r = await p.query('SELECT value FROM app_config WHERE key = $1', [key]);
  return r.rows.length ? r.rows[0].value : null;
}

/** 写入一个配置项（upsert）。 */
async function setConfig(key, value) {
  const p = getPool();
  await p.query(
    `INSERT INTO app_config (key, value, updated_at) VALUES ($1, $2, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [key, value, Date.now()]
  );
}

module.exports = {
  DEFAULT_SESSION_ID,
  initDb,
  loadSessions,
  saveSession,
  saveSessionMeta,
  getConfig,
  setConfig,
  getPool
};
