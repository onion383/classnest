// =========================================================================
// smoke-truthfulness.test.js —— 四处「测试工具假绿」修复的判据
//
// ① pattern-sweep --report：解析了 REPORT_ONLY 却仍按 failures 退出 → 非阻断报告误判失败
// ② font-subset：nameID 缺失只打印、配对产物缺失 continue → 许可/覆盖被删仍 exit 0
// ③ viewer-anim：页面 8s 安全阀 r.ok=true 把超时伪装成功 → 动画没起跑也出"成功"数据
// ④ sweep-fixes：mustHave 匹配 raw（含注释）→ 实现删了、注释还在也算通过
//
// 判据：每处都用「结构核验 + 真实行为抽查」，变异必须转红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../..')
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8')

test('① pattern-sweep：--report 固定 exit 0，正常模式仍按命中数判', () => {
  const code = read('testjs/probe/pattern-sweep-probe.cjs')
  assert.match(code, /runSweep\(\{ only: ONLY_MODE, reportOnly: REPORT_ONLY \}\)/, 'REPORT_ONLY 必须传给 runSweep')
  assert.match(code, /process\.exit\(REPORT_ONLY \? 0 : \(r\.failures \? 1 : 0\)\)/, '报告模式必须固定 0')
  // 真跑：--report 退出码 0（即使有命中），正常模式也跑得通
  const rc = (args) => {
    try { execFileSync(process.execPath, [path.join(ROOT, 'testjs/probe/pattern-sweep-probe.cjs'), ...args], { cwd: ROOT, stdio: 'ignore' }); return 0 }
    catch (e) { return e.status }
  }
  assert.equal(rc(['--report']), 0, '--report 必须退出 0')
  assert.equal(rc(['--mode=__nonexistent__']), 0, '正常模式无命中应退出 0')
})

test('② font-subset：许可 nameID 缺失与配对产物缺失都置失败', () => {
  const code = read('testjs/smoke/font-subset-verify.mjs')
  assert.match(code, /const missingNameIds[\s\S]{0,80}filter\(\(nid\) => !names\.has\(nid\)\)/, '必须收集缺失的 nameID')
  assert.match(code, /let ok = missingNameIds\.length === 0/, '缺失 nameID 必须让 ok=false')
  assert.match(code, /if \(!\(fs\.existsSync\(fp\) && fs\.existsSync\(tp\)\)\) \{[\s\S]{0,160}ok = false/, '配对产物缺失必须失败')
  assert.ok(!/existsSync\(fp\) && fs\.existsSync\(tp\)\)\) continue/.test(code), '不许再 continue 跳过缺失产物')
})

test('③ viewer-anim：页面安全阀超时标记为失败，外层识别并拒收', () => {
  const code = read('testjs/probe/viewer-anim-probe.cjs')
  assert.match(code, /setTimeout\(\(\) => \{ r\.ok = true; r\.timedOut = true \}, 8000\)/, '超时安全阀必须打 timedOut 标记')
  assert.match(code, /if \(r && r\.timedOut\) return reject\(/, '外层必须把 timedOut 当失败')
  // 真跑 waitFor 逻辑：注入假 executeJavaScript 返回 timedOut 行，必须 reject
  const bodyStart = code.indexOf('function waitFor(')
  const body = code.slice(bodyStart, code.indexOf('async function runOne(', bodyStart))
  let rejected = false
  const fn = new Function('Date', 'setTimeout', `
    ${body}
    return waitFor({ webContents: { executeJavaScript: async () => ({ ok: true, timedOut: true }) } }, 100)
  `)(Date, () => {})
  return fn.catch((e) => { rejected = /超时/.test(e.message) }).then(() => {
    assert.ok(rejected, '安全阀超时必须让 waitFor reject，不能当成功')
  })
})

test('④ sweep-fixes：mustHave 只看去注释的真实代码', () => {
  const code = read('testjs/units/sweep-fixes.test.js')
  assert.ok(!/mustHave\.test\(raw\)/.test(code), 'mustHave 不许再匹配含注释的 raw')
  assert.match(code, /mustHave\.test\(code\)/, 'mustHave 必须匹配去注释后的代码')
  assert.ok(code.includes('const code = stripComments(raw)'), '必须生成去注释代码')
})
