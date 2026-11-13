// =========================================================================
// search-paging.test.js —— 全局搜索「第 13 条起静默消失」的根治验证
//                          （P3-08 / Q1-02，§4-5）
//
// 根因不是「12 太小」而是没有分页；把上限放大到 200 只是把天花板往外挪。
// 这里断言的是 **LIMIT ? OFFSET ? 真的翻页**、**hasMore 由多取的一条精确判定**、
// **前端按页追加**，以及内存型数据源（课表/座位/值日 JSON）同样按页切。
//
// 手法：真 Express router + 真 HTTP，只把 ../db 换成按 offset 返回不同行区间的假库
// （不碰磁盘）；拼音库换成可控桩，才能稳定验证多词时每个词各自拿到 OR 分支。
// 只测纯函数会假绿 —— 调用点没接线照样全绿，所以后面另有源码接线判据。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const express = backendRequire('express')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const { LIMITS, clampInt, resolveSearchLimits, clipPage, windowOf } = require('../../student-backend/services/searchLimits.js')

// —— 依赖桩：必须在 require 路由之前 ——
const dbPath = require.resolve(path.join(ROOT, 'student-backend/db.js'))
const state = { calls: [], rowCount: 250, values: ['张三', '李四'], scheduleHits: false }
const fakeDb = {
  prepare(sql) {
    return {
      all: (...params) => {
        state.calls.push({ sql, params })
        if (/SELECT DISTINCT/i.test(sql)) return state.values.map(v => ({ v }))
        if (/FROM students WHERE/i.test(sql) && /LIMIT \? OFFSET \?/i.test(sql)) {
          const limit = Number(params[params.length - 2])
          const offset = Number(params[params.length - 1])
          const n = Math.max(0, Math.min(state.rowCount - offset, limit))
          return Array.from({ length: n }, (_, i) => ({ id: offset + i + 1, '姓名': '张三' + (offset + i + 1) }))
        }
        return []
      },
      get: (...params) => {
        state.calls.push({ sql, params })
        // 内存型源：6 行 × 5 列、每格都命中「张三」，共 30 条，够翻 3 页。
        if (state.scheduleHits && /FROM (schedule|master_schedule) WHERE id = 1/i.test(sql)) {
          const cells = Array.from({ length: 6 }, () => Array.from({ length: 5 }, () => ({ course: '张三' })))
          return { cells, settings: {} }
        }
        return null
      },
    }
  },
}
const originalDbModule = require.cache[dbPath]
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: { db: fakeDb } }

const pmPath = backendRequire.resolve('pinyin-match')
const originalPmModule = require.cache[pmPath]
require.cache[pmPath] = {
  id: pmPath, filename: pmPath, loaded: true,
  exports: { match: (value, q) => (value === '张三' && q === 'zs') || (value === '李四' && q === 'ls') },
}

const searchRouter = require('../../student-backend/routes/search.js')

const app = express()
app.use('/api/search', searchRouter)
let server
let base

test.before(async () => {
  server = app.listen(0, '127.0.0.1')
  await new Promise(r => server.once('listening', r))
  base = `http://127.0.0.1:${server.address().port}`
})
test.after(async () => {
  await new Promise(r => server.close(r))
  // 恢复 require.cache：本文件若与其它单测同进程跑，不能把假库/假拼音留给别人
  if (originalDbModule) require.cache[dbPath] = originalDbModule
  else delete require.cache[dbPath]
  if (originalPmModule) require.cache[pmPath] = originalPmModule
  else delete require.cache[pmPath]
})

async function search(query, opts = {}) {
  state.calls = []
  state.rowCount = opts.rowCount ?? 250
  state.values = ['张三', '李四']
  state.scheduleHits = !!opts.scheduleHits
  const params = new URLSearchParams(query)
  const res = await fetch(`${base}/api/search?${params}`)
  return { status: res.status, body: await res.json() }
}

const studentQuery = () => state.calls.find(c => /FROM students WHERE/i.test(c.sql) && /LIMIT \? OFFSET \?/i.test(c.sql))
const distinctQuery = () => state.calls.find(c => /SELECT DISTINCT/i.test(c.sql))
const scheduleGroups = (body) => body.groups.filter(g => g.table === 'schedule' || g.table === 'master_schedule')

// —— 分页解析（纯函数）——

test('默认第 0 页：固定 12 条、多取 1 条判 hasMore、offset=0', () => {
  assert.deepEqual(resolveSearchLimits({}), {
    page: 0, perGroup: 12, offset: 0, probeLimit: 13, maxTerms: 12, pinyinValues: 400,
  })
  assert.equal(LIMITS.PAGE_SIZE, 12)
  assert.equal(LIMITS.MAX_PAGE, 1000)
  assert.equal(LIMITS.HARD_MAX_TERMS, 20)
  assert.equal(LIMITS.MAX_PINYIN_VALUES, 5000)
})

test('page 换算成 offset，脏参数一律夹回安全区间', () => {
  assert.deepEqual(
    [resolveSearchLimits({ page: '3' }).page, resolveSearchLimits({ page: '3' }).offset],
    [3, 36],
  )
  assert.equal(resolveSearchLimits({ page: -3 }).page, 0)
  assert.equal(resolveSearchLimits({ page: 'abc' }).page, 0)
  assert.equal(resolveSearchLimits({ page: { a: 1 } }).page, 0)
  assert.equal(resolveSearchLimits({ page: 99999 }).page, 1000)
  assert.equal(resolveSearchLimits({ maxTerms: 999 }).maxTerms, 20)
  assert.equal(resolveSearchLimits({ pinyinValues: 999999 }).pinyinValues, 5000)
})

test('页大小不可被请求放大 —— 防止退回「调阈值」那条补丁路', () => {
  const l = resolveSearchLimits({ perGroup: 9999 })
  assert.equal(l.perGroup, 12)
  assert.equal(l.probeLimit, 13)
  const src = read('student-backend/services/searchLimits.js')
  assert.ok(!/query\.perGroup|MAX_PER_GROUP|DEFAULT_PER_GROUP/.test(src), '又出现可放大的每组上限')
})

test('clampInt 只收安全的整数（NaN / 数组 / 对象回默认）', () => {
  assert.equal(clampInt('7', 12, 1, 20), 7)
  assert.equal(clampInt(undefined, 12, 1, 20), 12)
  assert.equal(clampInt(NaN, 12, 1, 20), 12)
  assert.equal(clampInt([1], 12, 1, 20), 12)
  assert.equal(clampInt({}, 12, 1, 20), 12)
  assert.equal(clampInt(99, 12, 1, 20), 20)
})

test('clipPage 多出一条才置 hasMore，并且只回一页', () => {
  const l = resolveSearchLimits({})
  const s1 = { hasMore: false }
  assert.equal(clipPage(Array.from({ length: 12 }, (_, i) => i), l, s1).length, 12)
  assert.equal(s1.hasMore, false, '恰好一页不能谎报还有下一页')
  const s2 = { hasMore: false }
  assert.equal(clipPage(Array.from({ length: 13 }, (_, i) => i), l, s2).length, 12)
  assert.equal(s2.hasMore, true)
  assert.deepEqual(clipPage(null, l, { hasMore: false }), [])
})

test('windowOf 给内存型源切出与 SQL 相同的页窗口', () => {
  const l = resolveSearchLimits({ page: 2 })
  const all = Array.from({ length: 40 }, (_, i) => i)
  assert.deepEqual(windowOf(all, l), [24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36])
  assert.deepEqual(windowOf(null, l), [])
})

// —— 真 HTTP：SQL 源确实在翻页 ——

test('第 0 页 12 条、SQL 带 LIMIT 13 OFFSET 0、hasMore=true', async () => {
  const { body } = await search({ q: '张三' })
  assert.equal(body.meta.page, 0)
  assert.equal(body.meta.perGroup, 12)
  assert.equal(body.meta.hasMore, true)
  const g = body.groups.find(x => x.table === 'students')
  assert.equal(g.items.length, 12)
  assert.equal(g.items[0].id, 1)
  assert.equal(studentQuery().params.at(-2), 13, '多取一条才能精确判 hasMore')
  assert.equal(studentQuery().params.at(-1), 0)
})

test('第 1 页从第 13 条开始，与第 0 页不重叠', async () => {
  const { body } = await search({ q: '张三', page: 1 })
  assert.equal(body.meta.page, 1)
  const g = body.groups.find(x => x.table === 'students')
  assert.equal(g.items.length, 12)
  assert.equal(g.items[0].id, 13)
  assert.equal(studentQuery().params.at(-2), 13)
  assert.equal(studentQuery().params.at(-1), 12)
  assert.equal(body.meta.hasMore, true)
})

test('最后一页没有多余一条时 hasMore=false，按钮自然消失', async () => {
  const { body } = await search({ q: '张三', page: 1 }, { rowCount: 24 })
  assert.equal(body.groups.find(x => x.table === 'students').items.length, 12)
  assert.equal(body.meta.hasMore, false)
  assert.equal(studentQuery().params.at(-1), 12)
})

test('结果不足一页时不谎报还有下一页', async () => {
  const { body } = await search({ q: '张三' }, { rowCount: 3 })
  assert.equal(body.groups.find(x => x.table === 'students').items.length, 3)
  assert.equal(body.meta.hasMore, false)
})

test('请求里的 perGroup 被忽略：不再靠放大上限取更多', async () => {
  const { body } = await search({ q: '张三', perGroup: 9999 })
  assert.equal(body.meta.perGroup, 12)
  assert.equal(body.groups.find(x => x.table === 'students').items.length, 12)
  assert.equal(studentQuery().params.at(-2), 13)
  assert.equal(studentQuery().params.at(-1), 0)
})

// —— 真 HTTP：内存型 JSON 源也必须按页切（只测 SQL 会假绿）——

test('课表 JSON 源：0/1/2 页各自拿到不重叠的 12/12/6 条', async () => {
  const p0 = await search({ q: '张三' }, { rowCount: 0, scheduleHits: true })
  assert.equal(scheduleGroups(p0.body).length, 2)
  assert.ok(scheduleGroups(p0.body).every(g => g.items.length === 12))
  assert.equal(scheduleGroups(p0.body)[0].items[0].id, '0:0')
  assert.equal(p0.body.meta.hasMore, true)

  const p1 = await search({ q: '张三', page: 1 }, { rowCount: 0, scheduleHits: true })
  assert.ok(scheduleGroups(p1.body).every(g => g.items.length === 12))
  assert.equal(scheduleGroups(p1.body)[0].items[0].id, '2:2', 'offset=12 应从第 13 个命中格开始')

  const p2 = await search({ q: '张三', page: 2 }, { rowCount: 0, scheduleHits: true })
  assert.ok(scheduleGroups(p2.body).every(g => g.items.length === 6))
  assert.equal(p2.body.meta.hasMore, false)
})

// —— 阈值与多词拼音（上一批已闭合，这里防回归）——

test('第 6 个及以后的关键词不再被静默丢弃', async () => {
  const one = await search({ q: '甲' })
  const baseLikes = (studentQuery().sql.match(/LIKE \?/g) || []).length
  assert.ok(baseLikes > 0)
  const many = await search({ q: '甲 乙 丙 丁 戊 己 庚 辛' })
  const likes = (studentQuery().sql.match(/LIKE \?/g) || []).length
  assert.equal(likes, baseLikes * 8, '8 个词都要进 WHERE（旧实现只留 5 个）')
  assert.equal(many.body.meta.perGroup, 12)
  assert.ok(one.body.groups.length > 0)
})

test('pinyinValues 可放宽且受硬上限约束', async () => {
  await search({ q: 'zs', pinyinValues: 0 })
  assert.equal(distinctQuery().params.at(-1), 1)
  await search({ q: 'zs', pinyinValues: 2500 })
  assert.equal(distinctQuery().params.at(-1), 2500)
  await search({ q: 'zs', pinyinValues: 999999 })
  assert.equal(distinctQuery().params.at(-1), 5000)
})

test('多词纯字母：每个词各自拿到拼音 IN 分支，词间仍是 AND', async () => {
  const { body } = await search({ q: 'zs ls' })
  const sql = studentQuery().sql
  assert.equal((sql.match(/IN \(/g) || []).length, 2, '两个字母词各有一个拼音分支')
  assert.ok(sql.includes(') AND ('), '词与词之间必须还是 AND')
  assert.match(sql, /OR "姓名" IN \(\?\)\) AND \(/, '第一个拼音分支必须收在词内，后面还有第二个词')
  assert.ok(!/\)\) OR "姓名" IN \(/.test(sql), '不能退回「整条 WHERE 再 OR 一次拼音」的旧写法')
  assert.ok(studentQuery().params.includes('张三'))
  assert.ok(studentQuery().params.includes('李四'))
  assert.ok(body.groups.length > 0)
})

test('中英混合词：只有字母词走拼音，中文词仍按 LIKE 限定', async () => {
  await search({ q: 'zs 张三' })
  const sql = studentQuery().sql
  assert.equal((sql.match(/IN \(/g) || []).length, 1)
  assert.ok(sql.includes(') AND ('))
  assert.ok(studentQuery().params.includes('张三'))
})

// —— 接线源码判据（防「纯函数全绿但调用点没接」）——

test('接线：后端每个结果源都走分页，SQL 与内存 JSON 都不例外', () => {
  const src = read('student-backend/services/searchQuery.js').replace(/^[ \t]*\/\/.*$/gm, '')
  assert.ok(!/const (PER_GROUP|MAX_TERMS|PINYIN_VALUES)\s*=/.test(src), '又冒出硬编码常量')
  assert.match(src, /resolveSearchLimits, clipPage, windowOf/)
  assert.match(src, /const limits = resolveSearchLimits\(query\)/)
  assert.equal((src.match(/LIMIT \? OFFSET \?/g) || []).length, 4, '四个 SQL 源都要 OFFSET')
  assert.equal((src.match(/clipPage\(/g) || []).length, 8, '八个结果源都要裁成一页')
  assert.equal((src.match(/windowOf\(/g) || []).length, 4, '四个内存型源都要按页取窗口')
  assert.equal((src.match(/const collectUpTo = limits\.offset \+ limits\.probeLimit/g) || []).length, 4)
  assert.match(src, /meta\.hasMore = pageState\.hasMore/)
  assert.match(src, /return \{ groups, meta \}/)
  assert.ok(!/truncated|maxPerGroup/.test(src), '不能退回「放大上限重查」那条路')
  assert.match(src, /splitTerms\(q, limits\.maxTerms\)/)
  assert.match(src, /primaryValues\(src\.table, src\.primary, limits\.pinyinValues\)/)
  assert.match(src, /const pm = terms\.some\(t => \/\^\[a-z\]\+\$\/i\.test\(t\.text\)\)/, '多词也要启用拼音匹配器')
  assert.match(src, /function pinyinAlternatives\(/)
  assert.match(src, /pm && \/\^\[a-z\]\+\$\/i\.test\(q\)/, 'nameHit 必须按词判断，中文词不该进拼音匹配器')

  // M12-B5：路由只剩 HTTP 形状，查询实现下沉到 service（SQL 不许回到路由层）
  const routeSrc = read('student-backend/routes/search.js')
  assert.match(routeSrc, /runSearch\(req\.query\)/)
  assert.ok(!/db\.prepare\(/.test(routeSrc), 'search 路由不许再有裸 SQL')
})

test('接线：前端按页追加，不再放大上限重查', () => {
  const s = read('student-frontend/src/components/base/SearchDialog.vue')
  assert.match(s, /params: \{ q, page \}/)
  assert.match(s, /append \? remoteResults\.value\.concat\(incoming\) : incoming/)
  assert.match(s, /remoteHasMore\.value = !!\(meta && meta\.hasMore\)/)
  assert.match(s, /remotePage\.value \+= 1/)
  assert.match(s, /fetchRemoteSearch\(q, remotePage\.value, true\)/)
  assert.equal((s.match(/remotePage\.value = 0/g) || []).length, 2, '清空关键字与换关键字两处都要回第一页')
  assert.match(s, /v-if="remoteHasMore &&/)
  assert.match(s, /@click="showMoreRemote"/)
  assert.match(s, /scheduleRemote\.cancel\(\)/)
  assert.ok(!/remotePerGroup|remoteTruncated|maxPerGroup|perGroup/.test(s), '前端不该再复制页大小或放大上限')
})
