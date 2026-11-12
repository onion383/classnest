// =========================================================================
// photo-info-cache.test.js —— 相册「信息」缓存封顶（v6 性能专题 · 1-4）
//
// 验收点：
//   ① 超过 200 条时淘汰最久未使用的一条（命中也会刷新「最近使用」）；
//   ② 换号清空：模块加载时已登记到 userScopedCache，登出统一调用后缓存为空；
//   ③ 接线：AlbumView 不再自带无上限 Map，读/写/卸载都走这个模块。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const CACHE_MODULE = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/photoInfoCache.js')).href
const USER_SCOPED = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/userScopedCache.js')).href
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('LRU：超上限淘汰最久未使用，命中会刷新顺序', async () => {
  const { getPhotoInfo, setPhotoInfo, clearPhotoInfo, photoInfoCacheSize, PHOTO_INFO_CACHE_MAX } = await import(CACHE_MODULE)
  clearPhotoInfo()
  assert.equal(PHOTO_INFO_CACHE_MAX, 200)

  for (let i = 0; i < PHOTO_INFO_CACHE_MAX; i++) setPhotoInfo(`p${i}`, { n: i })
  assert.equal(photoInfoCacheSize(), PHOTO_INFO_CACHE_MAX)

  // 命中 p0 → p0 变成「最近使用」；再写一条新记录应淘汰 p1（此时最旧）
  assert.deepEqual(getPhotoInfo('p0'), { n: 0 })
  setPhotoInfo('new', { n: -1 })
  assert.equal(photoInfoCacheSize(), PHOTO_INFO_CACHE_MAX, '始终不超过上限')
  assert.deepEqual(getPhotoInfo('p0'), { n: 0 }, '刚命中的条目不能被淘汰')
  assert.equal(getPhotoInfo('p1'), null, '最久未使用的那条应被淘汰')
  assert.deepEqual(getPhotoInfo('new'), { n: -1 })

  assert.equal(getPhotoInfo('不存在'), null)
  clearPhotoInfo()
  assert.equal(photoInfoCacheSize(), 0)
})

test('换号清空：模块加载时已登记到用户级清理表', async () => {
  const cache = await import(CACHE_MODULE)
  const userScoped = await import(USER_SCOPED)
  cache.clearPhotoInfo()
  cache.setPhotoInfo('a', { n: 1 })
  assert.equal(cache.photoInfoCacheSize(), 1)

  userScoped.resetUserScopedCaches()
  assert.equal(cache.photoInfoCacheSize(), 0, '登出/换号必须清空照片信息缓存')
})

test('接线：AlbumView 不再自带无上限 Map，读写与卸载都走模块', () => {
  const view = read('student-frontend/src/views/AlbumView.vue')
  assert.match(view, /from '\.\.\/utils\/photoInfoCache\.js'/)
  assert.match(view, /getPhotoInfo\(p\.id\)/)
  assert.match(view, /setPhotoInfo\(p\.id, res\.data\.data\)/)
  assert.match(view, /clearPhotoInfo\(\)/)
  assert.doesNotMatch(view, /const infoCache = new Map\(\)/)
})
