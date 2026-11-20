/**
 * db.js — Postgres 持久化层（多场次版）
 * ------------------------------------------------------------
 * 全部运行态与归档数据都在 Postgres，应用重启后数据仍在。
 *
 * 数据实体与表结构（均含时间戳）：
 *   - game_session  场次实体（名称、状态、创建/关闭时间）—— 一个实例可并行承载 1–4 场
 *   - round         场次内的当前轮次状态（开奖数字、锁定时间），每场一行
 *   - player        场次内每个玩家的登记与预测，主键 (session_id, id)
 *   - identity      场次内的跨轮次身份档案，主键 (session_id, id)
 *   - round_archive 竞猜归档表头（一轮一行，append-only）
 *   - round_archive_entry 归档明细（一人一行，append-only）
 *
 * 所有业务表首列都是 session_id：任何读写都必须带 session_id，
 * 场次之间不共享任何可变状态（连「老玩家」累计轮次也按场次独立计数）。
 *
 * 玩家 ID 统一为「二维码内容 / 用户直接提交的原始 ID」（未经 hash）。
 *
 * 表结构由 initDb() 建出，CREATE ... IF NOT EXISTS 保证可反复执行；
 * 本层不做任何结构迁移，以当前定义为准（旧结构库需在升级前自行完成 DDL）。
 *
 * 连接串来源（优先级从高到低）：
 *   1. PG_HOST / PG_USER / PG_PASS —— Fly.io secrets，拼成
 *      postgresql://PG_USER:PG_PASS@PG_HOST:PG_PORT/PG_DB
 *      （PG_PORT 默认 5432，PG_DB 默认 postgres）
 *   2. DATABASE_URL / PG_URL —— 完整连接串，本地开发用
 *   3. 本地默认值
 */
const { Pool } = require('pg');

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

/* ============================================================
 * 竞猜归档（append-only）
 * ------------------------------------------------------------
 * 与运行态表彻底分开：round / player 是「当前一轮」的可变快照，
 * 每轮 reset 都会被清空重写；归档表只增不改，是一轮结束后的唯一留痕。
 *
 *   round_archive        一轮一行：场次快照 + 轮次号 + 开奖数字 + 锁定时间
 *   round_archive_entry  一人一行：会员号 + 预测内容 + 命中结果
 *
 * 写入时机：锁定（/api/confirm）那一刻，与运行态快照写在同一个事务里，
 * 所以「锁定成功」与「归档成功」要么同时成立，要么同时回滚。
 *
 * 不可变性：由数据库触发器兜底——任何 UPDATE / DELETE / TRUNCATE 直接抛错，
 * 不只是「代码里不写 delete」的口头约定。要更正只能追加新记录。
 * ============================================================ */

/** 数字 → 单/双（与前端、玩家端同一套字形；正文里只认这两个字面值） */
function lineOfNumber(n) {
  return Number(n) % 2 === 1 ? '单' : '双';
}

/** 建归档表 + append-only 触发器。可反复执行。 */
async function initArchiveTables(p) {
  await p.query(`
    CREATE TABLE IF NOT EXISTS round_archive (
      archive_id      BIGSERIAL PRIMARY KEY,
      session_id      TEXT    NOT NULL,   -- 场次 ID（对账/分账的唯一维度）
      session_name    TEXT    NOT NULL,   -- 场次名称快照（事后改名不影响历史）
      session_seq     INTEGER NOT NULL,   -- 场次显示序号快照
      round           INTEGER NOT NULL,   -- 场次内轮次号
      number          INTEGER NOT NULL,   -- 开奖数字 1–8
      odd_even        TEXT    NOT NULL,   -- 开奖单双（由 number 派生，便于直接对账）
      locked_at       BIGINT  NOT NULL,   -- 锁定时间戳（毫秒）—— 当日汇总按此列切分
      archived_at     BIGINT  NOT NULL,   -- 归档写入时间戳（毫秒）
      player_count    INTEGER NOT NULL DEFAULT 0, -- 本轮扫码人数
      submitted_count INTEGER NOT NULL DEFAULT 0  -- 本轮提交预测人数
    );
  `);
  await p.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS uq_round_archive_session_round
      ON round_archive (session_id, round);
  `);
  await p.query('CREATE INDEX IF NOT EXISTS idx_round_archive_locked ON round_archive (locked_at);');

  await p.query(`
    CREATE TABLE IF NOT EXISTS round_archive_entry (
      archive_id    BIGINT  NOT NULL REFERENCES round_archive (archive_id), -- 所属轮次（不级联删除：归档行永不被删）
      member_id     TEXT    NOT NULL,   -- 会员号（二维码内容 / 玩家原始 ID）
      odd_even      TEXT,               -- 预测单双（null = 未提交）
      number        INTEGER,            -- 预测数字（null = 未提交）
      submitted     BOOLEAN NOT NULL DEFAULT FALSE, -- 是否提交过预测
      odd_even_hit  BOOLEAN NOT NULL DEFAULT FALSE, -- 单双是否命中（未提交恒为 false）
      number_hit    BOOLEAN NOT NULL DEFAULT FALSE, -- 数字是否命中（未提交恒为 false）
      registered_at BIGINT  NOT NULL,   -- 扫码登记时间戳（毫秒）
      submitted_at  BIGINT,             -- 提交预测时间戳（毫秒）
      archived_at   BIGINT  NOT NULL,   -- 归档写入时间戳（毫秒）
      PRIMARY KEY (archive_id, member_id)
    );
  `);
  await p.query('CREATE INDEX IF NOT EXISTS idx_round_archive_entry_member ON round_archive_entry (member_id);');
  await p.query('CREATE INDEX IF NOT EXISTS idx_round_archive_entry_session ON round_archive_entry (archive_id, submitted);');

  // append-only 兜底：任何改写历史的尝试在数据库层就被拒
  await p.query(`
    CREATE OR REPLACE FUNCTION archive_block_mutation() RETURNS trigger AS $fn$
    BEGIN
      RAISE EXCEPTION 'append-only 表 % 不允许 %', TG_TABLE_NAME, TG_OP
        USING HINT = '结算归档只允许 INSERT；需要更正请追加新记录，不要改写历史。';
    END;
    $fn$ LANGUAGE plpgsql;
  `);
  for (const table of ['round_archive', 'round_archive_entry']) {
    await p.query(`DROP TRIGGER IF EXISTS trg_${table}_no_update_delete ON ${table};`);
    await p.query(
      `CREATE TRIGGER trg_${table}_no_update_delete
         BEFORE UPDATE OR DELETE ON ${table}
         FOR EACH ROW EXECUTE FUNCTION archive_block_mutation();`
    );
    await p.query(`DROP TRIGGER IF EXISTS trg_${table}_no_truncate ON ${table};`);
    await p.query(
      `CREATE TRIGGER trg_${table}_no_truncate
         BEFORE TRUNCATE ON ${table}
         FOR EACH STATEMENT EXECUTE FUNCTION archive_block_mutation();`
    );
  }
}

/**
 * 幂等建表：首次启动时创建全部表、索引与归档触发器，已存在则跳过。
 * 只保证「表结构存在」，不做任何列补齐或数据重写。
 * 所有时间戳统一存毫秒（BIGINT），与 state 里的 Date.now() 语义一致。
 */
async function initDb() {
  const p = getPool();

  // 场次表
  await p.query(`
    CREATE TABLE IF NOT EXISTS game_session (
      session_id TEXT PRIMARY KEY,          -- 场次 ID（首个场次固定为 main，新建场次为随机短串）
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
      left_at       BIGINT,                 -- 离开现场时间戳（null = 在场；仅大屏展示用）
      PRIMARY KEY (session_id, id)          -- 同一 ID 可同时存在于多个场次
    );
  `);

  // 身份档案：一场内一份，跨该场次的轮次累计
  await p.query(`
    CREATE TABLE IF NOT EXISTS identity (
      session_id       TEXT NOT NULL,       -- 所属场次
      id               TEXT NOT NULL,       -- 与 player.id 统一（原始 ID）
      last_seen_round  INTEGER NOT NULL,    -- 最近出现的轮次（场次内）
      completed_rounds INTEGER NOT NULL DEFAULT 0,
      created_at       BIGINT NOT NULL,     -- 首次建档时间戳（毫秒）
      updated_at       BIGINT NOT NULL,     -- 最近更新时间戳（毫秒）
      PRIMARY KEY (session_id, id)          -- 同一 ID 可同时存在于多个场次
    );
  `);

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

  await initArchiveTables(p);
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
      submittedAt: r.submitted_at != null ? Number(r.submitted_at) : null,
      leftAt: r.left_at != null ? Number(r.left_at) : null
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
 * 把「当前这一轮」追加进归档（调用方事务内）。
 *
 * 只在轮次已锁定（number 与 lockedAt 都有值）时写入；未锁定的轮次没有任何留痕价值，
 * 也避免把 staff 正在录号的中间态写进归档表。
 *
 * 幂等：表头按 (session_id, round) 唯一，明细按 (archive_id, member_id) 唯一，
 * 全部 ON CONFLICT DO NOTHING —— 重复保存同一轮不会产生第二份归档，
 * 也不会覆盖既有行的任何字段（append-only 的前提）。
 *
 * 返回 archive_id（未锁定返回 null）。
 */
async function archiveRoundInTx(client, session) {
  if (session.number == null || session.lockedAt == null) return null;

  const players = Object.values(session.players);
  const submitted = players.filter((pl) => pl.oddEven != null).length;
  const oddEven = lineOfNumber(session.number);
  const now = Date.now();

  const ins = await client.query(
    `INSERT INTO round_archive
       (session_id, session_name, session_seq, round, number, odd_even,
        locked_at, archived_at, player_count, submitted_count)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (session_id, round) DO NOTHING
     RETURNING archive_id`,
    [
      session.id, session.name, Number(session.seq) || 1, session.round,
      session.number, oddEven, session.lockedAt, now, players.length, submitted
    ]
  );

  let archiveId;
  if (ins.rows.length) {
    archiveId = Number(ins.rows[0].archive_id);
  } else {
    const ex = await client.query(
      'SELECT archive_id FROM round_archive WHERE session_id = $1 AND round = $2',
      [session.id, session.round]
    );
    if (!ex.rows.length) return null; // 理论上不可达：唯一索引冲突必然能查到
    archiveId = Number(ex.rows[0].archive_id);
  }

  if (!players.length) return archiveId;

  // 分批插明细：每批 200 行，避免单条 SQL 参数过多
  const BATCH = 200;
  for (let i = 0; i < players.length; i += BATCH) {
    const chunk = players.slice(i, i + BATCH);
    const params = [];
    const tuples = [];
    for (const pl of chunk) {
      const hasPred = pl.oddEven != null;
      const base = params.length;
      tuples.push(
        `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},` +
        `$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10})`
      );
      params.push(
        archiveId,
        pl.id,
        hasPred ? pl.oddEven : null,
        hasPred && pl.number != null ? Number(pl.number) : null,
        hasPred,
        // 命中判定：单双按开奖数字奇偶性，数字按相等。未提交一律 false
        hasPred && pl.oddEven === oddEven,
        hasPred && pl.number != null && Number(pl.number) === Number(session.number),
        pl.registeredAt,
        pl.submittedAt != null ? pl.submittedAt : null,
        now
      );
    }
    await client.query(
      `INSERT INTO round_archive_entry
         (archive_id, member_id, odd_even, number, submitted,
          odd_even_hit, number_hit, registered_at, submitted_at, archived_at)
       VALUES ${tuples.join(',')}
       ON CONFLICT (archive_id, member_id) DO NOTHING`,
      params
    );
  }
  return archiveId;
}

/**
 * 单个场次的全量落库（事务内）。
 * 只删写本场次的行：round 删除后重插一行，player 本场次清空后重写，
 * identity 按 (session_id, id) upsert（历史累计不能删）。
 *
 * 归档也在同一个事务里写：锁定后的轮次一旦落库就同时有归档记录，
 * 不会出现「运行态已开奖、归档表缺这一轮」的中间态。
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
           (session_id, id, round, odd_even, number, registered_at, submitted_at, left_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (session_id, id) DO UPDATE SET
           round=EXCLUDED.round, odd_even=EXCLUDED.odd_even, number=EXCLUDED.number,
           submitted_at=EXCLUDED.submitted_at, left_at=EXCLUDED.left_at`,
        [session.id, pl.id, session.round, pl.oddEven, pl.number, pl.registeredAt, pl.submittedAt,
          pl.leftAt != null ? pl.leftAt : null]
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

    // 归档：本轮已锁定则追加写；未锁定直接跳过。
    // 注意这里只有 INSERT，没有任何 DELETE / UPDATE —— reset 走的也是这条路径，
    // 它清的是 round / player，碰不到归档表。
    await archiveRoundInTx(client, session);

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

/**
 * 入队并返回 { ok, error }。不向外抛异常（历史调用点都是 fire-and-forget），
 * 但把结果交给调用方 —— 锁定这一轮必须等到「写入 + 归档」真正成功才算结算完成。
 */
function enqueueWrite(sessionId, fn) {
  const prev = writeChains.get(sessionId) || Promise.resolve();
  const next = prev
    .then(fn, fn)
    .then(
      () => ({ ok: true }),
      (e) => {
        console.error('[db] 保存场次失败(' + sessionId + '):', e.message);
        return { ok: false, error: e.message };
      }
    );
  writeChains.set(sessionId, next);
  return next;
}

/** 持久化某个场次的全量状态（round / player / identity / 已锁定轮次的归档）。 */
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

/* ============================================================
 * 归档读取：当日聚合 + 对账导出
 * ------------------------------------------------------------
 * 所有查询都以 locked_at ∈ [from, to) 为口径（毫秒时间戳半开区间），
 * 由上层按运营时区算好边界，数据库只做区间比较，不做时区换算。
 * ============================================================ */

/** 某一轮是否已归档（用于启动补齐与诊断，不参与写入路径）。 */
async function archiveExists(sessionId, round) {
  const r = await getPool().query(
    'SELECT 1 FROM round_archive WHERE session_id = $1 AND round = $2 LIMIT 1',
    [sessionId, round]
  );
  return (r.rowCount || 0) > 0;
}

/**
 * 时间区间内的汇总：场次数、轮次数、去重参与人数，以及分场次明细。
 * 「场次数」= 区间内有已归档轮次的场次数（不是当前进行中的场次数）。
 */
async function archiveSummary(from, to) {
  const p = getPool();

  const t = await p.query(
    `SELECT count(*)::int                              AS rounds,
            count(DISTINCT session_id)::int             AS sessions,
            coalesce(sum(player_count), 0)::int         AS entries,
            coalesce(sum(submitted_count), 0)::int      AS submitted
       FROM round_archive
      WHERE locked_at >= $1 AND locked_at < $2`,
    [from, to]
  );

  const m = await p.query(
    `SELECT count(DISTINCT e.member_id)::int AS members,
            count(DISTINCT e.member_id) FILTER (WHERE e.submitted)::int AS predicted_members
       FROM round_archive a
       JOIN round_archive_entry e ON e.archive_id = a.archive_id
      WHERE a.locked_at >= $1 AND a.locked_at < $2`,
    [from, to]
  );

  // 分场次：表头与人数分别聚合后再 join。
  // 不能直接 LEFT JOIN 明细后 count(*)——一轮 N 人会被放大成 N 行，轮次与人数全错。
  const s = await p.query(
    `SELECT h.session_id, h.session_name, h.session_seq, h.rounds, h.entries, h.submitted,
            h.first_locked_at, h.last_locked_at, coalesce(m.members, 0)::int AS members
       FROM (
         SELECT session_id,
                (array_agg(session_name ORDER BY locked_at DESC, round DESC))[1] AS session_name,
                max(session_seq)::int                    AS session_seq,
                count(*)::int                            AS rounds,
                coalesce(sum(player_count), 0)::int      AS entries,
                coalesce(sum(submitted_count), 0)::int   AS submitted,
                min(locked_at)                           AS first_locked_at,
                max(locked_at)                           AS last_locked_at
           FROM round_archive
          WHERE locked_at >= $1 AND locked_at < $2
          GROUP BY session_id
       ) h
       LEFT JOIN (
         SELECT a.session_id, count(DISTINCT e.member_id)::int AS members
           FROM round_archive a
           JOIN round_archive_entry e ON e.archive_id = a.archive_id
          WHERE a.locked_at >= $1 AND a.locked_at < $2
          GROUP BY a.session_id
       ) m ON m.session_id = h.session_id
      ORDER BY h.first_locked_at ASC, h.session_id ASC`,
    [from, to]
  );

  return {
    rounds: t.rows[0].rounds,
    sessions: t.rows[0].sessions,
    entries: t.rows[0].entries,
    submitted: t.rows[0].submitted,
    members: m.rows[0].members,
    predictedMembers: m.rows[0].predicted_members,
    bySession: s.rows.map((r) => ({
      sessionId: r.session_id,
      sessionName: r.session_name,
      sessionSeq: Number(r.session_seq),
      rounds: r.rounds,
      entries: r.entries,
      submitted: r.submitted,
      members: r.members,
      firstLockedAt: Number(r.first_locked_at),
      lastLockedAt: Number(r.last_locked_at)
    }))
  };
}

/** 轮次级明细：一轮一行（含 0 人轮次）。用于核对「当天到底开了几轮」。 */
async function archiveRoundRows(from, to, sessionId) {
  const p = getPool();
  const params = [from, to];
  let sql = `
    SELECT session_id, session_name, session_seq, round, number, odd_even,
           locked_at, archived_at, player_count, submitted_count
      FROM round_archive
     WHERE locked_at >= $1 AND locked_at < $2`;
  if (sessionId) { params.push(sessionId); sql += ` AND session_id = $${params.length}`; }
  sql += ' ORDER BY locked_at ASC, session_id ASC, round ASC';
  const res = await p.query(sql, params);
  return res.rows;
}

/**
 * 逐人逐轮明细：一人一轮一行，跨场次全部返回。
 * 排序按「会员号 → 锁定时间」：同一玩家的跨场记录连续排列，方便逐人核对；
 * 但**不做任何合并或汇总**——每行就是一次猜测及其与实际开奖结果的匹配情况。
 */
async function archiveEntryRows(from, to, sessionId) {
  const p = getPool();
  const params = [from, to];
  let sql = `
    SELECT a.session_id, a.session_name, a.session_seq, a.round, a.number AS drawn_number,
           a.odd_even AS drawn_odd_even, a.locked_at, a.archived_at,
           e.member_id, e.odd_even, e.number, e.submitted, e.odd_even_hit, e.number_hit,
           e.registered_at, e.submitted_at
      FROM round_archive a
      JOIN round_archive_entry e ON e.archive_id = a.archive_id
     WHERE a.locked_at >= $1 AND a.locked_at < $2`;
  if (sessionId) { params.push(sessionId); sql += ` AND a.session_id = $${params.length}`; }
  sql += ' ORDER BY e.member_id ASC, a.locked_at ASC, a.session_id ASC, a.round ASC, e.registered_at ASC';
  const res = await p.query(sql, params);
  return res.rows;
}

module.exports = {
  initDb,
  loadSessions,
  saveSession,
  saveSessionMeta,
  getConfig,
  setConfig,
  getPool,
  lineOfNumber,
  archiveExists,
  archiveSummary,
  archiveRoundRows,
  archiveEntryRows
};
