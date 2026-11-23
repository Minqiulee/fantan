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
 * 身份模型：玩家自带二维码或直接提交会员号，页面识别后，服务端**不保存也不下发原文**：
 *   - 会员号先算盲索引 ref = HMAC-SHA256(pepper, 会员号)（不可逆、确定性），
 *     以 ref 作为玩家唯一 ID：players / identities / 归档表的主键都是它
 *   - 原文以密文存 member_enc（信封加密：RSA 包裹 DEK + AES-256-GCM，版本号写在密文里）
 *   - 对外（接口负载、员工端、大屏、对账 CSV）只出现 ref 与脱敏标签 ****1234
 *   - 实现见 lib/member-id.js；配置与轮换见 docs/member-id-encryption.md
 *
 * 规则模型（奖品 + 特殊数字的版本化）：
 *   - 「奖品四档 + 命中特殊数字全员加奖」合起来是一整套规则，按整体快照存版本
 *     （表 rule_version，append-only，一次保存 = 一版，内容没变不新增版本）
 *   - **规则按轮绑定**（round.rule_version 存「当前这一轮」所用版本）：
 *     场次创建时首轮绑定当时最新版；**新开一轮（reset）时重新绑定当前最新版**，
 *     所以管理员改规则后，同一场次随后新开的轮次用新规则，已在进行的轮次不受影响
 *   - 归档表记下每轮用的版本（round_archive.rule_version → 对账 CSV「规则版本」列），
 *     事后能回答「这一轮按哪一版规则发的奖」
 *   - 规则**不进进程内存**：读场次快照时一条 SQL 连规则一起取，管理端读配置直接查库。
 *     没有缓存就没有 TTL，也就不存在「通知丢了要等一会儿才对得上」的窗口
 *
 * 持久化：状态存 Postgres（见 db.js），应用重启后数据仍在。
 * 连接串只认 DATABASE_URL（托管库如 Supabase 就给这一条），未设则用本地默认库。
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
const MAX_SESSIONS = 4;                  // 单实例同时进行的场次上限
const MAX_SESSION_NAME = 24;             // 场次名称长度上限
const FIRST_SESSION_ID = 'main';         // 空库首次启动时创建的场次 ID（固定值，链接可长期复用）
const DEFAULT_PLAYER_PASSWORD = '8888';  // 默认玩家端场次口令（可用 PLAYER_SESSION_PASSWORD 覆盖）
const PLAYER_BIND_TTL = 12 * 60 * 60 * 1000; // 玩家场次绑定有效期：12 小时
const UNLOCK_MAX_FAILS = 5;              // 连续口令错误次数上限
const UNLOCK_LOCK_MS = 30 * 1000;        // 超限后锁定时长

/* 席位（seat）：场次的参与人数 = 席位总数，一个设备占一个席位。
 *   - 设备首次加入场次必须选一个具体席位，绑定关系跟场次走、跨轮次保留
 *   - 席位记录本身（1…seatCount）由场次创建时物化，扩缩容只增删空席位
 *   - 占用校验与人数上限都在 store.mutate 的同一把版本锁内完成，
 *     所以「两人同时抢同一个席位」只会有一个成功，不存在超卖
 *   - 默认值与上下界只在 lib/seats.js 定义一次：db 层兜底、前端弹窗预填
 *     （见 /shared/seat-config.js）都引用同一份，避免默认值漂移 */
const {
  DEFAULT_SEAT_COUNT, MIN_SEAT_COUNT, MAX_SEAT_COUNT, parseSeatCount
} = require('./lib/seats');
const SEAT_DEVICE_RE = /^[A-Za-z0-9_-]{8,64}$/; // 设备标识：浏览器本地随机串

/* 可猜数字范围：0–9，含两端。0 既是合法开奖数字，也在「双」的判定里（0 % 2 === 0）。
 * 所有入口（predict / pick / submit / confirm / bonus-prize）都走 parseNumber0to9()，
 * 不用 falsy 判断——否则 0 会被当成「没填」。 */
const NUMBER_MIN = 0;
const NUMBER_MAX = 9;

/** 解析 0–9 的整数猜数；null / undefined / '' / 布尔 / 非整数 / 越界一律返回 null。
 *  注意返回 null 表示「非法或缺失」，0 是合法值，调用方必须用 `=== null` 判断。 */
function parseNumber0to9(v) {
  if (v === null || v === undefined || typeof v === 'boolean') return null;
  if (typeof v === 'string' && v.trim() === '') return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= NUMBER_MIN && n <= NUMBER_MAX ? n : null;
}

/* 大屏（/bigscreen）默认公开：现场投屏直接打开即可，不弹登录/口令。
 * 代价是「拿到 URL 的人都能看到开奖前每个人的选项」，所以这里留一个开关：
 * 设 BIGSCREEN_PUBLIC=0 即恢复「仅有效员工 token 可见」。
 * 注意与玩家口令无关：玩家端仍有自己的场次门禁。 */
const BIGSCREEN_PUBLIC = String(process.env.BIGSCREEN_PUBLIC == null ? '' : process.env.BIGSCREEN_PUBLIC).trim() !== '0';

/* 账号体系：登录是「账号 + 独立密码」，不再是共享密码。
 *   - 初始管理员由环境变量引导创建（ADMIN_USERNAME / ADMIN_PASSWORD），之后一律在管理界面维护
 *   - 员工账号由管理员在管理界面创建，一人一份密码
 *   - 兼容：登录请求不传 username 时视为初始管理员，老脚本/老链接不至于立刻失效 */
const DEFAULT_ADMIN_USERNAME = 'admin';
const DEFAULT_ADMIN_PASSWORD = '123456';
const USERNAME_RE = /^[a-z0-9._-]{2,32}$/;   // 账号规则（统一小写）
const PASSWORD_MIN = 6;
const PASSWORD_MAX = 64;
const ROLE_STAFF = 'staff';
const ROLE_ADMIN = 'admin';

/* 场景口令：切换员工归属场次时使用，与登录密码、玩家口令三者互不复用。
 * 只以 scrypt 哈希 + 盐留在进程内存，不落库、不下发、不进日志。 */
const DEFAULT_STAFF_SESSION_PASSWORD = '7777';
const SWITCH_MAX_FAILS = 5;
const SWITCH_LOCK_MS = 60 * 1000;

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

/* 多实例支撑：共享会话存储（store.js）+ 跨实例状态通知（pubsub.js）。
 * 本进程不再持有任何权威状态，内存里只有可丢弃的读缓存。 */
const { createStore } = require('./store');
const { createPubSub } = require('./pubsub');
const memberId = require('./lib/member-id');

/* ---------------- 玩家端场次口令与绑定 ---------------- */

/** 玩家端口令：只保留 scrypt 哈希与随机盐（内存态，不落库、不进日志、不下发）。
 *  用于「选择 / 切换场次」这一动作的门禁。 */
let playerPwSalt = null;
let playerPwHash = null;

/** 绑定令牌的 HMAC 签名密钥：随机生成后存 DB（app_config），
 *  这样服务重启后玩家的绑定仍然有效，而仓库与配置里都没有任何密钥明文。 */
let bindSecret = null;

/* 登录会话落库（staff_session）：多实例部署时 A 实例签发的 token 要能被 B 实例认可，
 * 否则员工刷新后打到另一台机器就被踢回登录页。会话里带账号，审计才能追到人。 */

/* 员工场次口令：scrypt 哈希 + 随机盐，只在进程内存里，用于「切换场次」这一动作。 */
let staffSessionPwSalt = null;
let staffSessionPwHash = null;

/* ---------------- 场次 ---------------- */

/**
 * 进程实例标识：PUB/SUB 用它过滤自己发出的通知（别人的通知才需要重新读库）。
 * 部署时可用 INSTANCE_ID 显式指定（如机器名 / Pod 名），便于排查跨实例问题。
 */
const INSTANCE_ID = process.env.INSTANCE_ID || 'i-' + process.pid + '-' + crypto.randomBytes(3).toString('hex');

/**
 * 共享会话存储（唯一写入口）与跨实例通知通道，start() 里初始化。
 * 之前的 `gameSessions` Map 已删除：那正是多实例下「会话丢失 / 状态不同步」的根源。
 */
let store = null;
let pubsub = null;

/**
 * 读缓存条目上限（LRU）。按「单实例并发场次峰值 × 2~3」给，默认值在 store.js 里。
 * 这是内存闸，不是新鲜度策略：TTL 仍然是 5 秒，两者职责不同。
 * 不设或给非法值时 store 会回落到默认上限，不会退化成无上限。
 */
function cacheMaxEntries() {
  const raw = Number(process.env.STORE_CACHE_MAX);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : undefined;
}

/**
 * 场次对象结构（由 db.loadSessionSnapshot 从库里重建，前端与 SSE 负载格式不变）：
 * {
 *   id, name, seq, status: 'open'|'closed', createdAt, closedAt,
 *   round, number, lockedAt,           // 场次内轮次状态（number 非 null 即已锁定）
 *   ruleVersion,                       // 当前这一轮绑定的规则版本（奖品 + 特殊数字，reset 时重绑）
 *   players: { [pid]: {...} },         // 本场次本轮的玩家
 *   identities: { [pid]: {...} },      // 本场次跨轮身份档案
 *   version                            // 状态版本号（乐观锁凭据 + SSE 事件 id）
 * }
 */

/** 生成不与现有场次冲突的短 ID（随机；真撞车时 store.create 会换一个重试）。 */
function newSessionId() {
  return crypto.randomBytes(4).toString('hex');
}

/** 进行中的场次摘要。 */
function openOf(list) {
  return list.filter((s) => s.status === 'open');
}

/** 玩家端可见的场次摘要（只列进行中的场次）。 */
function publicSessionList(list) {
  return openOf(list).map((s) => ({
    id: s.id,
    name: s.name,
    round: s.round,
    locked: s.number != null,
    seatCount: s.seatCount,
    seatOccupied: s.seatOccupied
  }));
}

/** 员工端可见的场次摘要（含已关闭场次，便于回看）。 */
function staffSessionList(list) {
  return list.map((s) => ({
    id: s.id,
    name: s.name,
    seq: s.seq,
    status: s.status,
    round: s.round,
    locked: s.number != null,
    players: s.playerCount,
    seatCount: s.seatCount,
    seatOccupied: s.seatOccupied,
    ruleVersion: s.ruleVersion,
    createdAt: s.createdAt,
    closedAt: s.closedAt
  }));
}

/** 默认场次：第一个进行中的场次，没有则空串。 */
function defaultSessionIdOf(list) {
  const open = openOf(list);
  return open.length ? open[0].id : '';
}


/* ---------------- SSE（Server-Sent Events）---------------- */

/** SSE 分组：session_id -> Set<client>。client = { res, pid, view, lastVersion }。
 *  广播只在组内进行，不同场次的客户端互不可见。 */
const sseClients = new Map();

/** 向单个 SSE 连接发送一条事件。返回是否写入成功（连接已关闭时返回 false）。 */
function sseSend(res, event, data, id) {
  try {
    // state 事件以场次版本号为 id：EventSource 重连时会经 Last-Event-ID 头带回。
    // 服务端不解析该头 —— 广播本来就是全量快照，重连首帧必定落在当前版本，
    // 「客户端错过多少」不需要判断，也无从增量补发
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
    if (!sseSend(c.res, 'state', buildStatePayload(session, c.pid, c.view), session.version)) {
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

/* ---------------- 草稿（临时选择）：只存进程内存，绝不落库 ----------------
 *
 * 为什么必须独立存：`player.odd_even` 非空是「已提交」的唯一判定依据，归档
 * （db.archiveSnapshot）、对账 CSV、命中判定、publicPlayers 全看它。草稿一旦写进
 * 那一列，就等于提交，会进归档、会被算成中奖。所以草稿走独立的内存表，
 * 库里的 player 表一个字节都不动。
 *
 * 代价与兜底：
 *   - 草稿不落库 → 实例重启后消失。玩家端本地存着 {oe,num,seq}，重连对比
 *     /api/state 里的 draft 与本地 seq，发现服务端落后就重发一次。
 *     客户端有 500ms 节流 + 值变才发，重发成本可以忽略。
 *   - 多实例 → 收到写入的实例把内容经 NOTIFY 转发（这里破例让通知携带数据，
 *     因为草稿不在库里，收端没有「回读」这个选项）。通知丢了也只是该实例
 *     暂时看不到草稿，玩家端重连补发即恢复，最终一致。
 */
const DRAFT_BCAST_MS = 500;   // 草稿变更合并窗口：一场最多 4 次/秒广播
const DRAFT_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/** sid -> Map(pid -> { oe, num, seq, at }) */
const draftStore = new Map();
/** sid -> Map(pid -> 已接受的最大 seq)。
 *  与 draftStore 分开存的原因：撤销草稿要删值，但序号水位不能跟着删 ——
 *  否则「删掉后用一个小 seq 再选」会绕过单调性，乱序的旧请求能把已撤销的选择复活。 */
const draftSeqStore = new Map();
/** sid -> Set(pid)：待广播的脏玩家 */
const draftPending = new Map();
/** sid -> timer */
const draftTimers = new Map();
/** `sid|round|pid` -> { idemKey, oddEven, number, at }：提交幂等回执（内存，重启后
 *  退化为「已提交」判定，仍然不会重复落库）。 */
const submitReceipts = new Map();

/** 把草稿变更转发给其他实例（本实例客户端由 flushDrafts 广播）。
 *  这条通知携带数据，是本项目里唯一的例外：草稿不在库里，收端没有回读的选项。 */
/** 把其他实例转来的草稿合进本地内存，再按合并窗口广播给本实例的客户端。 */
function ingestRemoteDrafts(evt) {
  const sid = evt && evt.sid;
  if (!sid || !Array.isArray(evt.items)) return;
  for (const it of evt.items) {
    if (!it || !it.pid) continue;
    mergeDraft(sid, it.pid, it.draft || null, it.seq);
  }
}

function publishDrafts(sid, items) {
  if (!pubsub || !items || items.length === 0) return;
  pubsub.publish({ type: 'draft', sid, items }).catch(() => { /* 丢了也能靠重连补发 */ });
}

/** 清掉某场次的提交回执（场次关闭 / 新一轮时调用，避免内存无界增长）。
 *  回执只用于「同 key 重放」，丢了不影响正确性：已提交的判断看 player.odd_even。 */
function forgetReceipts(sid) {
  const prefix = sid + '|';
  for (const k of submitReceipts.keys()) {
    if (k.startsWith(prefix)) submitReceipts.delete(k);
  }
}

function draftsOf(sid) {
  let m = draftStore.get(sid);
  if (!m) { m = new Map(); draftStore.set(sid, m); }
  return m;
}

function draftOf(sid, pid) {
  const m = draftStore.get(sid);
  return (m && m.get(pid)) || null;
}

/** 该玩家已接受的最大草稿序号；没有写过为 0。 */
function draftSeqOf(sid, pid) {
  const m = draftSeqStore.get(sid);
  return (m && m.get(pid)) || 0;
}

function bumpDraftSeq(sid, pid, seq) {
  let m = draftSeqStore.get(sid);
  if (!m) { m = new Map(); draftSeqStore.set(sid, m); }
  m.set(pid, seq);
}

/** 写入草稿（只改内存）+ 标记待广播。返回是否真的变化。 */
function putDraft(sid, pid, d) {
  draftsOf(sid).set(pid, d);
  bumpDraftSeq(sid, pid, d.seq);
  markDraftDirty(sid, pid);
  return true;
}

function dropDraft(sid, pid) {
  const m = draftStore.get(sid);
  if (!m || !m.delete(pid)) return false;
  markDraftDirty(sid, pid);
  return true;
}

function clearDrafts(sid) {
  draftSeqStore.delete(sid);
  const m = draftStore.get(sid);
  if (!m || m.size === 0) return;
  const pids = Array.from(m.keys());
  draftStore.delete(sid);
  pids.forEach((pid) => markDraftDirty(sid, pid));
}

/** 把一条草稿合并进本地内存（跨实例通知、玩家端补发都走这里）。
 *  只认更大的 seq：乱序到达的旧值不会把新值盖回去。 */
function mergeDraft(sid, pid, d, seq) {
  const cur = draftOf(sid, pid);
  if (d == null) {
    // 撤销也要吃掉序号：否则随后到达的旧 PUT 会把已撤销的选择复活
    if (seq && seq > draftSeqOf(sid, pid)) bumpDraftSeq(sid, pid, seq);
    if (!cur) return false;
    return dropDraft(sid, pid);
  }
  if (d.seq <= draftSeqOf(sid, pid)) return false;
  return putDraft(sid, pid, { oe: d.oe, num: d.num, seq: d.seq, at: d.at || Date.now() });
}

function markDraftDirty(sid, pid) {
  let set = draftPending.get(sid);
  if (!set) { set = new Set(); draftPending.set(sid, set); }
  set.add(pid);
  if (draftTimers.has(sid)) return;
  const t = setTimeout(() => flushDrafts(sid), DRAFT_BCAST_MS);
  if (t.unref) t.unref();
  draftTimers.set(sid, t);
}

/** 合并窗口到期：把这段时间内变化的玩家一次性推给本场次的在线客户端。
 *  发的是「局部补丁」而不是全量 state —— 草稿不推进 version，用全量快照会
 *  让客户端的版本判新旧逻辑失去意义（也容易把过期快照盖回去）。 */
function flushDrafts(sid) {
  draftTimers.delete(sid);
  const set = draftPending.get(sid);
  draftPending.delete(sid);
  if (!set || set.size === 0) return;
  const group = sseClients.get(sid);
  if (!group || group.size === 0) return;   // 没人在看：不广播，内存还在，首帧 state 会带出
  const items = [];
  set.forEach((pid) => {
    const d = draftOf(sid, pid);
    items.push({
      pid,
      draft: d ? { oe: d.oe, num: d.num, seq: d.seq, at: d.at } : null
    });
  });
  emitToSession({ id: sid }, 'draft', { sid, items });
}

/**
 * 「在场玩家」—— 所有对外列表、人数与统计的唯一口径。
 *
 * 已登出 / 已离开（leftAt 非空）的玩家视为不在现场：不下发、不计数、不进归档明细。
 * 只有两条路径会重新把人放回名单：重新扫码（/api/scan）或玩家端 SSE 重连，
 * 且都只在本轮未锁定前生效 —— 锁定即名单冻结，之后的离开/登出不再改写本轮结果。
 */
function presentPlayers(session) {
  return Object.values(session.players)
    .filter((p) => p.leftAt == null)
    .sort((a, b) => a.registeredAt - b.registeredAt);
}

/** 本轮选择统计：total / submitted / draft / none。只算在场玩家，只读内存 + 快照，不查库。 */
function countChoices(session) {
  const m = draftStore.get(session.id);
  let submitted = 0, draft = 0;
  const players = presentPlayers(session);
  for (const p of players) {
    if (p.oddEven != null) submitted += 1;
    else if (m && m.has(p.id)) draft += 1;
  }
  return {
    total: players.length,
    submitted,
    draft,
    none: players.length - submitted - draft
  };
}

/** 本轮「选了但没确认」的名单：锁定前的二次确认用它，也是对账时解释
 *  「这个人为什么没成绩」的唯一依据（草稿不落库，锁定即清）。
 *  已离开的玩家不在此列表里：人都走了，不能拿他的草稿挡住开奖。 */
function pendingDraftsOf(session) {
  const m = draftStore.get(session.id);
  if (!m || m.size === 0) return [];
  const out = [];
  m.forEach((d, pid) => {
    const p = session.players[pid];
    if (!p || p.leftAt != null || p.oddEven != null) return;
    out.push({ pid, oddEven: d.oe, number: d.num, seq: d.seq, at: d.at });
  });
  return out.sort((a, b) => a.at - b.at);
}

/** 单个玩家的选择态（对外统一口径）：submitted > draft > none。
 *  已离开的玩家不进入任何对外列表，因此这里也不考虑 left。 */
function choiceOf(session, pid) {
  const p = session.players[pid];
  if (!p) return 'none';
  if (p.oddEven != null) return 'submitted';
  return draftOf(session.id, pid) ? 'draft' : 'none';
}

/** 构建状态负载。pid 传空表示不带 me 字段（工作人员端视角）。
 *  view='bigscreen' 时改用大屏视图（开奖前也带出每个人的选项），其余一律玩家视图。
 *  负载只包含本场次的数据。 */
function buildStatePayload(session, pid, view) {
  const bigscreen = view === 'bigscreen';
  const me = pid ? session.players[pid] : null;
  const myDraft = me ? draftOf(session.id, me.id) : null;
  // 规则按本场次**锁定的版本**取，不取「现在最新的一版」：
  // 管理员改了奖品/特殊数字，正在进行的场次看到的仍然是它开场时那一版
  const rule = ruleOf(session);
  return {
    ok: true,
    ...(bigscreen ? { view: 'bigscreen' } : {}),
    session: { id: session.id, name: session.name, status: session.status },
    version: session.version,
    serverTime: Date.now(),
    round: session.round,
    locked: session.number != null,
    number: session.number != null ? session.number : undefined,
    // 席位：seatCount 是配置的容纳人数，seats 是占用情况（选座界面依赖它实时刷新），
    // mySeat 只对本机已登记玩家有意义（未登记 / 新一轮开局前为 null）
    seatCount: session.seatCount,
    seats: seatList(session),
    mySeat: me && me.seatNo != null ? me.seatNo : null,
    ruleVersion: rule.version,
    prizes: rule.prizes,
    // 额外奖励：触发结果不落库，由「本轮开奖数字是否命中该版本的特殊数字」现场重算
    // （锁定后开奖数字不再变，同一轮重算结果恒定；重置后 number=null 自然不触发）
    bonus: {
      ...rule.bonus,
      triggered: ruleBonusHit(rule, session.number)
    },
    counts: countChoices(session),
    players: bigscreen ? bigscreenPlayers(session) : publicPlayers(session),
    me: me ? {
      id: me.id,
      maskedId: me.maskedId,
      oddEven: me.oddEven,
      number: me.number,
      // 草稿只在内存：刷新/重连后靠它把选择恢复出来，避免玩家以为白点了
      draft: myDraft ? { oe: myDraft.oe, num: myDraft.num, seq: myDraft.seq } : null
    } : null
  };
}

/**
 * 场次状态变更的统一出口（本地提交时由 store 事件触发，见 wireStoreEvents）。
 * 广播是纯内存操作：负载来自刚落库的快照，其他实例通过 PUB/SUB 各自读库后自行广播。
 */
function announceChange(change) {
  const { session, type } = change;
  if (type === 'closed') {
    // 先发关闭事件再断连：玩家端据此退回场次选择，而不是只看到一次断线重连
    store.list().then((list) => {
      emitToSession(session, 'session_closed', {
        sid: session.id,
        name: session.name,
        sessions: publicSessionList(list)
      });
      dropSessionClients(session);
    }).catch(() => dropSessionClients(session));
    return;
  }
  broadcastSessionState(session);
}

/* ---------------- 账号与密码 ---------------- */

/** 账号归一化：统一小写去空白，`Admin` 与 `admin` 是同一个账号。 */
function normalizeUsername(raw) {
  return String(raw == null ? '' : raw).trim().toLowerCase();
}

/** scrypt 派生：`scrypt$N$r$p$saltHex$hashHex`。永不明文存密码。 */
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
  return ['scrypt', SCRYPT_N, SCRYPT_R, SCRYPT_P, salt.toString('hex'), key.toString('hex')].join('$');
}

/** 定时安全比对。格式不合法、算法未知一律判失败（不做异常抛出）。 */
function verifyPassword(password, stored) {
  if (typeof password !== 'string' || !password || !stored) return false;
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(N) || !Number.isInteger(r) || !Number.isInteger(p)) return false;
  let salt;
  let expect;
  try {
    salt = Buffer.from(parts[4], 'hex');
    expect = Buffer.from(parts[5], 'hex');
  } catch (e) {
    return false;
  }
  if (!salt.length || !expect.length) return false;
  try {
    const got = crypto.scryptSync(password, salt, expect.length, { N, r, p });
    return got.length === expect.length && crypto.timingSafeEqual(got, expect);
  } catch (e) {
    return false;
  }
}

/** 密码强度底线：长度 + 不能与账号相同。返回错误码或 null。 */
function passwordProblem(password, username) {
  const pw = String(password == null ? '' : password);
  if (pw.length < PASSWORD_MIN) return 'password_too_short';
  if (pw.length > PASSWORD_MAX) return 'password_too_long';
  if (username && pw.toLowerCase() === String(username).toLowerCase()) return 'password_too_weak';
  return null;
}

/** 初始化员工场次口令哈希（口令本身不保留）。 */
function initStaffSessionPassword() {
  const pw = process.env.STAFF_SESSION_PASSWORD || DEFAULT_STAFF_SESSION_PASSWORD;
  staffSessionPwSalt = crypto.randomBytes(16);
  staffSessionPwHash = crypto.scryptSync(pw, staffSessionPwSalt, 32);
}

/** 定时安全比对员工场次口令。 */
function checkStaffSessionPassword(input) {
  if (typeof input !== 'string' || !input || input.length > 128) return false;
  const h = crypto.scryptSync(input, staffSessionPwSalt, 32);
  return crypto.timingSafeEqual(h, staffSessionPwHash);
}

/**
 * 启动引导：保证库里至少有一个管理员。
 *  - 已有任何 admin 账号 → 什么都不做（绝不覆盖线上密码）
 *  - 否则用 ADMIN_USERNAME / ADMIN_PASSWORD 建一个；没配就用默认值并在日志里醒目提示
 */
async function bootstrapAccounts() {
  const admins = await db.countAccounts({ role: ROLE_ADMIN });
  if (!admins) {
    const username = normalizeUsername(process.env.ADMIN_USERNAME || DEFAULT_ADMIN_USERNAME);
    const password = process.env.ADMIN_PASSWORD || DEFAULT_ADMIN_PASSWORD;
    if (!USERNAME_RE.test(username)) {
      console.error('✖ ADMIN_USERNAME 不合法（只允许 a-z 0-9 . _ -，2–32 位）：' + username);
    } else {
      const problem = passwordProblem(password, username);
      if (problem) {
        console.error('✖ ADMIN_PASSWORD 不合法（' + problem + '），未创建管理员');
      } else {
        await db.createAccount({
          username, displayName: '管理员', role: ROLE_ADMIN,
          passwordHash: hashPassword(password), createdBy: 'bootstrap'
        });
        console.log('[account] 已创建初始管理员: ' + username +
          (process.env.ADMIN_PASSWORD ? '' : '（使用默认密码，请登录后立即修改）'));
      }
    }
  }
}

/** 签发登录会话（落库），并绑定默认场次。token 在任意实例都有效。 */
async function issueStaffSession(sessionId, account) {
  const token = crypto.randomBytes(24).toString('hex');
  await db.createStaffSession(token, sessionId || '', Date.now() + SESSION_TTL, account.username);
  return token;
}

/** 取登录会话（过期 / 账号停用视为未登录，由 db 层顺手清理）。 */
function getStaffSession(token) {
  return db.getStaffSession(token);
}

async function requireAuth(token) {
  return !!(await getStaffSession(token));
}

/** 管理界面接口的准入：必须是 admin 角色的有效会话。 */
async function requireAdmin(token) {
  const s = await getStaffSession(token);
  return s && s.role === ROLE_ADMIN ? s : null;
}

/** 写一条操作日志（返回 Promise，关键动作应 await，避免进程退出时丢记录）。
 *  审计失败不能影响业务：只记本地错误，不向调用方抛异常。 */
function audit(req, actor, action, extra = {}) {
  const who = actor || {};
  return db.appendAudit({
    actor: typeof who === 'string' ? who : (who.username || ''),
    role: typeof who === 'string' ? '' : (who.role || ''),
    action,
    sid: extra.sid || '',
    target: extra.target || '',
    detail: extra.detail == null ? null : extra.detail,
    ip: req ? clientIp(req) : ''
  }).catch((e) => console.error('[audit] 写入失败 ' + action + ': ' + e.message));
}

/**
 * 「切换员工场次」的场景口令校验。
 *  - 管理员免校验：这是给员工设的操作边界，管理员登录已是最高凭据
 *  - 员工必须带口令：新建场次（会顺带切过去）与选择场次都走这里
 *  - 失败按账号限频，跨实例同一口径（计数在 auth_throttle 表里）
 * 返回 true 表示放行；false 表示已经写好响应。
 */
async function guardStaffSwitch(req, res, staff, input) {
  if (staff.role === ROLE_ADMIN) return true;
  const key = 'switch:' + staff.username;
  const left = await lockLeft(key);
  if (left > 0) {
    json(res, 429, { ok: false, code: 'staff_too_many_attempts', retryAfter: left });
    return false;
  }
  if (input == null || input === '') {
    json(res, 403, { ok: false, code: 'staff_session_password_required' });
    return false;
  }
  if (!checkStaffSessionPassword(String(input))) {
    const st = await noteFail(key, SWITCH_MAX_FAILS, SWITCH_LOCK_MS);
    const remain = st.lockedUntil > Date.now() ? Math.ceil((st.lockedUntil - Date.now()) / 1000) : 0;
    await audit(req, staff, 'switch_denied', { detail: { reason: 'bad_password' } });
    json(res, 401, {
      ok: false,
      code: 'staff_wrong_password',
      ...(remain > 0 ? { retryAfter: remain } : {})
    });
    return false;
  }
  await db.throttleClear(key);
  return true;
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

/**
 * 席位绑定凭据就是设备标识本身：浏览器首次生成一段随机串存在本地，加入场次时写到
 * session_seat.device_id。服务端只认「这一行绑的是不是这个设备」，不额外签发令牌 ——
 * 席位是现场物理座位，绑定范围仅限单场，没必要再引入一层可过期的签名（反而多一个
 * 「令牌过期但席位还在」的状态要对齐）。
 */

/* ---------------- 席位：快照上的纯函数工具 ---------------- */

/** 设备标识合法化：去空白后必须符合固定字符集；非法返回空串。 */
function normalizeDeviceId(raw) {
  const v = String(raw == null ? '' : raw).trim();
  return SEAT_DEVICE_RE.test(v) ? v : '';
}

/** 解析席位号：只接受 1…MAX_SEAT_COUNT 的整数（字符串数字也接受）。 */
function parseSeatNo(v) {
  return parseSeatCount(v);
}

/** 设备在当前场次已占的席位；没有返回 null。设备与席位是一对一。 */
function seatOfDevice(session, deviceId) {
  if (!deviceId) return null;
  for (const seat of Object.values(session.seats || {})) {
    if (seat.deviceId && seat.deviceId === deviceId) return seat;
  }
  return null;
}

/** 已占用席位数（= 已加入的设备数，不是本轮登记人数）。 */
function occupiedSeatCount(session) {
  return Object.values(session.seats || {}).filter((s) => !!s.deviceId).length;
}

/** 已占用席位里的最大席位号（缩容的下界：不能把有人坐的席位删掉）。 */
function maxOccupiedSeatNo(session) {
  let max = 0;
  for (const seat of Object.values(session.seats || {})) {
    if (seat.deviceId && seat.no > max) max = seat.no;
  }
  return max;
}

/** 玩家端可见的席位占用列表：只暴露「几号、有没有人」，不含会员身份。 */
function seatList(session) {
  return Object.values(session.seats || {})
    .sort((a, b) => a.no - b.no)
    .map((s) => ({ no: s.no, occupied: !!s.deviceId }));
}

/* ---------------- 规则版本（奖品四档 + 特殊数字） ----------------
 * 单双与数字是两次独立猜测，四种组合各成一档：
 *   both    数字和单双都中
 *   number  只中数字（数字对、单双错）
 *   oddeven 只中单双（单双对、数字错）
 *   miss    两项都没中
 *
 * 四档文案 + 「命中特殊数字 → 全员加奖」合起来是一整套规则，按**整体快照**存版本
 * （表 rule_version，append-only）：
 *   - 一次保存 = 一版；内容没变不新增版本（反复点保存不该刷出一堆空版本）
 *   - 规则**按轮绑定**：场次创建时首轮锁定当时最新版，新开一轮（reset）重新绑定最新版，
 *     已在进行的轮次仍按自己那一版判定
 *   - 所以更新规则不影响正在进行的轮次，只对之后新建的场次 / 新开的轮次生效
 *   - 对账归档记录每轮用的是哪一版（round_archive.rule_version → CSV「规则版本」列）
 *   - 每档只有 title / desc 两个字段，**每个字段都是三语对象**
 *     （zh-CN 简体 / zh-HK 繁体 / en-US 英文），空串表示「这一种语言没填」，
 *     某种语言没填时展示端按固定顺序回退，绝不显示空白
 *   - 长度在上限处截断而不是拒绝：奖品文案不是安全边界，没必要让管理员保存失败
 *
 * ## 三语文案（本次改造的核心）
 *
 * 奖品文案要同时在三种界面语言下正确显示，所以 title / desc 由单串变成
 * `{ 'zh-CN': '', 'zh-HK': '', 'en-US': '' }`。两条铁律：
 *   1. **一旦这一档开始配置，名称就必须三语齐全**（只填一种语言的文案等于另外两种语言的
 *      玩家看到的是别的语言的内容，属于配置事故）。说明（desc）要么三语都不填，要么三语都填，
 *      避免「中文有说明、英文没说明」的半截状态。校验不过直接 400，不落库。
 *   2. 未配置的档位（六个字段全空）仍然合法 —— 玩家端不显示该档奖品卡（不会被当成配置错误）。
 *
 * 旧的单语数据（字符串）不迁移、不改写历史版本：读取时归一化成「简体中文有值、其余为空」，
 * 展示端按语言回退，升级前后玩家看到的内容完全一致；管理员下次保存时会被要求补齐三语。
 *
 * 规则**不进进程内存**：场次快照那条 SQL 把 rule_version 一起 JOIN 出来（见 db.SNAPSHOT_SQL），
 * 管理端的配置读取也每次直查库。因此不存在缓存、也不存在 TTL —— 任何一个实例都不会读到
 * 别的实例改过之后才「过一会儿」才对得上的旧规则。
 */
const PRIZE_TIERS = ['both', 'number', 'oddeven', 'miss'];
const PRIZE_TITLE_MAX = 32;
const PRIZE_DESC_MAX = 120;

/** 三语字段的固定顺序（= 管理界面字段顺序 = 展示端回退顺序）。 */
const PRIZE_LOCALES = ['zh-CN', 'zh-HK', 'en-US'];
/** 旧版单语文案落位到哪种语言：历史文案都是简体中文，其余语言由展示端回退。 */
const PRIZE_LEGACY_LOCALE = 'zh-CN';

function emptyLocalizedText() {
  const out = {};
  for (const loc of PRIZE_LOCALES) out[loc] = '';
  return out;
}

function emptyPrizeConfig() {
  const cfg = {};
  for (const tier of PRIZE_TIERS) cfg[tier] = { title: emptyLocalizedText(), desc: emptyLocalizedText() };
  return cfg;
}

/**
 * 单个三语字段归一化。三种输入形态都要认：
 *   - 三语对象（正常保存）→ 逐语言去空白 + 按上限截断，缺的语言补空串
 *   - 字符串（旧版单语数据）→ 落到 PRIZE_LEGACY_LOCALE，其余语言留空由展示端回退
 *   - 其他（null / 数字 / 数组）→ 全空
 * 只做「能读懂就收下」的宽松处理；「三语是否齐全」由下面的 validate* 单独判定，
 * 这样读历史数据永远不会因为校验规则收紧而报错。
 */
function normalizeLocalizedText(input, max) {
  const out = emptyLocalizedText();
  if (input == null) return out;
  if (typeof input === 'string') {
    out[PRIZE_LEGACY_LOCALE] = input.trim().slice(0, max);
    return out;
  }
  if (typeof input !== 'object') return out;
  for (const loc of PRIZE_LOCALES) {
    const v = input[loc];
    out[loc] = String(v == null ? '' : v).trim().slice(0, max);
  }
  return out;
}

/** 归一化：只认四档 × title/desc 两个三语字段，其余字段一律丢弃（防止把任意 JSON 塞进库）。 */
function normalizePrizeConfig(input) {
  const out = emptyPrizeConfig();
  if (!input || typeof input !== 'object') return out;
  for (const tier of PRIZE_TIERS) {
    const src = input[tier];
    if (!src || typeof src !== 'object') continue;
    out[tier].title = normalizeLocalizedText(src.title, PRIZE_TITLE_MAX);
    out[tier].desc = normalizeLocalizedText(src.desc, PRIZE_DESC_MAX);
  }
  return out;
}

/** 这个三语字段有内容吗（不看具体哪种语言）。 */
function hasAnyText(field) {
  return !!field && PRIZE_LOCALES.some((loc) => !!field[loc]);
}

/**
 * 三语完整性校验 —— 在 normalize 之后调用（入参已是三语对象）。
 * 返回 [{ tier, field, locales }]，locales 是缺失/未填的语言；空数组表示通过。
 *
 * 规则（每条都对应一次真实的配置事故）：
 *   - 整档六格全空 → 合法，玩家端不显示该档奖品卡；
 *   - 档位开始配置后，名称必须三语齐全 —— 玩家端按当前语言取文案，缺语言只能回退，
 *     那等于让英文玩家拿到中文奖品名；
 *   - 说明要么三语都填、要么都不填 —— 避免同一条奖品在三种语言下信息量不同。
 */
function validatePrizeConfig(prizes) {
  const problems = [];
  for (const tier of PRIZE_TIERS) {
    const cfg = prizes[tier];
    if (!hasAnyText(cfg.title) && !hasAnyText(cfg.desc)) continue;
    const missingTitle = PRIZE_LOCALES.filter((loc) => !cfg.title[loc]);
    if (missingTitle.length) problems.push({ tier, field: 'title', locales: missingTitle });
    const descFilled = PRIZE_LOCALES.filter((loc) => cfg.desc[loc]).length;
    if (descFilled > 0 && descFilled < PRIZE_LOCALES.length) {
      problems.push({
        tier,
        field: 'desc',
        locales: PRIZE_LOCALES.filter((loc) => !cfg.desc[loc])
      });
    }
  }
  return problems;
}

/**
 * 全员额外奖励（命中特殊数字 → 全员加奖）：
 * 开奖数字等于「特殊数字」时，除原有中奖判定外，所有参与者（含未猜中者）额外获得一份指定奖品。
 * 它是规则的一部分（与四档文案同版本保存），字段为
 * `{ number: 0-9|null, title: {三语}, desc: {三语} }`（三语规则与四档一致）。
 *   - number 为 null 表示未启用（不触发）。**0 是合法特殊数字，不能再用 0 表示「不启用」**
 *   - 触发**不落库**：/api/state 里按「本轮开奖数字是否命中该场次锁定版本的特殊数字」现场重算，
 *     锁定后开奖数字不再变 → 同一轮重算结果恒定；一轮只锁定一次，天然只触发一次；
 *     新一轮 reset 把 number 置 null，自然不再触发
 *   - 改特殊数字只影响之后新建的场次：老场次读的是它自己锁定的那一版，
 *     所以「锁定后再改配置把已开奖轮翻成触发」这种情况不再出现
 */
function emptyBonusConfig() {
  return { number: null, title: emptyLocalizedText(), desc: emptyLocalizedText() };
}

/** 归一化：number 走与开奖数字同一套 0–9 校验（非法/缺失视为未启用），
 *  title/desc 是三语对象，各语言走同样的长度上限。 */
function normalizeBonusConfig(input) {
  const out = emptyBonusConfig();
  if (!input || typeof input !== 'object') return out;
  const n = parseNumber0to9(input.number);
  if (n !== null) out.number = n;
  out.title = normalizeLocalizedText(input.title, PRIZE_TITLE_MAX);
  out.desc = normalizeLocalizedText(input.desc, PRIZE_DESC_MAX);
  return out;
}

/** 额外奖励的三语完整性校验（入参已归一化）：文案一旦填就必须三语齐全，规则与四档相同。
 *  只开特殊数字、不写文案是合法的 —— 玩家端用内置文案。 */
function validateBonusConfig(bonus) {
  const problems = [];
  if (!hasAnyText(bonus.title) && !hasAnyText(bonus.desc)) return problems;
  const missingTitle = PRIZE_LOCALES.filter((loc) => !bonus.title[loc]);
  if (missingTitle.length) problems.push({ tier: 'bonus', field: 'title', locales: missingTitle });
  const descFilled = PRIZE_LOCALES.filter((loc) => bonus.desc[loc]).length;
  if (descFilled > 0 && descFilled < PRIZE_LOCALES.length) {
    problems.push({
      tier: 'bonus',
      field: 'desc',
      locales: PRIZE_LOCALES.filter((loc) => !bonus.desc[loc])
    });
  }
  return problems;
}

/** 空规则：只在「库里连一版都没有」的极端情况下兜底（启动引导保证不会发生）。 */
function emptyRule() {
  return { version: 0, prizes: emptyPrizeConfig(), bonus: emptyBonusConfig() };
}

/**
 * 取某个场次当前轮该用的规则 —— **按当前轮绑定的版本**，不是「现在最新的版本」。
 * 规则来自 `session.rule`（读场次快照那条 SQL 一起查出来的），因此这里不发查询、也不读缓存。
 * 新开一轮（reset）时会把 `session.rule` 重绑成最新版，见 /api/reset。
 */
function ruleOf(session) {
  const r = session && session.rule;
  if (!r) return emptyRule();
  return {
    version: Number(r.version),
    prizes: normalizePrizeConfig(r.prizes),
    bonus: normalizeBonusConfig(r.bonus)
  };
}

/** 库里最新一版（管理端配置接口用）。每次直查，不缓存 —— 否则另一台实例刚存的版本要「等一会儿」才看得到。 */
async function loadLatestRule() {
  const row = await db.getLatestRule();
  if (!row) return emptyRule();
  return {
    version: Number(row.version),
    prizes: normalizePrizeConfig(row.prizes),
    bonus: normalizeBonusConfig(row.bonus)
  };
}

/**
 * 保存一版新规则。patch 只带要改的那一块（`{prizes}` 或 `{bonus}`）：
 * 另一块由数据库在同一个事务里沿用最新一版 —— 不要拿调用方手里那份规则去拼，
 * 多实例下它可能是旧的，会把别的实例刚改的那块悄悄回滚。
 *
 * 内容与最新版相同 → 库里不新增版本（created:false），返回值仍是那一版。
 */
async function saveRule(patch, { source, actor }) {
  const payload = { source, createdBy: actor || '' };
  if (patch.prizes !== undefined) payload.prizes = normalizePrizeConfig(patch.prizes);
  if (patch.bonus !== undefined) payload.bonus = normalizeBonusConfig(patch.bonus);
  const result = await db.saveRuleVersion(payload);
  if (!result.ok) throw new Error(result.error || 'rule_save_failed');

  // 不回填任何进程内状态：下一次读场次快照 / 读配置时自然拿到新版本
  const rule = {
    version: Number(result.rule.version),
    prizes: normalizePrizeConfig(result.rule.prizes),
    bonus: normalizeBonusConfig(result.rule.bonus)
  };
  return { rule, created: !!result.created };
}

/** 本轮开奖数字命中特殊数字吗（按该场次锁定的那一版规则判定，未启用返回 false）。 */
function ruleBonusHit(rule, number) {
  return number != null && rule.bonus.number != null && Number(number) === rule.bonus.number;
}

/**
 * 启动时保证「至少有一版规则」，并把版本化之前建的场次挂到最早一版上。
 *
 * 升级场景：老库把奖品配置存在 app_config（每次保存就地覆盖，没有历史），
 * 这里把最后一份落成 v1 —— 老场次当时用的就是这份配置，所以统一挂 min(version)
 * 是对历史最接近的还原。空库则落一版空配置，保证新建场次一定锁得到版本。
 */
async function bootstrapRules() {
  const existing = await db.listRuleVersions();
  if (!existing.length) {
    let oldPrizes = null;
    let oldBonus = null;
    try {
      const rawPrizes = await db.getConfig('prize_config');
      const rawBonus = await db.getConfig('bonus_prize');
      if (rawPrizes) { try { oldPrizes = JSON.parse(rawPrizes); } catch (e) { oldPrizes = null; } }
      if (rawBonus) { try { oldBonus = JSON.parse(rawBonus); } catch (e) { oldBonus = null; } }
    } catch (e) {
      console.error('[rule] 读取旧奖品配置失败（按空配置初始化）:', e.message);
    }
    const seeded = await db.saveRuleVersion({
      prizes: normalizePrizeConfig(oldPrizes),
      bonus: normalizeBonusConfig(oldBonus),
      source: 'seed',
      createdBy: 'bootstrap'
    });
    if (!seeded.ok) throw new Error(seeded.error || 'rule_bootstrap_failed');
    console.log('[rule] 初始化规则 v' + seeded.rule.version
      + '（来源：' + (oldPrizes || oldBonus ? 'app_config 旧配置' : '空配置') + '）');
  }

  const pinned = await db.pinSessionsWithoutRule();
  if (pinned) console.log('[rule] 已为 ' + pinned + ' 个历史场次补上规则版本');
}

/** 来源 IP：优先取反向代理头，退化到 socket 地址。 */
function clientIp(req) {
  const xff = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  return xff || (req.socket && req.socket.remoteAddress) || 'unknown';
}

/** 口令/密码错误限频（存库）。key 三种：'login:<账号>'、'switch:<账号>'、'player:<ip>'。
 *  放库里的理由是多实例口径：每台机器各算一遍等于把阈值放大 N 倍。 */

function playerThrottleKey(ip) {
  return 'player:' + ip;
}

/** 锁定剩余秒数（0 表示未锁定）。 */
async function lockLeft(key) {
  const st = await db.throttleState(key);
  const left = st.lockedUntil - Date.now();
  return left > 0 ? Math.ceil(left / 1000) : 0;
}

/** 记一次失败（达阈值即锁定，返回记完后的状态）。 */
function noteFail(key, max, lockMs) {
  return db.throttleFail(key, max, lockMs);
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
 *
 * 多实例注意：这里会按需读库（不再有进程内场次表）。
 *  - fresh=true 用于「马上要把快照发给客户端」的路径（/api/state、/api/stream），
 *    绕过读缓存，保证首帧不是别的实例提交前的旧版本；
 *  - 其他路径允许走 TTL 缓存，真正的写操作随后由 store.mutate 重新读最新值。
 */
async function playerSessionContext(sidRaw, utoken, staffToken, { fresh = false } = {}) {
  const wanted = String(sidRaw || '');
  let listPromise = null;
  const getList = () => (listPromise = listPromise || store.list());

  // 员工端：凭员工会话直接放行（含已关闭场次，便于回看）
  if (staffToken && await requireAuth(staffToken)) {
    const s = wanted ? await store.load(wanted, { fresh }) : null;
    if (!s) {
      return { err: { status: 404, code: 'session_not_found', sessions: staffSessionList(await getList()) } };
    }
    return { session: s, staff: true };
  }

  if (utoken) {
    const bind = verifyBind(utoken);
    if (!bind) return { err: { status: 403, code: 'session_need_unlock', reason: 'bad_token' } };
    if (wanted && wanted !== bind.sid) {
      return { err: { status: 403, code: 'session_locked', boundSid: bind.sid } };
    }
    const s = await store.load(bind.sid, { fresh });
    if (!s) {
      return { err: { status: 404, code: 'session_not_found', sessions: publicSessionList(await getList()) } };
    }
    if (s.status !== 'open') {
      return { err: { status: 409, code: 'session_closed', sessions: publicSessionList(await getList()) } };
    }
    return { session: s };
  }

  const open = openOf(await getList());
  if (open.length === 1) {
    if (wanted && wanted !== open[0].id) {
      return { err: { status: 403, code: 'session_locked', boundSid: open[0].id } };
    }
    const s = await store.load(open[0].id, { fresh });
    if (!s) return { err: { status: 404, code: 'session_not_found', sessions: [] } };
    return { session: s };
  }
  if (open.length === 0) {
    return { err: { status: 404, code: 'session_not_found', sessions: [] } };
  }
  return { err: { status: 403, code: 'session_need_unlock', sessions: publicSessionList(await getList()) } };
}


/**
 * 大屏准入：默认公开（BIGSCREEN_PUBLIC），不需要登录或口令。
 *  - 带有效员工 token：走员工视角，可回看已关闭场次（与员工端一致）
 *  - 不带 / 带无效 token：只看进行中的场次；指定 sid 可用就用它，否则回落到第一个进行中场次
 *    （现场大屏要「打开即看」，不能因为链接里没有 sid 就弹出选场/口令）
 * 返回 { session, staff? } 或 { err }。
 */
async function bigscreenContext(sidRaw, staffToken, { fresh = false } = {}) {
  const wanted = String(sidRaw || '');
  if (staffToken) {
    const ctx = await playerSessionContext(wanted, '', staffToken, { fresh });
    if (ctx.session) return ctx;
  }
  const list = await store.list();
  const open = openOf(list);
  const sid = wanted && open.some((s) => s.id === wanted) ? wanted : defaultSessionIdOf(list);
  if (!sid) return { err: { status: 404, code: 'session_not_found', sessions: [] } };
  const s = await store.load(sid, { fresh });
  if (!s) return { err: { status: 404, code: 'session_not_found', sessions: publicSessionList(list) } };
  if (s.status !== 'open') {
    return { err: { status: 409, code: 'session_closed', sessions: publicSessionList(list) } };
  }
  return { session: s };
}


/** 准入判定失败时的统一响应；返回 true 表示已响应。 */
function rejectPlayerSession(res, ctx) {
  if (!ctx || ctx.session) return false;
  const e = ctx.err || { status: 500, code: 'internal_error' };
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
 *  只反映本场次、且只含在场玩家（已登出/已离开的不下发）。
 *  status 是「已提交/待确认/未选」的统一口径，但不含具体选项。 */
function publicPlayers(session) {
  const locked = session.number != null;
  const drafts = draftStore.get(session.id);
  return presentPlayers(session).map((p) => {
    // 老玩家判定：在本场次曾完整走完过至少一轮（提交过预测且那一轮最终开奖）
    const completed = (session.identities[p.id] || {}).completedRounds || 0;
    const item = {
      id: p.id,
      maskedId: p.maskedId,
      seatNo: p.seatNo,
      submitted: p.oddEven != null,
      status: choiceOf(session, p.id),
      draft: !!(drafts && drafts.has(p.id)) && p.oddEven == null,
      isVeteran: completed >= 1
    };
    if (locked) { // 已开奖：展示每个人的预测与命中
      item.oddEven = p.oddEven;
      item.number = p.number;
    }
    return item;
  });
}

/**
 * 大屏视图：本场次本轮每个玩家的「当前选项」。
 *
 * 与 publicPlayers 的唯一区别是开奖前也返回选项 —— 大屏是现场内部展示，
 * 需要让所有人看到谁选了单、谁选了双。因此这个视图**只允许员工授权通道**获取
 * （见 handleStream / /api/state 里的 view=bigscreen 校验），玩家端仍走 publicPlayers。
 *
 * 字段语义：
 *   status  'submitted' 已确认 | 'draft' 选了没确认 | 'none' 还没选；
 *   oe/num  用于显示的「当前值」：已提交取提交值，未提交取草稿值，都没有为 null；
 *   submitted 仅表示「已确认提交」（草稿不算），统计与归档只认它；
 *   draftSeq 草稿的客户端序号（大屏不用，留给排障）；
 *   isVeteran 本场次老玩家。
 *
 * **已登出 / 已离开的玩家不会出现在这个数组里**：大屏看到的是「现在还在场的人」，
 * 不是本轮登记过的人。客户端据此直接删卡片，不需要再判断 left 状态。
 */
function bigscreenPlayers(session) {
  const drafts = draftStore.get(session.id);
  return presentPlayers(session).map((p) => {
    const completed = (session.identities[p.id] || {}).completedRounds || 0;
    const submitted = p.oddEven != null;
    const d = submitted ? null : (drafts && drafts.get(p.id)) || null;
    return {
      id: p.id,
      maskedId: p.maskedId,
      seatNo: p.seatNo,
      status: submitted ? 'submitted' : (d ? 'draft' : 'none'),
      oe: submitted ? p.oddEven : (d ? d.oe : null),
      num: submitted ? p.number : (d ? d.num : null),
      draftOddEven: d ? d.oe : null,
      draftNumber: d ? d.num : null,
      draftSeq: d ? d.seq : null,
      draftAt: d ? d.at : null,
      oddEven: p.oddEven,
      number: p.number,
      submitted,
      isVeteran: completed >= 1,
      registeredAt: p.registeredAt,
      submittedAt: p.submittedAt
    };
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

/* 列头常量：**顺序即契约**，下游脚本按位置/列名解析，改动等于破坏对账。
 * 需要新字段时只追加到末尾，不要插在中间、不要改名。
 * 两套列头都不含积分/总分字段——系统只记录每次猜测与实际开奖是否匹配。
 * 「锁定人」是该轮开奖的操作账号（与操作日志同源，空 = 无记录）。
 * 「会员号」列的**内容已变**：现在输出盲索引令牌 m_xxxx（不可逆、跨场次稳定），
 *   不再是二维码原文。列名保持不变（改名会打断按列名解析的下游），语义见 docs/member-id-encryption.md。
 * 末列「规则版本」是该轮所用规则（奖品四档 + 特殊数字）的版本号：
 *   取自场次开场时锁定的那一版，空 = 版本化之前的历史行（当时没有版本概念）。 */
const CSV_DETAIL_HEADER = [
  '场次ID', '场次名称', '场次序号', '轮次号', '开奖数字', '开奖单双',
  '锁定时间', '归档时间', '会员号', '预测单双', '预测数字', '是否提交',
  '单双命中', '数字命中', '登记时间', '提交时间', '锁定人', '规则版本'
];
const CSV_ROUND_HEADER = [
  '场次ID', '场次名称', '场次序号', '轮次号', '开奖数字', '开奖单双',
  '锁定时间', '归档时间', '扫码人数', '提交人数', '锁定人', '规则版本'
];
const CSV_AUDIT_HEADER = [
  '时间', '账号', '角色', '操作', '场次ID', '对象', '明细', 'IP'
];

/* ---------------- API ---------------- */

async function handleApi(req, res, url) {
  const pid = url.searchParams.get('pid') || '';

  /* 登录（账号 + 独立密码 → 会话 token，并绑定默认场次）
   * 限频与 token 都在库里：同一账号连错 5 次锁 30 秒，跨实例共享这个计数。
   * 账号必填：一人一账号，没有「默认账号」这种捷径。 */
  if (req.method === 'POST' && url.pathname === '/api/staff-login') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    if (!body.username || !String(body.username).trim()) {
      return json(res, 400, { ok: false, code: 'username_required' });
    }
    const username = normalizeUsername(body.username);
    const throttleKey = 'login:' + username;
    const left = await lockLeft(throttleKey);
    if (left > 0) {
      return json(res, 429, { ok: false, code: 'too_many_attempts', retryAfter: left });
    }

    const account = await db.getAccountWithSecret(username);
    const disabled = !!account && account.status !== 'active';
    if (!account || disabled || !verifyPassword(String(body.password || ''), account.passwordHash)) {
      const st = await noteFail(throttleKey, 5, 30000);
      await audit(req, username, 'login_failed', {
        detail: { reason: !account ? 'no_account' : disabled ? 'disabled' : 'bad_password' }
      });
      if (st.lockedUntil > Date.now()) {
        return json(res, 429, {
          ok: false, code: 'too_many_attempts',
          retryAfter: Math.ceil((st.lockedUntil - Date.now()) / 1000)
        });
      }
      return json(res, 401, { ok: false, code: disabled ? 'account_disabled' : 'wrong_password' });
    }

    await db.throttleClear(throttleKey);
    await db.touchAccountLogin(username);
    const list = await store.list();
    const sid = defaultSessionIdOf(list);
    const token = await issueStaffSession(sid, account);
    await audit(req, account, 'login', { sid, detail: { sessionId: sid } });
    return json(res, 200, {
      ok: true,
      token,
      sid,
      sessions: staffSessionList(list),
      user: { username: account.username, role: account.role, displayName: account.displayName }
    });
  }

  /* 退出登录 */
  if (req.method === 'POST' && url.pathname === '/api/staff-logout') {
    const body = await readBody(req);
    const token = body && body.token;
    if (token) {
      const s = await getStaffSession(token);
      await db.deleteStaffSession(token);
      if (s) await audit(req, s, 'logout', { sid: s.sessionId });
    }
    return json(res, 200, { ok: true });
  }

  /* 会话有效性检查（页面启动时判断是否已登录，并取回绑定的场次与账号信息） */
  if (req.method === 'GET' && url.pathname === '/api/staff-check') {
    const token = url.searchParams.get('token') || '';
    const s = await getStaffSession(token);
    if (!s) return json(res, 200, { ok: false });
    // 绑定的场次可能已被别人关闭（甚至在别的实例上关闭的）：回退到默认场次
    let sid = s.sessionId;
    if (!sid || !(await store.load(sid))) {
      const list = await store.list();
      sid = defaultSessionIdOf(list);
      await db.setStaffSessionScope(token, sid);
    }
    return json(res, 200, {
      ok: true,
      sid,
      sessions: staffSessionList(await store.list()),
      user: { username: s.username, role: s.role, displayName: s.displayName }
    });
  }

  /* 场次列表：玩家端只看到进行中的场次；带有效员工 token 时返回含已关闭场次的完整列表。
   * needPassword 告诉玩家端：此刻是否需要先过口令才能入场（≥2 场并行时为 true）。 */
  if (req.method === 'GET' && url.pathname === '/api/sessions') {
    const token = url.searchParams.get('token') || '';
    const list = await store.list();
    if (token && await requireAuth(token)) {
      return json(res, 200, { ok: true, sessions: staffSessionList(list) });
    }
    return json(res, 200, {
      ok: true,
      sessions: publicSessionList(list),
      needPassword: openOf(list).length > 1
    });
  }

  /* 玩家端：选择 / 切换场次的口令校验入口。
   *  - 成功后返回绑定令牌（ut），客户端后续带着它访问，服务端据此锁定场次
   *  - 失败按 IP 限频，连续 5 次错 → 锁 30 秒（计数在库里，跨实例同一口径）
   *  - auto=true 仅在「唯一进行中场次」时允许免口令自动绑定（用来自动进入并把场次固定下来） */
  if (req.method === 'POST' && url.pathname === '/api/session-unlock') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });

    const sid = String(body.sid || '');
    const ip = clientIp(req);
    const throttleKey = playerThrottleKey(ip);
    const list = await store.list();
    const left = await lockLeft(throttleKey);
    if (left > 0) {
      return json(res, 429, { ok: false, code: 'player_too_many_attempts', retryAfter: left });
    }

    const session = await store.load(sid);
    if (!session) {
      return json(res, 404, { ok: false, code: 'session_not_found', sessions: publicSessionList(list) });
    }
    if (session.status !== 'open') {
      return json(res, 409, { ok: false, code: 'session_closed', sessions: publicSessionList(list) });
    }

    const auto = body.auto === true;
    if (auto) {
      const open = openOf(list);
      if (!(open.length === 1 && open[0].id === session.id)) {
        return json(res, 403, { ok: false, code: 'unlock_password_required', sessions: publicSessionList(list) });
      }
    } else if (!checkPlayerPassword(body.password)) {
      const st = await noteFail(throttleKey, UNLOCK_MAX_FAILS, UNLOCK_LOCK_MS);
      const remain = st.lockedUntil > Date.now()
        ? Math.ceil((st.lockedUntil - Date.now()) / 1000) : 0;
      return json(res, 401, {
        ok: false,
        code: 'player_wrong_password',
        ...(remain > 0 ? { retryAfter: remain } : {})
      });
    }

    await db.throttleClear(throttleKey); // 验证通过即清空该 IP 的失败计数
    const exp = Date.now() + PLAYER_BIND_TTL;
    return json(res, 200, {
      ok: true,
      sid: session.id,
      ut: signBind(session.id, exp),
      expiresAt: exp,
      session: { id: session.id, name: session.name, round: session.round, locked: session.number != null },
      sessions: publicSessionList(list)
    });
  }

  /* 新建场次（员工端）。上限与序号在 db 的全局锁内判定，两台实例同时新建也不会超卖。 */
  if (req.method === 'POST' && url.pathname === '/api/session-create') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = await getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });
    // 新建场次会把自己绑过去，等同于切换场次 —— 同样要走场景口令
    if (!(await guardStaffSwitch(req, res, staff, body.sessionPassword))) return;

    const name = normalizeSessionName(body.name, '');
    if (name === false) {
      return json(res, 400, { ok: false, code: 'session_name_too_long', maxLen: MAX_SESSION_NAME });
    }
    // 参与人数（= 席位总数）：不传按默认 12；传了就必须是 1…64 的整数，不做静默回退
    let seatCount = DEFAULT_SEAT_COUNT;
    if (body.seats !== undefined && body.seats !== null && body.seats !== '') {
      const parsed = parseSeatNo(body.seats);
      if (parsed === null) {
        return json(res, 400, {
          ok: false, code: 'invalid_seat_count',
          min: MIN_SEAT_COUNT, max: MAX_SEAT_COUNT
        });
      }
      seatCount = parsed;
    }

    const created = await store.create({
      id: newSessionId(),
      name,
      maxOpen: MAX_SESSIONS,
      seatCount,
      makeId: () => newSessionId()
    });
    if (!created.ok) {
      if (created.code === 'session_limit') {
        return json(res, 409, { ok: false, code: 'session_limit', max: MAX_SESSIONS });
      }
      console.error('[session] 新建场次失败:', created.error);
      return json(res, 500, { ok: false, code: 'create_failed' });
    }

    const session = created.session;
    await db.setStaffSessionScope(staff.token, session.id); // 创建者直接切到新场次
    await audit(req, staff, 'session_create', {
      sid: session.id, target: session.name, detail: { name: session.name }
    });
    return json(res, 200, {
      ok: true,
      sid: session.id,
      session: {
        id: session.id, name: session.name, round: session.round, status: session.status,
        seatCount: session.seatCount, ruleVersion: session.ruleVersion
      },
      sessions: staffSessionList(await store.list())
    });
  }

  /* 调整场次参与人数（席位配置）。员工 / 管理员都可用。
   * 规则（与加入、占用校验共用同一把版本锁，因此不存在「校验通过但写进去超卖」）：
   *   - 新人数必须是 1…MAX_SEAT_COUNT 的整数
   *   - 不能小于「已占用席位里的最大席位号」：有人坐的席位不能凭空消失（要缩容先让人离开）
   *   - 扩容补空席位；缩容只删空席位，已绑定设备的席位号保持稳定、不重排
   *   - 已登记玩家的 seatNo 不受影响（缩容 bounds 已经覆盖了所有有人的席位） */
  if (req.method === 'POST' && url.pathname === '/api/session-seats') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = await getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });

    const sidSeat = String(body.sid || '') || staff.sessionId;
    const next = parseSeatNo(body.seats);
    if (next === null) {
      return json(res, 400, {
        ok: false, code: 'invalid_seat_count',
        min: MIN_SEAT_COUNT, max: MAX_SEAT_COUNT
      });
    }
    const current = await store.load(sidSeat, { fresh: true });
    if (!current) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (current.status !== 'open') return json(res, 409, { ok: false, code: 'session_closed' });

    const out = await store.mutate(sidSeat, (s) => {
      if (s.status !== 'open') {
        return { abort: { status: 409, body: { ok: false, code: 'session_closed' } } };
      }
      const maxUsed = maxOccupiedSeatNo(s);
      if (next < maxUsed) {
        return {
          abort: {
            status: 409,
            body: {
              ok: false, code: 'seat_count_below_occupied',
              maxOccupied: maxUsed, occupied: occupiedSeatCount(s), seatCount: next
            }
          }
        };
      }
      // 缩容：删掉新上界之外的空席位；扩容：把缺的席位补成空席位
      for (const key of Object.keys(s.seats)) {
        if (Number(key) > next) delete s.seats[key];
      }
      for (let i = 1; i <= next; i += 1) {
        if (!s.seats[i]) {
          s.seats[i] = { no: i, deviceId: '', memberId: '', memberEnc: null, boundAt: null };
        }
      }
      s.seatCount = next;
      return { result: { seatCount: next, occupied: occupiedSeatCount(s) } };
    });

    if (out.notFound) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (out.aborted) return json(res, out.aborted.status, out.aborted.body);
    if (out.conflict) return json(res, 409, { ok: false, code: 'write_conflict' });
    if (out.failed) return json(res, 500, { ok: false, code: 'write_failed' });

    await audit(req, staff, 'session_seats', {
      sid: sidSeat, target: current.name,
      detail: { from: current.seatCount, to: next, occupied: out.result.occupied }
    });
    return json(res, 200, {
      ok: true,
      sid: sidSeat,
      seatCount: out.result.seatCount,
      occupied: out.result.occupied,
      seats: seatList(out.session),
      sessions: staffSessionList(await store.list())
    });
  }

  /* 切换场次（员工端）：只改该 token 的归属绑定，不影响其他员工 */
  if (req.method === 'POST' && url.pathname === '/api/session-select') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = await getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });
    const session = await store.load(String(body.sid || ''));
    if (!session) return json(res, 404, { ok: false, code: 'session_not_found' });
    // 切换场次必须过场景口令（与登录密码、玩家口令互不复用）
    if (!(await guardStaffSwitch(req, res, staff, body.sessionPassword))) return;
    const from = staff.sessionId;
    await db.setStaffSessionScope(staff.token, session.id);
    await audit(req, staff, 'session_select', {
      sid: session.id, target: session.name,
      detail: { from: from || '', to: session.id, name: session.name }
    });
    return json(res, 200, {
      ok: true,
      sid: session.id,
      session: { id: session.id, name: session.name, round: session.round, status: session.status },
      sessions: staffSessionList(await store.list())
    });
  }

  /* 关闭场次（员工端）：标记关闭、通知并断开该场次的连接，数据保留可回看。
   * 关闭事件经 PUB/SUB 广播，其他实例上的同场次连接也会收到 session_closed 并断开。 */
  if (req.method === 'POST' && url.pathname === '/api/session-close') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = await getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });
    const sid = String(body.sid || '') || staff.sessionId;

    const out = await store.mutate(sid, (s) => {
      if (s.status !== 'open') {
        return { abort: { status: 409, body: { ok: false, code: 'session_already_closed' } } };
      }
      s.status = 'closed';
      s.closedAt = Date.now();
      return { result: {} };
    }, { type: 'closed' });

    if (out.notFound) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (out.aborted) return json(res, out.aborted.status, out.aborted.body);
    if (out.conflict) return json(res, 409, { ok: false, code: 'write_conflict' });
    if (out.failed) return json(res, 500, { ok: false, code: 'write_failed' });

    const session = out.session;
    // 场次关闭：内存草稿与提交回执一并清掉（草稿本来就不落库，没有历史需要保留）
    clearDrafts(session.id);
    forgetReceipts(session.id);
    // 关闭前把已锁定的本轮顺带归档（幂等；已归档则只做一次 SELECT）
    if (session.number != null) {
      const w = await db.archiveSnapshot(session);
      if (!w.ok) console.error('[archive] 关闭场次时归档失败 sid=' + session.id + ': ' + w.error);
    }

    // 归属该场次的员工改绑到下一个进行中的场次（可能为空）。库里统一改，跨实例一致。
    const list = await store.list();
    const nextSid = defaultSessionIdOf(list);
    await db.rebindStaffSessions(session.id, nextSid);
    await audit(req, staff, 'session_close', {
      sid: session.id, target: session.name,
      detail: { round: session.round, locked: session.number != null, nextSid }
    });

    return json(res, 200, {
      ok: true,
      sid: session.id,
      nextSid,
      sessions: staffSessionList(await store.list())
    });
  }

  /* 状态查询：某场次的全量状态快照。SSE 客户端在重连/回到前台时调用，用于对齐断线期间错过的变更。
   * 必须通过场次准入判定：玩家带绑定令牌（以令牌场次为准），员工带 staff token。
   * view=bigscreen 是大屏专用视图（开奖前也含每个人的选项）：默认公开（BIGSCREEN_PUBLIC），
   * 仅当 BIGSCREEN_PUBLIC=0 时才要求员工 token。
   * fresh=true：首帧必须来自数据库，不能是本地读缓存里别的实例提交前的版本。 */
  if (req.method === 'GET' && url.pathname === '/api/state') {
    const sidRaw = url.searchParams.get('sid') || '';
    const staffToken = url.searchParams.get('token') || '';
    const view = url.searchParams.get('view') === 'bigscreen' ? 'bigscreen' : '';
    const ctx = view === 'bigscreen'
      ? await bigscreenContext(sidRaw, staffToken, { fresh: true })
      : await playerSessionContext(sidRaw, url.searchParams.get('ut') || '', staffToken, { fresh: true });
    if (rejectPlayerSession(res, ctx)) return;
    if (view === 'bigscreen' && !BIGSCREEN_PUBLIC && !ctx.staff) {
      return json(res, 403, { ok: false, code: 'bigscreen_unauthorized' });
    }
    return json(res, 200, buildStatePayload(ctx.session, pid, view));
  }

  /* 席位占用查询：玩家端选座界面用（也用于刷新「刚被别人抢走」的乐观更新）。
   * 只返回席位号 + 是否占用；带 deviceId 时额外返回 mySeat（本机占的是几号）。 */
  if (req.method === 'GET' && url.pathname === '/api/seats') {
    const ctx = await playerSessionContext(
      url.searchParams.get('sid') || '',
      url.searchParams.get('ut') || ''
    );
    if (rejectPlayerSession(res, ctx)) return;
    const deviceId = normalizeDeviceId(url.searchParams.get('deviceId'));
    const mine = seatOfDevice(ctx.session, deviceId);
    return json(res, 200, {
      ok: true,
      sid: ctx.session.id,
      seatCount: ctx.session.seatCount,
      occupied: occupiedSeatCount(ctx.session),
      seats: seatList(ctx.session),
      mySeat: mine ? mine.no : null
    });
  }

  /* 加入场次：设备选一个席位并绑定。
   *   - 第一次加入必须带 seatNo（产品要求「必须选择具体席位」，不自动分配）
   *   - 同一设备重复加入（刷新 / 换轮次 / 令牌过期重签）只认已绑定的席位，
   *     即使传了别的 seatNo 也不会换座 —— 「沿用已绑定的 seat」是服务端的硬约束
   *   - 已占用席位返回 409 seat_taken；越界返回 409 seat_out_of_range
   *   - 占用判断在 store.mutate 内完成：两个设备同时抢同一席位只有一个能成功 */
  if (req.method === 'POST' && url.pathname === '/api/join') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });

    const deviceId = normalizeDeviceId(body.deviceId);
    if (!deviceId) return json(res, 400, { ok: false, code: 'device_invalid' });

    const ctx = await playerSessionContext(String(body.sid || ''), String(body.ut || ''));
    if (rejectPlayerSession(res, ctx)) return;

    const hasAsked = body.seatNo !== undefined && body.seatNo !== null && body.seatNo !== '';
    const asked = hasAsked ? parseSeatNo(body.seatNo) : null;

    const out = await store.mutate(ctx.session.id, (s) => {
      if (s.status !== 'open') {
        return { abort: { status: 409, body: { ok: false, code: 'session_closed' } } };
      }
      const bound = seatOfDevice(s, deviceId);
      if (bound) {
        // 已绑定设备：无论传了什么号都沿用原席位（换轮次 / 刷新 / 令牌过期的统一入口）
        return { result: { seatNo: bound.no, reused: true } };
      }
      if (!hasAsked) {
        return {
          abort: {
            status: 400,
            body: {
              ok: false, code: 'seat_required',
              seatCount: s.seatCount, occupied: occupiedSeatCount(s), seats: seatList(s)
            }
          }
        };
      }
      if (asked === null) {
        return {
          abort: {
            status: 400,
            body: { ok: false, code: 'seat_invalid', min: MIN_SEAT_COUNT, max: MAX_SEAT_COUNT }
          }
        };
      }
      if (asked > s.seatCount) {
        return {
          abort: {
            status: 409,
            body: {
              ok: false, code: 'seat_out_of_range',
              seatCount: s.seatCount, occupied: occupiedSeatCount(s), seats: seatList(s)
            }
          }
        };
      }
      const seat = s.seats[asked];
      if (!seat) {
        // 理论不可达：seatCount 内的席位一定被铺满；防御性拒绝，不静默建行
        return { abort: { status: 409, body: { ok: false, code: 'seat_out_of_range', seatCount: s.seatCount } } };
      }
      if (seat.deviceId) {
        return {
          abort: {
            status: 409,
            body: {
              ok: false, code: 'seat_taken', seatNo: asked,
              seatCount: s.seatCount, occupied: occupiedSeatCount(s), seats: seatList(s)
            }
          }
        };
      }
      seat.deviceId = deviceId;
      seat.boundAt = Date.now();
      return { result: { seatNo: asked, reused: false } };
    });

    if (out.notFound) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (out.aborted) return json(res, out.aborted.status, out.aborted.body);
    if (out.conflict) return json(res, 409, { ok: false, code: 'write_conflict' });
    if (out.failed) return json(res, 500, { ok: false, code: 'write_failed' });

    const session = out.session;
    return json(res, 200, {
      ok: true,
      sid: session.id,
      seatNo: out.result.seatNo,
      reused: out.result.reused,
      seatCount: session.seatCount,
      occupied: occupiedSeatCount(session),
      seats: seatList(session),
      session: { id: session.id, name: session.name, round: session.round, locked: session.number != null }
    });
  }

  /* 二维码识别：内容即会员号，但**不再直接当 ID 用**。
   * 落库与内存一律用 ref = HMAC(pepper, 会员号)（盲索引，不可逆、确定性），
   * 明文只以密文形式存 member_enc，接口和页面只出现 ref 与脱敏标签 ****1234。
   * 身份按场次隔离：同一会员号在 A 场与 B 场是两个独立玩家（ref 相同、主键含 session_id）。
   * 登记走 store.mutate：两台实例同时扫同一个码，只会建出一个玩家（版本 CAS 保证）。 */
  if (req.method === 'POST' && url.pathname === '/api/scan') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });

    const content = String(body.content || '').trim();
    if (!content) return json(res, 400, { ok: false, code: 'scan_empty' });
    if (content.length > QR_MAX_LEN) return json(res, 400, { ok: false, code: 'scan_too_long', maxLen: QR_MAX_LEN });

    const ctx = await playerSessionContext(String(body.sid || ''), String(body.ut || ''));
    if (rejectPlayerSession(res, ctx)) return;

    // 扫码必须发生在「已选席位」的设备上：席位是现场的物理座位，会员登记挂到席位上。
    // 没选席位的设备先去 /api/join（玩家端会自动弹出选座卡片）。
    const deviceId = normalizeDeviceId(body.deviceId);
    if (!deviceId) return json(res, 400, { ok: false, code: 'device_invalid' });

    // 加密就在这一层做：ref 给主键与接口，enc 给落库，maskedId 给页面
    const id = memberId.ref(content);
    const enc = memberId.seal(content);
    const maskedId = memberId.mask(content);

    const out = await store.mutate(ctx.session.id, (s) => {
      if (s.status !== 'open') {
        return { abort: { status: 409, body: { ok: false, code: 'session_closed' } } };
      }
      const seat = seatOfDevice(s, deviceId);
      if (!seat) {
        return {
          abort: {
            status: 403,
            body: {
              ok: false, code: 'seat_required',
              seatCount: s.seatCount, occupied: occupiedSeatCount(s), seats: seatList(s)
            }
          }
        };
      }
      // 情况一：本场次本轮已扫过该码 → 幂等恢复同一玩家（同一席位、任意次数）
      const existing = s.players[id];
      // 一个会员一轮只能占一个席位：在别的机器上重扫不会「换座」，
      // 否则原席位会留下一个无主的 player 行，人数与席位对不上。
      if (existing && existing.seatNo != null && existing.seatNo !== seat.no) {
        return {
          abort: {
            status: 409,
            body: { ok: false, code: 'member_other_seat', seatNo: existing.seatNo }
          }
        };
      }
      // 一个席位一轮只坐一个会员：座位上已有人在玩时，换人必须先让原玩家登出（leftAt）。
      // 这条对「本人回来」同样生效：离开后席位被同座的新玩家接走，原玩家不能再挤回来。
      const occupantId = seat.memberId && seat.memberId !== id ? seat.memberId : '';
      const occupant = occupantId ? s.players[occupantId] : null;
      if (occupant && occupant.leftAt == null) {
        return {
          abort: {
            status: 409,
            body: { ok: false, code: 'seat_member_conflict', seatNo: seat.no }
          }
        };
      }
      if (existing) {
        // 密文不参与身份判定：ref 才是身份。这里只在「本进程刚生成的密文与库里不同」时更新，
        // 效果是轮换后重扫一次就把这一行带到当前密钥版本（不强制，纯属顺手升级）。
        existing.enc = enc;
        existing.seatNo = seat.no;
        seat.memberId = id;
        seat.memberEnc = enc;
        const idt = s.identities[id];
        if (idt) {
          idt.lastSeenRound = s.round;
          idt.enc = enc;
        } else {
          s.identities[id] = { lastSeenRound: s.round, completedRounds: 0, enc };
        }
        // 重新扫码 = 回到现场，两端名单与统计立刻恢复。
        // 但本轮已锁定后不再放回：锁定即名单冻结，否则「离开前不算、回来后又有」
        // 会让结果表与已落库的归档对不上。
        if (s.number == null) existing.leftAt = null;
        return { result: { pid: id, status: 'known', seatNo: seat.no } };
      }

      // 情况二：本场次本轮新码。已开奖 → 拒绝入场
      if (s.number != null) {
        return { abort: { status: 400, body: { ok: false, code: 'scan_locked' } } };
      }

      // 情况三：本场次本轮新码 → 建档（席位号随玩家一起落库，便于大屏/员工端按座位展示）
      s.players[id] = {
        id, enc, maskedId, seatNo: seat.no, oddEven: null, number: null,
        registeredAt: Date.now(), submittedAt: null
      };
      seat.memberId = id;
      seat.memberEnc = enc;
      if (!seat.boundAt) seat.boundAt = Date.now();
      const prev = s.identities[id];
      s.identities[id] = {
        lastSeenRound: s.round,
        completedRounds: (prev && prev.completedRounds) || 0,
        enc
      };
      return { result: { pid: id, status: 'known', seatNo: seat.no } };
    });

    if (out.notFound) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (out.aborted) return json(res, out.aborted.status, out.aborted.body);
    if (out.conflict) return json(res, 409, { ok: false, code: 'write_conflict' });
    if (out.failed) return json(res, 500, { ok: false, code: 'write_failed' });
    return json(res, 200, {
      ok: true, pid: out.result.pid, maskedId, sid: out.session.id,
      status: out.result.status, seatNo: out.result.seatNo
    });
  }

  /* 玩家离开现场 / 主动登出：打标记、不删数据。
   *  - 由玩家端在 pagehide（sendBeacon）与「登出」按钮（fetch keepalive）上报，
   *    因此必须是幂等且极轻的写
   *  - 不删玩家行：只是从「在场名单」里移出 —— 所有列表、看板、人数与统计都不再包含他，
   *    重新扫码或 SSE 重连再放回（本轮未锁定为前提）
   *  - 重复上报（正在离开 / 已离开）不再递增版本号，避免无意义的全量广播
   *  - 本轮已锁定：忽略。锁定即名单冻结，结果表与归档已经按锁定那一刻的人算完，
   *    之后的离开/登出不能反过来改写它们（否则两端会看到两套人数） */
  if (req.method === 'POST' && url.pathname === '/api/leave') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const ctx = await playerSessionContext(String(body.sid || ''), String(body.ut || ''));
    if (rejectPlayerSession(res, ctx)) return;

    const pidLeave = String(body.pid || '');
    const out = await store.mutate(ctx.session.id, (s) => {
      if (s.number != null) return { skip: true, result: { ignored: true, locked: true } };
      const p = s.players[pidLeave];
      // 幂等：未登记 / 已离开都不写库，也不递增版本号
      if (!p || p.leftAt != null) return { skip: true, result: { ignored: true } };
      p.leftAt = Date.now();
      return { result: { ignored: false } };
    });

    if (out.notFound) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (out.conflict) return json(res, 409, { ok: false, code: 'write_conflict' });
    if (out.failed) return json(res, 500, { ok: false, code: 'write_failed' });
    if (out.result.ignored) {
      return json(res, 200, { ok: true, ignored: true, locked: !!out.result.locked });
    }
    return json(res, 200, { ok: true, ignored: false });
  }

  if (req.method === 'POST' && url.pathname === '/api/predict') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const ctx = await playerSessionContext(String(body.sid || ''), String(body.ut || ''));
    if (rejectPlayerSession(res, ctx)) return;

    const pidPredict = String(body.pid || '');
    const oddEven = body.oddEven;
    const number = parseNumber0to9(body.number);
    if (oddEven !== '单' && oddEven !== '双') return json(res, 400, { ok: false, code: 'predict_invalid_oe' });
    if (number === null) return json(res, 400, { ok: false, code: 'predict_invalid' });

    // 校验必须在 mutator 里做：只有读到「最新版本」才能判断是否真的重复提交。
    // 两台实例同时为一个玩家提交预测时，CAS 只允许一条提交成功，另一条重试后看到
    // oddEven 已非空 → predict_duplicate，不可能出现后写覆盖先写。
    const out = await store.mutate(ctx.session.id, (s) => {
      const p = s.players[pidPredict];
      if (!p) return { abort: { status: 400, body: { ok: false, code: 'predict_not_scanned' } } };
      if (s.number != null) return { abort: { status: 400, body: { ok: false, code: 'predict_closed' } } };
      if (p.oddEven != null) return { abort: { status: 400, body: { ok: false, code: 'predict_duplicate' } } };
      // 同上：成功的写入视为「回到现场」，避免离开标记把人挡在名单外
      p.leftAt = null;
      p.oddEven = oddEven;
      p.number = number;
      p.submittedAt = Date.now();
      return { result: {} };
    });

    if (out.notFound) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (out.aborted) return json(res, out.aborted.status, out.aborted.body);
    if (out.conflict) return json(res, 409, { ok: false, code: 'write_conflict' });
    if (out.failed) return json(res, 500, { ok: false, code: 'write_failed' });
    return json(res, 200, { ok: true });
  }

  /* 临时选择（草稿）上报：玩家每改一次选项调一次，只写内存、不写库、不推进 version。
   *
   * 幂等与乱序：客户端带单调 seq（localStorage 持久化），服务端只接受 seq 更大的写入。
   * 同一 seq 重发、或旧 seq 迟到，一律 200 + accepted:false + 当前值 —— 这不是错误，
   * 客户端应该用返回值覆盖本地，而不是弹错。用 HTTP 状态码区分「业务拒绝」和
   * 「本来就该忽略」会让前端很难写。
   *
   * 已提交之后再改草稿没有意义：直接 409，前端应转只读。 */
  if (req.method === 'PUT' && url.pathname === '/api/pick') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const ctx = await playerSessionContext(String(body.sid || ''), String(body.ut || ''));
    if (rejectPlayerSession(res, ctx)) return;
    const session = ctx.session;

    const pidPick = String(body.pid || '');
    if (!session.players[pidPick]) return json(res, 400, { ok: false, code: 'pick_not_scanned' });

    const oe = body.oddEven;
    const num = parseNumber0to9(body.number);
    const seq = Number(body.seq);
    if (oe !== '单' && oe !== '双') return json(res, 400, { ok: false, code: 'pick_invalid_oe' });
    if (num === null) return json(res, 400, { ok: false, code: 'pick_invalid' });
    if (!Number.isInteger(seq) || seq <= 0) return json(res, 400, { ok: false, code: 'seq_invalid' });

    if (session.number != null) {
      return json(res, 409, { ok: false, code: 'round_locked', number: session.number });
    }
    const self = session.players[pidPick];
    if (self.oddEven != null) {
      return json(res, 409, {
        ok: false, code: 'already_submitted',
        submit: { oddEven: self.oddEven, number: self.number, submittedAt: self.submittedAt }
      });
    }

    const cur = draftOf(session.id, pidPick);
    if (seq <= draftSeqOf(session.id, pidPick)) {
      return json(res, 200, {
        ok: true, accepted: false, ignored: 'stale_seq',
        seq: draftSeqOf(session.id, pidPick),
        draft: cur ? { oe: cur.oe, num: cur.num, seq: cur.seq } : null,
        version: session.version, serverTime: Date.now()
      });
    }

    const d = { oe, num, seq, at: Date.now() };
    putDraft(session.id, pidPick, d);
    publishDrafts(session.id, [{ pid: pidPick, draft: d, seq }]);
    return json(res, 200, {
      ok: true, accepted: true, seq,
      draft: { oe, num, seq }, version: session.version, serverTime: Date.now()
    });
  }

  /* 撤销临时选择（玩家清空选择）。同样按 seq 判定，避免「删」与「改」乱序打架。 */
  if (req.method === 'DELETE' && url.pathname === '/api/pick') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const ctx = await playerSessionContext(String(body.sid || ''), String(body.ut || ''));
    if (rejectPlayerSession(res, ctx)) return;
    const session = ctx.session;

    const pidDrop = String(body.pid || '');
    if (!session.players[pidDrop]) return json(res, 400, { ok: false, code: 'pick_not_scanned' });
    const seq = Number(body.seq);
    if (!Number.isInteger(seq) || seq <= 0) return json(res, 400, { ok: false, code: 'seq_invalid' });

    if (session.number != null) {
      return json(res, 409, { ok: false, code: 'round_locked', number: session.number });
    }
    const selfDrop = session.players[pidDrop];
    if (selfDrop.oddEven != null) {
      return json(res, 409, { ok: false, code: 'already_submitted' });
    }

    if (seq <= draftSeqOf(session.id, pidDrop)) {
      return json(res, 200, {
        ok: true, accepted: false, ignored: 'stale_seq',
        seq: draftSeqOf(session.id, pidDrop), version: session.version
      });
    }
    // 水位照样推进：没草稿可删也要吃掉这个 seq，避免随后一个小 seq 的 PUT 复活旧选择
    bumpDraftSeq(session.id, pidDrop, seq);
    const curDrop = draftOf(session.id, pidDrop);
    if (!curDrop) return json(res, 200, { ok: true, accepted: false, ignored: 'no_draft', seq, version: session.version });

    dropDraft(session.id, pidDrop);
    publishDrafts(session.id, [{ pid: pidDrop, draft: null, seq }]);
    return json(res, 200, { ok: true, accepted: true, seq, draft: null, version: session.version });
  }

  /* 最终确认提交：这一下才算参赛。
   *
   * 与 /api/predict（老接口，保留兼容）的区别：
   *   - 必须带 Idempotency-Key：双击、超时重试、多端同时点，都只会落一次库；
   *     同 key 重放返回 200 + replay:true，异 key 且已提交返回 409 + 终态快照
   *     （前端据此展示「已提交」，而不是报错）。
   *   - 提交成功即清掉内存草稿：草稿的使命结束，大屏状态从「待确认」变「已确认」。
   * 校验全部在 mutator 内做：只有读到最新快照才能判断是不是真的重复提交。 */
  if (req.method === 'POST' && url.pathname === '/api/submit') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const idemKey = String(
      req.headers['idempotency-key'] || req.headers['x-idempotency-key']
      || body.idempotencyKey || body.idemKey || ''
    ).trim();
    if (!/^[A-Za-z0-9_-]{8,64}$/.test(idemKey)) {
      return json(res, 422, { ok: false, code: 'idempotency_key_required' });
    }

    const ctx = await playerSessionContext(String(body.sid || ''), String(body.ut || ''));
    if (rejectPlayerSession(res, ctx)) return;
    const session = ctx.session;

    const pidSub = String(body.pid || '');
    const oe = body.oddEven;
    const num = parseNumber0to9(body.number);
    if (oe !== '单' && oe !== '双') return json(res, 400, { ok: false, code: 'pick_invalid_oe' });
    if (num === null) return json(res, 400, { ok: false, code: 'pick_invalid' });

    // 重放：同 key 已经成功过，直接回原结果（客户端可能没收到上一次响应）
    const receiptKey = session.id + '|' + session.round + '|' + pidSub;
    const receipt = submitReceipts.get(receiptKey);
    if (receipt && receipt.idemKey === idemKey) {
      const mine = session.players[pidSub];
      return json(res, 200, {
        ok: true, replay: true, version: session.version, counts: countChoices(session),
        submit: mine && mine.oddEven != null
          ? { oddEven: mine.oddEven, number: mine.number, submittedAt: mine.submittedAt }
          : { oddEven: receipt.oddEven, number: receipt.number, submittedAt: receipt.at }
      });
    }

    const out = await store.mutate(session.id, (s) => {
      const p = s.players[pidSub];
      if (!p) return { abort: { status: 400, body: { ok: false, code: 'pick_not_scanned' } } };
      if (s.number != null) {
        return { abort: { status: 409, body: { ok: false, code: 'round_locked', number: s.number } } };
      }
      if (p.oddEven != null) {
        return {
          abort: {
            status: 409,
            body: {
              ok: false, code: 'already_submitted',
              submit: { oddEven: p.oddEven, number: p.number, submittedAt: p.submittedAt }
            }
          }
        };
      }
      // 能提交就说明人在现场：顺手撤销可能残留的离开标记（pagehide 与提交竞态、
      // 网络抖动导致的误上报），否则会出现「已提交但两端都看不到、锁定也不归档」。
      p.leftAt = null;
      p.oddEven = oe;
      p.number = num;
      p.submittedAt = Date.now();
      return { result: { oddEven: oe, number: num, submittedAt: p.submittedAt } };
    });

    if (out.notFound) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (out.aborted) return json(res, out.aborted.status, out.aborted.body);
    if (out.conflict) return json(res, 409, { ok: false, code: 'write_conflict' });
    if (out.failed) return json(res, 500, { ok: false, code: 'write_failed' });

    dropDraft(session.id, pidSub);
    submitReceipts.set(receiptKey, {
      idemKey, oddEven: oe, number: num, at: out.result.submittedAt
    });
    return json(res, 200, {
      ok: true, replay: false, version: out.session ? out.session.version : session.version,
      counts: out.session ? countChoices(out.session) : countChoices(session),
      submit: out.result
    });
  }


  /* 锁定本轮开奖数字（员工端）。
   * 同时锁定的两台实例只会有一个成功：CAS 保证 only-one-wins，
   * 另一个重试后看到 number 已有值 → already_locked。
   *
   * ackPending：本轮存在「选了但没确认提交」的草稿时，必须由员工显式确认要开奖
   * （409 pending_confirm_required + 名单），避免把一群以为自己在玩的人直接作废。
   * 门槛只卡草稿，不卡「压根没选」的人 —— 后者本来就没参赛意图，卡了反而挡住正常开奖。 */
  if (req.method === 'POST' && url.pathname === '/api/confirm') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = await getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });

    const number = parseNumber0to9(body.number);
    if (number === null) {
      return json(res, 400, { ok: false, code: 'invalid_number' });
    }

    const sidConfirm = String(body.sid || '') || staff.sessionId;
    if (!body.ackPending) {
      const now = await store.load(sidConfirm, { fresh: true });
      if (!now) return json(res, 404, { ok: false, code: 'session_not_found' });
      if (now.number == null) {
        const pend = pendingDraftsOf(now);
        if (pend.length > 0) {
          return json(res, 409, {
            ok: false, code: 'pending_confirm_required',
            counts: countChoices(now), pending: pend
          });
        }
      }
    }

    const out = await store.mutate(sidConfirm, (s) => {
      if (s.status !== 'open') {
        return { abort: { status: 409, body: { ok: false, code: 'session_closed' } } };
      }
      if (s.number != null) {
        return { abort: { status: 400, body: { ok: false, code: 'already_locked', number: s.number } } };
      }
      // 唯一写入点：数字来自工作人员在网页外的抽取，仅在此录入并锁定
      s.number = number;
      s.lockedAt = Date.now();
      s.lockedBy = staff.username;   // 对账要能追到「这一轮是谁锁的」
      // 开奖即视为本轮完整竞猜结束：凡提交过预测且仍在场的玩家，本场次完整竞猜轮次 +1
      // 只认玩家表里的 odd_even（= 已确认提交），内存草稿不参与任何计数；
      // 已离开的不算参与本轮，也就不累计老玩家轮次
      presentPlayers(s).forEach((p) => {
        if (p.oddEven != null) {
          const idt = s.identities[p.id]
            || (s.identities[p.id] = { lastSeenRound: s.round, completedRounds: 0, enc: p.enc });
          idt.completedRounds = (idt.completedRounds || 0) + 1;
          idt.lastSeenRound = s.round;
        }
      });
      return { result: { number } };
    });

    if (out.notFound) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (out.aborted) return json(res, out.aborted.status, out.aborted.body);
    if (out.conflict) return json(res, 409, { ok: false, code: 'write_conflict' });
    if (out.failed) {
      console.error('[archive] 锁定写入失败 sid=' + sidConfirm + ': ' + out.failed);
      return json(res, 500, { ok: false, code: 'write_failed' });
    }

    // 本轮结束：内存草稿全部作废（未确认 = 未参赛），随后的广播里 status 变 draft→none
    const voided = Array.from((draftStore.get(sidConfirm) || new Map()).keys());
    clearDrafts(sidConfirm);

    // 归档在提交事务里用 SAVEPOINT 隔离（见 db.commitSnapshot）：
    // 归档失败时锁定已生效，如实告知「已锁定但未归档」，可稍后由 /api/archive-sync 补齐。
    // 本轮是否命中特殊数字，按**该场次锁定的规则版本**判定（与玩家端展示同一口径）。
    const lockedRule = ruleOf(out.session);
    const bonusTriggered = ruleBonusHit(lockedRule, number);
    await audit(req, staff, 'round_lock', {
      sid: sidConfirm, target: String(number),
      detail: {
        number, round: out.session ? out.session.round : null, archived: !!out.archived,
        ruleVersion: lockedRule.version, bonusTriggered,
        voidedDrafts: voided.length
      }
    });
    if (!out.archived) {
      console.error('[archive] 归档写入失败 sid=' + sidConfirm + ': ' + (out.archiveError || 'unknown'));
      return json(res, 200, {
        ok: true, number, sid: sidConfirm, archived: false, warning: 'archive_write_failed',
        bonusTriggered,
        counts: out.session ? countChoices(out.session) : undefined
      });
    }
    return json(res, 200, {
      ok: true, number, sid: sidConfirm, archived: true,
      bonusTriggered,
      counts: out.session ? countChoices(out.session) : undefined
    });
  }

  /* 开始新一轮（员工端）。
   * 先确保已锁定的一轮已经归档（归档失败就不许清空，归档表是唯一留痕），
   * 再在 mutator 里核对「轮次号 + 是否已锁定」——两台实例同时点「新一轮」只有一个生效，
   * 另一个会看到轮次号已变而拒绝，不会把 round 连加两次、也不会清掉新一轮的玩家。 */
  if (req.method === 'POST' && url.pathname === '/api/reset') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = await getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });

    const sidReset = String(body.sid || '') || staff.sessionId;
    const current = await store.load(sidReset, { fresh: true });
    if (!current) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (current.status !== 'open') return json(res, 409, { ok: false, code: 'session_closed' });

    // 清空前先把已锁定的这一轮归档落定：归档失败就不许开新一轮
    if (current.number != null) {
      const flushed = await db.archiveSnapshot(current);
      if (!flushed.ok) {
        console.error('[archive] 新一轮前归档失败 sid=' + sidReset + ' round=' + current.round + ': ' + flushed.error);
        return json(res, 409, { ok: false, code: 'archive_write_failed' });
      }
    }
    const expectRound = current.round;
    const expectLockedAt = current.lockedAt;

    // 新开一轮要重新绑定「当前最新规则」：管理员在上一轮进行中改了奖品/特殊数字，
    // 这一轮就该按最新版发奖，而不是沿用开场时锁定的旧版。
    // 已在进行的轮次不受影响——它归档时记的是它自己那轮的版本（round_archive.rule_version）。
    // 直查库（loadLatestRule），不缓存：另一台实例刚存的版本必须立刻拿得到。
    const latest = await loadLatestRule();

    const out = await store.mutate(sidReset, (s) => {
      if (s.status !== 'open') {
        return { abort: { status: 409, body: { ok: false, code: 'session_closed' } } };
      }
      // 期间别的实例已经开过新一轮 → 拒绝，避免「双开」把轮次连加
      if (s.round !== expectRound || s.lockedAt !== expectLockedAt) {
        return { abort: { status: 409, body: { ok: false, code: 'round_changed', round: s.round } } };
      }
      s.round += 1;
      s.number = null;
      s.lockedAt = null;
      s.lockedBy = '';
      s.players = {};
      // 席位：设备绑定保留（换轮次不用重新选座），只清「这一轮坐在这里的会员」。
      // 会员登记仍然是每轮一次（players 清空 → 玩家端回到扫码卡片），
      // 但扫码时沿用同一席位，不会让玩家再选一次座。
      for (const seat of Object.values(s.seats || {})) {
        seat.memberId = '';
        seat.memberEnc = null;
      }
      // 重绑规则：本轮（round 已 +1）改用最新版。rule 字段与快照 SQL JOIN 出来的形态一致
      // （原始 prizes/bonus，ruleOf 会再做归一化），ruleVersion 写回 round.rule_version（当前轮权威来源）。
      s.ruleVersion = latest.version;
      s.rule = { version: latest.version, prizes: latest.prizes, bonus: latest.bonus };
      return { result: { round: s.round, ruleVersion: latest.version } };
    });

    if (out.notFound) return json(res, 404, { ok: false, code: 'session_not_found' });
    if (out.aborted) return json(res, out.aborted.status, out.aborted.body);
    if (out.conflict) return json(res, 409, { ok: false, code: 'write_conflict' });
    if (out.failed) return json(res, 500, { ok: false, code: 'write_failed' });
    await audit(req, staff, 'round_reset', {
      sid: sidReset, target: String(current.round),
      detail: { fromRound: current.round, toRound: out.result.round, lockedBefore: current.number != null }
    });
    // 新一轮：上一轮的草稿与提交回执全部作废（草稿不进下一轮，避免串轮误显示）
    clearDrafts(sidReset);
    forgetReceipts(sidReset);
    return json(res, 200, { ok: true, round: out.result.round, sid: out.session.id });
  }

  /* 当日聚合（归档口径）：场次数、轮次数、按会员号去重的参与人数，附分场次明细。
   * 口径固定为 locked_at（锁定时间）落在区间内，与当前进行中的场次无关；
   * 归档表 append-only，所以 reset 之后再查同一天，数字只增不减。 */
  if (req.method === 'GET' && url.pathname === '/api/archive/summary') {
    const admin = await requireAdmin(url.searchParams.get('token') || '');
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });
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

  /* 对账导出（CSV，列头顺序固定，见 CSV_*_HEADER）。只导出「谁猜了什么、实际开了什么、匹配与否」，
   * 不计算积分、不做跨场汇总——同一会员号在不同场次的记录就是一列行，逐行核对。
   *   ?level=detail（默认）一人一轮一行，跨场次全量 —— 逐人核对猜测与实际结果
   *   ?level=round   一轮一行（含 0 人轮次）—— 核对当天开了几轮
   * 可选 ?sid= 只导某一场，?date= / ?from=&to= 指定区间（默认今天）。 */
  if (req.method === 'GET' && url.pathname === '/api/archive/export.csv') {
    const admin = await requireAdmin(url.searchParams.get('token') || '');
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });
    const range = archiveRange(url);
    if (!range) return json(res, 400, { ok: false, code: 'bad_date_range' });

    const level = String(url.searchParams.get('level') || 'detail').toLowerCase();
    if (!['detail', 'round'].includes(level)) {
      return json(res, 400, { ok: false, code: 'bad_level', levels: ['detail', 'round'] });
    }
    const sidFilter = String(url.searchParams.get('sid') || '');

    let header;
    let rows;
    if (level === 'round') {
      header = CSV_ROUND_HEADER;
      const data = await db.archiveRoundRows(range.from, range.to, sidFilter);
      rows = data.map((r) => [
        r.session_id, r.session_name, Number(r.session_seq), Number(r.round),
        Number(r.number), r.odd_even,
        fmtArchiveTime(r.locked_at), fmtArchiveTime(r.archived_at),
        Number(r.player_count), Number(r.submitted_count),
        r.locked_by || '',
        r.rule_version == null ? '' : Number(r.rule_version)
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
        fmtArchiveTime(r.submitted_at),
        r.locked_by || '',
        r.rule_version == null ? '' : Number(r.rule_version)
      ]);
    }

    // 导出是一次「把营业额数据带走」的动作，必须留痕：谁、什么时候、导了什么口径、多少行
    await audit(req, admin, 'export_archive', {
      sid: sidFilter,
      target: level,
      detail: { level, date: range.label, from: range.from, to: range.to, rows: rows.length }
    });

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

  /* ---------------- 员工账号管理（仅管理员） ----------------
   * 一个账号一份独立密码：管理员在这里建号 / 改显示名 / 调角色 / 停用 / 重置密码。
   * 密码只以 scrypt 派生值落库，任何接口都不会返回它。
   * 两条硬规则：不能停用自己、不能把最后一个可用管理员降级或停用（否则谁都进不去）。 */

  /* ---------------- 规则配置（仅管理员） ----------------
   * 奖品四档 + 特殊数字是一整套规则，按版本保存：保存只产生「新的一版」，
   * **对正在进行的场次没有任何影响**，只有之后新建的场次才锁定它。
   * 两个接口分开只是为了让管理界面按区块编辑，落库永远是一整套快照：
   * 改四档时特殊数字沿用当前最新版（反之亦然），不会把另一块清空。 */

  if (req.method === 'GET' && url.pathname === '/api/prize-config') {
    const admin = await requireAdmin(url.searchParams.get('token') || '');
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });
    // 管理端看的是「最新一版」= 之后新建场次会用到的规则，每次直查库（多实例下不会读到旧的那版）
    const latest = await loadLatestRule();
    return json(res, 200, {
      ok: true,
      prizes: latest.prizes,
      ruleVersion: latest.version,
      limits: { title: PRIZE_TITLE_MAX, desc: PRIZE_DESC_MAX }
    });
  }

  /* 保存四档奖品文案 → 新规则版本。跨实例靠 PUB/SUB 的 rule 通知让各实例重拉版本表。 */
  if (req.method === 'POST' && url.pathname === '/api/prize-config') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const admin = await requireAdmin(body.token);
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });

    // 先归一化再校验三语完整性：不完整的配置**不入库**（否则玩家端会拿到缺语言的文案）
    const normalized = normalizePrizeConfig(body.prizes);
    const problems = validatePrizeConfig(normalized);
    if (problems.length) {
      return json(res, 400, { ok: false, code: 'prize_incomplete', missing: problems });
    }

    let saved;
    try {
      saved = await saveRule({ prizes: normalized }, { source: 'prize', actor: admin.username });
    } catch (e) {
      console.error('[rule] 保存奖品配置失败:', e.message);
      return json(res, 500, { ok: false, code: 'prize_save_failed' });
    }
    await audit(req, admin, 'prize_config', {
      detail: {
        ruleVersion: saved.rule.version,
        created: saved.created,
        tiers: PRIZE_TIERS.map((tier) => ({
          tier,
          title: saved.rule.prizes[tier].title,
          desc: saved.rule.prizes[tier].desc
        }))
      }
    });
    // 不广播、不发通知：进行中的场次读的是它自己锁定的版本，本来就不该变；
    // 其他实例下一次读库自然拿到新版本。
    return json(res, 200, {
      ok: true, prizes: saved.rule.prizes, ruleVersion: saved.rule.version, created: saved.created
    });
  }

  /* 额外奖品（命中特殊数字 → 全员加奖）配置读取：仅 admin。 */
  if (req.method === 'GET' && url.pathname === '/api/bonus-prize') {
    const admin = await requireAdmin(url.searchParams.get('token') || '');
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });
    const latest = await loadLatestRule();
    return json(res, 200, {
      ok: true,
      bonus: latest.bonus,
      ruleVersion: latest.version,
      limits: { title: PRIZE_TITLE_MAX, desc: PRIZE_DESC_MAX },
      range: { min: NUMBER_MIN, max: NUMBER_MAX }
    });
  }

  /* 保存特殊数字 + 全员加奖文案 → 新规则版本（同样只对之后新建的场次生效）。 */
  if (req.method === 'POST' && url.pathname === '/api/bonus-prize') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const admin = await requireAdmin(body.token);
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });

    const normalized = normalizeBonusConfig(body.bonus);
    const problems = validateBonusConfig(normalized);
    if (problems.length) {
      return json(res, 400, { ok: false, code: 'bonus_incomplete', missing: problems });
    }

    let saved;
    try {
      saved = await saveRule({ bonus: normalized }, { source: 'bonus', actor: admin.username });
    } catch (e) {
      console.error('[rule] 保存额外奖品失败:', e.message);
      return json(res, 500, { ok: false, code: 'bonus_save_failed' });
    }
    await audit(req, admin, 'bonus_config', {
      detail: {
        ruleVersion: saved.rule.version,
        created: saved.created,
        number: saved.rule.bonus.number,
        title: saved.rule.bonus.title,
        desc: saved.rule.bonus.desc
      }
    });
    // 同上：不广播、不发通知，规则改动只影响之后新建的场次
    return json(res, 200, {
      ok: true, bonus: saved.rule.bonus, ruleVersion: saved.rule.version, created: saved.created
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/accounts') {
    const admin = await requireAdmin(url.searchParams.get('token') || '');
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });
    return json(res, 200, { ok: true, accounts: await db.listAccounts(), me: admin.username });
  }

  if (req.method === 'POST' && url.pathname === '/api/account-create') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const admin = await requireAdmin(body.token);
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });

    const username = normalizeUsername(body.username);
    if (!USERNAME_RE.test(username)) {
      return json(res, 400, { ok: false, code: 'username_invalid' });
    }
    const problem = passwordProblem(body.password, username);
    if (problem) {
      return json(res, 400, {
        ok: false, code: problem, min: PASSWORD_MIN, max: PASSWORD_MAX
      });
    }
    const role = body.role === ROLE_ADMIN ? ROLE_ADMIN : ROLE_STAFF;
    const displayName = String(body.displayName || '').trim().slice(0, 32);
    if (await db.getAccountWithSecret(username)) {
      return json(res, 409, { ok: false, code: 'username_taken' });
    }
    await db.createAccount({
      username, displayName, role,
      passwordHash: hashPassword(String(body.password)), createdBy: admin.username
    });
    await audit(req, admin, 'account_create', {
      target: username, detail: { role, displayName }
    });
    return json(res, 200, { ok: true, accounts: await db.listAccounts() });
  }

  if (req.method === 'POST' && url.pathname === '/api/account-update') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const admin = await requireAdmin(body.token);
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });

    const targetName = normalizeUsername(body.username);
    const target = await db.getAccountWithSecret(targetName);
    if (!target) return json(res, 404, { ok: false, code: 'account_not_found' });

    const fields = {};
    if (body.displayName !== undefined) {
      fields.displayName = String(body.displayName || '').trim().slice(0, 32);
    }
    if (body.role !== undefined) {
      if (body.role !== ROLE_STAFF && body.role !== ROLE_ADMIN) {
        return json(res, 400, { ok: false, code: 'role_invalid' });
      }
      fields.role = body.role;
    }
    if (body.status !== undefined) {
      if (body.status !== 'active' && body.status !== 'disabled') {
        return json(res, 400, { ok: false, code: 'status_invalid' });
      }
      fields.status = body.status;
    }
    if (!Object.keys(fields).length) {
      return json(res, 400, { ok: false, code: 'nothing_to_update' });
    }
    if (fields.status === 'disabled' && targetName === admin.username) {
      return json(res, 409, { ok: false, code: 'cannot_disable_self' });
    }
    const losingAdmin = target.role === ROLE_ADMIN && target.status === 'active' &&
      ((fields.role && fields.role !== ROLE_ADMIN) ||
       (fields.status && fields.status !== 'active'));
    if (losingAdmin) {
      const activeAdmins = await db.countAccounts({ role: ROLE_ADMIN, status: 'active' });
      if (activeAdmins <= 1) return json(res, 409, { ok: false, code: 'last_admin' });
    }

    await db.updateAccount(targetName, fields);
    // 角色 / 状态变了就踢掉该账号现有会话：降级或停用必须立即生效，不能等 token 过期
    if (fields.role !== undefined || fields.status !== undefined) {
      await db.deleteStaffSessionsByUser(targetName);
    }
    await audit(req, admin, 'account_update', {
      target: targetName,
      detail: {
        before: { role: target.role, status: target.status, displayName: target.displayName },
        after: fields
      }
    });
    return json(res, 200, {
      ok: true,
      accounts: await db.listAccounts(),
      self: targetName === admin.username
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/account-password') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const admin = await requireAdmin(body.token);
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });

    const targetName = normalizeUsername(body.username);
    const target = await db.getAccountWithSecret(targetName);
    if (!target) return json(res, 404, { ok: false, code: 'account_not_found' });

    const problem = passwordProblem(body.password, targetName);
    if (problem) {
      return json(res, 400, {
        ok: false, code: problem, min: PASSWORD_MIN, max: PASSWORD_MAX
      });
    }
    await db.setAccountPassword(targetName, hashPassword(String(body.password)));
    const kicked = await db.deleteStaffSessionsByUser(targetName);
    await audit(req, admin, 'account_password', { target: targetName, detail: { sessionsKicked: kicked } });
    return json(res, 200, { ok: true, self: targetName === admin.username });
  }

  /* ---------------- 操作日志（仅管理员） ----------------
   * 查看与导出共用同一套日期口径（运营时区自然日，默认今天）。
   * 导出本身也记一条 audit —— 日志被谁导走同样要能追溯。 */

  if (req.method === 'GET' && url.pathname === '/api/audit') {
    const admin = await requireAdmin(url.searchParams.get('token') || '');
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });
    const range = archiveRange(url);
    if (!range) return json(res, 400, { ok: false, code: 'bad_date_range' });
    const rows = await db.listAudit({
      from: range.from,
      to: range.to,
      actor: normalizeUsername(url.searchParams.get('actor') || ''),
      action: String(url.searchParams.get('action') || ''),
      limit: url.searchParams.get('limit') || 200
    });
    return json(res, 200, {
      ok: true, date: range.label, from: range.from, to: range.to, rows
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/audit/export.csv') {
    const admin = await requireAdmin(url.searchParams.get('token') || '');
    if (!admin) return json(res, 401, { ok: false, code: 'unauthorized' });
    const range = archiveRange(url);
    if (!range) return json(res, 400, { ok: false, code: 'bad_date_range' });
    const rows = await db.allAudit({
      from: range.from,
      to: range.to,
      actor: normalizeUsername(url.searchParams.get('actor') || ''),
      action: String(url.searchParams.get('action') || '')
    });
    const csv = buildCsv(CSV_AUDIT_HEADER, rows.map((r) => [
      fmtArchiveTime(r.at), r.actor, r.role, r.action, r.sid, r.target,
      r.detail ? JSON.stringify(r.detail) : '', r.ip
    ]));
    await audit(req, admin, 'export_audit', {
      target: 'audit', detail: { date: range.label, from: range.from, to: range.to, rows: rows.length }
    });
    const tag = range.label.replace(/[^0-9A-Za-z-]+/g, '_').replace(/^_|_$/g, '');
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': 'attachment; filename="audit-log-' + (tag || 'range') + '.csv"',
      'Cache-Control': 'no-store'
    });
    return res.end(csv);
  }

  /* 归档补齐（员工端）：把库里所有「已锁定但没落进归档表」的轮次重新写一遍。
   * 正常情况下永远用不到（锁定与归档同一事务、仅归档段用 SAVEPOINT 隔离），
   * 它是归档写入失败或进程在归档落定前重启之后的兜底。幂等，可反复调用，
   * 且因为只追加归档、不推进版本号，可以在任意实例上并发调用。 */
  if (req.method === 'POST' && url.pathname === '/api/archive-sync') {
    const body = await readBody(req);
    if (!body) return json(res, 400, { ok: false, code: 'bad_request' });
    const staff = await getStaffSession(body.token);
    if (!staff) return json(res, 401, { ok: false, code: 'unauthorized' });

    const summaries = (await store.list()).filter((s) => s.number != null && s.lockedAt != null);
    const targets = [];
    for (const sum of summaries) {
      const s = await store.load(sum.id, { fresh: true });
      if (s && s.number != null && s.lockedAt != null) targets.push(s);
    }
    const failed = [];
    for (const s of targets) {
      const w = await db.archiveSnapshot(s);
      if (!w.ok) failed.push({ sid: s.id, round: s.round, error: w.error });
    }
    await audit(req, staff, 'archive_sync', {
      detail: { checked: targets.length, failed: failed.length }
    });
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
 *  - 连接后立即下发一次本场次的全量状态（事件名 state），首帧强制读库（fresh）
 *  - 期间本场次的状态变更由 store 的 change 事件广播（本实例提交 + 其他实例的 PUB/SUB 通知）
 *  - ?view=bigscreen 走大屏视图（含每个人的当前选项）：默认公开，BIGSCREEN_PUBLIC=0 时才要员工 token
 *  - 客户端断开（含网络中断）后 EventSource 自动重连；重连请求会带
 *    Last-Event-ID 头（上次 state 的版本号）。服务端**不**解析它来判增量：
 *    广播即全量快照，首帧永远落在当前版本，断线期间漏掉的变更已经在首帧里
 *    （契约见 test/sse-reconnect.test.mjs）
 *  - 每 15 秒发一次心跳（事件名 ping）维持连接
 *  - 场次关闭时服务端先发 session_closed 事件再断开连接（其他实例上关闭也一样）
 */
async function handleStream(req, res, url) {
  const sid = url.searchParams.get('sid') || '';
  const pid = url.searchParams.get('pid') || '';
  const view = url.searchParams.get('view') === 'bigscreen' ? 'bigscreen' : '';
  const staffToken = url.searchParams.get('token') || '';
  const ctx = view === 'bigscreen'
    ? await bigscreenContext(sid, staffToken, { fresh: true })
    : await playerSessionContext(sid, url.searchParams.get('ut') || '', staffToken, { fresh: true });

  if (ctx.err) {
    // SSE 无法读 JSON 错误体，用状态码 + JSON 体让客户端判断
    return json(res, ctx.err.status, { ok: false, code: ctx.err.code, sessions: ctx.err.sessions || null });
  }
  // 大屏视图会暴露未开奖的选项：默认公开，关掉公开模式后只认员工会话
  if (view === 'bigscreen' && !BIGSCREEN_PUBLIC && !ctx.staff) {
    return json(res, 403, { ok: false, code: 'bigscreen_unauthorized' });
  }
  let session = ctx.session;
  if (session.status !== 'open') {
    return json(res, 409, { ok: false, code: 'session_closed' });
  }

  // 玩家端重连即视为「回到现场」：撤销 pagehide 时上报的离开标记。
  // 浏览器刷新 / 从后台切回 / 切场次回来都会走到这里，所以离开状态不会黏住。
  // 本轮已锁定时不撤销：锁定即名单冻结，重连只能看结果，不能把自己加回本轮名单。
  if (!view && pid) {
    const out = await store.mutate(session.id, (s) => {
      const self = s.players[pid];
      if (!self || self.leftAt == null || s.number != null) return { skip: true, result: {} };
      // 席位已被同座的新玩家接走：不能靠重连把自己放回名单（与扫码的占用判定同一口径）
      const seat = self.seatNo != null ? s.seats[self.seatNo] : null;
      if (seat && seat.memberId && seat.memberId !== pid) {
        const occupant = s.players[seat.memberId];
        if (occupant && occupant.leftAt == null) return { skip: true, result: {} };
      }
      self.leftAt = null;
      return { result: {} };
    });
    if (out.session) session = out.session;
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no' // 禁用 nginx 等反向代理缓冲
  });
  res.write('retry: 2000\n\n'); // 告知客户端断线后 2 秒重连

  // 首条事件：本场次的全量状态（复用场次版本号作为事件 id）
  sseSend(res, 'state', buildStatePayload(session, pid, view), session.version);

  const client = { res, pid, view, lastVersion: session.version };
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

/**
 * 页面入口映射：URL → public/ 下的实际文件。
 * 目录按页面组织（public/index|staff|admin|bigscreen，各自含 index.html/style.css/app.js），
 * 共享资源放 public/shared（i18n.js、vendor/html5-qrcode.min.js）。
 * 除 `/staff` 这类短别名外，旧的 `/staff.html` 直链也一并保留，
 * 避免已印制的二维码、书签和历史文档里的链接失效。
 */
const PAGE_ENTRY = {
  '/': '/index/index.html',
  '/index/': '/index/index.html',
  '/index.html': '/index/index.html',
  '/staff': '/staff/index.html',
  '/staff/': '/staff/index.html',
  '/staff.html': '/staff/index.html',
  '/admin': '/admin/index.html',
  '/admin/': '/admin/index.html',
  '/admin.html': '/admin/index.html',
  '/bigscreen': '/bigscreen/index.html',
  '/bigscreen/': '/bigscreen/index.html',
  '/bigscreen.html': '/bigscreen/index.html'
};

/**
 * 前端席位配置：浏览器里跑的是原生脚本，拿不到 lib/seats.js（CommonJS），
 * 所以把常量生成一小段 JS 下发，而不是在 public/ 下再抄一份数字——
 * 抄一份就等于又埋了一个「改一处忘一处」的漂移点。
 * 页面里用 window.SEAT_CONFIG.defaultCount / min / max。
 */
function serveSeatConfig(res) {
  const body = 'window.SEAT_CONFIG = ' + JSON.stringify({
    defaultCount: DEFAULT_SEAT_COUNT,
    min: MIN_SEAT_COUNT,
    max: MAX_SEAT_COUNT
  }) + ';\n';
  res.writeHead(200, {
    'Content-Type': MIME['.js'],
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function serveStatic(req, res, url) {
  let rel = decodeURIComponent(url.pathname);
  if (rel === '') rel = '/';
  if (PAGE_ENTRY[rel]) rel = PAGE_ENTRY[rel];
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

/* ---------------- 健康检查 ---------------- */

/**
 * 两个探针分工不同，不要混成一个：
 *
 *   /healthz  存活（liveness）：只证明「进程还活着、能接 HTTP」，**不碰数据库**。
 *             数据库挂了不该被误判成「进程坏了」而去重启——重启治不了库。
 *             用途：编排器判断要不要杀进程、外部监控/告警。
 *   /readyz   就绪（readiness）：证明「现在能对外服务」——数据库真的能查询才 200，
 *             否则 503。用途：决定这个实例要不要留在负载均衡后面。
 *
 * Fly.io 只会因为 checks 失败把实例摘出流量，**不会重启实例**；
 * 且任一条 check 失败即视为不健康，所以真正参与流量决策的是 /readyz，
 * /healthz 用于监控与人工判断。
 */
const HEALTH_STARTED_AT = Date.now();
const READY_DB_TIMEOUT_MS = 2000;

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(message);
      err.code = 'timeout';
      reject(err);
    }, ms);
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); }
    );
  });
}

async function handleHealth(req, res, url) {
  if (url.pathname === '/healthz') {
    // 故意不查库：存活探针一旦依赖下游，下游抖动会变成「实例批量重启」
    return json(res, 200, {
      ok: true,
      status: 'ok',
      uptimeSec: Math.round((Date.now() - HEALTH_STARTED_AT) / 1000),
      instance: INSTANCE_ID,
      time: new Date().toISOString()
    });
  }

  // /readyz：一次最轻的往返，确认连接池能拿到可用连接
  const t0 = Date.now();
  try {
    await withTimeout(db.getPool().query('SELECT 1'), READY_DB_TIMEOUT_MS, '数据库就绪检查超时');
    return json(res, 200, {
      ok: true,
      status: 'ready',
      db: { ok: true, latencyMs: Date.now() - t0 },
      instance: INSTANCE_ID,
      time: new Date().toISOString()
    });
  } catch (e) {
    console.error('[health] 就绪检查失败:', e && e.message);
    return json(res, 503, {
      ok: false,
      status: 'not_ready',
      db: { ok: false, latencyMs: Date.now() - t0, error: (e && (e.code || e.name)) || 'db_error' },
      instance: INSTANCE_ID,
      time: new Date().toISOString()
    });
  }
}

/* ---------------- 启动 ---------------- */

/**
 * 场次自举：库中一个场次都没有时建首个场次（固定 ID = FIRST_SESSION_ID，链接稳定）。
 * 多实例同时冷启动也安全：新建走全局 advisory lock + 主键冲突即视为别人已建好。
 */
async function bootstrapSessions() {
  const before = await store.list();
  if (!before.length) {
    const created = await store.create({
      id: FIRST_SESSION_ID,
      name: '第 1 场',
      maxOpen: MAX_SESSIONS,
      seatCount: DEFAULT_SEAT_COUNT,
      makeId: () => FIRST_SESSION_ID
    });
    if (created.ok) console.log('[session] 初始化默认场次:', FIRST_SESSION_ID, created.session && created.session.name);
    else if (created.code !== '23505') console.error('[session] 初始化默认场次失败:', created.error);
  }
  const list = await store.list();
  console.log('[session] 库中场次 ' + list.length + ' 个（进行中 ' + openOf(list).length + ' 个），实例 ' + INSTANCE_ID);
}

/**
 * 启动补齐：库里若存在「已锁定但没进归档表」的轮次（典型场景是锁定时归档写库失败、
 * 之后进程重启），启动时补写一次。幂等：已归档的轮次不会重写。
 * 多实例同时启动也没问题：补写只 INSERT，唯一索引 + ON CONFLICT 去重。
 */
async function backfillArchives() {
  let filled = 0;
  const list = (await store.list()).filter((s) => s.number != null && s.lockedAt != null);
  for (const sum of list) {
    if (await db.archiveExists(sum.id, sum.round)) continue;
    const s = await store.load(sum.id, { fresh: true });
    if (!s) continue;
    const w = await db.archiveSnapshot(s);
    if (w.ok) filled += 1;
    else console.error('[archive] 启动补齐失败 sid=' + s.id + ' round=' + s.round + ': ' + w.error);
  }
  if (filled) console.log('[archive] 启动补齐：已锁定轮次补写归档 ' + filled + ' 场');
}

/** 把 store 的变更事件接到 SSE 广播上（本地提交 + 远端通知共用同一条路径）。 */
function wireStoreEvents() {
  store.on('change', (change) => {
    try {
      announceChange(change);
    } catch (e) {
      console.error('[sse] 广播失败 sid=' + (change.session && change.session.id) + ':', e.message);
    }
  });
}

async function start() {
  initPlayerPassword();
  initStaffSessionPassword();

  // 会员号加密密钥先校验：缺配置就直接拒绝启动，不做「明文兜底」。
  // 放在最前面是因为一旦跑起来，写进库的就只能是密文，密钥不对等于数据永久读不出来。
  try {
    const mid = memberId.describe();
    console.log('[member-id] 字段加密就绪：AES-256-GCM + RSA-OAEP 包裹，写入版本 v'
      + mid.current + '，可用版本 [' + mid.versions.join(',') + ']');
  } catch (e) {
    console.error('[member-id] 会员号加密密钥配置有问题，应用无法启动：');
    console.error('  ' + e.message);
    console.error('  生成方法：node scripts/member-keygen.mjs（详见 docs/member-id-encryption.md）');
    process.exit(1);
  }

  // 连接参数统一由 db.js 解析：PUB/SUB 需要自己建一条长连接，且
  // 托管 pooler（Supabase 6543 事务模式）不支持 LISTEN，必须改走会话模式端口
  const listenConfig = db.resolveListenConfig();

  try {
    await db.initDb();        // 幂等建表（缺失的表 / 新增的列，不改既有数据）
    await loadBindSecret();   // 绑定令牌签名密钥（存 app_config，重启复用）
    // 规则版本要先于场次就绪：新建场次会锁定「当时的最新一版」，
    // bootstrapRules 保证至少有一版，并把版本化之前建的场次挂到最早一版
    await bootstrapRules();
    await bootstrapAccounts(); // 保证库里至少有一个管理员
    // 发布通道要先于 store 建好：store 每次提交都会通过它广播给其他实例
    pubsub = createPubSub({ ...listenConfig, instanceId: INSTANCE_ID });
    store = createStore({ db, pubsub, maxEntries: cacheMaxEntries() });
    wireStoreEvents();

    // 远端变更：重新读库 → 版本变了才广播给本实例的 SSE 连接
    // 草稿例外：它不在库里，通知里直接带内容，合进本地内存后按 500ms 窗口广播
    // 规则没有分支：规则不进进程内存（读快照时一起从库里取），没有缓存要失效，
    // 也就没有「别的实例改了规则要通知我重读」这件事。老实例发来的 prize/bonus 通知
    // 没有 sid，会在 applyRemote 里被直接忽略。
    pubsub.on('event', (evt) => {
      if (evt && evt.type === 'draft') {
        try {
          ingestRemoteDrafts(evt);
        } catch (e) {
          console.error('[pubsub] 应用草稿通知失败:', e.message);
        }
        return;
      }
      store.applyRemote(evt).catch((e) => console.error('[pubsub] 应用通知失败:', e.message));
    });
    // 重连成功后补一次全量对齐（断线期间的通知会丢，但状态不会）
    pubsub.on('ready', ({ recovered }) => {
      if (recovered) store.resync().catch((e) => console.error('[store] 重新对齐失败:', e.message));
    });
    await pubsub.start();

    await bootstrapSessions(); // 场次自举 / 读取（不再把状态装进内存表）
    await backfillArchives(); // 已锁定但未归档的轮次补写（幂等）
  } catch (e) {
    console.error('[db] 数据库初始化失败，应用无法启动:', e.message);
    console.error('  请确认 DATABASE_URL 已配置（Fly.io: fly secrets set DATABASE_URL=postgresql://user:pass@host:port/db）');
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname === '/healthz' || url.pathname === '/readyz') {
      handleHealth(req, res, url).catch((e) => {
        console.error('[health] 探针异常:', e && e.message);
        if (!res.headersSent) json(res, 503, { ok: false, status: 'unknown' });
        else res.end();
      });
    } else if (url.pathname === '/api/stream') {
      handleStream(req, res, url).catch(() => {
        if (!res.headersSent) json(res, 500, { ok: false, error: '服务器内部错误' });
        else res.end();
      });
    } else if (url.pathname === '/shared/seat-config.js') {
      // 由 lib/seats.js 生成，前端唯一的席位默认值/上下界来源
      serveSeatConfig(res);
    } else if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url).catch((e) => {
        console.error('[api] ' + url.pathname + ' 处理失败:', e && e.stack ? e.stack : e);
        json(res, 500, { ok: false, error: '服务器内部错误' });
      });
    } else {
      serveStatic(req, res, url);
    }
  }).listen(PORT, '0.0.0.0', () => {
    console.log('单双竞猜已启动: http://localhost:' + PORT + '/  (玩家端，进入后选场次并扫自己的二维码)');
    console.log('工作人员端入口: http://localhost:' + PORT + '/staff （账号 + 密码登录）');
    console.log('管理界面入口: http://localhost:' + PORT + '/admin （对账导出 / 员工账号 / 操作日志 / 场次管理，需管理员账号）');
    console.log('实时大屏入口: http://localhost:' + PORT + '/bigscreen （' + (BIGSCREEN_PUBLIC ? '公开访问，打开即看' : '需员工登录') + '，按场次实时展示每位玩家的当前选项）');
    console.log('多场次: 全集群最多并行 ' + MAX_SESSIONS + ' 场，员工端可运行时新建/切换/关闭');
    console.log('场景口令: 员工「切换场次」需输入场次口令（管理员免校验）；玩家选择场次需玩家口令');
    console.log('账号: 一人一账号一密码，初始管理员由 ADMIN_USERNAME / ADMIN_PASSWORD 引导创建，之后在管理界面维护');
    console.log('数据持久化: Postgres（连接串来自 DATABASE_URL，池上限可用 DB_POOL_MAX 覆盖）');
    console.log('多实例: 状态、员工会话、限频全在 Postgres；跨实例变更走 LISTEN/NOTIFY（实例 ' + INSTANCE_ID + '）');
    if (!process.env.ADMIN_PASSWORD) {
      console.log('⚠ 初始管理员默认密码为 ' + DEFAULT_ADMIN_PASSWORD + '，请登录后立即在管理界面修改（或用 ADMIN_PASSWORD 环境变量指定）');
    }
    if (!process.env.PLAYER_SESSION_PASSWORD) {
      console.log('⚠ 玩家端场次口令默认为 ' + DEFAULT_PLAYER_PASSWORD + '，建议设置 PLAYER_SESSION_PASSWORD 环境变量覆盖');
    }
    if (!process.env.STAFF_SESSION_PASSWORD) {
      console.log('⚠ 员工切换场次口令默认为 ' + DEFAULT_STAFF_SESSION_PASSWORD + '，建议设置 STAFF_SESSION_PASSWORD 环境变量覆盖');
    }
  });

  // 优雅退出：断开 LISTEN 长连接，避免数据库侧留下悬挂连接
  const shutdown = async (sig) => {
    console.log('[server] 收到 ' + sig + '，正在退出…');
    try { server.close(); } catch (_) { /* 已关闭 */ }
    if (pubsub) await pubsub.stop();
    try { await db.getPool().end(); } catch (_) { /* 已关闭 */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

start();

