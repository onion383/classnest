#!/usr/bin/env node
// =========================================================================
// secure-channel-retry.js —— 安全信道「401 重试」行为的回归测试
//
// 背景：桌面组件曾长期卡在「正在加载常用软件…」，根因之一是安全信道在会话过期 /
// 凭据降级时没有正确重试，而 401 又被当成「登录过期」把用户踢回登录页。这里用
// 一个浏览器上下文的断言页（testjs/probe/pages/secure-channel-retry.html）
// 驱动 secureAxios 的错误处理分支，逐条验证：
//   · GET 撞上 session-expired 会重建会话并重发（旧实现不会 → 全站持续 401）
//   · 带 body 的请求撞上 session-expired 也会重发
//   · 凭据降级（握手失败退回明文 Bearer）造成的 401 会重试且强制带 token
//   · auth-required 分支仍按原逻辑重试，且不被降级分支吞掉
//
// 断言页放在 testjs/probe/pages/（随 testjs 一起入库，不留在前端源码目录里）。
// 它在 Vite 的 root（student-frontend/）之外，靠 vite.config.js 已有的
// `server.fs.allow`（含仓库根）用 `/@fs/` 路径访问 —— 绝对路径运行时算出，换机器也正确。
//
// 退出码：0 = 通过；1 = 失败；3 = 环境不具备（Vite 开发服务器未启动）→ 跳过
// 前置：Vite 开发服务器在 5173 端口（npm run dev）
// =========================================================================
const path = require('node:path')
const net = require('node:net')
const { spawn } = require('node:child_process')

const ROOT = path.join(__dirname, '..', '..')
const PAGE_FILE = path.join(ROOT, 'testjs', 'probe', 'pages', 'secure-channel-retry.html')
// Windows 上要写成 D:/… 正斜杠形式；/@fs/ 之后是文件系统绝对路径
const PAGE_URL = 'http://127.0.0.1:5173/@fs/' + PAGE_FILE.replace(/\\/g, '/')
const VITE_PORT = 5173
const TOOL = path.join(ROOT, 'testjs', 'tools', 'electron-page-probe.cjs')
// Electron 子进程的超时上限（ms）：断言页要起 Electron + 跑完 5 组重试用例，
// 慢机器上给 90 秒；超时按**失败**计入（不能当成通过）。
const ELECTRON_TIMEOUT_MS = Number(process.env.ELECTRON_TIMEOUT_MS) || 90000
// 结束子进程树：Electron 还会再起渲染进程，只 kill 直接子进程会残留
const { killTree } = require('../tools/killTree.cjs')

function portAlive(port) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port })
    const done = (ok) => { sock.destroy(); resolve(ok) }
    sock.setTimeout(700, () => done(false))
    sock.on('connect', () => done(true))
    sock.on('error', () => done(false))
  })
}

function runElectron() {
  return new Promise((resolve) => {
    let electronPath
    try {
      electronPath = require('electron')
    } catch (e) {
      resolve({ code: 3, out: '找不到 electron 可执行文件：' + (e && e.message) })
      return
    }
    const child = spawn(electronPath, [TOOL, PAGE_URL], {
      cwd: ROOT,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (d) => { out += d.toString() })
    child.stderr.on('data', (d) => { out += d.toString() })
    // ⚠️ 必须有超时：Electron 子进程 hang（页面加载卡住 / 断言页崩了 / 进程不退出）时，
    //   没有超时 = 这个冒烟脚本**永久挂起**，整个冒烟批次跟着挂住。
    // 超时按**失败**计入（不能当成通过）。
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      try { killTree(child) } catch (_) { /* 已退出 */ }
    }, ELECTRON_TIMEOUT_MS)
    const done = (code) => {
      clearTimeout(timer)
      resolve({ code, out })
    }
    child.on('error', (e) => done(1))
    child.on('exit', (code) => {
      if (timedOut) { done(1); return }
      done(code ?? 1)
    })
  })
}

async function main() {
  if (!fs_exists(TOOL)) {
    console.log('FAIL 缺少探针工具：' + TOOL)
    process.exit(1)
  }
  // 断言页是本测试的**前提**。它曾被删掉过一次（探针页在 student-frontend/dev-probes/，
  // 随「Options API → Composition API」重构一并删了），而脚本还在引用它 →
  // Vite 把请求兜底成 index.html → 页面里没有 #out → 报「探针页没跑起来？」，
  // 看起来像环境问题，实际是**资产缺失**，长期挂在冒烟里没人查。
  // 故这里前置检查，缺文件直接指名道姓地报出来。
  if (!fs_exists(PAGE_FILE)) {
    console.log('FAIL 缺少断言页：' + PAGE_FILE)
    process.exit(1)
  }
  if (!(await portAlive(VITE_PORT))) {
    console.log('SKIP Vite 开发服务器未在 5173 端口（npm run dev 后再跑）')
    process.exit(3)
  }

  const { code, out } = await runElectron()
  const lines = out.split(/\r?\n/)
  const results = lines.filter((l) => /^(PASS|FAIL)\s/.test(l))
  if (!results.length) {
    console.log(out)
    console.log('FAIL 没有拿到断言结果（探针页没跑起来？）')
    console.log('     断言页：' + PAGE_FILE)
    console.log('     访问地址：' + PAGE_URL)
    console.log('     若 Vite 已启动仍如此，多半是 vite.config.js 的 server.fs.allow 没放开仓库根')
    process.exit(1)
  }
  for (const l of results) console.log(l)
  const failed = results.filter((l) => l.startsWith('FAIL'))
  if (failed.length || code !== 0) {
    console.log('FAIL ' + failed.length + '/' + results.length + ' 条断言未通过（探针退出码 ' + code + '）')
    process.exit(1)
  }
  console.log('PASS 全部 ' + results.length + ' 条断言通过')
  process.exit(0)
}

function fs_exists(p) {
  try { require('node:fs').accessSync(p); return true } catch (_) { return false }
}

main()
