// =========================================================================
// slug-scopes.test.js —— 「按库隔离的进程内状态」底座行为契约（审查 v4 · P2）
//
// 根因：各库的 album_photos.id 独立自增。任何裸 id 全局 Map / 一份全局攒批数组
// 都会让两个库塌缩：同号互相覆盖、删错库、整批挂错 slug（串图）。
// 这里钉住 utils/slugScopes.js 的不变量，静态接线由 probe/slug-scope-probe.cjs 守。
//
// 跑法：node --test testjs/units/slug-scopes.test.js
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')

const ROOT = path.join(__dirname, '..', '..')
const scopes = require(path.join(ROOT, 'student-backend', 'utils', 'slugScopes.js'))

test('分桶：两个库同号 id 互不覆盖，totalSize 是各桶之和', () => {
  const pending = scopes.createSlugBuckets(() => new Map())
  pending.forSlug('@aaa').set(5, 'A 的转交时刻')
  pending.forSlug('@bbb').set(5, 'B 的转交时刻')

  assert.equal(pending.forSlug('@aaa').get(5), 'A 的转交时刻')
  assert.equal(pending.forSlug('@bbb').get(5), 'B 的转交时刻')
  assert.equal(pending.totalSize(), 2, '裸 Map 实现在这里只会得到 1（塌缩）')

  pending.forSlug('@aaa').delete(5)
  assert.equal(pending.forSlug('@bbb').get(5), 'B 的转交时刻', '删 A 不能连带删掉 B')
})

test('peek 只看不建桶；clearSlug 只清该库；clearAllForSlug 清所有登记者', () => {
  const a = scopes.createSlugBuckets(() => new Set())
  const b = scopes.createSlugBuckets(() => new Map())
  a.forSlug('@x').add(1)
  b.forSlug('@x').set(1, 'v')

  assert.equal(a.peek('@never'), undefined)
  assert.equal(a.size(), 1, 'peek 不应该凭空造出一个空桶')

  scopes.clearAllForSlug('@x')
  assert.equal(a.forSlug('@x').size, 0)
  assert.equal(b.forSlug('@x').size, 0)
  assert.equal(scopes.safeSlug('@x'), '@x')
})

test('攒批：交错 push 后 flush(A) 只发 A 的条目，且不借用调用时的 slug', () => {
  const sent = []
  const batch = scopes.createSlugBatch({ limit: 50, flush: (slug, entries) => sent.push({ slug, entries }) })

  batch.push('@a', ['a1'])
  batch.push('@b', ['b1'])
  batch.push('@a', ['a2'])
  batch.flush('@a')                       // 模拟「B 库的扫描 onProgress」触发 A 的攒批

  assert.equal(sent.length, 1)
  assert.equal(sent[0].slug, '@a', 'flush 的 slug 必须来自条目入桶时的库')
  assert.deepEqual(sent[0].entries, [['a1'], ['a2']], '旧实现会把 b1 一起挂到 @a 名下')
  assert.equal(batch.pendingSize(), 1, 'B 库攒的条目不能被 A 的 flush 带走')

  batch.flushAll()
  assert.equal(sent.length, 2)
  assert.equal(sent[1].slug, '@b')
  assert.deepEqual(sent[1].entries, [['b1']])
  assert.equal(batch.pendingSize(), 0)
})

test('攒批：达到 limit 自动发自己库的桶；flush 抛错也不残留', () => {
  const sent = []
  const batch = scopes.createSlugBatch({
    limit: 2,
    flush: (slug, entries) => { sent.push({ slug, entries }); throw new Error('IPC 断了') },
  })
  batch.push('@a', 1)
  batch.push('@b', 2)
  batch.push('@a', 3)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].slug, '@a')
  assert.deepEqual(sent[0].entries, [1, 3])
  assert.equal(batch.pendingSize(), 1, '发送失败不能把条目留在桶里等下一个库带走')
  batch.flushAll()
  assert.equal(sent[1].slug, '@b')
  assert.equal(batch.pendingSize(), 0)
})

test('登出清桶后，该库待生成条目不再占配额；其它库不受影响', () => {
  const pending = scopes.createSlugBuckets(() => new Map())
  pending.forSlug('@gone').set(7, Date.now())
  pending.forSlug('@stay').set(7, Date.now())
  assert.equal(pending.totalSize(), 2)

  scopes.clearAllForSlug('@gone')
  assert.equal(pending.peek('@gone'), undefined)
  assert.equal(pending.totalSize(), 1)
  assert.equal(pending.forSlug('@stay').get(7) > 0, true)
})

test('safeSlug：非法值兜底 default，且归一化幂等', () => {
  assert.equal(scopes.safeSlug('@c7e1f503baaf'), '@c7e1f503baaf')
  assert.equal(scopes.safeSlug('../escape'), 'default')
  assert.equal(scopes.safeSlug(''), 'default')
  assert.equal(scopes.safeSlug(scopes.safeSlug('@ok')), '@ok')
  assert.ok(scopes._registeredCount() >= 2, '底座必须把分桶状态登记进统一清理表')
})
