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
 *   - session_state 场次状态版本号（多实例乐观锁）
 *   - staff_session 员工登录会话（跨实例共享）
 *   - auth_throttle 登录/口令错误限频（跨实例共享）
 *
 * 所有业务表首列都是 session_id：任何读写都必须带 session_id，
 * 场次之间不共享任何可变状态（连「老玩家」累计轮次也按场次独立计数）。
 *
 * 玩家 ID 统一为「二维码内容 / 用户直接提交的原始 ID」（未经 hash）。
 *
 * 表结构由 initDb() 建出，CREATE ... IF NOT EXISTS 保证可反复执行；
 * 结构以这里的定义为准——本层不做任何补列、回填或迁移。
 *
 * 多实例前提（本轮改造）：
 *   - 运行态不在任何进程内存里，Postgres 是唯一事实来源；实例只保留可随时丢弃的读缓存
 *   - session_state.version 是每个场次的乐观锁凭据，所有状态提交都是
 *     「先 CAS 抢版本，再写快照」，抢不到就重新读取重试（写覆盖不可能发生）
 *   - 员工登录会话（staff_session）与登录限频（auth_throttle）同样落库，
 *     因此任一实例签发的 token 在任意实例都有效
 *   - 跨实例通知不经过数据库表，走 LISTEN/NOTIFY（见 pubsub.js），本层只负责写与读
 *
 * 连接串来源（优先级从高到低）：
 *   1. DATABASE_URL / PG_URL —— 完整连接串；**完整串优先**，避免残留的 PG_* 旧值
 *      悄悄盖掉新换的库（托管库如 Supabase 只给一条连接串）
 *   2. PG_HOST / PG_USER / PG_PASS —— 拆开的三个值，拼成
 *      postgresql://PG_USER:PG_PASS@PG_HOST:PG_PORT/PG_DB
 *      （PG_PORT 默认 5432，PG_DB 默认 postgres）
 *   3. 本地默认值
 *
 * 托管 PgBouncer（Supabase pooler）注意点：
 *   - pooler 强制 TLS，连接串没写 sslmode 时这里自动补 `sslmode=require`；
 *   - 事务模式 pooler（端口 6543）不支持 LISTEN/NOTIFY，长连接订阅必须走
 *     会话模式（同一主机 5432），见 resolveListenConnectionString()；
 *   - 事务模式下连接是被多客户端复用的，池子不宜开大：默认 max=5，
 *     用 PG_POOL_MAX 覆盖。
 */
const { Pool } = require('pg');

const LOCAL_DEFAULT_URL = 'postgres://postgres:postgres@localhost:5432/oddeven';

/** Supabase pooler 事务模式 / 会话模式端口。 */
const POOLER_TX_PORT = '6543';
const POOLER_SESSION_PORT = '5432';

let pool = null;

/** 由拆开的 PG_* 拼接连接串；主机/用户/密码缺一不可，否则返回 null 交由上层回退。 */
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

/** 当前生效的连接串（读写用，已保证托管库带 sslmode）。 */
function resolveConnectionString() {
  return ensureSslMode(
    process.env.DATABASE_URL ||
    process.env.PG_URL ||
    buildConnectionString() ||
    LOCAL_DEFAULT_URL
  );
}

/** 是否托管 pooler 主机（Supabase pooler 形如 aws-1-xxx.pooler.supabase.com）。 */
function isSupabasePooler(url) {
  const m = /^postgres(?:ql)?:\/\/[^/]*@([^/:?]+)/i.exec(url || '');
  return !!m && /\.supabase\.com$/i.test(m[1]);
}

/**
 * 托管库必须 TLS。连接串里已经写了 sslmode 就尊重用户的写法，
 * 否则补 `sslmode=require`（pg 会按 require 处理为「加密但不校验证书」）。
 */
function ensureSslMode(url) {
  if (!isSupabasePooler(url)) return url;
  if (/[?&]sslmode=/i.test(url)) return url;
  return url + (url.includes('?') ? '&' : '?') + 'sslmode=require';
}

/**
 * LISTEN/NOTIFY 专用的连接串（见 pubsub.js）。
 * 事务模式 pooler（6543）会把连接随机分给不同客户端，LISTEN 订阅注定失效，
 * 因此同一主机改走会话模式 5432；非 pooler 主机原样返回。
 */
function resolveListenConnectionString() {
  const url = resolveConnectionString();
  if (!isSupabasePooler(url)) return url;
  return url.replace(':' + POOLER_TX_PORT + '/', ':' + POOLER_SESSION_PORT + '/');
}

/** 日志用：抹掉连接串里的密码。 */
function maskUrl(url) {
  return String(url).replace(/^([a-z]+:\/\/[^:/@]+:)[^@]*@/i, '$1***@');
}

/** 懒加载连接池。池参数可用 PG_POOL_MAX 覆盖，方便本地/测试。 */
function getPool() {
  if (pool) return pool;
  const connectionString = resolveConnectionString();
  const max = Number(process.env.PG_POOL_MAX || 5);
  pool = new Pool({
    connectionString,
    max: Number.isFinite(max) && max > 0 ? max : 5,
    idleTimeoutMillis: 10000,       // pooler 会主动踢掉空闲连接，别攥太久
    connectionTimeoutMillis: 10000, // 跨区访问（如 ap-south-1）握手偏慢
    keepAlive: true
  });
  console.log('[db] 连接 ' + maskUrl(connectionString) + '（池上限 ' + pool.options.max + '）');
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
      submitted_count INTEGER NOT NULL DEFAULT 0, -- 本轮提交预测人数
      locked_by       TEXT    NOT NULL DEFAULT '' -- 锁定该轮开奖的账号（审计追溯用）
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

/** 审计表 append-only：审计要能当证据用，改得了就没意义。 */
async function initAuditTable(p) {
  for (const [name, ddl] of [
    ['trg_audit_log_no_update_delete', 'BEFORE UPDATE OR DELETE ON audit_log FOR EACH ROW'],
    ['trg_audit_log_no_truncate', 'BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT']
  ]) {
    await p.query(`DROP TRIGGER IF EXISTS ${name} ON audit_log;`);
    await p.query(
      `CREATE TRIGGER ${name} ${ddl} EXECUTE FUNCTION archive_block_mutation();`
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
      locked_at  BIGINT,                    -- 锁定时间戳（毫秒）
      locked_by  TEXT NOT NULL DEFAULT ''   -- 锁定人账号（null/空 = 未知/历史数据）
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

  // 场次状态版本号：多实例乐观锁的唯一凭据。
  // 每次状态提交都在事务里先做 `UPDATE ... WHERE version = $expected`，
  // 更新不到行就说明别的实例抢先提交过，调用方重新读取后重试（见 store.js）。
  // 只加不覆盖，版本号单调递增，可直接用作 SSE 的 Last-Event-ID。
  await p.query(`
    CREATE TABLE IF NOT EXISTS session_state (
      session_id TEXT PRIMARY KEY,          -- 所属场次
      version    BIGINT NOT NULL DEFAULT 1,  -- 状态版本号（每次提交 +1）
      updated_at BIGINT NOT NULL             -- 最近提交时间戳（毫秒）
    );
  `);

  // 员工登录会话：跨实例共享，任一实例签发的 token 在任意实例都有效。
  // 过期行按需清理（读取时顺手删），不做定时任务。
  await p.query(`
    CREATE TABLE IF NOT EXISTS staff_session (
      token      TEXT PRIMARY KEY,
      session_id TEXT NOT NULL DEFAULT '',  -- 该员工当前归属的场次
      expires_at BIGINT NOT NULL,           -- 过期时间戳（毫秒）
      created_at BIGINT NOT NULL,
      username   TEXT NOT NULL              -- 登录账号（鉴权与审计的唯一依据，必填）
    );
  `);
  await p.query('CREATE INDEX IF NOT EXISTS idx_staff_session_expires ON staff_session(expires_at);');

  // 员工账号：一个账号一份独立密码，角色区分「员工端」与「管理界面」。
  // 密码只存 scrypt 派生值（scrypt$N$r$p$salt$hash），永不存明文、不进日志、不下发。
  await p.query(`
    CREATE TABLE IF NOT EXISTS staff_account (
      username      TEXT PRIMARY KEY,          -- 登录账号（大小写敏感，建号时归一化校验）
      display_name  TEXT NOT NULL DEFAULT '',  -- 显示名（对账/日志里给人看）
      role          TEXT NOT NULL DEFAULT 'staff',  -- staff | admin
      status        TEXT NOT NULL DEFAULT 'active', -- active | disabled
      password_hash TEXT NOT NULL,             -- scrypt 派生值
      created_at    BIGINT NOT NULL,
      created_by    TEXT NOT NULL DEFAULT '',  -- 建号人账号（首个管理员为 bootstrap）
      updated_at    BIGINT NOT NULL,
      last_login_at BIGINT                     -- 最近登录时间（null = 从未登录）
    );
  `);
  await p.query('CREATE INDEX IF NOT EXISTS idx_staff_account_role ON staff_account(role, status);');

  // 操作日志：登录、切场次、锁定开奖、新一轮、关闭场次、账号变更、对账导出全部落这里。
  // 与归档表一样 append-only（触发器在 initAuditTable 里装），保证「谁做了什么」改不掉。
  await p.query(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id       BIGSERIAL PRIMARY KEY,
      at       BIGINT NOT NULL,               -- 发生时间（毫秒）
      actor    TEXT   NOT NULL DEFAULT '',    -- 操作账号（未登录的失败尝试写尝试名）
      role     TEXT   NOT NULL DEFAULT '',    -- 操作时角色
      action   TEXT   NOT NULL,               -- login / logout / round_lock / export ...
      sid      TEXT   NOT NULL DEFAULT '',    -- 相关场次
      target   TEXT   NOT NULL DEFAULT '',    -- 被操作对象（账号名 / 场次名 / 明细行数）
      detail   JSONB,                         -- 附加信息（不含任何密码）
      ip       TEXT   NOT NULL DEFAULT ''
    );
  `);
  await p.query('CREATE INDEX IF NOT EXISTS idx_audit_log_at ON audit_log (at DESC);');
  await p.query('CREATE INDEX IF NOT EXISTS idx_audit_log_actor ON audit_log (actor, at DESC);');

  // 登录 / 场次口令的错误计数：key = 'login:<账号>' | 'switch:<账号>' | 'player:<ip>'。
  // 放库里是为了让「连续 N 次错误锁 M 秒」在多实例下仍然是全局口径，
  // 而不是每个实例各算一遍（那样等于把阈值放大 N 倍）。
  await p.query(`
    CREATE TABLE IF NOT EXISTS auth_throttle (
      key          TEXT PRIMARY KEY,
      fails        INTEGER NOT NULL DEFAULT 0,
      locked_until BIGINT  NOT NULL DEFAULT 0,
      updated_at   BIGINT  NOT NULL
    );
  `);

  await p.query('CREATE INDEX IF NOT EXISTS idx_player_session ON player(session_id, registered_at);');
  await p.query('CREATE INDEX IF NOT EXISTS idx_round_session ON round(session_id);');
  await p.query('CREATE INDEX IF NOT EXISTS idx_session_status ON game_session(status, seq);');

  await initArchiveTables(p);
  await initAuditTable(p);
}

/* ============================================================
 * 运行态读写：快照 + 乐观锁
 * ------------------------------------------------------------
 * 每个场次的运行态由四张表拼成一份快照（round / player / identity / session_state）。
 * 读：一条 SQL 用 LATERAL 聚合出整场快照，避免多次查询之间出现撕裂读。
 * 写：同一事务内先 CAS 版本号，再写快照；版本被别的实例改过就整体回滚，
 *     由调用方重新读取后重试（store.js 的重试循环）。
 * 归档：在同一个事务里用 SAVEPOINT 包住，归档写失败只回滚归档这一段，
 *     锁定本身照常提交 —— 这与改造前「锁定生效但如实返回 archived:false」的语义一致。
 * ============================================================ */

/** 快照行 → 场次对象（与改造前内存里的结构完全一致，前端/SSE 负载不用改）。 */
function rowToSession(r) {
  const s = {
    id: r.session_id,
    name: r.name,
    status: r.status,
    seq: Number(r.seq),
    createdAt: Number(r.created_at),
    closedAt: r.closed_at != null ? Number(r.closed_at) : null,
    round: r.round_no != null ? Number(r.round_no) : 1,
    number: r.round_number != null ? Number(r.round_number) : null,
    lockedAt: r.locked_at != null ? Number(r.locked_at) : null,
    lockedBy: r.locked_by || '',
    players: {},
    identities: {},
    version: r.version != null ? Number(r.version) : 1
  };
  for (const p of r.players || []) {
    s.players[p.id] = {
      id: p.id,
      oddEven: p.odd_even,
      number: p.number != null ? Number(p.number) : null,
      registeredAt: Number(p.registered_at),
      submittedAt: p.submitted_at != null ? Number(p.submitted_at) : null,
      leftAt: p.left_at != null ? Number(p.left_at) : null
    };
  }
  for (const it of r.identities || []) {
    s.identities[it.id] = {
      lastSeenRound: Number(it.last_seen_round),
      completedRounds: Number(it.completed_rounds)
    };
  }
  return s;
}

const SNAPSHOT_SQL = `
  SELECT gs.session_id, gs.name, gs.status, gs.seq, gs.created_at, gs.closed_at,
         st.version AS version,
         r.round AS round_no, r.number AS round_number, r.locked_at, r.locked_by,
         pl.j AS players, idt.j AS identities
    FROM game_session gs
    LEFT JOIN session_state st ON st.session_id = gs.session_id
    LEFT JOIN round r ON r.session_id = gs.session_id
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
               'id', p.id, 'odd_even', p.odd_even, 'number', p.number,
               'registered_at', p.registered_at, 'submitted_at', p.submitted_at,
               'left_at', p.left_at) ORDER BY p.registered_at ASC) AS j
        FROM player p WHERE p.session_id = gs.session_id
    ) pl ON TRUE
    LEFT JOIN LATERAL (
      SELECT json_agg(json_build_object(
               'id', i.id, 'last_seen_round', i.last_seen_round,
               'completed_rounds', i.completed_rounds)) AS j
        FROM identity i WHERE i.session_id = gs.session_id
    ) idt ON TRUE
`;

/**
 * 读取单个场次的完整快照（含版本号）。不存在返回 null。
 * 若该场次没有 session_state 行（只能是被人工改动过），补一行版本 1，保证后续 CAS 有行可更。
 */
async function loadSessionSnapshot(sessionId) {
  const p = getPool();
  const r = await p.query(SNAPSHOT_SQL + ' WHERE gs.session_id = $1', [sessionId]);
  if (!r.rows.length) return null;
  const row = r.rows[0];
  if (row.version == null) {
    await p.query(
      `INSERT INTO session_state (session_id, version, updated_at) VALUES ($1, 1, $2)
       ON CONFLICT (session_id) DO NOTHING`,
      [sessionId, Date.now()]
    );
  }
  return rowToSession(row);
}

/**
 * 场次摘要列表（不含 players 明细）—— 列表页、准入判定、上限计数都用它。
 * 返回 [{ id, name, status, seq, createdAt, closedAt, round, number, lockedAt, playerCount, version }]。
 */
async function listSessionSummaries() {
  const p = getPool();
  const r = await p.query(`
    SELECT gs.session_id, gs.name, gs.status, gs.seq, gs.created_at, gs.closed_at,
           st.version, r.round AS round_no, r.number AS round_number, r.locked_at, r.locked_by,
           (SELECT count(*)::int FROM player p WHERE p.session_id = gs.session_id) AS player_count
      FROM game_session gs
      LEFT JOIN session_state st ON st.session_id = gs.session_id
      LEFT JOIN round r ON r.session_id = gs.session_id
     ORDER BY gs.seq ASC, gs.created_at ASC
  `);
  return r.rows.map((x) => ({
    id: x.session_id,
    name: x.name,
    status: x.status,
    seq: Number(x.seq),
    createdAt: Number(x.created_at),
    closedAt: x.closed_at != null ? Number(x.closed_at) : null,
    round: x.round_no != null ? Number(x.round_no) : 1,
    number: x.round_number != null ? Number(x.round_number) : null,
    lockedAt: x.locked_at != null ? Number(x.locked_at) : null,
    lockedBy: x.locked_by || '',
    playerCount: Number(x.player_count || 0),
    version: x.version != null ? Number(x.version) : 1
  }));
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
        locked_at, archived_at, player_count, submitted_count, locked_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (session_id, round) DO NOTHING
     RETURNING archive_id`,
    [
      session.id, session.name, Number(session.seq) || 1, session.round,
      session.number, oddEven, session.lockedAt, now, players.length, submitted,
      session.lockedBy || ''
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

/** 全局锁键：新建场次时用它把「数上限 + 分配序号 + 插入」串成临界区（跨实例）。 */
const SESSION_CREATE_LOCK = 882014501;

/** 把快照里的玩家数组摊成批量写入用的并列数组。 */
function playerColumns(players) {
  const ids = [];
  const rounds = [];
  const oes = [];
  const nums = [];
  const regs = [];
  const subs = [];
  const lefts = [];
  for (const pl of players) {
    ids.push(pl.id);
    rounds.push(pl.round);
    oes.push(pl.oddEven);
    nums.push(pl.number);
    regs.push(pl.registeredAt);
    subs.push(pl.submittedAt != null ? pl.submittedAt : null);
    lefts.push(pl.leftAt != null ? pl.leftAt : null);
  }
  return { ids, rounds, oes, nums, regs, subs, lefts };
}

/**
 * 提交一个场次的完整快照 —— 多实例下唯一的状态写入口。
 *
 * 事务结构（顺序即正确性）：
 *   1. CAS：`UPDATE session_state SET version = version + 1 WHERE session_id = $1 AND version = $2`
 *      更新不到行 → 说明别的实例在这期间提交过，整体回滚并返回 { conflict: true }
 *      （此后的快照写入根本不会执行，所以不存在「盖掉别人写入」的可能）
 *   2. 抢到版本后再写 game_session / round / player / identity
 *   3. 归档用 SAVEPOINT 隔开：归档失败只回滚归档这一段，锁定照常提交，
 *      调用方据此返回 archived:false（可稍后由 archive-sync 补齐）
 *
 * 玩家行改成「批量 unnest upsert + 删掉不在快照里的行」：
 * 一场 N 人从 N 条 SQL 降到 2 条，锁持有时间不再随人数线性增长（多实例下这点很关键）。
 *
 * 返回：
 *   成功 { ok: true, version, archived, archiveError }
 *   冲突 { ok: false, conflict: true }
 */
async function commitSnapshot(sessionId, expectedVersion, session) {
  const p = getPool();
  const client = await p.connect();
  const now = Date.now();
  let archived = false;
  let archiveError = null;

  try {
    await client.query('BEGIN');

    // 1. 抢版本（乐观锁）。先抢再写，避免半场数据落库。
    const cas = await client.query(
      `UPDATE session_state
          SET version = version + 1, updated_at = $2
        WHERE session_id = $1 AND version = $3
        RETURNING version`,
      [sessionId, now, expectedVersion]
    );
    if (!cas.rowCount) {
      await client.query('ROLLBACK');
      return { ok: false, conflict: true };
    }
    const version = Number(cas.rows[0].version);

    // 2. 元信息 + 轮次 + 玩家 + 身份档案
    await client.query(
      `INSERT INTO game_session (session_id, name, status, seq, created_at, closed_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (session_id) DO UPDATE SET
         name=EXCLUDED.name, status=EXCLUDED.status, seq=EXCLUDED.seq,
         closed_at=EXCLUDED.closed_at`,
      [session.id, session.name, session.status, session.seq, session.createdAt, session.closedAt]
    );

    await client.query(
      `INSERT INTO round (session_id, round, number, locked_at, locked_by) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (session_id) DO UPDATE SET
         round=EXCLUDED.round, number=EXCLUDED.number, locked_at=EXCLUDED.locked_at,
         locked_by=EXCLUDED.locked_by`,
      [session.id, session.round, session.number, session.lockedAt, session.lockedBy || '']
    );

    const players = Object.values(session.players).map((pl) => ({
      ...pl,
      round: session.round
    }));
    const cols = playerColumns(players);

    // 快照里没有的玩家行要删掉（reset 清场就靠这一句）
    await client.query(
      'DELETE FROM player WHERE session_id = $1 AND NOT (id = ANY($2::text[]))',
      [session.id, cols.ids]
    );

    if (players.length) {
      await client.query(
        `INSERT INTO player
           (session_id, id, round, odd_even, number, registered_at, submitted_at, left_at)
         SELECT $1, u.id, u.round, u.odd_even, u.number, u.registered_at, u.submitted_at, u.left_at
           FROM unnest($2::text[], $3::int[], $4::text[], $5::int[],
                       $6::bigint[], $7::bigint[], $8::bigint[])
             AS u(id, round, odd_even, number, registered_at, submitted_at, left_at)
         ON CONFLICT (session_id, id) DO UPDATE SET
           round=EXCLUDED.round, odd_even=EXCLUDED.odd_even, number=EXCLUDED.number,
           submitted_at=EXCLUDED.submitted_at, left_at=EXCLUDED.left_at`,
        [session.id, cols.ids, cols.rounds, cols.oes, cols.nums, cols.regs, cols.subs, cols.lefts]
      );
    }

    const identities = Object.entries(session.identities).map(([id, it]) => ({
      id,
      lastSeenRound: it.lastSeenRound,
      completedRounds: it.completedRounds || 0
    }));
    if (identities.length) {
      await client.query(
        `INSERT INTO identity
           (session_id, id, last_seen_round, completed_rounds, created_at, updated_at)
         SELECT $1, u.id, u.last_seen_round, u.completed_rounds, $2, $2
           FROM unnest($3::text[], $4::int[], $5::int[]) AS u(id, last_seen_round, completed_rounds)
         ON CONFLICT (session_id, id) DO UPDATE SET
           last_seen_round=EXCLUDED.last_seen_round,
           completed_rounds=EXCLUDED.completed_rounds,
           updated_at=EXCLUDED.updated_at`,
        [session.id, now, identities.map((x) => x.id),
          identities.map((x) => x.lastSeenRound), identities.map((x) => x.completedRounds)]
      );
    }

    // 3. 归档：只有 INSERT，没有 DELETE / UPDATE。
    // reset 走的是同一条路径，它清的是 round / player，碰不到归档表。
    if (session.number != null && session.lockedAt != null) {
      await client.query('SAVEPOINT archive_write');
      try {
        await archiveRoundInTx(client, session);
        archived = true;
      } catch (e) {
        // 归档写不进去（表缺失 / 磁盘满 / 触发器异常）不能让锁定白做：
        // 回滚归档这一段，锁定继续提交，由调用方返回 archived:false。
        await client.query('ROLLBACK TO SAVEPOINT archive_write');
        archiveError = e.message;
        console.error('[db] 归档写入失败 sid=' + session.id + ' round=' + session.round + ': ' + e.message);
      }
    }

    await client.query('COMMIT');
    return { ok: true, version, archived, archiveError };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* 连接已断 */ }
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }
}

/**
 * 新建场次：跨实例临界区。
 * 在全局 advisory lock 内「数进行中场次 → 分配序号 → 插入」，因此两台实例同时点「新建」
 * 也不会突破上限、不会撞序号。名称留空时按序号自动命名（与员工端默认名一致）。
 *
 * 返回 { ok:true, session } / { ok:false, code:'session_limit', open } / { ok:false, error }
 */
async function createSessionRow({ id, name, maxOpen }) {
  const p = getPool();
  const client = await p.connect();
  const now = Date.now();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [SESSION_CREATE_LOCK]);

    const cnt = await client.query("SELECT count(*)::int AS n FROM game_session WHERE status = 'open'");
    const open = cnt.rows[0].n;
    if (open >= maxOpen) {
      await client.query('ROLLBACK');
      return { ok: false, code: 'session_limit', open };
    }

    const seqRes = await client.query('SELECT coalesce(max(seq), 0)::int AS s FROM game_session');
    const seq = Number(seqRes.rows[0].s) + 1;
    const finalName = name || '第 ' + seq + ' 场';

    await client.query(
      `INSERT INTO game_session (session_id, name, status, seq, created_at, closed_at)
       VALUES ($1,$2,'open',$3,$4,NULL)`,
      [id, finalName, seq, now]
    );
    await client.query(
      'INSERT INTO session_state (session_id, version, updated_at) VALUES ($1, 1, $2)',
      [id, now]
    );
    await client.query(
      'INSERT INTO round (session_id, round, number, locked_at) VALUES ($1, 1, NULL, NULL)',
      [id]
    );

    await client.query('COMMIT');
    return { ok: true, session: { id, name: finalName, seq } };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    return { ok: false, error: e.message, code: e.code };
  } finally {
    client.release();
  }
}

/**
 * 单独把某个场次「已锁定但未归档」的轮次补写进归档表（幂等）。
 * 不碰运行态、不递增版本号：它只追加归档，供 archive-sync / 启动补齐 / reset 前兜底使用。
 * 冲突由唯一索引 + ON CONFLICT DO NOTHING 吸收，多实例同时补写不会产生第二份。
 */
async function archiveSnapshot(session) {
  if (session.number == null || session.lockedAt == null) return { ok: true, skipped: true };
  const p = getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', ['archive:' + session.id]);
    await archiveRoundInTx(client, session);
    await client.query('COMMIT');
    return { ok: true };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) { /* ignore */ }
    console.error('[db] 归档补写失败 sid=' + session.id + ' round=' + session.round + ': ' + e.message);
    return { ok: false, error: e.message };
  } finally {
    client.release();
  }
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
 * 员工账号 + 登录会话（跨实例共享）
 * ------------------------------------------------------------
 * 改造前是「一个共享密码 → token」，谁登进来都分不清是谁；
 * 现在是「账号 + 独立密码 → token」，会话里带账号，审计才追得下去。
 * token 仍落库：A 实例签发、B 实例认可，实例重启也不掉登录。
 * ============================================================ */

/** 账号行 → 对外结构（**不含 password_hash**，接口与日志都用它）。 */
function rowToAccount(r) {
  return {
    username: r.username,
    displayName: r.display_name || '',
    role: r.role,
    status: r.status,
    createdAt: Number(r.created_at),
    createdBy: r.created_by || '',
    updatedAt: Number(r.updated_at),
    lastLoginAt: r.last_login_at != null ? Number(r.last_login_at) : null
  };
}

async function listAccounts() {
  const r = await getPool().query(
    `SELECT username, display_name, role, status, created_at, created_by, updated_at, last_login_at
       FROM staff_account ORDER BY role DESC, username ASC`
  );
  return r.rows.map(rowToAccount);
}

/** 取账号（含密码派生值），只给登录校验用；不要把它返回给任何接口。 */
async function getAccountWithSecret(username) {
  const r = await getPool().query(
    `SELECT username, display_name, role, status, password_hash,
            created_at, created_by, updated_at, last_login_at
       FROM staff_account WHERE username = $1`,
    [username]
  );
  if (!r.rows.length) return null;
  return { ...rowToAccount(r.rows[0]), passwordHash: r.rows[0].password_hash };
}

async function countAccounts(filter = {}) {
  const params = [];
  const where = [];
  if (filter.role) { params.push(filter.role); where.push('role = $' + params.length); }
  if (filter.status) { params.push(filter.status); where.push('status = $' + params.length); }
  const r = await getPool().query(
    'SELECT count(*)::int AS n FROM staff_account' + (where.length ? ' WHERE ' + where.join(' AND ') : ''),
    params
  );
  return r.rows[0].n;
}

async function createAccount({ username, displayName, role, passwordHash, createdBy }) {
  const now = Date.now();
  await getPool().query(
    `INSERT INTO staff_account
       (username, display_name, role, status, password_hash, created_at, created_by, updated_at)
     VALUES ($1,$2,$3,'active',$4,$5,$6,$5)`,
    [username, displayName || '', role, passwordHash, now, createdBy || '']
  );
}

/** 改显示名 / 角色 / 状态。未传的字段保持原值。 */
async function updateAccount(username, fields) {
  const sets = [];
  const params = [username];
  const push = (col, val) => { params.push(val); sets.push(col + ' = $' + params.length); };
  if (fields.displayName !== undefined) push('display_name', fields.displayName);
  if (fields.role !== undefined) push('role', fields.role);
  if (fields.status !== undefined) push('status', fields.status);
  if (!sets.length) return;
  params.push(Date.now());
  sets.push('updated_at = $' + params.length);
  await getPool().query(
    'UPDATE staff_account SET ' + sets.join(', ') + ' WHERE username = $1',
    params
  );
}

async function setAccountPassword(username, passwordHash) {
  await getPool().query(
    'UPDATE staff_account SET password_hash = $2, updated_at = $3 WHERE username = $1',
    [username, passwordHash, Date.now()]
  );
}

async function touchAccountLogin(username) {
  await getPool().query(
    'UPDATE staff_account SET last_login_at = $2 WHERE username = $1',
    [username, Date.now()]
  );
}

/**
 * 签发登录会话。账号必填——会话的有效性与角色一律回查 staff_account，
 * 因此停用账号或调整角色立即生效，不必等 token 过期。
 */
async function createStaffSession(token, sessionId, expiresAt, username) {
  await getPool().query(
    `INSERT INTO staff_session (token, session_id, expires_at, created_at, username)
     VALUES ($1, $2, $3, $4, $5)`,
    [token, sessionId || '', expiresAt, Date.now(), username]
  );
}

/**
 * 取有效会话（过期 / 账号已停用 一律视为未登录）。
 * 返回 { token, sessionId, expiresAt, username, role, displayName } 或 null。
 * 角色以账号表当前值为准，不是签发时的快照——降级立即生效。
 */
async function getStaffSession(token) {
  if (!token) return null;
  const p = getPool();
  const now = Date.now();
  const r = await p.query(
    `SELECT s.token, s.session_id, s.expires_at, s.username,
            a.display_name, a.role, a.status
       FROM staff_session s
       JOIN staff_account a ON a.username = s.username
      WHERE s.token = $1 AND s.expires_at > $2`,
    [token, now]
  );
  if (!r.rows.length) {
    p.query('DELETE FROM staff_session WHERE token = $1 AND expires_at <= $2', [token, now])
      .catch(() => { /* 清理失败不影响判定 */ });
    return null;
  }
  const row = r.rows[0];
  if (row.status !== 'active') {
    p.query('DELETE FROM staff_session WHERE token = $1', [token])
      .catch(() => { /* 清理失败不影响判定 */ });
    return null;
  }
  return {
    token: row.token,
    sessionId: row.session_id || '',
    expiresAt: Number(row.expires_at),
    username: row.username,
    role: row.role,
    displayName: row.display_name || ''
  };
}

/** 踢掉某个账号的所有会话（改密码 / 停用 / 降级时用，立即生效）。 */
async function deleteStaffSessionsByUser(username) {
  if (!username) return 0;
  const r = await getPool().query('DELETE FROM staff_session WHERE username = $1', [username]);
  return r.rowCount || 0;
}

async function deleteStaffSession(token) {
  if (!token) return;
  await getPool().query('DELETE FROM staff_session WHERE token = $1', [token]);
}

/** 改绑某个员工会话的场次归属（切换场次 / 场次关闭后回退）。 */
async function setStaffSessionScope(token, sessionId) {
  await getPool().query(
    'UPDATE staff_session SET session_id = $2 WHERE token = $1',
    [token, sessionId || '']
  );
}

/** 场次关闭后，把所有归属该场次的员工会话统一改绑到下一个场次。 */
async function rebindStaffSessions(fromSid, toSid) {
  await getPool().query(
    'UPDATE staff_session SET session_id = $2 WHERE session_id = $1',
    [fromSid, toSid || '']
  );
}

/* ============================================================
 * 登录 / 口令错误限频（跨实例共享）
 * ------------------------------------------------------------
 * key = 'staff' 或 'player:<ip>'。放在库里是为了让「连续 N 次错锁 M 秒」
 * 在多实例下仍是全局口径，而不是每台实例各算一遍（那等于把阈值放大 N 倍）。
 * ============================================================ */

/** 当前计数与锁定状态。 */
async function throttleState(key) {
  const r = await getPool().query(
    'SELECT fails, locked_until FROM auth_throttle WHERE key = $1',
    [key]
  );
  if (!r.rows.length) return { fails: 0, lockedUntil: 0 };
  return { fails: Number(r.rows[0].fails), lockedUntil: Number(r.rows[0].locked_until) };
}

/**
 * 记一次失败。达到阈值即锁定，计数归零（与改造前的语义一致：
 * 锁定期间不再继续累加，锁满一轮重新从 0 开始数）。
 * 返回记完之后的状态。
 */
async function throttleFail(key, maxFails, lockMs) {
  const now = Date.now();
  const r = await getPool().query(
    `INSERT INTO auth_throttle (key, fails, locked_until, updated_at)
     VALUES ($1, 1, 0, $2)
     ON CONFLICT (key) DO UPDATE SET
       fails = CASE
                 WHEN auth_throttle.locked_until > $2 THEN auth_throttle.fails
                 WHEN auth_throttle.fails + 1 >= $3 THEN 0
                 ELSE auth_throttle.fails + 1
               END,
       locked_until = CASE
                 WHEN auth_throttle.locked_until > $2 THEN auth_throttle.locked_until
                 WHEN auth_throttle.fails + 1 >= $3 THEN $2 + $4
                 ELSE 0
               END,
       updated_at = $2
     RETURNING fails, locked_until`,
    [key, now, maxFails, lockMs]
  );
  return { fails: Number(r.rows[0].fails), lockedUntil: Number(r.rows[0].locked_until) };
}

/** 清空某个 key 的失败计数（验证通过时调用）。 */
async function throttleClear(key) {
  await getPool().query('DELETE FROM auth_throttle WHERE key = $1', [key]);
}


/* ============================================================
 * 操作日志（append-only）
 * ------------------------------------------------------------
 * 只写不改：谁登入、谁切了场次、谁锁定了哪一轮、谁导出了哪份对账。
 * detail 里绝不放密码、口令、token —— 只放业务字段（数字、场次名、CSV 行数等）。
 * 写入失败不能拖累主流程：调用方一律 fire-and-forget + 本地 console.error。
 * ============================================================ */

async function appendAudit(e) {
  await getPool().query(
    `INSERT INTO audit_log (at, actor, role, action, sid, target, detail, ip)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [
      e.at || Date.now(),
      e.actor || '',
      e.role || '',
      e.action,
      e.sid || '',
      e.target || '',
      e.detail == null ? null : JSON.stringify(e.detail),
      e.ip || ''
    ]
  );
}

/**
 * 查日志（新的在前）。from/to 为毫秒半开区间；actor 为精确匹配。
 * limit 默认 200、上限 1000（导出走的是另一个函数，不吃这个上限）。
 */
async function listAudit({ from, to, actor, action, limit } = {}) {
  const params = [];
  const where = [];
  if (from != null) { params.push(from); where.push('at >= $' + params.length); }
  if (to != null) { params.push(to); where.push('at < $' + params.length); }
  if (actor) { params.push(actor); where.push('actor = $' + params.length); }
  if (action) { params.push(action); where.push('action = $' + params.length); }
  const n = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  params.push(n);
  const r = await getPool().query(
    `SELECT id, at, actor, role, action, sid, target, detail, ip
       FROM audit_log` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ` ORDER BY at DESC, id DESC LIMIT $${params.length}`,
    params
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    at: Number(x.at),
    actor: x.actor,
    role: x.role,
    action: x.action,
    sid: x.sid || '',
    target: x.target || '',
    detail: x.detail || null,
    ip: x.ip || ''
  }));
}

/** 导出用：区间内全量（新的在前），不分页。 */
async function allAudit({ from, to, actor, action } = {}) {
  const params = [];
  const where = [];
  if (from != null) { params.push(from); where.push('at >= $' + params.length); }
  if (to != null) { params.push(to); where.push('at < $' + params.length); }
  if (actor) { params.push(actor); where.push('actor = $' + params.length); }
  if (action) { params.push(action); where.push('action = $' + params.length); }
  const r = await getPool().query(
    `SELECT id, at, actor, role, action, sid, target, detail, ip FROM audit_log` +
    (where.length ? ' WHERE ' + where.join(' AND ') : '') +
    ' ORDER BY at DESC, id DESC',
    params
  );
  return r.rows.map((x) => ({
    id: Number(x.id),
    at: Number(x.at),
    actor: x.actor,
    role: x.role,
    action: x.action,
    sid: x.sid || '',
    target: x.target || '',
    detail: x.detail || null,
    ip: x.ip || ''
  }));
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
           locked_at, archived_at, player_count, submitted_count, locked_by
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
           a.odd_even AS drawn_odd_even, a.locked_at, a.archived_at, a.locked_by,
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
  getPool,
  lineOfNumber,

  // 连接串解析（pubsub 需要一条独立的 LISTEN 长连接）
  resolveConnectionString,
  resolveListenConnectionString,
  maskUrl,

  // 运行态（快照 + 乐观锁）
  loadSessionSnapshot,
  listSessionSummaries,
  commitSnapshot,
  createSessionRow,
  archiveSnapshot,

  // 员工账号 / 会话
  listAccounts,
  getAccountWithSecret,
  countAccounts,
  createAccount,
  updateAccount,
  setAccountPassword,
  touchAccountLogin,
  createStaffSession,
  getStaffSession,
  deleteStaffSessionsByUser,
  deleteStaffSession,
  setStaffSessionScope,
  rebindStaffSessions,

  // 操作日志
  appendAudit,
  listAudit,
  allAudit,

  // 限频
  throttleState,
  throttleFail,
  throttleClear,

  // 配置
  getConfig,
  setConfig,

  // 归档读取
  archiveExists,
  archiveSummary,
  archiveRoundRows,
  archiveEntryRows
};
