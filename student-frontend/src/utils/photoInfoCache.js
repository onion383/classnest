// =========================================================================
// photoInfoCache.js —— 相册「信息」面板的缓存（EXIF / ICC）
//
// 原来这个缓存是 AlbumView 里的一个无上限 Map（v6 · 1-4）：
//   · 翻完一本大相册就攒下几千条照片信息（每条约几百字节到几 KB）；
//   · 换号后仍留着上一个账号的照片元数据；
//   · 组件卸载后引用随组件一起消失，跨次打开本来也不复用。
//
// 现在收口到这里：200 条上限的 LRU（命中即刷新为最近使用）+ 登出/换号清空。
// 模块加载时登记一次用户级清理，重复挂载不会重复登记（Set 去重，闭包身份稳定）。
// =========================================================================

import { registerUserScopedReset } from './userScopedCache.js'

export const PHOTO_INFO_CACHE_MAX = 200

const cache = new Map()

// 读：命中就刷新为「最近使用」（Map 保序，删了再插排到末尾），未命中返回 null。
export function getPhotoInfo(id) {
  if (!cache.has(id)) return null
  const value = cache.get(id)
  cache.delete(id)
  cache.set(id, value)
  return value
}

// 写：同上刷新顺序，并从最旧的一端淘汰到上限以内。
export function setPhotoInfo(id, value) {
  cache.delete(id)
  cache.set(id, value)
  while (cache.size > PHOTO_INFO_CACHE_MAX) {
    cache.delete(cache.keys().next().value)
  }
}

export function clearPhotoInfo() { cache.clear() }

// 仅测试用：当前条数（验证淘汰确实发生）
export function photoInfoCacheSize() { return cache.size }

registerUserScopedReset(clearPhotoInfo)
