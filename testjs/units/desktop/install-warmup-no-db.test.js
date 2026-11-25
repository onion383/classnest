// =========================================================================
// install-warmup-no-db.test.js —— 安装器预热不许建 index.db（否则跳过首启引导）
//
// 根因：inno 装完必跑 ClassNest.exe --warmup，后端就绪后走 warmupStep →
// dbManager.warmup() → ensureIndex() → 创建 index.db。主进程 looksLikeFirstRun()
// 以 index.db 是否存在判首启，于是新装机器首次真启动被判成"非首启"，跳过引导向导。
// 修法：warmup 分支设 CLASSNEST_INSTALL_WARMUP=1，后端 fork 继承后跳过建库/开库两步，
// 只保留纯内存的鉴权模块预热（文件/模块缓存预热目的不变）。
//
// 判据：①真跑抽出的 warmupStep（注入假 dbManager/环境），验 warmup 模式不建库、
//        正常模式建库；②静态核验 main.js 设标志、后端读标志、setup.iss 跑 --warmup、
//        首启判定仍看 index.db。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const { extractFunctionBody } = require('#testjs/units/_mechanism.cjs')
const APP = abs('student-backend/app.js')
const MAIN = abs('electron/main/main.js')
const ISS = abs('electron/inno/setup.iss')
const appSrc = fs.readFileSync(APP, 'utf8')

/** 抽出 warmupStep 的函数体，注入假依赖真跑（AST 抽，替代手动数花括号） */
function extractWarmupStep() {
  return extractFunctionBody(appSrc, 'warmupStep')
}

function runWarmupStep(env) {
  const calls = []
  const fakeDbManager = {
    warmup: () => calls.push('dbManager.warmup'),
    warmupMostRecent: () => calls.push('dbManager.warmupMostRecent'),
  }
  const fakeProcess = { env }
  // 抽出的是函数**体**，直接执行即可；注入 warmupAuth / _bootT0 等闭包依赖
  const fn = new Function('dbManager', 'process', 'Date', 'console', 'warmupAuth', '_bootT0', `
    ${extractWarmupStep()}
  `)
  fn(fakeDbManager, fakeProcess, Date, { log: () => {} }, () => {}, 0)
  return calls
}

test('真跑 warmupStep：安装预热不建 index.db、不开账号库', () => {
  const calls = runWarmupStep({ CLASSNEST_INSTALL_WARMUP: '1' })
  assert.ok(!calls.includes('dbManager.warmup'), '安装预热绝不能建 index.db')
  assert.ok(!calls.includes('dbManager.warmupMostRecent'), '安装预热绝不能开账号库')
})

test('真跑 warmupStep：正常启动仍照常建库预热（不误伤正常首屏性能）', () => {
  const calls = runWarmupStep({})
  assert.deepEqual(calls, ['dbManager.warmup', 'dbManager.warmupMostRecent'])
})

test('静态接线：主进程设标志、后端读标志、安装器跑 warmup、首启仍看 index.db', () => {
  const main = fs.readFileSync(MAIN, 'utf8')
  assert.match(main, /process\.argv\.includes\('--warmup'\)/, '主进程要有 warmup 分支')
  assert.match(main, /process\.env\.CLASSNEST_INSTALL_WARMUP\s*=\s*'1'/, 'warmup 分支必须设标志')
  assert.match(main, /looksLikeFirstRun/, '首启判定仍在')
  assert.match(main, /resolveIndexPath\(\)/, '首启判定仍看 index.db')

  const iss = fs.readFileSync(ISS, 'utf8')
  assert.match(iss, /--warmup/, '安装器必须跑预热')

  const noComments = appSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
  assert.match(noComments, /process\.env\.CLASSNEST_INSTALL_WARMUP === '1'/, '后端必须读标志')
  assert.match(noComments, /if \(!installWarmup\)[\s\S]{0,120}dbManager\.warmup\(\)/, '建库必须在非安装预热分支')
  const guardCount = (noComments.match(/if \(!installWarmup\)/g) || []).length
  assert.equal(guardCount, 2, '建库与开账号库两步都要被标志挡住')
})
