/**
 * 单双竞猜 · 本地实现（无任何第三方依赖）
 * ------------------------------------------------------------
 * 规则核心：本轮数字由工作人员在网页外抽取（抽签/抽卡等），
 * 本服务只负责「录入、校验、锁定与分发」，绝不在服务端或前端
 * 随机生成或抽取该数字。
 *
 * 身份模型（v2）：玩家自带二维码，页面扫码识别后，
 * 以「二维码内容」的 SHA-256 作为玩家唯一 ID：
 *   - players 按 ID 存储本轮登记与预测
 *   - identities 跨轮次记住每个 ID 上次用的称呼（便于复扫自动回填）
 *   - scanLog 记录每一次扫码识别（时间、ID、结果）
 *
 * 持久化（v3）：状态存 Postgres（见 db.js），应用重启后数据仍在。
 * 需要 DATABASE_URL 环境变量提供连接串（Fly.io Postgres 注入）。
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

const QR_MAX_LEN = 512;   // 二维码内容长度上限
const SCAN_LOG_MAX = 500; // 扫码记录条数上限（超出丢弃最旧，db.js 中同样保留此上限）
const SESSION_TTL = 12 * 60 * 60 * 1000; // 员工端会话有效期：12 小时
const DEFAULT_PASSWORD = '123456';       // 默认员工端密码（可用 STAFF_PASSWORD 环境变量覆盖）

/* 员工端权限：密码哈希 + 会话表（内存态，服务重启即失效，需重新登录） */
let staffPasswordHash = null;
let failedAttempts = 0;
let lockedUntil = 0;
const sessions = {}; // token -> { expiresAt }

/** 全局游戏状态（内存态，作为数据库状态的运行时缓存） */
let state = {
  round: 1,        // 当前轮次
  number: null,    // 本轮开奖数字：仅由工作人员 POST /api/confirm 写入，锁定后不可更改
  lockedAt: null,  // 锁定时间
  players: {},     // qrId -> { id, qrPreview, name, oddEven, number, registeredAt, submittedAt, scanCount, lastScanAt }
  identities: {},  // qrId -> { lastSeenRound, lastName, totalScans }（跨轮次身份档案）
  scanLog: []      // [{ ts, round, id, idShort, result }] result: new|known|known_no_name|rejected_locked
};

/* ---------------- SSE（Server-Sent Events）---------------- */

/** 状态版本号：任何一次会改变对客户端可见状态的写入都递增。
 *  用于 SSE 重连时判断是否需要补发全量状态（见 /api/stream 的 Last-Event-ID 逻辑）。 */
let stateVersion = 0;

/** SSE 连接集合：res -> { pid, lastVersion, heartbeat }。
 *  用于状态变更时向所有在线客户端广播，并周期性发送心跳维持连接。 */
const sseClients = new Set();

/** 向单个 SSE 连接发送一条事件。返回是否写入成功（连接已关闭时返回 false）。 */
function sseSend(res, event, data) {
  try {
    // state 事件以版本号为 id：EventSource 重连时会经 Last-Event-ID 头带回，
    // 服务端可据此判断客户端是否错过变更（本实现广播即全量快照，故天然对齐）
    if (event === 'state') {
      res.write('id: ' + stateVersion + '\n');
    }
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
    return true;
  } catch (e) {
    return false;
  }
}

/** 广播全量状态给所有在线 SSE 客户端（携带最新版本号）。
 *  按每个客户端各自登记的 pid 构建负载：玩家端带上自己的 me 视角，
 *  工作人员端（pid 为空）不带 me。 */
function broadcastState() {
  for (const c of sseClients) {
    if (c.res.writableEnded) { sseClients.delete(c); continue; }
    sseSend(c.res, 'state', buildStatePayload(c.pid));
    c.lastVersion = stateVersion;
  }
}

/** 构建状态负载。pid 传 null 表示不带 me 字段（工作人员端视角）。 */
function buildStatePayload(pid) {
  const me = pid ? state.players[pid] : null;
  return {
    ok: true,
    version: stateVersion,
    round: state.round,
    locked: state.number != null,
    number: state.number != null ? state.number : undefined,
    players: publicPlayers(),
    me: me ? { id: me.id, idShort: me.id.slice(0, 8), name: me.name, oddEven: me.oddEven, number: me.number } : null
  };
}

/** 标记状态已变更：递增版本号并广播给所有在线客户端。 */
function markStateChanged() {
  stateVersion += 1;
  broadcastState();
}

/** 从数据库加载状态到内存。失败时回退到内存初始状态（但会记录错误）。 */
async function loadState() {
  try {
    const s = await db.loadState();
    state = {
      round: s.round,
      number: s.number,
      lockedAt: s.lockedAt,
      players: s.players || {},
      identities: s.identities || {},
      scanLog: s.scanLog || []
    };
  } catch (e) {
    console.error('[db] 加载状态失败，使用内存初始状态:', e.message);
  }
}

/** 持久化当前状态到数据库。失败仅记录错误，不阻断请求。 */
function saveState() {
  db.saveState(state).catch((e) => {
    console.error('[db] 保存状态失败:', e.message);
  });
}

function initStaffPassword() {
  const pw = process.env.STAFF_PASSWORD || DEFAULT_PASSWORD;
  staffPasswordHash = crypto.createHash('sha256').update(pw, 'utf8').digest('hex');
}

function issueSession() {
  const token = crypto.randomBytes(24).toString('hex');
  sessions[token] = { expiresAt: Date.now() + SESSION_TTL };
  return token;
}

function requireAuth(token) {
  const s = sessions[token];
  return !!s && s.expiresAt > Date.now();
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

function qrIdOf(content) {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

function logScan(id, result) {
  state.scanLog.push({ ts: Date.now(), round: state.round, id: id, idShort: id.slice(0, 8), result });
  if (state.scanLog.length > SCAN_LOG_MAX) state.scanLog = state.scanLog.slice(-SCAN_LOG_MAX);
}

/** 玩家公共视图：开奖前绝不包含任何人的预测明细与本轮数字 */
function publicPlayers() {
  const locked = state.number != null;
  return Object.values(state.players)
    .sort((a, b) => a.registeredAt - b.registeredAt)
    .map((p) => {
      // 老玩家判定：曾完整走完过至少一轮（提交过预测且那一轮最终开奖）
      const completed = (state.identities[p.id] || {}).completedRounds || 0;
      const item = { name: p.name, submitted: p.oddEven != null, isVeteran: completed >= 1 };
      if (locked) { // 已开奖：展示每个人的预测与命中
        item.oddEven = p.oddEven;
        item.number = p.number;
      }
      return item;
    });
}

/* ---------------- API ---------------- */

async function handleApi(req, res, url) {
  const pid = url.searchParams.get('pid') || '';

  /* 员工端登录（密码 → 会话 token） */
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
      return json(res, 200, { ok: true, token: issueSession() });
    }
    failedAttempts += 1;
    if (failedAttempts >= 5) { lockedUntil = Date.now() + 30000; failedAttempts = 0; }
    return json(res, 401, { ok: false, code: 'wrong_password' });
  }

  /* 员工端退出会话 */
  if (req.method === 'POST' && url.pathname === '/api/staff-logout') {
    const body = await readBody(req);
    const token = body && body.token;
    if (token) delete sessions[token];
    return json(res, 200, { ok: true });
  }

  /* 员工端会话有效性检查（用于页面启动时判断是否已登录） */
  if (req.method === 'GET' && url.pathname === '/api/staff-check') {
    const token = url.searchParams.get('token') || '';
    return json(res, 200, { ok: requireAuth(token) });
  }

  /* 状态查询：全量状态快照。SSE 客户端在重连/回到前台时调用，用于对齐断线期间错过的变更 */
  if (req.method === 'GET' && url.pathname === '/api/state') {
    return json(res, 200, buildStatePayload(pid));
  }

  /* 二维码识别：内容 → 唯一 ID。重复扫码幂等返回同一玩家 */
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const content = String(body.content || '').trim();
    if (!content) return json(res, 400, { ok: false, code: 'scan_empty' });
    if (content.length > QR_MAX_LEN) return json(res, 400, { ok: false, code: 'scan_too_long', maxLen: QR_MAX_LEN });

    const id = qrIdOf(content);
    const preview = content.length > 24 ? content.slice(0, 24) + '…' : content;

    // 情况一：本轮已扫过该码 → 幂等恢复同一玩家（任意设备、任意次数）
    const existing = state.players[id];
    if (existing) {
      existing.scanCount += 1;
      existing.lastScanAt = Date.now();
      logScan(id, existing.name ? 'known' : 'known_no_name');
      const idt = state.identities[id];
      if (idt) { idt.totalScans += 1; idt.lastSeenRound = state.round; }
      saveState();
      markStateChanged();
      return json(res, 200, {
        ok: true, pid: id, idShort: id.slice(0, 8),
        status: existing.name ? 'known' : 'known_no_name',
        name: existing.name || null,
        lastName: (state.identities[id] || {}).lastName || null
      });
    }

    // 情况二：本轮新码。已开奖 → 拒绝入场
    if (state.number != null) {
      logScan(id, 'rejected_locked');
      saveState();
      return json(res, 400, { ok: false, code: 'scan_locked' });
    }

    // 情况三：本轮新码 → 建档（直接以二维码内容作为显示名）
    state.players[id] = {
      id, qrPreview: preview,
      name: content, oddEven: null, number: null,
      registeredAt: Date.now(), submittedAt: null,
      scanCount: 1, lastScanAt: Date.now()
    };
    const prev = state.identities[id];
    state.identities[id] = {
      lastSeenRound: state.round,
      lastName: (prev && prev.lastName) || null,
      totalScans: (prev && prev.totalScans || 0) + 1,
      completedRounds: (prev && prev.completedRounds) || 0
    };
    logScan(id, 'new');
    saveState();
    markStateChanged();
    return json(res, 200, {
      ok: true, pid: id, idShort: id.slice(0, 8),
      status: 'known',
      name: content
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/predict') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const p = state.players[String(body.pid || '')];
    if (!p) return json(res, 400, { ok: false, code: 'predict_not_scanned' });
    if (state.number != null) return json(res, 400, { ok: false, code: 'predict_closed' });
    if (p.oddEven != null) return json(res, 400, { ok: false, code: 'predict_duplicate' });
    const oddEven = body.oddEven;
    const number = Number(body.number);
    if (oddEven !== '单' && oddEven !== '双') return json(res, 400, { ok: false, code: 'predict_invalid_oe' });
    if (!Number.isInteger(number) || number < 1 || number > 8) return json(res, 400, { ok: false, code: 'predict_invalid' });
    p.oddEven = oddEven;
    p.number = number;
    p.submittedAt = Date.now();
    saveState();
    markStateChanged();
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/confirm') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    if (!requireAuth(body.token)) return json(res, 401, { ok: false, code: 'unauthorized' });
    const number = Number(body.number);
    if (!Number.isInteger(number) || number < 1 || number > 8) {
      return json(res, 400, { ok: false, code: 'invalid_number' });
    }
    if (state.number != null) {
      return json(res, 400, { ok: false, code: 'already_locked', number: state.number });
    }
    // 唯一写入点：数字来自工作人员在网页外的抽取，仅在此录入并锁定
    state.number = number;
    state.lockedAt = Date.now();
    // 开奖即视为本轮完整竞猜结束：凡提交过预测的玩家，完整竞猜轮次 +1
    Object.values(state.players).forEach((p) => {
      if (p.oddEven != null) {
        const idt = state.identities[p.id] || (state.identities[p.id] = {});
        idt.completedRounds = (idt.completedRounds || 0) + 1;
        idt.lastSeenRound = state.round;
      }
    });
    saveState();
    markStateChanged();
    return json(res, 200, { ok: true, number });
  }

  if (req.method === 'POST' && url.pathname === '/api/reset') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    if (!requireAuth(body.token)) return json(res, 401, { ok: false, code: 'unauthorized' });
    // 新一轮：清空本轮玩家与扫码记录；identities（跨轮次身份档案）保留
    state = {
      round: state.round + 1, number: null, lockedAt: null,
      players: {}, identities: state.identities, scanLog: []
    };
    saveState();
    markStateChanged();
    return json(res, 200, { ok: true, round: state.round });
  }

  return json(res, 404, { ok: false, error: '接口不存在' });
}

/* ---------------- SSE 流端点 ---------------- */

const SSE_HEARTBEAT_MS = 15000; // 心跳间隔：15 秒发一次，防止代理/浏览器超时断开

/** 建立 SSE 长连接。URL 可带 ?pid=<玩家ID> 以在每次状态事件中附带该玩家视角。
 *  - 连接后立即下发一次全量状态（事件名 state）
 *  - 期间状态变更由 markStateChanged() 主动广播
 *  - 客户端断开（含网络中断）后 EventSource 自动重连；重连请求会带
 *    Last-Event-ID 头，服务端据此判断客户端是否已错过事件，错过则补发全量状态
 *  - 每 15 秒发一次心跳（事件名 ping）维持连接
 */
function handleStream(req, res, url) {
  const pid = url.searchParams.get('pid') || '';

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // 禁用 nginx 等反向代理缓冲
  });
  res.write('retry: 2000\n\n'); // 告知客户端断线后 2 秒重连

  // 首条事件：全量状态（复用版本号作为事件 id）
  sseSend(res, 'state', buildStatePayload(pid));

  const client = { res, pid, lastVersion: stateVersion };
  sseClients.add(client);

  // 心跳定时器
  const heartbeat = setInterval(() => {
    if (res.writableEnded) return;
    sseSend(res, 'ping', { t: Date.now() });
  }, SSE_HEARTBEAT_MS);

  // 客户端主动关闭（关闭页面/调用 close()）：清理资源
  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
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

async function start() {
  initStaffPassword();

  try {
    await db.initDb(); // 幂等建表
    await loadState(); // 从数据库恢复上次状态
  } catch (e) {
    console.error('[db] 数据库初始化失败，应用无法启动:', e.message);
    console.error('  请确认 DATABASE_URL 已正确配置（Fly.io: fly secrets set DATABASE_URL=...）');
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
    console.log('单双竞猜已启动: http://localhost:' + PORT + '/  (玩家端，进入后扫自己的二维码)');
    console.log('工作人员端入口: http://localhost:' + PORT + '/staff');
    console.log('数据持久化: Postgres（DATABASE_URL）');
    if (!process.env.STAFF_PASSWORD) {
      console.log('⚠ 工作人员端默认密码为 ' + DEFAULT_PASSWORD + '，建议设置 STAFF_PASSWORD 环境变量覆盖（如 STAFF_PASSWORD=你的密码 node server.js）');
    }
  });
}

start();
