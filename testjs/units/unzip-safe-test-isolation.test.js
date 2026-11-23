// =========================================================================
// unzip-safe-test-isolation.test.js —— smoke 测试不许删别人在系统 temp 的文件
//
// 根因：unzip-safe-test.cjs 为了让"目标外泄漏"断言可重复，开跑前无条件
// unlink 三个固定路径，其中包括 os.tmpdir()/evil.txt 这种通用文件名 ——
// 任何人在系统 temp 放的 evil.txt 都会被静默删掉。
// 修法：样本 / 输出 / 泄漏落点全放进 mkdtemp 独占沙箱，恶意条目名带 RUN_ID
// 随机 marker，检测只扫沙箱内 marker 文件，绝不再碰全局路径。
//
// 判据：在系统 temp 与仓库 tmp 各放一个 evil.txt 哨兵，真跑一次 smoke 测试，
// 两个哨兵必须原封不动（静态字符串检查不足以证明删除范围被收住）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../..')
const SOURCE = path.join(ROOT, 'testjs/smoke/unzip-safe-test.cjs')
const PY = process.env.PYTHON || 'python'

function pythonAvailable() {
  try { execFileSync(PY, ['--version'], { stdio: 'ignore' }); return true } catch (_) { return false }
}

test('源码不再 unlink 全局通用文件名，改用独占沙箱 + 随机 marker', () => {
  // 去注释后扫描：注释里说明历史路径是合理的，只有真实代码算数
  const code = fs.readFileSync(SOURCE, 'utf8')
    .split(/\r?\n/).filter((line) => !line.trim().startsWith('//')).join('\n')
  assert.ok(!/os\.tmpdir\(\)\s*,\s*'evil\.txt'/.test(code), '不许再引用系统 temp 的 evil.txt')
  assert.ok(!code.includes("'/tmp/evil.txt'"), '不许再引用系统 /tmp 的 evil.txt')
  assert.ok(!/unlinkSync\(stale\)/.test(code), '不许无条件 unlink 全局路径')
  assert.ok(!/outsideLeakPaths\s*\(/.test(code), '不许再保留全局泄漏路径清单')
  assert.match(code, /mkdtempSync\(path\.join\(os\.tmpdir\(\), 'unzipsafe-'\)\)/, '样本根必须独占 mkdtemp')
  assert.match(code, /RUN_ID/, '恶意文件名必须带本次运行的随机 marker')
  assert.match(code, /function leakedFiles\s*\(/, '泄漏检测必须只扫本次沙箱')
  assert.match(code, /process\.on\('exit'[\s\S]{0,160}rmSync\(SANDBOX/, '异常退出也要清掉沙箱')
})

test('真实 smoke 测试跑完：系统 temp 与仓库 tmp 的哨兵都原封不动', (t) => {
  if (!pythonAvailable()) return t.skip('python 不可用，smoke 会按环境不具备跳过')

  const systemSentinel = path.join(os.tmpdir(), 'evil.txt')
  const repoSentinel = path.join(ROOT, 'testjs/tmp/evil.txt')
  const created = []
  for (const p of [systemSentinel, repoSentinel]) {
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, 'DO-NOT-DELETE')
    created.push(p)
  }
  t.after(() => { for (const p of created) { try { fs.rmSync(p, { force: true }) } catch (_) {} } })

  const childEnv = { ...process.env }
  delete childEnv.NODE_TEST_CONTEXT
  const r = spawnSync(process.execPath, [SOURCE], {
    cwd: ROOT,
    env: childEnv,
    encoding: 'utf8',
    timeout: 60000,
  })
  assert.equal(r.status, 0, r.stdout + r.stderr)
  assert.match(r.stdout, /全部通过/, 'smoke 测试必须完整跑完')

  for (const p of created) {
    assert.ok(fs.existsSync(p), `通用文件名哨兵绝不能被测试删掉：${p}`)
    assert.equal(fs.readFileSync(p, 'utf8'), 'DO-NOT-DELETE')
  }
})
