// =========================================================================
// ports-config.test.js —— 端口单一口径的变异反证
//
// 只测纯函数会假绿：这里专门验证「改一处端口，主进程 / 后端 / Vite / CSP 一起变」。
// 配置在子进程里重载，避免测试进程的 env 污染默认值判定。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function loadConfig(env = {}) {
  const clean = { ...process.env }
  for (const key of ['BACKEND_PORT', 'PORT', 'FRONTEND_PORT']) delete clean[key]
  const code = 'process.stdout.write(JSON.stringify(require("./config/ports.cjs")))'
  return JSON.parse(execFileSync(process.execPath, ['-e', code], {
    cwd: ROOT,
    env: { ...clean, ...env },
    encoding: 'utf8',
  }))
}

test('默认端口来自 ports.json，地址由同一份配置派生', () => {
  const defaults = JSON.parse(read('config/ports.json'))
  const cfg = loadConfig()
  assert.equal(cfg.backendPort, defaults.backendPort)
  assert.equal(cfg.frontendPort, defaults.frontendPort)
  assert.equal(cfg.backendOrigin, `http://127.0.0.1:${defaults.backendPort}`)
  assert.equal(cfg.frontendOrigin, `http://127.0.0.1:${defaults.frontendPort}`)
})

test('端口变量能覆盖默认值，BACKEND_PORT 优先于 PORT（变异反证）', () => {
  const legacy = loadConfig({ PORT: '4123', FRONTEND_PORT: '5234' })
  assert.equal(legacy.backendPort, 4123)
  assert.equal(legacy.frontendPort, 5234)
  assert.equal(legacy.backendOrigin, 'http://127.0.0.1:4123')

  const both = loadConfig({ PORT: '4123', BACKEND_PORT: '4567' })
  assert.equal(both.backendPort, 4567)
  assert.equal(both.backendOrigin, 'http://127.0.0.1:4567')
})

test('主进程与后端都接同一份配置，dev 窗口地址也跟着走', () => {
  for (const rel of [
    'electron/main/main.api-proxy.js',
    'electron/main/main.backend.js',
    'electron/main/main.dev-loader.js',
    'electron/main/main.dialogs.js',
    'electron/main/main.js',
    'electron/main/main.widget.js',
    'electron/main/main.protocol.js',
    'electron/main/main.web-prefs.js',
    'student-backend/app.js',
    'student-frontend/vite.config.js',
  ]) {
    const src = read(rel)
    assert.match(src, /config\/ports\.cjs/, `${rel} 必须读 config/ports.cjs`)
    assert.ok(
      !/["'`]http:\/\/127\.0\.0\.1:(3000|5173)/.test(src),
      `${rel} 不得残留写死的端口地址`,
    )
  }
  assert.match(read('electron/main/main.backend.js'), /PORT: String\(ports\.backendPort\)/)
  assert.match(read('electron/main/main.dev-loader.js'), /ports\.frontendOrigin/)
  assert.match(read('electron/main/main.widget.js'), /ports\.frontendOrigin/)
  assert.match(read('student-frontend/vite.config.js'), /port: ports\.frontendPort/)
  assert.match(read('student-frontend/vite.config.js'), /target: ports\.backendOrigin/)
})

test('渲染层媒体 origin 由主进程注入，与 CSP 同源', () => {
  const prefs = read('electron/main/main.web-prefs.js')
  const preload = read('electron/preload.js')
  const frontend = read('student-frontend/src/utils/backendOrigin.js')
  const protocol = read('electron/main/main.protocol.js')
  assert.match(prefs, /'--backend-origin=' \+ ports\.backendOrigin/)
  assert.match(preload, /exposeInMainWorld\('__BACKEND_ORIGIN__'/)
  assert.match(frontend, /globalThis\.__BACKEND_ORIGIN__/)
  assert.match(frontend, /import ports from '\.\.\/\.\.\/\.\.\/config\/ports\.json'/)
  assert.match(protocol, /const backendOrigin = ports\.backendOrigin/)
  // 配置目录必须进安装包，否则主进程在打包版读不到端口
  assert.match(read('electron-builder.json'), /"config\/\*\*\/\*"/)
})

test('运行期顺延端口：getter 跟随，代理/安全通道拿到的是新值（变异反证）', () => {
  const ports = require('../../config/ports.cjs')
  const before = ports.backendOrigin
  const beforePort = ports.backendPort

  assert.equal(ports.setBackendPort(38121), true)
  assert.equal(ports.backendPort, 38121)
  assert.equal(ports.backendOrigin, 'http://127.0.0.1:38121', 'getter 必须跟着变，不能是快照')

  // 代理目标在调用时取 origin：若哪天改回模块级常量，这条会失败
  const { targetUrlFor } = require('../../electron/main/main.api-proxy.js')
  assert.equal(targetUrlFor('app://local/api/dashboard?x=1'), 'http://127.0.0.1:38121/api/dashboard?x=1')

  // 非法值一律拒绝，别让一个坏消息把 origin 弄成 http://127.0.0.1:NaN
  assert.equal(ports.setBackendPort('38122'), false)
  assert.equal(ports.setBackendPort(0), false)
  assert.equal(ports.setBackendPort(70000), false)
  assert.equal(ports.backendPort, 38121)

  ports.setBackendPort(beforePort)
  assert.equal(ports.backendOrigin, before, '用例结束要复原，避免污染同进程其它测试')
})

test('dev 就绪判据：不能只看「端口有响应」，否则会加载到别人的页面', () => {
  const src = read('electron/main/main.dev-loader.js')
  const html = read('student-frontend/index.html')
  // 只看 pollViteAndNavigate 这一段：文件里 loadUrlWithRetry 另有 res.resume()，不能连坐
  const pollBody = src.slice(src.indexOf('function pollViteAndNavigate'), src.indexOf('module.exports'))

  assert.match(pollBody, /looksLikeOurVite\(body\)/, '轮询必须校验响应内容再导航')
  assert.match(pollBody, /res\.on\('end'/, '要先读完响应体才能判定')
  assert.doesNotMatch(pollBody, /res\.resume\(\)\s*\/\/ 消耗响应体/, '不能读都不读就导航')

  // 判据本身要能命中真实入口：改 index.html 结构时这里会先红，提醒同步判据
  assert.match(html, /id=["']app["']/, '入口必须有 Vue 挂载点，判据依赖它')
  assert.match(html, /\/src\/main\.js/, '入口必须引用 /src/main.js，判据依赖它')
  assert.match(src, /id=\["'\]app\["'\]/, '判据里的挂载点写法要与 index.html 一致')
  assert.match(src, /\\\/src\\\/main\\\.js/, '判据里的入口路径要与 index.html 一致')
})
