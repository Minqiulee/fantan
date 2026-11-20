/**
 * store.js — 场次会话存储（跨实例共享 + 本地读缓存 + 乐观锁）
 * ------------------------------------------------------------
 * 改造前：session 是进程内存里的对象，请求直接改它，然后 fire-and-forget 落库。
 * 那套写法在单进程下成立，多实例下必然出三类问题：
 *   1. 会话丢失：某台实例新建/修改的场次，其他实例的内存里没有；重启更是全丢
 *   2. 状态不同步：A 实例广播了，B 实例的 SSE 连接收不到，两边推不同快照
 *   3. 写覆盖：两台实例各读一份快照、各改一处、各写一次，后写的把先写的抹掉
 *
 * 现在：
 *   - **Postgres 是唯一事实来源**。内存里只有 cache（读缓存），随时可以丢弃；
 *     缓存 TTL 兜底（默认 5 秒），所以即使通知全丢，最坏也只是短暂读到旧快照。
 *   - **所有写都必须走 mutate()**：读最新快照 → 交给 mutator 修改 → 带版本号提交。
 *     版本号 CAS 失败即说明别的实例抢先提交，重新读取重跑 mutator（最多 6 次）。
 *     mutator 必须是无外部副作用的纯函数式修改（只改入参快照、返回结果）。
 *   - **变更事件统一由 store 发出**：本地提交直接 emit；远端通过 PUB/SUB 收到提示后
 *     重新读库、比对版本、再 emit。server 只监听事件做 SSE 广播，不关心变更来自哪台机器。
 *
 * 事件：store.on('change', ({ type, session, version, remote, archived }))
 *   type = 'change' 普通状态变更 | 'closed' 场次关闭（收端要断开该场次连接）
 */
const { EventEmitter } = require('events');

/** 读缓存有效期：通知机制正常时用不到它，纯粹是「通知丢了」的兜底。 */
const CACHE_TTL_MS = 5000;

/** 同一场次的提交冲突重试上限。冲突意味着并发写，重跑 mutator 即可。 */
const MAX_COMMIT_RETRIES = 6;

function createStore({ db, pubsub = null, logger = console, ttlMs = CACHE_TTL_MS } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  /** sid -> { session, at } */
  const cache = new Map();
  /** sid -> Promise：远端通知的合并去重，避免一次突发把库读穿 */
  const refreshing = new Map();
  /** 刷新期间又有新通知的场次 */
  const pending = new Set();

  function put(session) {
    cache.set(session.id, { session, at: Date.now() });
  }

  /**
   * 取一个场次的完整快照。
   * fresh=true 绕过缓存（提交前读数、SSE 首帧、远端通知对齐都必须读库）。
   */
  async function load(sid, { fresh = false } = {}) {
    if (!sid) return null;
    const hit = cache.get(sid);
    if (!fresh && hit && Date.now() - hit.at < ttlMs) return hit.session;
    const session = await db.loadSessionSnapshot(sid);
    if (!session) {
      cache.delete(sid);
      return null;
    }
    put(session);
    return session;
  }

  /** 场次摘要列表（每台实例都直接查库：场次数是十位数量级，缓存反而更容易错）。 */
  async function list() {
    return db.listSessionSummaries();
  }

  /** sid -> Promise：同一实例内的写入排队，避免自己人和自己人抢版本号 */
  const writeChains = new Map();

  /**
   * 进程内的单场次写锁。
   *
   * 乐观锁负责「跨实例」正确性，但同一个实例上 12 个玩家同时提交预测时，
   * 光靠 CAS 会出现大量「冲突 → 重读 → 重试」的无效往返（n 个并发最多 n-1 次冲突）。
   * 这里按场次排队：本实例的写操作串行进入，跨实例的竞争才交给 CAS。
   * 两者配合的效果是「本机无冲突、跨机最多退避重试」，而不是二选一。
   */
  function withLocalLock(sid, fn) {
    const prev = writeChains.get(sid) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(() => {}, () => {});
    writeChains.set(sid, tail);
    tail.then(() => { if (writeChains.get(sid) === tail) writeChains.delete(sid); });
    return run;
  }

  /**
   * 唯一的状态写入口。
   *
   * mutator(session) 的约定：
   *   - 直接修改传入的快照（它就是最新状态），返回 { result } 携带要回给 HTTP 的结果
   *   - 业务校验不通过时返回 { abort: { status, body } }，此时不会写库
   *   - 不要在这里做 IO / 发网络请求：冲突重试会重跑它
   *
   * 返回：
   *   { session, version, result, archived, archiveError }  成功
   *   { aborted }   业务拒绝
   *   { notFound }  场次不存在
   *   { conflict }  连续重试仍冲突（正常流量下几乎不可能）
   *   { failed }    写库失败（连接/约束等）
   */
  function mutate(sid, mutator, { type = 'change' } = {}) {
    return withLocalLock(sid, () => runMutate(sid, mutator, type));
  }

  async function runMutate(sid, mutator, type) {
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt += 1) {
      const current = await load(sid, { fresh: true });
      if (!current) return { notFound: true };

      const out = (await mutator(current)) || {};
      if (out.abort) {
        // mutator 可能已经动手改过对象才决定拒绝：把缓存丢掉，下次读必然回库，
        // 避免「没写进库的状态」在 TTL 内被后续请求读到。
        cache.delete(sid);
        return { aborted: out.abort };
      }
      // 幂等路径（例如重复上报「已离开」）：业务上确认无需写库，直接返回，不推进版本号
      if (out.skip) return { session: current, version: current.version, result: out.result, skipped: true };

      const write = await db.commitSnapshot(sid, current.version, current);
      if (write.conflict) {
        logger.warn('[store] 版本冲突，重试 sid=' + sid + ' attempt=' + (attempt + 1));
        continue;
      }
      if (!write.ok) {
        logger.error('[store] 提交失败 sid=' + sid + ':', write.error);
        cache.delete(sid); // 未落库的改动不能留在缓存里
        return { failed: write.error };
      }

      current.version = write.version;
      put(current);

      const change = {
        type,
        session: current,
        version: write.version,
        archived: write.archived,
        archiveError: write.archiveError,
        remote: false
      };
      emitter.emit('change', change);
      // 通知是「尽力而为」：投递失败不影响正确性，其他实例读缓存有 TTL 兜底
      if (pubsub) await pubsub.publish({ type, sid, version: write.version });

      return {
        session: current,
        version: write.version,
        result: out.result,
        archived: write.archived,
        archiveError: write.archiveError
      };
    }
    return { conflict: true };
  }

  /**
   * 新建场次：上限判断与序号分配在 db 层用全局 advisory lock 串起来（跨实例）。
   * id 冲突（随机短串撞车）时重试几次。
   */
  async function create({ id, name, maxOpen, makeId }) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // 首次用调用方指定的 id（首场固定为 main），撞车后换成新的随机 id
      const sid = attempt === 0 && id ? id : makeId();
      const r = await db.createSessionRow({ id: sid, name, maxOpen });
      if (!r.ok) {
        if (r.code === '23505') continue; // 主键冲突，换个 id 再来
        return r;
      }
      const session = await load(sid, { fresh: true });
      const version = session ? session.version : 1;
      if (session) {
        emitter.emit('change', { type: 'change', session, version, remote: false });
      }
      if (pubsub) await pubsub.publish({ type: 'change', sid, version });
      return { ok: true, session };
    }
    return { ok: false, error: 'session_id_collision' };
  }

  /**
   * 处理远端通知：重新读库 → 版本有变化才 emit。
   * 同一场次并发到达的通知会合并成一次读（refreshing / pending）。
   */
  async function applyRemote(evt) {
    const sid = evt && evt.sid;
    if (!sid) return;

    if (refreshing.has(sid)) {
      pending.add(sid);
      return refreshing.get(sid);
    }

    const task = (async () => {
      const prev = cache.get(sid);
      const session = await load(sid, { fresh: true });
      if (!session) return;
      if (evt.type !== 'closed' && prev && prev.session.version === session.version) return;
      emitter.emit('change', {
        type: evt.type === 'closed' ? 'closed' : 'change',
        session,
        version: session.version,
        remote: true
      });
    })();

    refreshing.set(sid, task);
    try {
      await task;
    } catch (e) {
      logger.error('[store] 远端通知处理失败 sid=' + sid + ':', e.message);
    } finally {
      refreshing.delete(sid);
      if (pending.delete(sid)) await applyRemote({ sid, type: 'change' });
    }
  }

  /**
   * 全量重新对齐：把缓存里每个场次重新读一遍，有变化就 emit。
   * PUB/SUB 断线重连后调用，补上断线期间错过的变更。
   */
  async function resync() {
    let changed = 0;
    for (const sid of Array.from(cache.keys())) {
      const prev = cache.get(sid);
      const session = await load(sid, { fresh: true });
      if (!session) continue;
      if (prev && prev.session.version === session.version) continue;
      changed += 1;
      emitter.emit('change', { type: 'change', session, version: session.version, remote: true });
    }
    if (changed) logger.log('[store] 重连后重新对齐 ' + changed + ' 个场次');
    return changed;
  }

  /** 把某个场次踢出缓存（关闭场次后不必留着）。 */
  function forget(sid) {
    cache.delete(sid);
  }

  return {
    on: (event, fn) => emitter.on(event, fn),
    load,
    list,
    mutate,
    create,
    applyRemote,
    resync,
    forget,
    stats: () => ({ cached: cache.size })
  };
}

module.exports = { createStore, CACHE_TTL_MS, MAX_COMMIT_RETRIES };
