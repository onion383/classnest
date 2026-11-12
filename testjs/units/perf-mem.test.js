// =========================================================================
// perf-mem.test.js —— 导出内存峰值探针（v6 性能专题 · 0-5）
//
// 验收点：默认零开销（snapshot 返回 null、不产出日志）；PERF_EXPORT=1 时才采样并打差值；
// 导出路由必须在 finally 里记录，成功/失败都能留下一条。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const perfMem = require('../../student-backend/services/perfMem')

function captureLog(fn) {
  const lines = []
  const orig = console.log
  console.log = (...args) => { lines.push(args.join(' ')) }
  try { fn() } finally { console.log = orig }
  return lines
}

test('默认关闭：snapshot 返回 null，log 空操作且不打日志', () => {
  delete process.env.PERF_EXPORT
  assert.equal(perfMem.memSnapshot(), null)
  const lines = captureLog(() => {
    assert.equal(perfMem.logExportMemory('zip 完成', { rss: 1 }), null)
  })
  assert.equal(lines.length, 0)
})

test('PERF_EXPORT=1：能采到字节数并打出三项差值', () => {
  process.env.PERF_EXPORT = '1'
  try {
    const before = perfMem.memSnapshot()
    assert.ok(before)
    for (const key of ['rss', 'heapUsed', 'external']) {
      assert.equal(typeof before[key], 'number')
    }
    // 制造一点可观测的分配，不依赖 GC 一定回收
    const hold = Buffer.alloc(1024 * 1024)
    let delta = null
    const lines = captureLog(() => { delta = perfMem.logExportMemory('zip 完成', before) })
    assert.ok(delta)
    for (const key of ['rssMB', 'heapMB', 'externalMB']) {
      assert.equal(typeof delta[key], 'number')
    }
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^\[perf\] 导出内存 zip 完成 rss .+heap .+external /)
    assert.ok(hold.length === 1024 * 1024)
  } finally {
    delete process.env.PERF_EXPORT
  }
})

test('没有 before 时不采样（失败路径不会凭空打一条 0 差值）', () => {
  process.env.PERF_EXPORT = '1'
  try {
    const lines = captureLog(() => {
      assert.equal(perfMem.logExportMemory('zip 失败', null), null)
    })
    assert.equal(lines.length, 0)
  } finally {
    delete process.env.PERF_EXPORT
  }
})

test('接线：导出路由在 finally 里记录，成功/失败都留痕', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../student-backend/routes/dataExport.js'), 'utf8')
  assert.match(src, /require\('\.\.\/services\/perfMem'\)/)
  assert.match(src, /const memBefore = memSnapshot\(\)/)
  assert.match(src, /finally \{[\s\S]{0,120}logExportMemory\(finished \? 'zip 完成' : 'zip 失败', memBefore\)/)
})
