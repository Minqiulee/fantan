/**
 * pubsub.js — 跨实例状态通知（Postgres LISTEN/NOTIFY）
 * ------------------------------------------------------------
 * 多实例部署时，状态变更发生在任意一台机器上，其他机器的 SSE 连接也必须
 * 「立刻」知道，否则同一个场次在不同实例上会推不同的快照。
 *
 * 为什么用 LISTEN/NOTIFY 而不是 Redis / NATS：
 *   - 系统本来就强依赖 Postgres，再引入一个中间件只是多一个会挂的东西；
 *   - 通知是「变更提示」而不是「状态载体」：消息里只有 { type, sid, version }，
 *     几十字节，远低于 8000 字节的 payload 上限；
 *   - 消息丢了不会错：接收方收到提示后一律回数据库读最新快照，
 *     即使整段通知全丢，读缓存也有 TTL 兜底（见 store.js）。
 *
 * 连接模型：每个实例一条专用连接，既 LISTEN 也发 pg_notify。
 * 不复用连接池：LISTEN 要求连接长期存活，混进池里会被其他查询借走。
 *
 * 托管 PgBouncer 注意：LISTEN 是会话级状态，事务模式 pooler（Supabase 端口 6543）
 * 里连接会被随机复用，订阅必然失效。因此传进来的 connectionString 必须是
 * 会话模式端口（db.js 的 resolveListenConnectionString() 负责把 6543 换成 5432）。
 *
 * 断线处理：指数退避重连（1s → 30s 封顶），重连成功后 emit 'ready'，
 * 由 store 做一次全量重新同步（补上断线期间错过的变更）。
 */
const { EventEmitter } = require('events');
const { Client } = require('pg');

/** 唯一的通知通道名。多实例必须一致；换名字等于换协议，需同时升级所有实例。 */
const CHANNEL = 'oddeven_session_events';

const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30000;

function createPubSub({ connectionString, instanceId, logger = console }) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(20);

  let client = null;
  let connecting = false;
  let stopping = false;
  let retry = 0;
  let timer = null;
  let connected = false;

  function scheduleReconnect(reason) {
    if (stopping || timer) return;
    const delay = Math.min(RECONNECT_BASE_MS * 2 ** retry, RECONNECT_MAX_MS);
    retry += 1;
    logger.warn('[pubsub] ' + reason + '，' + Math.round(delay / 1000) + ' 秒后重连');
    timer = setTimeout(() => {
      timer = null;
      connect();
    }, delay);
    if (timer.unref) timer.unref();
  }

  async function connect() {
    if (stopping || connecting) return;
    connecting = true;
    try {
      const c = new Client({ connectionString });
      c.on('error', (e) => {
        logger.error('[pubsub] 连接错误:', e.message);
        connected = false;
        scheduleReconnect('连接出错');
      });
      c.on('end', () => {
        connected = false;
        if (!stopping) scheduleReconnect('连接断开');
      });
      c.on('notification', (msg) => {
        if (msg.channel !== CHANNEL || !msg.payload) return;
        let evt;
        try {
          evt = JSON.parse(msg.payload);
        } catch (e) {
          logger.warn('[pubsub] 丢弃无法解析的通知:', msg.payload.slice(0, 120));
          return;
        }
        // 自己发的不再处理：本地已提交并广播过，重复处理只会多一次无谓读
        if (evt.origin === instanceId) return;
        emitter.emit('event', evt);
      });

      await c.connect();
      await c.query('LISTEN ' + CHANNEL);
      client = c;
      connected = true;
      const recovered = retry > 0;
      retry = 0;
      logger.log('[pubsub] 已订阅 ' + CHANNEL + '（实例 ' + instanceId + '）');
      // 重连成功：期间可能漏了通知，交给上层做一次全量对齐
      emitter.emit('ready', { recovered });
    } catch (e) {
      logger.error('[pubsub] 订阅失败:', e.message);
      connected = false;
      try { if (client) await client.end(); } catch (_) { /* 已断开 */ }
      client = null;
      scheduleReconnect('订阅失败');
    } finally {
      connecting = false;
    }
  }

  /**
   * 发布一条变更通知。
   * payload: { type: 'change'|'closed', sid, version }
   * 返回是否投递成功；失败只记日志——状态本身已经在库里，读路径有兜底。
   */
  async function publish(evt) {
    if (!connected || !client) {
      logger.warn('[pubsub] 通道未就绪，跳过通知 sid=' + (evt && evt.sid) + '（其他实例靠读取兜底）');
      return false;
    }
    try {
      await client.query('SELECT pg_notify($1, $2)', [
        CHANNEL,
        JSON.stringify({ ...evt, origin: instanceId, at: Date.now() })
      ]);
      return true;
    } catch (e) {
      logger.error('[pubsub] 通知发送失败:', e.message);
      return false;
    }
  }

  async function start() {
    stopping = false;
    await connect();
  }

  async function stop() {
    stopping = true;
    connected = false;
    if (timer) { clearTimeout(timer); timer = null; }
    if (client) {
      try { await client.end(); } catch (_) { /* 已断开 */ }
      client = null;
    }
  }

  return {
    start,
    stop,
    publish,
    on: (event, fn) => emitter.on(event, fn),
    status: () => ({ connected, channel: CHANNEL, instanceId })
  };
}

module.exports = { createPubSub, CHANNEL };
