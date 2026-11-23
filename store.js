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
 *   - **缓存有两个上限，各管一件事**：TTL 管「读到的旧不旧」，LRU 容量管「占多少内存」。
 *     只有 TTL 的话，过期条目不会被删、只是读时回库，场次数长期增长就是内存泄漏。
 *     已关闭的场次不进缓存（终态，只会被回看），所以缓存规模跟着「进行中的场次」走，
 *     不跟历史总量走。
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
// 新建场次不传席位数时的默认值：与 db 层、HTTP 层共用同一份常量（lib/seats.js）
const { DEFAULT_SEAT_COUNT } = require('./lib/seats');

/** 读缓存有效期：通知机制正常时用不到它，纯粹是「通知丢了」的兜底。 */
const CACHE_TTL_MS = 5000;

/**
 * 读缓存条目上限（LRU 淘汰）。
 *
 * TTL 只决定「一次读要不要回库」，它不删条目——过期条目照样占着内存。
 * 所以必须另设一道容量闸：超上限就淘汰最久未用的那个。
 * 取值口径是「单实例上的并发场次数 × 2~3」，不是历史总场次（那等于没有上限）。
 */
const MAX_CACHE_ENTRIES = 64;

/** 同一场次的提交冲突重试上限。冲突意味着并发写，重跑 mutator 即可。 */
const MAX_COMMIT_RETRIES = 6;

function createStore({ db, pubsub = null, logger = console, ttlMs = CACHE_TTL_MS, maxEntries = MAX_CACHE_ENTRIES } = {}) {
  const emitter = new EventEmitter();
  emitter.setMaxListeners(50);

  /** 上限兜底：传 0 / NaN / 负数一律回到默认值，否则缓存会退化成「一条都不留」。 */
  const rawLimit = Math.floor(Number(maxEntries));
  const cacheLimit = Number.isFinite(rawLimit) && rawLimit > 0 ? rawLimit : MAX_CACHE_ENTRIES;

  /**
   * sid -> { session, at }
   *
   * LRU 靠 Map 的插入顺序实现：命中时先 delete 再 set，把该条挪到队尾；
   * 超上限就从队头（最久未用）删。淘汰的代价只是一次额外的读库查询，
   * 不影响正确性——Postgres 才是事实来源，缓存随时可以丢。
   */
  const cache = new Map();
  /** sid -> Promise：远端通知的合并去重，避免一次突发把库读穿 */
  const refreshing = new Map();
  /** 刷新期间又有新通知的场次 */
  const pending = new Set();
  /** 缓存命中统计：只看 cached 一个数没法判断上限给得合不合适 */
  const metrics = { hits: 0, misses: 0, evictions: 0, closedDrops: 0 };

  function put(session) {
    if (!session || !session.id) return;
    // 已关闭的场次是终态、只会被回看，留在缓存里等于让历史场次永久占内存。
    // 用 delete 而不是「跳过」：远端刚把场次关掉时，本地可能还躺着一条 status=open
    // 的旧快照，必须顺手清掉，否则 TTL 窗口内还会被读到。
    if (session.status === 'closed') {
      if (cache.delete(session.id)) metrics.closedDrops += 1;
      return;
    }
    cache.delete(session.id); // 先删后插：无论新增还是刷新，都移到队尾
    cache.set(session.id, { session, at: Date.now() });
    while (cache.size > cacheLimit) {
      const oldest = cache.keys().next();
      if (oldest.done) break;
      cache.delete(oldest.value);
      metrics.evictions += 1;
    }
  }

  /**
   * 取一个场次的完整快照。
   * fresh=true 绕过缓存（提交前读数、SSE 首帧、远端通知对齐都必须读库）。
   */
  async function load(sid, { fresh = false } = {}) {
    if (!sid) return null;
    const hit = cache.get(sid);
    if (!fresh && hit && Date.now() - hit.at < ttlMs) {
      metrics.hits += 1;
      cache.delete(sid); // 命中即刷新 LRU 位置：热场次不能被冷场次挤掉
      cache.set(sid, hit);
      return hit.session;
    }
    if (!fresh) metrics.misses += 1;
    const session = await db.loadSessionSnapshot(sid);
    if (!session) {
      cache.delete(sid);
      return null;
    }
    put(session);
    return session;
  }

  /**
   * 场次摘要列表：每台实例都直查库，不进缓存。
   * 摘要查询本身是轻量 JOIN，而它天然要求「全量、最新」（列表页、准入判定、上限计数都用它），
   * 缓存一份反而要自己维护失效，收益为负。
   */
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
  async function create({ id, name, maxOpen, seatCount = DEFAULT_SEAT_COUNT, makeId }) {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      // 首次用调用方指定的 id（首场固定为 main），撞车后换成新的随机 id
      const sid = attempt === 0 && id ? id : makeId();
      const r = await db.createSessionRow({ id: sid, name, maxOpen, seatCount });
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
    /**
     * 缓存运行态。cached 是当前条目数，capacity 是上限：
     * cached 长期贴着 capacity、evictions 持续上涨，说明上限给小了；
     * hits/misses 是命中率，判断这个缓存到底还有没有意义。
     */
    stats: () => ({
      cached: cache.size,
      capacity: cacheLimit,
      hits: metrics.hits,
      misses: metrics.misses,
      evictions: metrics.evictions,
      closedDrops: metrics.closedDrops
    })
  };
}

module.exports = { createStore, CACHE_TTL_MS, MAX_CACHE_ENTRIES, MAX_COMMIT_RETRIES };
