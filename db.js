/**
 * db.js — Postgres 持久化层
 * ------------------------------------------------------------
 * 用 pg 连接池替换原 game-data.json 文件持久化，保证应用重启后数据仍在。
 *
 * 数据实体与表结构（均含时间戳）：
 *   - round      当前轮次状态（开奖数字、锁定时间）
 *   - player     每轮每个玩家的登记与预测（登记/提交/最后扫码时间）
 *   - identity   跨轮次玩家身份档案（首次出现/最近出现时间）
 *   - scan_log   扫码审计日志（ts 时间戳）
 *
 * 连接通过环境变量 DATABASE_URL 提供（Fly.io Postgres 会在 secrets 中注入）。
 */
const { Pool } = require('pg');

let pool = null;

/** 懒加载连接池。配置允许通过独立环境变量覆盖，方便本地/测试。 */
function getPool() {
  if (pool) return pool;
  const connectionString =
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

/**
 * 幂等建表：首次启动时自动创建所需表。字段注释见每张表。
 * 所有时间戳统一存毫秒（BIGINT），与现有 state 里的 Date.now() 语义一致。
 */
async function initDb() {
  const p = getPool();
  await p.query(`
    CREATE TABLE IF NOT EXISTS round (
      id         SERIAL PRIMARY KEY,
      round      INTEGER NOT NULL,          -- 当前轮次序号
      number     INTEGER,                   -- 开奖数字（null 表示未锁定）
      locked_at  BIGINT,                    -- 锁定时间戳（毫秒）
      updated_at BIGINT NOT NULL            -- 状态最近变更时间戳（毫秒）
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS player (
      id            TEXT PRIMARY KEY,       -- 二维码内容 SHA-256 哈希（唯一玩家 ID）
      round         INTEGER NOT NULL,       -- 所属轮次
      qr_preview    TEXT,                   -- 二维码内容预览（截断显示用）
      name          TEXT,                   -- 玩家显示名
      odd_even      TEXT,                   -- 预测单/双（null 表示未提交）
      number        INTEGER,                -- 预测数字
      registered_at BIGINT NOT NULL,        -- 登记时间戳（毫秒）
      submitted_at  BIGINT,                 -- 提交预测时间戳（毫秒）
      scan_count    INTEGER NOT NULL DEFAULT 1,
      last_scan_at  BIGINT                  -- 最后扫码时间戳（毫秒）
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS identity (
      id               TEXT PRIMARY KEY,    -- 二维码内容 SHA-256 哈希
      last_seen_round  INTEGER NOT NULL,    -- 最近出现的轮次
      last_name        TEXT,                -- 最近使用的称呼
      total_scans      INTEGER NOT NULL DEFAULT 0,
      completed_rounds INTEGER NOT NULL DEFAULT 0,
      created_at       BIGINT NOT NULL,     -- 首次建档时间戳（毫秒）
      updated_at       BIGINT NOT NULL      -- 最近更新时间戳（毫秒）
    );
  `);
  await p.query(`
    CREATE TABLE IF NOT EXISTS scan_log (
      id       BIGSERIAL PRIMARY KEY,
      ts       BIGINT NOT NULL,             -- 扫码时间戳（毫秒）
      round    INTEGER NOT NULL,            -- 当时轮次
      player_id TEXT,                       -- 玩家 ID 哈希
      id_short TEXT,                        -- 玩家 ID 前 8 位（显示用）
      result   TEXT NOT NULL                -- new|known|known_no_name|rejected_locked
    );
  `);
  await p.query('CREATE INDEX IF NOT EXISTS idx_player_round ON player(round);');
  await p.query('CREATE INDEX IF NOT EXISTS idx_scan_log_ts ON scan_log(ts DESC);');
  await p.query('CREATE INDEX IF NOT EXISTS idx_scan_log_round ON scan_log(round);');
}

const SCAN_LOG_MAX = 500; // 扫码日志条数上限（与 server.js 保持一致）

/**
 * 从数据库加载全量状态到内存（结构对齐原 state 对象）。
 * round 表取最大轮次；player/identity/scan_log 全部读回。
 */
async function loadState() {
  const p = getPool();

  const roundRes = await p.query('SELECT round, number, locked_at FROM round ORDER BY round DESC LIMIT 1');
  const row = roundRes.rows[0];
  const round = row ? row.round : 1;
  const number = row && row.number != null ? row.number : null;
  const lockedAt = row ? row.locked_at : null;

  const playersRes = await p.query('SELECT * FROM player ORDER BY registered_at ASC');
  const players = {};
  for (const r of playersRes.rows) {
    players[r.id] = {
      id: r.id,
      qrPreview: r.qr_preview,
      name: r.name,
      oddEven: r.odd_even,
      number: r.number,
      registeredAt: Number(r.registered_at),
      submittedAt: r.submitted_at != null ? Number(r.submitted_at) : null,
      scanCount: r.scan_count,
      lastScanAt: r.last_scan_at != null ? Number(r.last_scan_at) : null
    };
  }

  const idtRes = await p.query('SELECT * FROM identity');
  const identities = {};
  for (const r of idtRes.rows) {
    identities[r.id] = {
      lastSeenRound: r.last_seen_round,
      lastName: r.last_name,
      totalScans: r.total_scans,
      completedRounds: r.completed_rounds
    };
  }

  const logRes = await p.query('SELECT ts, round, player_id, id_short, result FROM scan_log ORDER BY ts ASC');
  const scanLog = logRes.rows.map((r) => ({
    ts: Number(r.ts),
    round: r.round,
    id: r.player_id,
    idShort: r.id_short,
    result: r.result
  }));

  return { round, number, lockedAt, players, identities, scanLog };
}

/**
 * 持久化全量状态。为简化事务边界与保证一致性，采用「同事务内清空 + 重写」策略。
 * 数据量小（单轮玩家 + 限长日志），整表重写足够且简单可靠。
 */
async function saveState(state) {
  const p = getPool();
  const client = await p.connect();
  const now = Date.now();
  try {
    await client.query('BEGIN');

    // round：仅保留一行，记录当前轮次状态
    await client.query('DELETE FROM round');
    await client.query(
      'INSERT INTO round (round, number, locked_at, updated_at) VALUES ($1,$2,$3,$4)',
      [state.round, state.number, state.lockedAt, now]
    );

    // player：本轮玩家（reset 时已清空，这里全量覆盖）
    await client.query('DELETE FROM player');
    for (const id of Object.keys(state.players)) {
      const pl = state.players[id];
      await client.query(
        `INSERT INTO player
           (id, round, qr_preview, name, odd_even, number,
            registered_at, submitted_at, scan_count, last_scan_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         ON CONFLICT (id) DO UPDATE SET
           round=EXCLUDED.round, qr_preview=EXCLUDED.qr_preview, name=EXCLUDED.name,
           odd_even=EXCLUDED.odd_even, number=EXCLUDED.number,
           submitted_at=EXCLUDED.submitted_at, scan_count=EXCLUDED.scan_count,
           last_scan_at=EXCLUDED.last_scan_at`,
        [pl.id, state.round, pl.qrPreview, pl.name, pl.oddEven, pl.number,
         pl.registeredAt, pl.submittedAt, pl.scanCount, pl.lastScanAt]
      );
    }

    // identity：跨轮次档案（reset 时保留，需用 upsert 而非全删，否则历史丢失）
    for (const id of Object.keys(state.identities)) {
      const it = state.identities[id];
      await client.query(
        `INSERT INTO identity
           (id, last_seen_round, last_name, total_scans, completed_rounds, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET
           last_seen_round=EXCLUDED.last_seen_round, last_name=EXCLUDED.last_name,
           total_scans=EXCLUDED.total_scans, completed_rounds=EXCLUDED.completed_rounds,
           updated_at=EXCLUDED.updated_at`,
        [id, it.lastSeenRound, it.lastName, it.totalScans, it.completedRounds, now, now]
      );
    }

    // scan_log：限长日志，全量覆盖（超出上限丢弃最旧）
    await client.query('DELETE FROM scan_log');
    const logs = state.scanLog.slice(-SCAN_LOG_MAX);
    for (const l of logs) {
      await client.query(
        'INSERT INTO scan_log (ts, round, player_id, id_short, result) VALUES ($1,$2,$3,$4,$5)',
        [l.ts, l.round, l.id, l.idShort, l.result]
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

module.exports = { initDb, loadState, saveState, getPool };
