// =========================================================================
// slugScopes.js —— 「按库（slug）隔离的进程内状态」的单一实现
//
// 为什么要有它：
//   album_photos.id / albums.id / ai_conversations.id 都**各库独立自增**
//   （见 albumThumbs.js:6-12 的历史事故注释）。所以任何以裸 id 为键的 Map，
//   或用一份模块级数组攒批再统一发送的状态，都会在两个库之间塌缩：
//     · 库 A 的 id=5 覆盖库 B 的 id=5；
//     · A 库回报 id=5 会把 B 库同号的待生成条目一起删掉；
//     · 攒批时「用调用那一刻的 slug」上报整批 → 内存索引记成别人的库 → 串图。
//
//   项目里 albumThumbs.indexBySlug、dbManager.connCache、worker.openConns 已经
//   各自手写了一遍分桶，但**没有单点表达**，于是新写的状态仍会退回裸 Map。
//   这里把「分桶 + 统一失效」收口：状态自己登记，登出/锁库时统一清，不点名。
//   与前端 utils/userScopedCache.js 是同一种思路（缓存自己登记清理函数）。
//
// 用法：
//   const scopes = require('../utils/slugScopes');
//   const pending = scopes.createSlugBuckets(() => new Map());
//   pending.forSlug(slug).set(photoId, Date.now());
//   scopes.clearAllForSlug(slug);   // 登出：一次清掉所有按库隔离的状态
// =========================================================================

'use strict';

// 与 albumThumbs.safeSlug 同口径（白名单 + 兜底 default），保持幂等：
// 已经归一化过的 slug 再过一次不会变，因此 IPC 转发时用桶的 key 是安全的。
function safeSlug(slug) {
  const s = String(slug || '');
  return /^[A-Za-z0-9_@-]{1,64}$/.test(s) ? s : 'default';
}

// 所有按库分桶的注册表都登记在这里，供 clearAllForSlug 统一失效。
const registries = new Set();

function bucketSize(bucket) {
  if (typeof bucket.size === 'number') return bucket.size;   // Map / Set
  if (typeof bucket.length === 'number') return bucket.length; // Array
  return 0;
}

// 建一组「slug → 桶」的分桶状态。factory 决定桶的类型（Map / Set / Array）。
function createSlugBuckets(factory) {
  const buckets = new Map();
  const api = {
    // 取（没有就建）该库的桶。所有读写都必须经由它，不要直接持有一份全局 Map。
    forSlug(slug) {
      const key = safeSlug(slug);
      let bucket = buckets.get(key);
      if (!bucket) { bucket = factory(); buckets.set(key, bucket); }
      return bucket;
    },
    // 只看不建：用于「回报时这个库根本没待办」的场景，避免清个空桶出来。
    peek(slug) {
      return buckets.get(safeSlug(slug));
    },
    clearSlug(slug) {
      buckets.delete(safeSlug(slug));
    },
    // 各桶条目数之和：配额闸看的是进程内全局在途量，不能只看某一个库。
    totalSize() {
      let n = 0;
      for (const bucket of buckets.values()) n += bucketSize(bucket);
      return n;
    },
    // 遍历所有 [slug, 桶]：TTL 清理、flushAll 用。key 已归一化（见 safeSlug 注释）。
    entries() {
      return buckets.entries();
    },
    size() {
      return buckets.size;
    },
    clear() {
      buckets.clear();
    },
  };
  registries.add(api);
  return api;
}

// 攒批发用的特化版本：条目按库分开攒，达到 limit 自动发该库自己的桶。
// flush(slug, entries) 由调用方提供（通常是 process.send / IPC 发送）。
// 关键不变量：**任何一次 flush 都只携带同一个 slug 的条目**，
// 且 flush 的 slug 来自条目入桶时的那个库，不是「调用 flush 那一刻」的库。
function createSlugBatch({ limit = 50, flush }) {
  const buckets = createSlugBuckets(() => []);

  function emit(slug, entries) {
    if (!entries.length) return;
    try { flush(slug, entries); } catch (e) {
      // 发送失败不能让条目永远留在桶里等下一次别的库把它带走
      console.warn('[slugScopes] 批次上报失败：', e && e.message);
    }
  }

  function drain(slug, arr) {
    if (!arr || !arr.length) return;
    const entries = arr.splice(0);
    emit(slug, entries);
  }

  return {
    push(slug, entry) {
      const arr = buckets.forSlug(slug);
      arr.push(entry);
      if (arr.length >= limit) drain(slug, arr);
    },
    // 只发这一个库的桶 —— onProgress / 任务收尾调用，不会偷走别的库攒的条目
    flush(slug) {
      drain(safeSlug(slug), buckets.peek(slug));
    },
    // 全部库各自发一次：异常兜底 / 锁库 / 退出前。每条报文仍带自己的 slug。
    flushAll() {
      for (const [slug, arr] of buckets.entries()) drain(slug, arr);
    },
    // 登出/锁库：丢掉还没发出去的条目（已经发了的由对端自己管）
    clearSlug(slug) {
      buckets.clearSlug(slug);
    },
    pendingSize() {
      return buckets.totalSize();
    },
  };
}

// 统一失效入口：登出、锁库、删库时调一次，不必知道有哪些状态需要清。
function clearAllForSlug(slug) {
  for (const api of registries) {
    try { api.clearSlug(slug); } catch (e) {
      console.warn('[slugScopes] 清理库状态失败：', e && e.message);
    }
  }
}

// 仅测试用：确认「需要按库隔离的状态确实登记了」
function _registeredCount() {
  return registries.size;
}

module.exports = {
  safeSlug,
  createSlugBuckets,
  createSlugBatch,
  clearAllForSlug,
  _registeredCount,
};
