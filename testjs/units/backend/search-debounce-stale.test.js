// =========================================================================
// search-debounce-stale.test.js —— 防抖窗口里旧词的结果不许落地（v7 §5-9 / #28）
//
// 原缺陷：remoteSeq.begin() 在 fetchRemoteSearch 里才取号，而新关键字要先等 250ms
// 防抖才发请求。这段窗口里上一次请求回来，序号仍是「当前」→ 旧词结果被写进
// remoteResults，用户先看到旧结果再被换成新结果（同实例、同弹窗，闪一下旧内容）。
//
// 修法：scheduleRemoteSearch 在排期前 remoteSeq.invalidate() + abortRemote()。
// 判据：把真实的 scheduleRemoteSearch / abortRemote / fetchRemoteSearch 抽出来跑，
// 用可控 debounce 与可控 axios 复现「旧请求在防抖窗口里回来」的时序。
// =========================================================================
const test = require('node:test')
const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createLatest } = require('../../../student-frontend/src/utils/latestOnly.js')

const VUE = 'student-frontend/src/components/base/SearchDialog.vue'

// 用真实函数体搭一个「模块作用域」：ref 用最小替身，debounce 与 axios 全部可控
function build(src) {
  const scope = `
    let lastRemoteQ = ''
    let remoteAbort = null
    const remoteSeq = createLatest()
    const pending = []
    const scheduleRemote = (fn, ms) => { pending.push({ fn, ms }); const s = () => { pending.length = 0; fn() }; s.cancel = () => { pending.length = 0 }; return s }
    const getRemoteAbort = () => remoteAbort
${extractFunctionDecl(src, 'abortRemote')}
${extractFunctionDecl(src, 'scheduleRemoteSearch')}
${extractFunctionDecl(src, 'fetchRemoteSearch')}
    return {
      scheduleRemoteSearch, fetchRemoteSearch,
      flush: () => { const p = pending.splice(0); p.forEach(x => x.fn()) },
      state: () => ({
        results: remoteResults.value,
        searching: remoteSearching.value,
        lastQ: lastRemoteQ,
        aborted: !!(getRemoteAbort() && getRemoteAbort().signal.aborted),
      }),
    }
  `
  const keyword = { value: '' }
  const remoteResults = { value: [] }
  const remoteSearching = { value: false }
  const remotePage = { value: 0 }
  const remoteHasMore = { value: false }
  // 截断提示状态（词数超限/拼音候选降级）：行为本身不参与防抖判定，但被赋值时必须存在
  const remoteTruncated = { value: { terms: false, used: 0, total: 0, pinyin: false } }
  const calls = []
  const deferreds = []
  const axios = {
    get(url, cfg) {
      let resolve, reject
      const promise = new Promise((res, rej) => { resolve = res; reject = rej })
      const d = { url, cfg, resolve, reject, promise }
      deferreds.push(d)
      calls.push(cfg.params)
      return promise
    },
  }
  const factory = new Function(
    'keyword', 'remoteResults', 'remoteSearching', 'remotePage', 'remoteHasMore', 'remoteTruncated',
    'axios', 'REMOTE_SOURCE', 'buildRemoteResults', 'createLatest',
    scope,
  )
  const api = factory(
    keyword, remoteResults, remoteSearching, remotePage, remoteHasMore, remoteTruncated,
    axios, { endpoint: '/api/search' }, (groups) => (groups ? groups.flat() : []), createLatest,
  )
  // 信号在 fetchRemoteSearch 里创建，abortRemote() 之后会把 remoteAbort 置空，
  // 所以「有没有被掐掉」要读请求自己拿到的 signal，而不是问模块变量。
  const aborted = () => deferreds.map(d => !!(d.cfg.signal && d.cfg.signal.aborted))
  return { api, keyword, remoteResults, remoteSearching, deferreds, calls, aborted }
}

const src = fs.readFileSync(abs(VUE), 'utf8')
const tick = () => new Promise(r => setTimeout(r, 0))

test('行为：防抖期间旧词的响应回来也不能覆盖当前结果', async () => {
  const env = build(src)
  // 第一轮：输入 a，防抖结束 → 请求 A 在途
  env.keyword.value = 'a'
  env.api.scheduleRemoteSearch()
  env.api.flush()
  assert.equal(env.deferreds.length, 1, '第一轮请求应已发出')

  // 用户继续输入 ab：防抖窗口开始，此刻请求 A 仍在途
  env.keyword.value = 'ab'
  env.api.scheduleRemoteSearch()
  assert.equal(env.aborted()[0], true, '应当在排期时就掐掉在途请求（不是等 250ms 后）')

  // 请求 A 回来 —— 它的结果属于旧词，不许落地
  env.deferreds[0].resolve({ data: { groups: [['旧词结果']], meta: { hasMore: false } } })
  await tick()
  assert.deepEqual(env.remoteResults.value, [], '旧词结果被写进了当前列表')
})

test('行为：正常一轮检索仍然回填结果', async () => {
  const env = build(src)
  env.keyword.value = '张三'
  env.api.scheduleRemoteSearch()
  env.api.flush()
  env.deferreds[0].resolve({ data: { groups: [['张三', '学号 1']], meta: { hasMore: true } } })
  await tick()
  assert.deepEqual(env.remoteResults.value, ['张三', '学号 1'])
  assert.equal(env.remoteSearching.value, false)
})

test('行为：清空关键字仍然作废在途请求', () => {
  const env = build(src)
  env.keyword.value = 'x'
  env.api.scheduleRemoteSearch()
  env.api.flush()
  env.keyword.value = ''
  env.api.scheduleRemoteSearch()
  assert.deepEqual(env.remoteResults.value, [])
  assert.equal(env.aborted()[0], true)
})

test('接线：排期前作废序号并中止在途', () => {
  const body = extractFunctionDecl(src, 'scheduleRemoteSearch')
  const idxInvalidate = body.indexOf('remoteSeq.invalidate()')
  const idxSchedule = body.indexOf('scheduleRemote(() => fetchRemoteSearch(q), 250)')
  assert.ok(idxInvalidate > 0, 'scheduleRemoteSearch 没作废旧序号')
  assert.ok(idxInvalidate < idxSchedule, '作废必须发生在排期之前')
  assert.match(body.slice(idxInvalidate, idxSchedule), /abortRemote\(\)/, '排期前要掐掉在途请求')
})

test('变异反证：去掉作废后旧结果照样落地', async () => {
  const mutated = src.replace(
    /remoteSeq\.invalidate\(\)\s+abortRemote\(\)\s+scheduleRemote\(\(\) => fetchRemoteSearch\(q\), 250\)/,
    'scheduleRemote(() => fetchRemoteSearch(q), 250)',
  )
  assert.ok(mutated !== src, '变异没匹配到作废语句')
  const env = build(mutated)
  env.keyword.value = 'a'
  env.api.scheduleRemoteSearch()
  env.api.flush()
  env.keyword.value = 'ab'
  env.api.scheduleRemoteSearch()
  env.deferreds[0].resolve({ data: { groups: [['旧词结果']], meta: { hasMore: false } } })
  await tick()
  assert.deepEqual(env.remoteResults.value, ['旧词结果'], '变异后旧结果会落地（判据有效）')
})
