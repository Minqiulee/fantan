/**
 * 单双竞猜 · 多场次（1–4）本地实现（无任何第三方依赖）
 * ------------------------------------------------------------
 * 规则核心：本轮数字由工作人员在网页外抽取（抽签/抽卡等），
 * 本服务只负责「录入、校验、锁定与分发」，绝不在服务端或前端
 * 随机生成或抽取该数字。
 *
 * 场次模型：一个运行实例可同时承载 1–4 个场次（session）。
 *   - 场次是独立的一等实体，拥有自己的轮次、玩家、身份档案与版本号
 *   - round / player / identity 全部带 session_id，读写、查询与业务判定
 *     一律先定位场次，场次之间不共享任何可变状态
 *   - SSE 连接按场次分组，状态变更只广播给该场次的客户端
 *   - 员工端可在运行时新建 / 切换 / 关闭场次，不改配置、不重启服务
 *
 * 玩家端场次门禁：≥2 场并行时，玩家「选择 / 切换场次」必须输入口令。
 *   - 口令只以 scrypt 哈希 + 随机盐存在进程内存，不落库、不下发、不进日志
 *   - 验证通过后签发绑定令牌（sid + 过期时间的 HMAC-SHA256，密钥存 app_config）
 *   - 服务端一律以令牌里的场次为准：请求里的 sid 与绑定不符会被拒（session_locked），
 *     因此改 URL / 本地存储都换不了场次；令牌 12 小时过期，过期后需重新验证
 *   - 只有「唯一进行中场次」时允许免口令自动绑定（此时不存在选错场的可能）
 *
 * 身份模型：玩家自带二维码或直接提交原始 ID，页面识别后，
 * 以「原始内容」直接作为玩家唯一 ID（不做 hash）：
 *   - players 按 ID 存储本轮登记与预测（每个场次各一份）
 *   - identities 在场次内跨轮次记住每个 ID 的完整竞猜轮次（判定老玩家）
 *
 * 持久化：状态存 Postgres（见 db.js），应用重启后数据仍在。
 * 需要 PG_HOST / PG_USER / PG_PASS 三个 secret 提供连接信息（见 db.js），
 * 端口和库名可用 PG_PORT / PG_DB 覆盖（默认 5432 / postgres），
 * 或直接用 DATABASE_URL 给出完整连接串。
 *
 * 运行：node server.js （默认 3000 端口，可用 PORT 环境变量覆盖）
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const QR_MAX_LEN = 512;   // 二维码/原始 ID 内容长度上限
const SESSION_TTL = 12 * 60 * 60 * 1000; // 员工端会话有效期：12 小时
const DEFAULT_PASSWORD = '123456';       // 默认员工端密码（可用 STAFF_PASSWORD 环境变量覆盖）
const MAX_SESSIONS = 4;                  // 单实例同时进行的场次上限
const MAX_SESSION_NAME = 24;             // 场次名称长度上限
const DEFAULT_PLAYER_PASSWORD = '8888';  // 默认玩家端场次口令（可用 PLAYER_SESSION_PASSWORD 覆盖）
const PLAYER_BIND_TTL = 12 * 60 * 60 * 1000; // 玩家场次绑定有效期：12 小时
const UNLOCK_MAX_FAILS = 5;              // 连续口令错误次数上限
const UNLOCK_LOCK_MS = 30 * 1000;        // 超限后锁定时长

/* 归档对账的「当日」口径：按固定时区偏移切分自然日（默认 +08:00，港/深/澳无夏令时）。
 * 汇总与导出都只认 locked_at（锁定时间）这一个时间轴，与建档/提交时间无关。 */
const ARCHIVE_TZ_OFFSET_MIN = (() => {
  const raw = process.env.ARCHIVE_TZ_OFFSET_MIN;
  if (raw == null || String(raw).trim() === '') return 480;
  const n = Number(raw);
  // 合法范围：-12h ~ +14h，越界按默认处理，避免口径被误配置整体挪一天
  return Number.isFinite(n) && Math.abs(n) <= 14 * 60 ? n : 480;
})();
const DAY_MS = 24 * 60 * 60 * 1000;

/* ---------------- 玩家端场次口令与绑定 ---------------- */

/** 玩家端口令：只保留 scrypt 哈希与随机盐（内存态，不落库、不进日志、不下发）。
 *  用于「选择 / 切换场次」这一动作的门禁。 */
let playerPwSalt = null;
let playerPwHash = null;

/** 绑定令牌的 HMAC 签名密钥：随机生成后存 DB（app_config），
 *  这样服务重启后玩家的绑定仍然有效，而仓库与配置里都没有任何密钥明文。 */
let bindSecret = null;

/** 口令错误限频：按来源 IP 计数，避免一个玩家把所有人锁死。 */
const unlockFails = new Map(); // ip -> { fails, until }

/* 员工端权限：密码哈希 + 会话表（内存态，服务重启即失效，需重新登录）。
 * 每个员工会话额外记住自己当前归属的场次，切换场次只改这个绑定。 */
let staffPasswordHash = null;
let failedAttempts = 0;
let lockedUntil = 0;
const staffSessions = new Map(); // token -> { expiresAt, sessionId }

/* ---------------- 场次 ---------------- */

/** 运行时场次表：session_id -> 场次对象。 */
const gameSessions = new Map();

/**
 * 场次对象结构：
 * {
 *   id, name, seq, status: 'open'|'closed', createdAt, closedAt,
 *   round, number, lockedAt,           // 场次内轮次状态（number 非 null 即已锁定）
 *   players: { [pid]: {...} },         // 本场次本轮的玩家
 *   identities: { [pid]: {...} },      // 本场次跨轮身份档案
 *   version                            // 场次内状态版本号（SSE 事件 id）
 * }
 */
function createSessionObject(id, name, seq) {
  return {
    id,
    name,
    seq,
    status: 'open',
    createdAt: Date.now(),
    closedAt: null,
    round: 1,
    number: null,
    lockedAt: null,
    players: {},
    identities: {},
    version: 0
  };
}

function openSessions() {
  return Array.from(gameSessions.values())
    .filter((s) => s.status === 'open')
    .sort((a, b) => a.seq - b.seq);
}

function allSessionsSorted() {
  return Array.from(gameSessions.values()).sort((a, b) => a.seq - b.seq);
}

function nextSeq() {
  let max = 0;
  for (const s of gameSessions.values()) if (s.seq > max) max = s.seq;
  return max + 1;
}

/** 生成不与现有场次冲突的短 ID（用作玩家端入口参数 ?s=<id>）。 */
function newSessionId() {
  let id;
  do {
    id = crypto.randomBytes(4).toString('hex');
  } while (gameSessions.has(id));
  return id;
}

/** 玩家端可见的场次摘要（只列进行中的场次）。 */
function publicSessionList() {
  return openSessions().map((s) => ({
    id: s.id,
    name: s.name,
    round: s.round,
    locked: s.number != null
  }));
}

/** 员工端可见的场次摘要（含已关闭场次，便于回看）。 */
function staffSessionList() {
  return allSessionsSorted().map((s) => ({
    id: s.id,
    name: s.name,
    seq: s.seq,
    status: s.status,
    round: s.round,
    locked: s.number != null,
    players: Object.keys(s.players).length,
    createdAt: s.createdAt,
    closedAt: s.closedAt
  }));
}

/** 默认场次：第一个进行中的场次，没有则 null。 */
function defaultSessionId() {
  const open = openSessions();
  return open.length ? open[0].id : '';
}

/** 按 ID 取场次（仅供员工侧与内部兜底使用）。
 *  玩家侧一律走 playerSessionContext()，它额外校验绑定令牌，防止跨场次跳转。 */
function resolveSession(sid) {
  if (sid) return gameSessions.get(sid) || null;
  const open = openSessions();
  return open.length === 1 ? open[0] : null;
}

/* ---------------- SSE（Server-Sent Events）---------------- */

/** SSE 分组：session_id -> Set<client>。client = { res, pid, lastVersion }。
 *  广播只在组内进行，不同场次的客户端互不可见。 */
const sseClients = new Map();

/** 向单个 SSE 连接发送一条事件。返回是否写入成功（连接已关闭时返回 false）。 */
function sseSend(res, event, data, id) {
  try {
    // state 事件以场次版本号为 id：EventSource 重连时会经 Last-Event-ID 头带回，
    // 服务端可据此判断客户端是否错过变更（本实现广播即全量快照，故天然对齐）
    if (event === 'state' && id != null) {
      res.write('id: ' + id + '\n');
    }
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
    return true;
  } catch (e) {
    return false;
  }
}

/** 向某个场次组内的所有客户端广播状态（携带该场次最新版本号）。
 *  按每个客户端各自登记的 pid 构建负载：玩家端带上自己的 me 视角，
 *  工作人员端（pid 为空）不带 me。 */
function broadcastSessionState(session) {
  const group = sseClients.get(session.id);
  if (!group) return;
  for (const c of group) {
    if (c.res.writableEnded) { group.delete(c); continue; }
    if (!sseSend(c.res, 'state', buildStatePayload(session, c.pid), session.version)) {
      group.delete(c);
      continue;
    }
    c.lastVersion = session.version;
  }
  if (group.size === 0) sseClients.delete(session.id);
}

/** 向某个场次组发送一条自定义事件（不改变状态版本）。 */
function emitToSession(session, event, data) {
  const group = sseClients.get(session.id);
  if (!group) return;
  for (const c of group) {
    if (c.res.writableEnded) { group.delete(c); continue; }
    sseSend(c.res, event, data);
  }
}

/** 关掉某个场次的所有连接（场次关闭时用）。 */
function dropSessionClients(session) {
  const group = sseClients.get(session.id);
  if (!group) return;
  sseClients.delete(session.id);
  for (const c of group) {
    try { c.res.end(); } catch (e) { /* 已断开 */ }
  }
}

/** 构建状态负载。pid 传空表示不带 me 字段（工作人员端视角）。
 *  负载只包含本场次的数据。 */
function buildStatePayload(session, pid) {
  const me = pid ? session.players[pid] : null;
  return {
    ok: true,
    session: { id: session.id, name: session.name, status: session.status },
    version: session.version,
    round: session.round,
    locked: session.number != null,
    number: session.number != null ? session.number : undefined,
    players: publicPlayers(session),
    me: me ? { id: me.id, oddEven: me.oddEven, number: me.number } : null
  };
}

/** 标记场次状态已变更：递增该场次版本号、广播给该场次的客户端、异步落库。
 *  这是所有写操作的唯一收口，避免漏广播或漏持久化。
 *  返回落库 promise（{ ok, error }），锁定这类必须确认写入结果的路径可以 await。 */
function commitSession(session) {
  session.version += 1;
  broadcastSessionState(session);
  return db.saveSession(session);
}

function initStaffPassword() {
  const pw = process.env.STAFF_PASSWORD || DEFAULT_PASSWORD;
  staffPasswordHash = crypto.createHash('sha256').update(pw, 'utf8').digest('hex');
}

/** 签发员工会话，并绑定默认场次（登录后即归属某一场）。 */
function issueStaffSession(sessionId) {
  const token = crypto.randomBytes(24).toString('hex');
  staffSessions.set(token, { expiresAt: Date.now() + SESSION_TTL, sessionId: sessionId || '' });
  return token;
}

function getStaffSession(token) {
  const s = staffSessions.get(token);
  if (!s) return null;
  if (s.expiresAt <= Date.now()) { staffSessions.delete(token); return null; }
  return s;
}

function requireAuth(token) {
  return !!getStaffSession(token);
}

/* ---------------- 玩家端：场次口令 + 绑定令牌 ---------------- */

/** 初始化玩家端口令哈希。口令本身不保留在任何变量里，只留盐与哈希。 */
function initPlayerPassword() {
  const pw = process.env.PLAYER_SESSION_PASSWORD || DEFAULT_PLAYER_PASSWORD;
  playerPwSalt = crypto.randomBytes(16);
  playerPwHash = crypto.scryptSync(pw, playerPwSalt, 32);
}

/** 定时安全比对玩家口令。空串 / 非字符串一律拒绝。 */
function checkPlayerPassword(input) {
  if (typeof input !== 'string' || !input || input.length > 128) return false;
  const h = crypto.scryptSync(input, playerPwSalt, 32);
  return crypto.timingSafeEqual(h, playerPwHash);
}

/** 读取（首次则生成）绑定令牌签名密钥，存 app_config，重启后复用。 */
async function loadBindSecret() {
  let v = await db.getConfig('player_bind_secret');
  if (!v || v.length < 32) {
    v = crypto.randomBytes(32).toString('hex');
    await db.setConfig('player_bind_secret', v);
    console.log('[player] 已生成场次绑定签名密钥（仅存于数据库，不对外暴露）');
  }
  bindSecret = Buffer.from(v, 'hex');
}

/**
 * 签发绑定令牌：`<sid>.<exp>.<sig>`。
 *  - 只包含场次与过期时间，不含口令、不含玩家 ID，无法反推口令
 *  - sig = HMAC-SHA256(secret, `<sid>.<exp>`)，服务端可无状态校验
 */
function signBind(sid, exp) {
  const payload = sid + '.' + exp;
  const sig = crypto.createHmac('sha256', bindSecret).update(payload).digest('hex').slice(0, 32);
  return payload + '.' + sig;
}

/** 校验绑定令牌，返回 { sid, exp } 或 null（伪造 / 篡改 / 过期）。 */
function verifyBind(token) {
  if (typeof token !== 'string' || token.length > 200) return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [sid, expStr, sig] = parts;
  if (!sid || !expStr || !sig) return null;
  const exp = Number(expStr);
  if (!Number.isFinite(exp) || exp <= Date.now()) return null;
  const expect = crypto.createHmac('sha256', bindSecret).update(sid + '.' + expStr).digest('hex').slice(0, 32);
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expect, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  return { sid, exp };
}

/** 来源 IP：优先取反向代理头，退化到 socket 地址。 */
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** 口令错误计数：返回锁定剩余秒数（0 表示未锁定）。
 *  注意只在「确实处于锁定状态」时才过期清理，否则失败计数会被每次调用顺手清掉。 */
function unlockLockLeft(ip) {
  const st = unlockFails.get(ip);
  if (!st || !st.until) return 0;
  const left = st.until - Date.now();
  if (left <= 0) { unlockFails.delete(ip); return 0; }
  return Math.ceil(left / 1000);
}

function noteUnlockFail(ip) {
  const st = unlockFails.get(ip) || { fails: 0, until: 0 };
  st.fails += 1;
  if (st.fails >= UNLOCK_MAX_FAILS) { st.until = Date.now() + UNLOCK_LOCK_MS; st.fails = 0; }
  unlockFails.set(ip, st);
}

/**
 * 场次准入判定 —— 所有 /api/state、/api/stream 的统一入口。
 *
 * 员工侧（带有效 staff token）：直接看目标场次，不受玩家口令约束（关闭的场次也能回看）。
 * 玩家侧：
 *  1. 带有效绑定令牌：以令牌里的场次为准。请求里的 sid 与绑定不一致 → 拒绝（session_locked），
 *     因此玩家无法通过改 URL / localStorage 跳到别的场次。
 *  2. 无令牌：只有「唯一一个进行中场次」时放行（此时不存在选错场的可能）；
 *     多个场次并行时一律要求先通过口令验证（session_need_unlock）。
 *
 * 返回 { session } 或 { err: { status, code, ... } }。
 */
function playerSessionContext(sidRaw, utoken, staffToken) {
  const wanted = String(sidRaw || '');

  // 员工端：凭员工会话直接放行（含已关闭场次，便于回看）
  if (staffToken && requireAuth(staffToken)) {
    const s = gameSessions.get(wanted);
    if (!s) return { err: { status: 404, code: 'session_not_found', sessions: staffSessionList() } };
    return { session: s, staff: true };
  }

  if (utoken) {
    const bind = verifyBind(utoken);
    if (!bind) return { err: { status: 403, code: 'session_need_unlock', reason: 'bad_token' } };
    if (wanted && wanted !== bind.sid) {
      return { err: { status: 403, code: 'session_locked', boundSid: bind.sid } };
    }
    const s = gameSessions.get(bind.sid);
    if (!s) return { err: { status: 404, code: 'session_not_found', sessions: publicSessionList() } };
    if (s.status !== 'open') {
      return { err: { status: 409, code: 'session_closed', sessions: publicSessionList() } };
    }
    return { session: s };
  }

  const open = openSessions();
  if (open.length === 1) {
    if (wanted && wanted !== open[0].id) {
      return { err: { status: 403, code: 'session_locked', boundSid: open[0].id } };
    }
    return { session: open[0] };
  }
  if (open.length === 0) {
    return { err: { status: 404, code: 'session_not_found', sessions: [] } };
  }
  return { err: { status: 403, code: 'session_need_unlock', sessions: publicSessionList() } };
}

/** 准入判定失败时的统一响应；返回 true 表示已响应。 */
function rejectPlayerSession(res, ctx) {
  if (ctx.session) return false;
  const e = ctx.err;
  const body = { ok: false, code: e.code };
  if (e.boundSid) body.boundSid = e.boundSid;
  if (e.sessions) body.sessions = e.sessions;
  if (e.reason) body.reason = e.reason;
  json(res, e.status, body);
  return true;
}

/* ---------------- 工具 ---------------- */

function json(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 64 * 1024) { req.destroy(); resolve(null); }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); } catch (e) { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

/** 玩家公共视图：开奖前绝不包含任何人的预测明细与本轮数字。
 *  只反映本场次。 */
function publicPlayers(session) {
  const locked = session.number != null;
  return Object.values(session.players)
    .sort((a, b) => a.registeredAt - b.registeredAt)
    .map((p) => {
      // 老玩家判定：在本场次曾完整走完过至少一轮（提交过预测且那一轮最终开奖）
      const completed = (session.identities[p.id] || {}).completedRounds || 0;
      const item = { id: p.id, submitted: p.oddEven != null, isVeteran: completed >= 1 };
      if (locked) { // 已开奖：展示每个人的预测与命中
        item.oddEven = p.oddEven;
        item.number = p.number;
      }
      return item;
    });
}

/** 校验场次名称：去空白、限长；返回 null 表示合法。 */
function normalizeSessionName(raw, fallback) {
  let name = String(raw == null ? '' : raw).trim();
  if (name.length > MAX_SESSION_NAME) return false;
  if (!name) name = fallback;
  return name;
}

/* ---------------- 归档对账：时间口径 / CSV 生成 ---------------- */

/**
 * 把一个运营时区里的自然日（YYYY-MM-DD）换算成毫秒半开区间 [start, end)。
 * 采用固定偏移（默认 +08:00）而非 IANA 时区库：港/深/澳无夏令时，边界永远稳定。
 * 返回 null 表示日期串非法（含 2026-02-31 这种不存在的日期）。
 */
function dayBounds(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''));
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const utc = Date.UTC(y, mo - 1, d);
  const probe = new Date(utc);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return null;
  const start = utc - ARCHIVE_TZ_OFFSET_MIN * 60000;
  return { start, end: start + DAY_MS, date: m[1] + '-' + m[2] + '-' + m[3] };
}

/** 运营时区下的「今天」。 */
function todayStr() {
  return new Date(Date.now() + ARCHIVE_TZ_OFFSET_MIN * 60000).toISOString().slice(0, 10);
}

/**
 * 解析查询参数里的时间区间：
 *   ?date=YYYY-MM-DD           单日（默认今天）
 *   ?from=YYYY-MM-DD&to=YYYY-MM-DD  闭区间，按自然日展开
 * 返回 { from, to, label } 或 null（非法参数）。
 */
function archiveRange(url) {
  const date = url.searchParams.get('date');
  const fromP = url.searchParams.get('from');
  const toP = url.searchParams.get('to');
  if (date) {
    const b = dayBounds(date);
    return b ? { from: b.start, to: b.end, label: b.date } : null;
  }
  if (fromP || toP) {
    const a = dayBounds(fromP || toP);
    const b = dayBounds(toP || fromP);
    if (!a || !b || a.start > b.start) return null;
    return { from: a.start, to: b.end, label: a.date === b.date ? a.date : a.date + ' ~ ' + b.date };
  }
  const t = dayBounds(todayStr());
  return t ? { from: t.start, to: t.end, label: t.date } : null;
}

/** 毫秒时间戳 → 运营时区下的 `YYYY-MM-DD HH:mm:ss`（不带偏移后缀，列头里已声明口径）。 */
function fmtArchiveTime(ms) {
  if (ms == null) return '';
  const d = new Date(Number(ms) + ARCHIVE_TZ_OFFSET_MIN * 60000);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

/** CSV 单元格转义：含逗号/引号/换行才加引号，内部引号双写。 */
function csvCell(v) {
  if (v === null || v === undefined) return '';
  const s = String(v);
  return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/** 行数组 → CSV 文本。带 UTF-8 BOM + CRLF，确保 Excel 双击不乱码、不并列。 */
function buildCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const r of rows) lines.push(r.map(csvCell).join(','));
  return '\ufeff' + lines.join('\r\n') + '\r\n';
}

/** 命中率：分母为有效预测轮次；无预测时留空而不是 0%。 */
function hitRate(hits, predicted) {
  if (!predicted) return '';
  return ((hits / predicted) * 100).toFixed(1) + '%';
}

/* 列头常量：**顺序即契约**，下游脚本按位置/列名解析，改动等于破坏对账。
 * 需要新字段时只追加到末尾，不要插在中间、不要改名。 */
const CSV_DETAIL_HEADER = [
  '场次ID', '场次名称', '场次序号', '轮次号', '开奖数字', '开奖单双',
  '锁定时间', '归档时间', '会员号', '预测单双', '预测数字', '是否提交',
  '单双命中', '数字命中', '登记时间', '提交时间'
];
const CSV_MEMBER_HEADER = [
  '会员号', '参与场次数', '参与轮次数', '有效预测轮次数',
  '单双命中轮次', '数字命中轮次', '单双命中率', '数字命中率',
  '首次参与时间', '末次参与时间'
];
const CSV_ROUND_HEADER = [
  '场次ID', '场次名称', '场次序号', '轮次号', '开奖数字', '开奖单双',
  '锁定时间', '归档时间', '扫码人数', '提交人数'
];

/* ---------------- API ---------------- */

async function handleApi(req, res, url) {
  const pid = url.searchParams.get('pid') || '';

  /* 员工端登录（密码 → 会话 token，并绑定默认场次） */
  if (req.method === 'POST' && url.pathname === '/api/staff-login') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    if (Date.now() < lockedUntil) {
      return json(res, 429, {
        ok: false, code: 'too_many_attempts',
        retryAfter: Math.ceil((lockedUntil - Date.now()) / 1000)
      });
    }
    const hash = crypto.createHash('sha256').update(String(body.password || ''), 'utf8').digest('hex');
    if (hash === staffPasswordHash) {
      failedAttempts = 0;
      const sid = defaultSessionId();
      return json(res, 200, {
        ok: true,
        token: issueStaffSession(sid),
        sid,
        sessions: staffSessionList()
      });
    }
    failedAttempts += 1;
    if (failedAttempts >= 5) { lockedUntil = Date.now() + 30000; failedAttempts = 0; }
    return json(res, 401, { ok: false, code: 'wrong_password' });
  }

  /* 员工端退出会话 */
  if (req.method === 'POST' && url.pathname === '/api/staff-logout') {
    const body = await readBody(req);
    const token = body && body.token;
    if (token) staffSessions.delete(token);
    return json(res, 200, { ok: true });
  }

  /* 员工端会话有效性检查（页面启动时判断是否已登录，并取回绑定的场次） */
  if (req.method === 'GET' && url.pathname === '/api/staff-check') {
    const token = url.searchParams.get('token') || '';
    const s = getStaffSession(token);
    if (!s) return json(res, 200, { ok: false });
    // 绑定的场次可能已被别人关闭：回退到默认场次
    let sid = s.sessionId;
    if (!sid || !gameSessions.has(sid)) { sid = defaultSessionId(); s.sessionId = sid; }
    return json(res, 200, { ok: true, sid, sessions: staffSessionList() });
  }

  /* 场次列表：玩家端只看到进行中的场次；带有效员工 token 时返回含已关闭场次的完整列表。
   * needPassword 告诉玩家端：此刻是否需要先过口令才能入场（≥2 场并行时为 true）。 */
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const token = url.searchParams.get('token') || '';
    if (token && requireAuth(token)) {
      return json(res, 200, { ok: true, sessions: staffSessionList() });
    }
    const open = openSessions();
    return json(res, 200, {
      ok: true,
      sessions: publicSessionList(),
      needPassword: open.length > 1
    });
  }

  /* 玩家端：选择 / 切换场次的口令校验入口。
   *  - 成功后返回绑定令牌（ut），客户端后续带着它访问，服务端据此锁定场次
   *  - 失败按 IP 限频，连续 5 次错 → 锁 30 秒
   *  - auto=true 仅在「唯一进行中场次」时允许免口令自动绑定（用来自动进入并把场次固定下来） */
  if (req.method === 'POST' && url.pathname === '/api/session-unlock') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });

    const sid = String(body.sid || '');
    const ip = clientIp(req);
    const left = unlockLockLeft(ip);
    if (left > 0) {
      return json(res, 429, { ok: false, code: 'player_too_many_attempts', retryAfter: left });
    }

    const session = gameSessions.get(sid);
    if (!session) {
      return json(res, 404, { ok: false, code: 'session_not_found', sessions: publicSessionList() });
    }
    if (session.status !== 'open') {
      return json(res, 409, { ok: false, code: 'session_closed', sessions: publicSessionList() });
    }

    const auto = body.auto === true;
    if (auto) {
      const open = openSessions();
      if (!(open.length === 1 && open[0].id === session.id)) {
        return json(res, 403, { ok: false, code: 'unlock_password_required', sessions: publicSessionList() });
      }
    } else if (!checkPlayerPassword(body.password)) {
      noteUnlockFail(ip);
      const remain = unlockLockLeft(ip);
      return json(res, 401, {
        ok: false,
        code: 'player_wrong_password',
        ...(remain > 0 ? { retryAfter: remain } : {})
      });
    }

    unlockFails.delete(ip); // 验证通过即清空该 IP 的失败计数
    const exp = Date.now() + PLAYER_BIND_TTL;
    return json(res, 200, {
      ok: true,
      sid: session.id,
      ut: signBind(session.id, exp),
      expiresAt: exp,
      session: { id: session.id, name: session.name, round: session.round, locked: session.number != null },
      sessions: publicSessionList()
    });
  }

  /* 新建场次（员工端） */
  if (req.method === 'POST' && url.pathname === '/api/session-create') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });
    if (openSessions().length >= MAX_SESSIONS) {
      return json(res, 409, { ok: false, code: 'session_limit', max: MAX_SESSIONS });
    }
    const seq = nextSeq();
    const name = normalizeSessionName(body.name, '第 ' + seq + ' 场');
    if (name === false) {
      return json(res, 400, { ok: false, code: 'session_name_too_long', maxLen: MAX_SESSION_NAME });
    }
    const session = createSessionObject(newSessionId(), name, seq);
    gameSessions.set(session.id, session);
    staff.sessionId = session.id; // 创建者直接切到新场次
    db.saveSessionMeta(session);
    db.saveSession(session);
    return json(res, 200, {
      ok: true,
      sid: session.id,
      session: { id: session.id, name: session.name, round: session.round, status: session.status },
      sessions: staffSessionList()
    });
  }

  /* 切换场次（员工端）：只改该 token 的归属绑定，不影响其他员工 */
  if (req.method === 'POST' && url.pathname === '/api/session-select') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });
    const session = gameSessions.get(String(body.sid || ''));
    if (!session) return json(res, 404, { ok: false, code: 'session_not_found' });
    staff.sessionId = session.id;
    return json(res, 200, {
      ok: true,
      sid: session.id,
      session: { id: session.id, name: session.name, round: session.round, status: session.status },
      sessions: staffSessionList()
    });
  }

  /* 关闭场次（员工端）：标记关闭、通知并断开该场次的连接，数据保留可回看 */
  if (req.method === 'POST' && url.pathname === '/api/session-close') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });
    const session = gameSessions.get(String(body.sid || '') || staff.sessionId);
    if (!session) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (session.status !== 'open') return json(res, 409, { ok: false, code: 'session_already_closed' });

    session.status = 'closed';
    session.closedAt = Date.now();
    session.version += 1;
    db.saveSessionMeta(session);
    // 关闭前把已锁定的本轮顺带刷一次归档（幂等；已归档则不进任何写操作）
    if (session.number != null) {
      db.saveSession(session).then((w) => {
        if (!w.ok) console.error('[archive] 关闭场次时归档失败 sid=' + session.id + ': ' + w.error);
      });
    }

    // 先通知该场次所有客户端，再断开连接：玩家端据此退回场次选择
    emitToSession(session, 'session_closed', {
      sid: session.id,
      name: session.name,
      sessions: publicSessionList()
    });
    dropSessionClients(session);

    // 归属该场次的员工改绑到下一个进行中的场次（可能为空）
    const nextSid = defaultSessionId();
    for (const st of staffSessions.values()) {
      if (st.sessionId === session.id) st.sessionId = nextSid;
    }
    return json(res, 200, {
      ok: true,
      sid: session.id,
      nextSid,
      sessions: staffSessionList()
    });
  }

  /* 状态查询：某场次的全量状态快照。SSE 客户端在重连/回到前台时调用，用于对齐断线期间错过的变更。
   * 必须通过场次准入判定：玩家带绑定令牌（以令牌场次为准），员工带 staff token。 */
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const ctx = playerSessionContext(
      url.searchParams.get('sid') || '',
      url.searchParams.get('ut') || '',
      url.searchParams.get('token') || ''
    );
    if (rejectPlayerSession(res, ctx)) return;
    return json(res, 200, buildStatePayload(ctx.session, pid));
  }

  /* 二维码识别：内容直接作为玩家唯一 ID（不做 hash）。重复扫码幂等返回同一玩家。
   * 身份按场次隔离：同一内容在 A 场与 B 场是两个独立玩家。 */
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const ctx = playerSessionContext(String(body.sid || ''), String(body.ut || ''));
    if (rejectPlayerSession(res, ctx)) return;
    const session = ctx.session;

    const content = String(body.content || '').trim();
    if (!content) return json(res, 400, { ok: false, code: 'scan_empty' });
    if (content.length > QR_MAX_LEN) return json(res, 400, { ok: false, code: 'scan_too_long', maxLen: QR_MAX_LEN });

    const id = content;

    // 情况一：本场次本轮已扫过该码 → 幂等恢复同一玩家（任意设备、任意次数）
    const existing = session.players[id];
    if (existing) {
      const idt = session.identities[id];
      if (idt) { idt.lastSeenRound = session.round; }
      commitSession(session);
      return json(res, 200, { ok: true, pid: id, sid: session.id, status: 'known' });
    }

    // 情况二：本场次本轮新码。已开奖 → 拒绝入场
    if (session.number != null) {
      return json(res, 400, { ok: false, code: 'scan_locked' });
    }

    // 情况三：本场次本轮新码 → 建档
    session.players[id] = {
      id, oddEven: null, number: null,
      registeredAt: Date.now(), submittedAt: null
    };
    const prev = session.identities[id];
    session.identities[id] = {
      lastSeenRound: session.round,
      completedRounds: (prev && prev.completedRounds) || 0
    };
    commitSession(session);
    return json(res, 200, { ok: true, pid: id, sid: session.id, status: 'known' });
  }

  if (req.method === 'POST' && url.pathname === '/api/predict') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const ctx = playerSessionContext(String(body.sid || ''), String(body.ut || ''));
    if (rejectPlayerSession(res, ctx)) return;
    const session = ctx.session;

    const p = session.players[String(body.pid || '')];
    if (!p) return json(res, 400, { ok: false, code: 'predict_not_scanned' });
    if (session.number != null) return json(res, 400, { ok: false, code: 'predict_closed' });
    if (p.oddEven != null) return json(res, 400, { ok: false, code: 'predict_duplicate' });
    const oddEven = body.oddEven;
    const number = Number(body.number);
    if (oddEven !== '单' && oddEven !== '双') return json(res, 400, { ok: false, code: 'predict_invalid_oe' });
    if (!Number.isInteger(number) || number < 1 || number > 8) return json(res, 400, { ok: false, code: 'predict_invalid' });
    p.oddEven = oddEven;
    p.number = number;
    p.submittedAt = Date.now();
    commitSession(session);
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/confirm') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });

    const session = gameSessions.get(String(body.sid || '') || staff.sessionId);
    if (!session) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (session.status !== 'open') return json(res, 409, { ok: false, code: 'session_closed' });

    const number = Number(body.number);
    if (!Number.isInteger(number) || number < 1 || number > 8) {
      return json(res, 400, { ok: false, code: 'invalid_number' });
    }
    if (session.number != null) {
      return json(res, 400, { ok: false, code: 'already_locked', number: session.number });
    }
    // 唯一写入点：数字来自工作人员在网页外的抽取，仅在此录入并锁定
    session.number = number;
    session.lockedAt = Date.now();
    // 开奖即视为本轮完整竞猜结束：凡提交过预测的玩家，本场次的完整竞猜轮次 +1
    Object.values(session.players).forEach((p) => {
      if (p.oddEven != null) {
        const idt = session.identities[p.id] || (session.identities[p.id] = {});
        idt.completedRounds = (idt.completedRounds || 0) + 1;
        idt.lastSeenRound = session.round;
      }
    });

    // 落库与归档在同一个事务里（见 db.doSaveSession）：等结果再回话，
    // 这样「已锁定」这句话背后一定有归档凭据，而不是只写了内存。
    const write = await commitSession(session);
    if (!write.ok) {
      console.error('[archive] 归档写入失败 sid=' + session.id + ' round=' + session.round + ': ' + write.error);
      // 锁定已经在内存与 SSE 广播中生效，不能谎报失败让员工重按（重按只会得到 already_locked）；
      // 如实告知「已锁定但未归档」，员工端据此提示，可稍后由 /api/archive-sync 补齐。
      return json(res, 200, {
        ok: true, number, sid: session.id, archived: false, warning: 'archive_write_failed'
      });
    }
    return json(res, 200, { ok: true, number, sid: session.id, archived: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });

    const session = gameSessions.get(String(body.sid || '') || staff.sessionId);
    if (!session) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (session.status !== 'open') return json(res, 409, { ok: false, code: 'session_closed' });

    // 清空前先把已锁定的这一轮归档落定：归档失败就不许开新一轮，
    // 否则这一轮的明细会被「开始新一轮」永久抹掉（归档表是唯一留痕）。
    if (session.number != null) {
      const flushed = await db.saveSession(session);
      if (!flushed.ok) {
        console.error('[archive] 新一轮前归档失败 sid=' + session.id + ' round=' + session.round + ': ' + flushed.error);
        return json(res, 409, { ok: false, code: 'archive_write_failed' });
      }
    }

    // 新一轮：清空本场次本轮玩家；identities（本场次跨轮次身份档案）保留
    session.round += 1;
    session.number = null;
    session.lockedAt = null;
    session.players = {};
    commitSession(session);
    return json(res, 200, { ok: true, round: session.round, sid: session.id });
  }

  /* 当日聚合（归档口径）：场次数、轮次数、按会员号去重的参与人数，附分场次明细。
   * 口径固定为 locked_at（锁定时间）落在区间内，与当前进行中的场次无关；
   * 归档表 append-only，所以 reset 之后再查同一天，数字只增不减。 */
  if (req.method === 'GET' && url.pathname === '/api/archive/summary') {
    const staff = getStaffSession(url.searchParams.get('token') || '');
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });
    const range = archiveRange(url);
    if (!range) return json(res, 400, { ok: false, code: 'bad_date_range' });

    const data = await db.archiveSummary(range.from, range.to);
    return json(res, 200, {
      ok: true,
      date: range.label,
      from: range.from,
      to: range.to,
      tzOffsetMin: ARCHIVE_TZ_OFFSET_MIN,
      ...data
    });
  }

  /* 对账导出（CSV，列头顺序固定，见 CSV_*_HEADER）。
   *   ?level=detail（默认）一人一轮一行 —— 积分结算原始凭据
   *   ?level=member  一人一行（跨场次合并）—— 直接按人结分
   *   ?level=round   一轮一行（含 0 人轮次）—— 核对当天开了几轮
   * 可选 ?sid= 只导某一场，?date= / ?from=&to= 指定区间（默认今天）。 */
  if (req.method === 'GET' && url.pathname === '/api/archive/export.csv') {
    const staff = getStaffSession(url.searchParams.get('token') || '');
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });
    const range = archiveRange(url);
    if (!range) return json(res, 400, { ok: false, code: 'bad_date_range' });

    const level = String(url.searchParams.get('level') || 'detail').toLowerCase();
    if (!['detail', 'member', 'round'].includes(level)) {
      return json(res, 400, { ok: false, code: 'bad_level' });
    }
    const sidFilter = String(url.searchParams.get('sid') || '');

    let header;
    let rows;
    if (level === 'member') {
      header = CSV_MEMBER_HEADER;
      const data = await db.archiveMemberRows(range.from, range.to, sidFilter);
      rows = data.map((r) => [
        r.member_id,
        r.sessions,
        r.rounds,
        r.predicted,
        r.odd_even_hits,
        r.number_hits,
        hitRate(r.odd_even_hits, r.predicted),
        hitRate(r.number_hits, r.predicted),
        fmtArchiveTime(r.first_locked_at),
        fmtArchiveTime(r.last_locked_at)
      ]);
    } else if (level === 'round') {
      header = CSV_ROUND_HEADER;
      const data = await db.archiveRoundRows(range.from, range.to, sidFilter);
      rows = data.map((r) => [
        r.session_id, r.session_name, Number(r.session_seq), Number(r.round),
        Number(r.number), r.odd_even,
        fmtArchiveTime(r.locked_at), fmtArchiveTime(r.archived_at),
        Number(r.player_count), Number(r.submitted_count)
      ]);
    } else {
      header = CSV_DETAIL_HEADER;
      const data = await db.archiveEntryRows(range.from, range.to, sidFilter);
      rows = data.map((r) => [
        r.session_id, r.session_name, Number(r.session_seq), Number(r.round),
        Number(r.drawn_number), r.drawn_odd_even,
        fmtArchiveTime(r.locked_at), fmtArchiveTime(r.archived_at),
        r.member_id,
        r.odd_even == null ? '' : r.odd_even,
        r.number == null ? '' : Number(r.number),
        r.submitted ? '是' : '否',
        r.submitted ? (r.odd_even_hit ? '命中' : '未中') : '未提交',
        r.submitted ? (r.number_hit ? '命中' : '未中') : '未提交',
        fmtArchiveTime(r.registered_at),
        fmtArchiveTime(r.submitted_at)
      ]);
    }

    const csv = buildCsv(header, rows);
    // 文件名只保留安全字符；日期里的 '-' 保留，区间里的 '~' 变 '_'
    const tag = range.label.replace(/[^0-9A-Za-z-]+/g, '_').replace(/^_|_$/g, '');
    const filename = 'archive-' + level + '-' + (tag || 'range') + '.csv';
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="' + filename + '"',
      'Cache-Control': 'no-store'
    });
    return res.end(csv);
  }

  /* 归档补齐（员工端）：把内存里所有「已锁定但没落进归档表」的轮次重新写一遍。
   * 正常情况下永远用不到（锁定与归档同一事务），它是 deploy 后回填历史锁定轮次、
   * 以及数据库瞬时故障后的兜底。幂等，可反复调用。 */
  if (req.method === 'POST' && url.pathname === '/api/archive-sync') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    if (!getStaffSession(body.token)) return json(res, 401, { ok: false, code: 'unauthorized' });

    const targets = allSessionsSorted().filter((s) => s.number != null && s.lockedAt != null);
    const failed = [];
    for (const s of targets) {
      const w = await db.saveSession(s);
      if (!w.ok) failed.push({ sid: s.id, round: s.round, error: w.error });
    }
    return json(res, 200, {
      ok: failed.length === 0,
      checked: targets.length,
      failed,
      rounds: targets.map((s) => ({ sid: s.id, name: s.name, round: s.round, number: s.number }))
    });
  }

  return json(res, 404, { ok: false, error: '接口不存在' });
}

/* ---------------- SSE 流端点 ---------------- */

const SSE_HEARTBEAT_MS = 15000; // 心跳间隔：15 秒发一次，防止代理/浏览器超时断开

/** 建立 SSE 长连接。必须带 ?sid=<场次ID>；可再带 ?pid=<玩家ID> 以在每次状态事件中附带该玩家视角。
 *  - 连接后立即下发一次本场次的全量状态（事件名 state）
 *  - 期间本场次的状态变更由 commitSession() 广播；其他场次的变更不会推给这条连接
 *  - 客户端断开（含网络中断）后 EventSource 自动重连；重连请求会带
 *    Last-Event-ID 头，服务端据此判断客户端是否已错过事件，错过则补发全量状态
 *  - 每 15 秒发一次心跳（事件名 ping）维持连接
 *  - 场次关闭时服务端先发 session_closed 事件再断开连接
 */
function handleStream(req, res, url) {
  const sid = url.searchParams.get('sid') || '';
  const pid = url.searchParams.get('pid') || '';
  const ctx = playerSessionContext(sid, url.searchParams.get('ut') || '', url.searchParams.get('token') || '');

  if (ctx.err) {
    // SSE 无法读 JSON 错误体，用状态码 + JSON 体让客户端判断
    return json(res, ctx.err.status, { ok: false, code: ctx.err.code, sessions: ctx.err.sessions || null });
  }
  const session = ctx.session;
  if (session.status !== 'open') {
    return json(res, 409, { ok: false, code: 'session_closed' });
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // 禁用 nginx 等反向代理缓冲
  });
  res.write('retry: 2000\n\n'); // 告知客户端断线后 2 秒重连

  // 首条事件：本场次的全量状态（复用场次版本号作为事件 id）
  sseSend(res, 'state', buildStatePayload(session, pid), session.version);

  const client = { res, pid, lastVersion: session.version };
  let group = sseClients.get(session.id);
  if (!group) { group = new Set(); sseClients.set(session.id, group); }
  group.add(client);

  // 心跳定时器
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    sseSend(res, 'ping', { t: Date.now() });
  }, SSE_HEARTBEAT_MS);

  // 客户端主动关闭（关闭页面/调用 close()）：清理资源
  req.on('close', () => {
    clearInterval(heartbeat);
    const g = sseClients.get(session.id);
    if (g) {
      g.delete(client);
      if (g.size === 0) sseClients.delete(session.id);
    }
    res.end();
  });
}

/* ---------------- 静态文件 ---------------- */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
};

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/' || rel === '') rel = '/index.html';          // 玩家端入口
  if (rel === '/staff') rel = '/staff.html';                    // 工作人员端入口（别名）
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('404 Not Found'); }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(buf);
  });
}

/* ---------------- 启动 ---------------- */

/** 从数据库恢复场次；库中一个场次都没有时建默认场次（老库数据已归到 main）。 */
async function bootstrapSessions() {
  const list = await db.loadSessions();
  for (const s of list) {
    s.version = 0;
    gameSessions.set(s.id, s);
  }
  if (gameSessions.size === 0) {
    const s = createSessionObject(db.DEFAULT_SESSION_ID, '第 1 场', 1);
    gameSessions.set(s.id, s);
    await db.saveSessionMeta(s);
    await db.saveSession(s);
    console.log('[session] 初始化默认场次:', s.id, s.name);
  }
  console.log('[session] 已加载场次 ' + gameSessions.size + ' 个（进行中 ' + openSessions().length + ' 个）');
}

/**
 * 启动补齐：库里若存在「已锁定但没进归档表」的轮次（典型场景是首次部署本功能前
 * 就已经锁定的那一轮），启动时补写一次。幂等：已归档的轮次不会重写。
 */
async function backfillArchives() {
  let filled = 0;
  for (const s of allSessionsSorted()) {
    if (s.number == null || s.lockedAt == null) continue;
    if (await db.archiveExists(s.id, s.round)) continue;
    const w = await db.saveSession(s);
    if (w.ok) filled += 1;
    else console.error('[archive] 启动补齐失败 sid=' + s.id + ' round=' + s.round + ': ' + w.error);
  }
  if (filled) console.log('[archive] 启动补齐：已锁定轮次补写归档 ' + filled + ' 场');
}

async function start() {
  initStaffPassword();
  initPlayerPassword();

  try {
    await db.initDb();        // 幂等建表 + 老库迁移
    await loadBindSecret();   // 绑定令牌签名密钥（存 app_config，重启复用）
    await bootstrapSessions(); // 从数据库恢复场次状态
    await backfillArchives(); // 已锁定但未归档的轮次补写（幂等）
  } catch (e) {
    console.error('[db] 数据库初始化失败，应用无法启动:', e.message);
    console.error('  请确认 PG_HOST / PG_USER / PG_PASS 已配置（Fly.io: fly secrets set PG_HOST=... PG_USER=... PG_PASS=...），可选 PG_PORT / PG_DB，或设置 DATABASE_URL');
    process.exit(1);
  }

  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/api/stream') {
      handleStream(req, res, url);
    } else if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch(() => json(res, 500, { ok: false, error: '服务器内部错误' }));
    } else {
      serveStatic(req, res, url);
    }
  }).listen(PORT, '0.0.0.0', () => {
    console.log('单双竞猜已启动: http://localhost:' + PORT + '/  (玩家端，进入后选场次并扫自己的二维码)');
    console.log('工作人员端入口: http://localhost:' + PORT + '/staff');
    console.log('多场次: 单实例最多并行 ' + MAX_SESSIONS + ' 场，员工端可运行时新建/切换/关闭');
    console.log('玩家端口令: ≥2 场并行时，选择/切换场次需输入口令（验证后绑定 12 小时，期间不可切换）');
    console.log('数据持久化: Postgres（PG_HOST/PG_USER/PG_PASS，端口与库名可用 PG_PORT/PG_DB 覆盖）');
    if (!process.env.STAFF_PASSWORD) {
      console.log('⚠ 工作人员端默认密码为 ' + DEFAULT_PASSWORD + '，建议设置 STAFF_PASSWORD 环境变量覆盖（如 STAFF_PASSWORD=你的密码 node server.js）');
    }
    if (!process.env.PLAYER_SESSION_PASSWORD) {
      console.log('⚠ 玩家端场次口令默认为 ' + DEFAULT_PLAYER_PASSWORD + '，建议设置 PLAYER_SESSION_PASSWORD 环境变量覆盖');
    }
  });
}

start();
