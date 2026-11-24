// =========================================================================
// fixture-data-dir-isolation.test.js —— 测试夹具不许继承外部 DATA_DIR
//
// 根因：_db-express-fixture.cjs 原来写的是
//   process.env.DATA_DIR = dataDir || process.env.DATA_DIR || makeTempDataDir(label)
// 调用方的 DATA_DIR 可能是真实用户数据目录；而单测里有大量 fs.rmSync(FILE)、
// rmSync(dir, {recursive:true})。继承等于把删除范围开到真实数据：
//   · mcp-token-store.test.js 会 rm core/.mcp-tokens.json
//   · refresh-virtual.test.js 会递归删固定仓库目录
// 因此判据必须是「外部给一个哨兵目录，跑真实测试后哨兵文件原封不动」，
// 只断言 env 值变化是不够的（改个环境值不算证明删除范围被收住）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../..')

// 子进程探针：同一进程连建两个夹具，验证「共享但独立」。
// 用子进程是因为夹具会改进程级 env / require.cache，不能污染测试进程自身。
const PROBE_CODE = `
const { createBackendDb } = require('./testjs/units/_db-express-fixture.cjs')
const before = process.env.DATA_DIR
const fxA = createBackendDb({ label: 'isolation-a' })
const afterFirst = process.env.DATA_DIR
const fxB = createBackendDb({ label: 'isolation-b' })
const afterSecond = process.env.DATA_DIR
console.log(JSON.stringify({ before, afterFirst, afterSecond, pid: process.pid }))
fxA.close(); fxB.close()
`

const EXPLICIT_CODE = `
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createBackendDb } = require('./testjs/units/_db-express-fixture.cjs')
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'explicit-data-dir-'))
const fx = createBackendDb({ label: 'explicit', dataDir: dir })
console.log(JSON.stringify({ dataDir: process.env.DATA_DIR, dir, pid: process.pid }))
fx.close()
`

test('夹具默认 DATA_DIR 是自己的独占临时目录，不继承外部值', (t) => {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'external-data-dir-'))
  t.after(() => { try { fs.rmSync(sentinel, { recursive: true, force: true }) } catch (_) {} })

  const r = spawnSync(process.execPath, ['-e', PROBE_CODE], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: sentinel },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.before, sentinel, '探针确实拿到了外部 DATA_DIR')
  assert.notEqual(out.afterFirst, sentinel, '夹具不得继承外部 DATA_DIR')
  assert.ok(out.afterFirst.startsWith(os.tmpdir()), '夹具必须把数据目录落在系统临时目录')
  assert.ok(out.afterFirst.includes(String(out.pid)), '目录名必须带 run id（pid），并行不撞名')
})

test('同进程多夹具共享同一个测试专用目录，不破坏既有语义', (t) => {
  const r = spawnSync(process.execPath, ['-e', PROBE_CODE], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: '' },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.afterFirst, out.afterSecond, '同进程第二夹具必须复用第一夹具的目录')
  assert.ok(out.afterFirst && out.afterFirst !== '', '共享目录必须真实存在，不能是空串')
})

test('显式 dataDir（调用方自建临时目录）仍然生效', () => {
  const r = spawnSync(process.execPath, ['-e', EXPLICIT_CODE], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: '/should/not/be/used' },
    encoding: 'utf8',
  })
  assert.equal(r.status, 0, r.stderr || r.stdout)
  const out = JSON.parse(r.stdout.trim())
  assert.equal(out.dataDir, out.dir, '显式 dataDir 必须原样使用')
})

test('真实 mcp-token-store 测试不会删掉外部 DATA_DIR 里的令牌索引', (t) => {
  const sentinel = fs.mkdtempSync(path.join(os.tmpdir(), 'real-data-dir-'))
  const coreDir = path.join(sentinel, 'core')
  const tokenFile = path.join(coreDir, '.mcp-tokens.json')
  fs.mkdirSync(coreDir, { recursive: true })
  fs.writeFileSync(tokenFile, 'SENTINEL-DO-NOT-DELETE')
  t.after(() => { try { fs.rmSync(sentinel, { recursive: true, force: true }) } catch (_) {} })

  // node --test 的 worker 会把 NODE_TEST_CONTEXT 传给孙进程；孙进程看到它就会以
  // 「递归运行」为由跳过测试文件，静默返回 0（典型假绿）。必须显式摘掉。
  const childEnv = { ...process.env, DATA_DIR: sentinel }
  delete childEnv.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, [
    '--test', '--test-reporter=tap', path.join(ROOT, 'testjs/units/mcp-token-store.test.js'),
  ], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  // 只校验「真的跑了且全通过」，不钉死兄弟文件的用例数（T05-04：增删用例不该让本用例红）
  const total = r.stdout.match(/# tests (\d+)/)
  const passed = r.stdout.match(/# pass (\d+)/)
  assert.ok(total && Number(total[1]) > 0, '孙进程必须真的跑完 mcp-token-store 的测试')
  assert.equal(Number(passed && passed[1]), Number(total[1]), '孙进程的测试必须全部通过\n' + r.stdout)
  assert.ok(fs.existsSync(tokenFile), '外部 DATA_DIR 的令牌索引绝不能被测试删掉')
  assert.equal(fs.readFileSync(tokenFile, 'utf8'), 'SENTINEL-DO-NOT-DELETE', '外部目录内容必须原封不动')
})
