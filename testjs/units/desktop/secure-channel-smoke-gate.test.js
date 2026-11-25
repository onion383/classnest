// =========================================================================
// secure-channel-smoke-gate.test.js —— 安全通道 smoke 不许凭部分 PASS 假绿
//
// 根因：eval 页断言到一半 renderer 崩溃时，探针 electron-page-probe.cjs 捕获异常后
// 只打印 PROBE_EVAL_FAIL 就 break，随后仍 PROBE_DONE + exit(0)；调用方只筛 PASS|FAIL
// 行，只要有一条 PASS 且退出码 0 就报全过。断言页有 9 条，却从不校验条数。
// 修法：探针侧 eval 异常/未完成一律 PROBE_FAIL + 非零码；调用方要求完整完成信号 +
// 断言条数等于页面 done() 数 + 无失败信号。
//
// 判据：①真跑探针的决定逻辑（抽出函数体注入假 win/app）验三种异常都非零且无 DONE；
//       ②真跑调用方的 main 判定段（抽出后注入假 runElectron/断言页）验部分 PASS 被拒。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const path = require('node:path')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const PROBE = abs('testjs/tools/electron-page-probe.cjs')
const CALLER = abs('testjs/smoke/secure-channel-retry.js')
const PAGE = abs('testjs/probe/pages/secure-channel-retry.html')
const { extractFunctionInner } = require('#testjs/units/_mechanism.cjs')

/** 从源码里按函数名抽函数体（AST，替代手动数花括号） */
function extractBody(code, startMark) {
  const m = /^(?:async\s+)?function\s+(\w+)\s*\(/.exec(startMark)
  if (!m) throw new Error('起点不是函数声明：' + startMark)
  return extractFunctionInner(code, m[1])
}

test('探针：eval 异常 / 未完成都非零退出且不打印 PROBE_DONE', () => {
  const code = fs.readFileSync(PROBE, 'utf8')
  // 结构判据：异常与未完成分支都要有 PROBE_FAIL + app.exit(非零)，且 PROBE_DONE 只在最后成功分支
  const evalPart = code.slice(code.indexOf('if (evalError)'), code.indexOf('if (!done)'))
  assert.match(evalPart, /PROBE_FAIL/, 'eval 异常必须打 PROBE_FAIL')
  assert.match(evalPart, /app\.exit\([1-9]/, 'eval 异常必须非零退出')
  const donePart = code.slice(code.indexOf('if (!done)'))
  assert.match(donePart, /PROBE_FAIL/, '未完成必须打 PROBE_FAIL')
  assert.match(donePart, /app\.exit\([1-9]/, '未完成必须非零退出')
  // PROBE_DONE 必须出现在两个失败分支之后（成功路径末尾）
  const doneAt = code.indexOf("console.log('PROBE_DONE')")
  assert.ok(doneAt > code.indexOf('if (!done)'), 'PROBE_DONE 只能出现在成功分支')
  assert.ok(!/catch[\s\S]{0,120}PROBE_DONE/.test(code), 'catch 后不许直接打印 DONE')
})

test('调用方：必须有完成信号、失败信号、条数三重检查', () => {
  const code = fs.readFileSync(CALLER, 'utf8')
  assert.match(code, /expected\s*=\s*\(pageSrc\.match\(/, '期望条数须从断言页源码动态数出')
  assert.ok(/pageSrc\.match\([^\n]*done/.test(code), '动态数的是断言页里的 done() 调用')
  assert.match(code, /PROBE_DONE/, '必须要求完成信号')
  assert.ok(code.includes('PROBE_') && /badSignal[\s\S]{0,120}PROBE_/.test(code), '必须识别探针失败信号')
  assert.match(code, /results\.length !== expected/, '必须校验断言条数')
  // 断言页当前确有 9 条 done()，且调用方没有硬编码数字
  const page = fs.readFileSync(PAGE, 'utf8')
  assert.equal((page.match(/\bdone\s*\(/g) || []).length, 9, '断言页应有 9 条断言')
  assert.ok(!/expected\s*=\s*9\b/.test(code), '不许把期望条数硬编码成 9')
})

test('真跑调用方判定段：部分 PASS + eval 失败被拒，完整 9 条才通过', () => {
  const code = fs.readFileSync(CALLER, 'utf8')
  const body = extractBody(code, 'async function main()')
  // 注入依赖：假 runElectron / 假 PORT / 假文件检查 / 可控 process.exit / 收集输出
  function run(outText, exitCode, label) {
    const logs = []
    let exitValue = null
    const fakeProcess = {
      exit: (n) => { exitValue = n; throw new Error('__EXIT__' + n) },
      env: process.env,
    }
    const fn = new Function('require', 'process', '__D', `
      const path = __D.path
      const PAGE_FILE = __D.PAGE_FILE
      const PAGE_URL = __D.PAGE_URL
      const TOOL = __D.TOOL
      const VITE_PORT = __D.VITE_PORT
      const fs_exists = __D.fs_exists
      const portAlive = __D.portAlive
      const runElectron = __D.runElectron
      const console = { log: (...a) => __D.logs.push(a.join(' ')) }
      return (async () => { ${body} })()
    `)
    const deps = {
      path, PAGE_FILE: PAGE, PAGE_URL: 'http://fake', TOOL: __filename, VITE_PORT: 5173,
      fs_exists: () => true,
      portAlive: async () => true,
      runElectron: async () => ({ code: exitCode, out: outText }),
      logs,
    }
    // require 只用于读断言页；给真 require 即可
    const p = fn(require, fakeProcess, deps)
    return p.then(() => ({ exitValue, logs, label }), (e) => ({
      exitValue: String(e.message).startsWith('__EXIT__') ? Number(e.message.slice(8)) : 'threw:' + e.message,
      logs, label,
    }))
  }
  const nine = Array.from({ length: 9 }, (_, i) => 'PASS 断言' + i).join('\n')
  const partial = 'PASS 断言0\nPASS 断言1\nPROBE_EVAL_FAIL renderer crashed\nPROBE_DONE'
  return Promise.all([
    run(partial, 0, '部分PASS+eval异常'),
    run(nine + '\nPROBE_FAIL 未完成', 5, '9条PASS但探针失败'),
    run('PASS 断言0\nPASS 断言1\nPASS 断言2\nPROBE_DONE', 0, '只有3条PASS'),
    run(nine + '\nPROBE_DONE', 0, '完整9条'),
  ]).then((rs) => {
    assert.equal(rs[0].exitValue, 1, rs[0].label + ' 必须失败')
    assert.equal(rs[1].exitValue, 1, rs[1].label + ' 必须失败')
    assert.equal(rs[2].exitValue, 1, rs[2].label + ' 必须失败')
    assert.equal(rs[3].exitValue, 0, rs[3].label + ' 应通过')
    assert.ok(rs[0].logs.join('\n').includes('探针未完成'), rs[0].label + ' 应报探针未完成')
    assert.ok(rs[2].logs.join('\n').includes('断言不完整'), rs[2].label + ' 应报条数不足')
  })
})
