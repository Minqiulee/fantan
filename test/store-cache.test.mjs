/**
 * 读缓存的容量与淘汰口径（纯内存，不连库）。
 *
 * 钉死的契约：
 *   1. 缓存有条目上限，超了淘汰最久未用的场次，不会跟着历史场次无限长；
 *   2. 命中会刷新 LRU 位置——热场次不能被一次性访问的冷场次挤掉；
 *   3. 已关闭的场次不进缓存，且会把本地残留的旧快照清掉（否则 TTL 窗口内还读得到）；
 *   4. 上限传 0 / NaN / 负数回落到默认值，不会退化成「一条都不缓存」；
 *   5. TTL 与容量是两件事：TTL 过期只是回库，条目仍在，由 LRU 负责回收。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import storeModule from '../store.js';

const { createStore, MAX_CACHE_ENTRIES } = storeModule;

/** 假 db：只提供 store 用到的两个方法，并记录每个 sid 的读库次数。 */
function fakeDb(statuses = {}) {
  const reads = {};
  return {
    reads,
    async loadSessionSnapshot(sid) {
      reads[sid] = (reads[sid] || 0) + 1;
      if (statuses[sid] === 'missing') return null;
      return { id: sid, name: sid, status: statuses[sid] || 'open', version: 1, players: {} };
    },
    async listSessionSummaries() {
      return [];
    }
  };
}

test('超出上限时淘汰最久未用的场次', async () => {
  const db = fakeDb();
  const store = createStore({ db, maxEntries: 2, logger: { warn() {}, error() {}, log() {} } });

  await store.load('A');
  await store.load('B');
  await store.load('C'); // 挤掉 A

  const s = store.stats();
  assert.equal(s.cached, 2);
  assert.equal(s.capacity, 2);
  assert.equal(s.evictions, 1);

  await store.load('A'); // A 已被淘汰，必须回库
  assert.equal(db.reads.A, 2);
  assert.equal(store.stats().cached, 2);
});

test('命中刷新 LRU 位置：热场次不被冷场次挤掉', async () => {
  const db = fakeDb();
  const store = createStore({ db, maxEntries: 2, logger: { warn() {}, error() {}, log() {} } });

  await store.load('hot');
  await store.load('cold');
  await store.load('hot'); // 命中，hot 移到队尾
  await store.load('fresh'); // 淘汰 cold，而不是 hot

  assert.equal(store.stats().cached, 2);
  await store.load('hot');
  assert.equal(db.reads.hot, 1, 'hot 仍在缓存里，不该回库');
  await store.load('cold');
  assert.equal(db.reads.cold, 2, 'cold 已被淘汰，必须回库');
});

test('已关闭的场次不进缓存，并清掉本地残留的 open 快照', async () => {
  const statuses = { A: 'open' };
  const db = fakeDb(statuses);
  const store = createStore({ db, maxEntries: 8, logger: { warn() {}, error() {}, log() {} } });

  await store.load('A');
  assert.equal(store.stats().cached, 1);

  statuses.A = 'closed';
  await store.load('A', { fresh: true }); // 模拟远端关闭后重新对齐
  assert.equal(store.stats().cached, 0);
  assert.equal(store.stats().closedDrops, 1);

  await store.load('A', { fresh: true }); // 已关场次再次读库，依然不入缓存
  assert.equal(store.stats().cached, 0);
});

test('上限给非法值时回落到默认值', () => {
  const db = fakeDb();
  for (const bad of [0, -3, NaN, undefined, null]) {
    const store = createStore({ db, maxEntries: bad, logger: { warn() {}, error() {}, log() {} } });
    assert.equal(store.stats().capacity, MAX_CACHE_ENTRIES, 'maxEntries=' + bad);
  }
});

test('TTL 过期只是回库，条目由 LRU 回收', async () => {
  const db = fakeDb();
  const store = createStore({
    db,
    maxEntries: 4,
    ttlMs: 5,
    logger: { warn() {}, error() {}, log() {} }
  });

  await store.load('A');
  assert.equal(store.stats().hits, 0);
  await store.load('A');
  assert.equal(store.stats().hits, 1, 'TTL 内命中');
  assert.equal(db.reads.A, 1);

  await new Promise((r) => setTimeout(r, 15));
  await store.load('A');
  assert.equal(db.reads.A, 2, 'TTL 过期后回库');
  assert.equal(store.stats().cached, 1, '过期条目仍在缓存里，占位由 LRU 负责回收');
  assert.equal(store.stats().misses, 2, '首次读 + TTL 过期各记一次 miss');
});

test('forget 立即释放条目', async () => {
  const db = fakeDb();
  const store = createStore({ db, maxEntries: 4, logger: { warn() {}, error() {}, log() {} } });

  await store.load('A');
  assert.equal(store.stats().cached, 1);
  store.forget('A');
  assert.equal(store.stats().cached, 0);
  await store.load('A');
  assert.equal(db.reads.A, 2);
});
