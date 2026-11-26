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
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const CI = abs('.github/workflows/ci.yml')
const RUNNER = abs('testjs/run-smoke.cjs')

test('CI：构建后起 Vite、等端口、跑 smoke 后停 Vite，并点名关键用例', () => {
  const ci = fs.readFileSync(CI, 'utf8')
  const smokeStep = ci.slice(ci.indexOf('冒烟测试'), ci.indexOf('# ---------------------------------------------------------------- 2. 打包'))
  assert.match(smokeStep, /Start-Process[\s\S]{0,120}dev-vite\.js/, 'CI 必须在冒烟前起 Vite')
  assert.match(smokeStep, /Invoke-WebRequest[\s\S]{0,200}\$port/, '必须轮询前端端口等 Vite 就绪')
  assert.match(smokeStep, /throw\s+'Vite[\s\S]{0,60}未就绪/, '端口等不到必须判失败，不能继续跑');
  assert.match(smokeStep, /finally[\s\S]{0,120}Stop-Process/, '无论成功失败都要停 Vite')
  // V9-T01-03：原来只点名一条，其余关键回归 SKIP 不拦闸。扩到真实存在的 smoke 脚本。
  for (const key of ['secure-channel-retry', 'undo-batch-test', 'cadre-undo-test', 'unzip-safe-test', 'api-routes-test']) {
    assert.match(smokeStep, new RegExp(`require-pass=${key}`), `必须点名关键用例 ${key}`)
    assert.ok(fs.existsSync(`testjs/smoke/${key}${key === 'secure-channel-retry' ? '.js' : '.cjs'}`),
      `点名的 ${key} 必须真在 smoke/ 下，否则 require-pass 会永远 missingRequired`)
  }
  assert.match(smokeStep, /\$LASTEXITCODE\s*-ne\s*0/, 'smoke 非零退出必须让 CI 失败')
  // 端口来源必须是唯一口径，不写死
  assert.match(smokeStep, /config\/ports\.cjs/, '前端端口须取自 ports.cjs，不写死')
})

test('runner：--require-pass 解析与 SKIP 判失败的判定逻辑真实有效', () => {
  const code = fs.readFileSync(RUNNER, 'utf8')
  // 接线判据
  assert.match(code, /requirePass:\s*\[\]/, '参数容器必须有 requirePass')
  assert.match(code, /--require-pass=/, '必须解析 --require-pass')
  assert.match(code, /resolveSmokeExit\(results,\s*opt\.requirePass\)/, '汇总必须调用真实判定函数')
  assert.match(code, /process\.exit\(exit\)/, '退出码必须来自判定函数结果')

  // 真跑汇总判定：直接 require runner 里的真函数（T07-01）。
  // 原先这里手抄了一份 judge() 副本，runner 改了判定口径、副本不动，测试仍绿。
  const { resolveSmokeExit } = require(RUNNER)
  const files = [
    { file: 'secure-channel-retry.js', code: null }, // SKIP
    { file: 'font-subset-verify.mjs', code: null },  // 合理跳过
    { file: 'unzip-safe-test.cjs', code: 0 },
  ]
  assert.equal(resolveSmokeExit(files, ['secure-channel-retry']).exit, 1, '关键用例 SKIP 必须失败')
  const passed = files.map((r) => r.file === 'secure-channel-retry.js' ? { ...r, code: 0 } : r)
  assert.equal(resolveSmokeExit(passed, ['secure-channel-retry']).exit, 0, '关键用例 PASS 才通过')
  const absent = files.filter((r) => r.file !== 'secure-channel-retry.js')
  assert.equal(resolveSmokeExit(absent, ['secure-channel-retry']).exit, 1, '关键用例未被收集也必须失败')
  assert.equal(resolveSmokeExit(absent, []).exit, 0, '未点名时合理跳过不应失败')
  // 失败项本身也必须让退出码为 1（SKIP 判定不能顺带放过 FAIL）
  assert.equal(resolveSmokeExit([{ file: 'x.cjs', code: 1 }], []).exit, 1, '有失败项必须退出 1')
})

test('CI：两条打包通道都在 electron-builder 前重建后端 bundle', () => {
  // app.bundle.js 是 git 忽略的生成物，生产优先跑它。CI 为传 --publish never 把
  // electron:build 展开写了，若漏掉 build:backend 就会用工作区残留的旧 bundle，
  // 后端源码修复进不了正式包。钉住两条通道都必须显式重建，且在打包之前。
  const ci = fs.readFileSync(CI, 'utf8')
  const steps = [
    { name: '打包正式版（前端', end: '打包 Vue 3.6 预览版' },
    { name: '打包 Vue 3.6 预览版', end: '校验安装包并生成 SHA-256' },
  ]
  for (const { name, end } of steps) {
    const from = ci.indexOf(name)
    assert.ok(from >= 0, `CI 缺少打包步骤：${name}`)
    const to = ci.indexOf(end, from)
    const step = ci.slice(from, to > from ? to : from + 1200)
    assert.match(step, /npm run build:backend/, `${name} 必须重建后端 bundle（否则用旧产物）`)
    const atBuild = step.indexOf('npm run build:backend')
    // 只认命令行 npx electron-builder，步骤标题里也含这个词（"前端 → ... → electron-builder"）
    const atPack = step.indexOf('npx electron-builder')
    assert.ok(atBuild >= 0 && atPack > atBuild, `${name} 的 build:backend 必须在 electron-builder 之前`)
  }
})
