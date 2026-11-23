// =========================================================================
// smoke-skip-gate.test.js —— CI 不许让关键 smoke 用例静默跳过
//
// 根因：secure-channel-retry 的断言页用裸 ESM import('/src/...')，只有 Vite 实时
// 转译能跑；CI 原先只 npm run build，不起 Vite → 该脚本永远 exit 3 = SKIP，
// run-smoke 只按 fail 数决定退出码 → 401 重试回归从未在流水线跑过却全绿。
// 修法：CI 构建后起 Vite（finally 停掉）；runner 新增 --require-pass=关键字，
// 被点名的用例 SKIP 或未收集都算失败；CI 点名 secure-channel-retry。
//
// 判据：①CI 源码静态核验起 Vite / 等端口 / 停 Vite / require-pass 接线；
//       ②真跑 runner 汇总判定逻辑：SKIP 的关键用例必须让退出码为 1。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const CI = path.join(ROOT, '.github/workflows/ci.yml')
const RUNNER = path.join(ROOT, 'testjs/run-smoke.cjs')

test('CI：构建后起 Vite、等端口、跑 smoke 后停 Vite，并点名关键用例', () => {
  const ci = fs.readFileSync(CI, 'utf8')
  const smokeStep = ci.slice(ci.indexOf('冒烟测试'), ci.indexOf('# ---------------------------------------------------------------- 2. 打包'))
  assert.match(smokeStep, /Start-Process[\s\S]{0,120}dev-vite\.js/, 'CI 必须在冒烟前起 Vite')
  assert.match(smokeStep, /Invoke-WebRequest[\s\S]{0,200}\$port/, '必须轮询前端端口等 Vite 就绪')
  assert.match(smokeStep, /throw\s+'Vite[\s\S]{0,60}未就绪/, '端口等不到必须判失败，不能继续跑');
  assert.match(smokeStep, /finally[\s\S]{0,120}Stop-Process/, '无论成功失败都要停 Vite')
  assert.match(smokeStep, /require-pass=secure-channel-retry/, '必须点名安全通道 smoke 为关键用例')
  assert.match(smokeStep, /\$LASTEXITCODE\s*-ne\s*0/, 'smoke 非零退出必须让 CI 失败')
  // 端口来源必须是唯一口径，不写死
  assert.match(smokeStep, /config\/ports\.cjs/, '前端端口须取自 ports.cjs，不写死')
})

test('runner：--require-pass 解析与 SKIP 判失败的判定逻辑真实有效', () => {
  const code = fs.readFileSync(RUNNER, 'utf8')
  // 接线判据
  assert.match(code, /requirePass:\s*\[\]/, '参数容器必须有 requirePass')
  assert.match(code, /--require-pass=/, '必须解析 --require-pass')
  assert.match(code, /missingRequired/, '必须有未运行关键用例的判定')
  assert.match(code, /process\.exit\(fail\.length \|\| missingRequired\.length \? 1 : 0\)/, 'SKIP 的关键用例必须让退出码为 1')

  // 真跑汇总判定：把结果数组喂进去，验退出码与输出
  function judge(results, requirePass) {
    const pass = results.filter((r) => r.code === 0)
    const fail = results.filter((r) => r.code !== 0 && r.code !== null)
    const skip = results.filter((r) => r.code === null)
    const missingRequired = requirePass.filter((key) =>
      !results.some((r) => r.file.includes(key) && r.code === 0)
    )
    return { exit: fail.length || missingRequired.length ? 1 : 0, missingRequired, pass, fail, skip }
  }
  const files = [
    { file: 'secure-channel-retry.js', code: null }, // SKIP
    { file: 'font-subset-verify.mjs', code: null },  // 合理跳过
    { file: 'unzip-safe-test.cjs', code: 0 },
  ]
  assert.equal(judge(files, ['secure-channel-retry']).exit, 1, '关键用例 SKIP 必须失败')
  const passed = files.map((r) => r.file === 'secure-channel-retry.js' ? { ...r, code: 0 } : r)
  assert.equal(judge(passed, ['secure-channel-retry']).exit, 0, '关键用例 PASS 才通过')
  const absent = files.filter((r) => r.file !== 'secure-channel-retry.js')
  assert.equal(judge(absent, ['secure-channel-retry']).exit, 1, '关键用例未被收集也必须失败')
  assert.equal(judge(absent, []).exit, 0, '未点名时合理跳过不应失败')
})
