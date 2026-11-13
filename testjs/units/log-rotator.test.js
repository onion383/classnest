// =========================================================================
// log-rotator.test.js —— 日志体积收口（v6 性能专题 · 1-1）
//
// 验收点：
//   ① rotateIfNeeded：不存在/未超限不动，超限只留尾部且带提示行，不把整份读进内存；
//   ② appendWithRotation：自动建目录、同一文件串行追加（不乱序、不丢行）、超限前先截断；
//   ③ 接线：backend.log 建流/截断全程异步（不再有 startBackend 路径上的同步 IO），
//      inp.log / desktop-layer.log 走同一轮转出口，运行期有低频巡检。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const MAIN = path.join(__dirname, '../../electron/main')
const read = (rel) => fs.readFileSync(path.join(MAIN, rel), 'utf8')
const { rotateIfNeeded, appendWithRotation, clearLogFile, NOTICE } = require(path.join(MAIN, 'main.logRotator.js'))

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cn-logrot-'))
}

test('rotateIfNeeded：文件不存在 / 未超限都不动，超限只留最近尾部', async () => {
  const dir = tmpDir()
  const file = path.join(dir, 'app.log')

  assert.equal(await rotateIfNeeded(file), false, '文件不存在应静默返回 false')

  fs.writeFileSync(file, 'small')
  assert.equal(await rotateIfNeeded(file, { maxBytes: 1024, keepBytes: 512 }), false)
  assert.equal(fs.readFileSync(file, 'utf8'), 'small', '未超限不得改动内容')

  // 造 4KB，尾段用可辨识的内容，确认保留的是「最近」的那部分
  const lines = []
  for (let i = 0; i < 400; i++) lines.push(`line-${String(i).padStart(3, '0')}-xxxxxxxx`)
  fs.writeFileSync(file, lines.join('\n'))
  const before = fs.statSync(file).size
  assert.ok(before > 4096)

  assert.equal(await rotateIfNeeded(file, { maxBytes: 2048, keepBytes: 1024 }), true)
  const after = fs.readFileSync(file, 'utf8')
  assert.ok(after.startsWith(NOTICE), '截断后应以提示行开头')
  assert.ok(after.endsWith('line-399-xxxxxxxx'), '必须保留最新的尾部')
  assert.ok(after.length < before, '截断后必须更小')
  assert.ok(Buffer.byteLength(after) <= 1024 + Buffer.byteLength(NOTICE) + 4)

  fs.rmSync(dir, { recursive: true, force: true })
})

test('appendWithRotation：建目录、串行追加、超限回收', async () => {
  const dir = tmpDir()
  const file = path.join(dir, 'nested', 'deep', 'inp.log')

  // 并发发起多笔追加：必须按调用顺序落盘，且目录自动创建
  const tasks = []
  for (let i = 0; i < 20; i++) {
    tasks.push(appendWithRotation(file, `row-${String(i).padStart(2, '0')}-yyyyyyyyyyyy\n`, { maxBytes: 4096, keepBytes: 1024 }))
  }
  await Promise.all(tasks)

  const text = fs.readFileSync(file, 'utf8')
  const rows = text.split('\n').filter((l) => l.startsWith('row-'))
  assert.deepEqual(rows, Array.from({ length: 20 }, (_, i) => `row-${String(i).padStart(2, '0')}-yyyyyyyyyyyy`),
    '串行链必须保证 20 行完整且顺序不乱')

  // 继续写到超限：最后一次写入后文件仍应受 keepBytes 约束
  for (let i = 0; i < 400; i++) {
    await appendWithRotation(file, `big-${i}-zzzzzzzzzzzzzzzzzzzz\n`, { maxBytes: 4096, keepBytes: 1024 })
  }
  const finalSize = fs.statSync(file).size
  assert.ok(finalSize <= 4096 + 64, `轮转后应受上限约束，实际 ${finalSize}`)
  assert.ok(fs.readFileSync(file, 'utf8').includes('big-399'), '最新一行必须在')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('clearLogFile：截断为 0，且与追加共用串行链（清完不会被排队中的旧行写回）', async () => {
  const dir = tmpDir()
  const file = path.join(dir, 'backend.log')
  fs.writeFileSync(file, 'a'.repeat(1024))

  // 先排一笔追加、再排清空：清空必须排在追加之后，最终体积才是 0
  const queued = appendWithRotation(file, 'queued-line\n')
  const cleared = clearLogFile(file)
  await Promise.all([queued, cleared])
  assert.equal(fs.statSync(file).size, 0, '清空必须落在排队写入之后')

  // 清完继续写：从 0 开始追加，不报错也不残留旧内容
  await appendWithRotation(file, 'after\n')
  assert.equal(fs.readFileSync(file, 'utf8'), 'after\n')

  // 文件不存在也不能抛（清理时可能刚好被外部删掉）
  await clearLogFile(path.join(dir, 'nope.log'))

  fs.rmSync(dir, { recursive: true, force: true })
})

test('接线：backend.log 全程异步、四个出口共用轮转器、运行期有低频巡检', () => {
  const backend = read('main.backend.js')
  assert.match(backend, /require\('\.\/main\.logRotator'\)/)
  // 关键判据：启动路径上不再出现同步读写日志文件
  assert.doesNotMatch(backend, /fs\.appendFileSync/, 'backend.log 的启动横幅不得再同步追加')
  assert.doesNotMatch(backend, /readFileSync\(logPath/, '截断不得整份读进内存')
  assert.match(backend, /await fs\.promises\.mkdir/)
  assert.match(backend, /rotateIfNeeded\(logPath, \{ maxBytes: 2 \* 1024 \* 1024, keepBytes: 1024 \* 1024 \}\)/)
  assert.match(backend, /backendLogQueue/, '建流窗口内的日志必须入队补写，不能丢')
  assert.match(backend, /startBackendLogRotateCheck\(\)/)
  assert.match(backend, /5 \* 60 \* 1000/, '运行期巡检间隔')

  const inp = read('main.inpLog.js')
  assert.match(inp, /appendWithRotation\(file, lines\.join/)
  assert.doesNotMatch(inp, /fs\.appendFileSync/)

  const widget = read('main.widget.js')
  assert.match(widget, /appendWithRotation\(/)
})
