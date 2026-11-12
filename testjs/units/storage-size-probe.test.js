// =========================================================================
// storage-size-probe.test.js —— 目录 / 日志体积探针（v6 性能专题 · 0-5）
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const { inspectStorage, dirSize, runSelftest } = require('../probe/storage-size-probe.cjs')

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'storage-size-unit-'))
  const dataDir = path.join(root, 'data')
  fs.mkdirSync(path.join(dataDir, 'uploads', 'deep'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'uploads', 'a.bin'), Buffer.alloc(100))
  fs.writeFileSync(path.join(dataDir, 'uploads', 'deep', 'b.bin'), Buffer.alloc(200))
  fs.writeFileSync(path.join(dataDir, 'backend.log'), Buffer.alloc(50))
  fs.writeFileSync(path.join(dataDir, 'inp.log'), Buffer.alloc(25))
  fs.writeFileSync(path.join(root, 'startup.log'), Buffer.alloc(10))
  fs.writeFileSync(path.join(root, 'desktop-layer.log'), Buffer.alloc(5))
  return { root, dataDir }
}

test('目录体积按文件累加，嵌套子目录不能漏', () => {
  const { root, dataDir } = makeTree()
  try {
    const s = dirSize(path.join(dataDir, 'uploads'))
    assert.equal(s.bytes, 300)
    assert.equal(s.files, 2)
    assert.equal(s.missing, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('不存在的目录标记 missing，不能伪装成空目录', () => {
  const { root, dataDir } = makeTree()
  try {
    const r = inspectStorage({ dataDir })
    const trash = r.dirs.find((d) => d.name === 'album-trash')
    assert.equal(trash.missing, true)
    assert.equal(trash.bytes, 0)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('日志按 data / userData 两个根分别统计，合计一致', () => {
  const { root, dataDir } = makeTree()
  try {
    const r = inspectStorage({ dataDir })
    assert.equal(r.logBytes, 90, 'backend 50 + inp 25 + startup 10 + desktop 5')
    assert.equal(r.dirBytes, 300, 'uploads 是唯一存在的目录')
    assert.equal(r.totalBytes, 390)
    const byName = Object.fromEntries(r.logs.map((l) => [l.name, l.bytes]))
    assert.equal(byName['backend.log'], 50)
    assert.equal(byName['startup.log'], 10)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('自证脚本能跑通（两级目录 + 多日志）', () => {
  const r = runSelftest()
  assert.equal(r.dirBytes, 300)
  assert.equal(r.logBytes, 85)
})
