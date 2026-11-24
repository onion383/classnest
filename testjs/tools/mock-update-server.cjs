// =========================================================================
// mock-update-server.cjs —— 本地模拟 GitHub Releases，用来在没有发布包时走通更新流程
//
// 只监听 127.0.0.1，只服务于 dev（主进程的 resolveUpdateEndpoints 对打包环境
// 完全忽略 mock 配置）。提供：
//   GET /releases/latest  —— 假 release JSON（含正式包 + Vue36 预览包干扰项）
//   GET /download/*       —— 假安装包（纯文本占位，扩展名 .exe；绝不执行）
//
// 假包内容刻意做成文本：即使误被打开也不会安装任何东西。dev mock 路径下主进程
// 只会 showItemInFolder 定位它，不会 openPath / spawn。
// =========================================================================
const http = require('node:http')
const crypto = require('node:crypto')

const DEFAULT_VERSION = '99.0.0'
const ASSET_NAME = `ClassNest-Setup-${DEFAULT_VERSION}.exe`
const PREVIEW_ASSET_NAME = `ClassNest-Vue36-Setup-${DEFAULT_VERSION}.exe`

function makeInstallerBytes() {
  const head = 'MOCK INSTALLER PLACEHOLDER — NOT A REAL EXECUTABLE. DO NOT RUN.\r\n'
  // 约 2 MB：让下载进度条有可见变化，同时保持测试启动快
  return Buffer.concat([Buffer.from(head), Buffer.alloc(2 * 1024 * 1024 - head.length, 0x2e)])
}

function sha256Hex(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex')
}

/**
 * 创建 mock 服务（不自动监听）。
 * @param {object}  opts
 * @param {number}  opts.port           端口，0 = 系统分配（测试用）
 * @param {boolean} opts.withDigest     是否给资产带 sha256 digest（默认 true）
 * @param {boolean} opts.updateAvailable 是否返回新版本（默认 true）
 * @param {string}  opts.version        假版本号
 */
function createMockUpdateServer({
  port = 18499,
  withDigest = true,
  updateAvailable = true,
  version = DEFAULT_VERSION,
  manifestMode = 'ok', // ok | absent | tampered
} = {}) {
  const installer = makeInstallerBytes()
  const digest = 'sha256:' + sha256Hex(installer)
  const installerName = `ClassNest-Setup-${version}.exe`
  const previewName = `ClassNest-Vue36-Setup-${version}.exe`
  let origin = `http://127.0.0.1:${port}`

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, origin)
    if (url.pathname === '/release-trust.json') {
      // 独立清单模拟：正常 / 缺失 / 与资产摘要冲突
      if (manifestMode === 'absent') {
        res.writeHead(404); res.end('not found'); return
      }
      const listed = manifestMode === 'tampered' ? 'sha256:' + '0'.repeat(64) : digest
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify({ schema: 1, entries: { [version]: listed } }))
      return
    }
    if (url.pathname === '/releases/latest') {
      const asset = (name) => ({
        name,
        size: installer.length,
        browser_download_url: `${origin}/download/${encodeURIComponent(name)}`,
        ...(withDigest ? { digest } : {}),
      })
      const payload = {
        tag_name: updateAvailable ? `v${version}` : 'v0.0.0',
        assets: [asset(previewName), asset(installerName)], // 预览包在前，验证挑选逻辑
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(payload))
      return
    }
    if (url.pathname.startsWith('/download/')) {
      // 只认这两个名字，避免被当成任意文件服务器
      const name = decodeURIComponent(url.pathname.slice('/download/'.length))
      if (name !== installerName && name !== previewName) {
        res.writeHead(404); res.end('not found'); return
      }
      res.writeHead(200, {
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(installer.length),
      })
      res.end(installer)
      return
    }
    res.writeHead(404); res.end('not found')
  })

  return {
    server,
    installer,
    digest,
    installerName,
    previewName,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', () => {
        origin = `http://127.0.0.1:${server.address().port}`
        resolve(origin)
      })
    }),
    close: () => new Promise((resolve) => server.close(() => resolve())),
    get origin() { return origin },
  }
}

module.exports = { createMockUpdateServer, makeInstallerBytes, sha256Hex, DEFAULT_VERSION, ASSET_NAME, PREVIEW_ASSET_NAME }

if (require.main === module) {
  const args = process.argv.slice(2)
  const portArg = args.indexOf('--port')
  const mock = createMockUpdateServer({
    port: portArg >= 0 ? Number(args[portArg + 1]) : 18499,
    withDigest: !args.includes('--no-digest'),
    updateAvailable: !args.includes('--no-update'),
    manifestMode: args.includes('--tamper-manifest') ? 'tampered' : (args.includes('--no-manifest') ? 'absent' : 'ok'),
  })
  mock.listen().then((origin) => {
    console.log(`[mock-update] ${origin}/releases/latest`)
    console.log(`[mock-update] 场景：${mock.installerName} · ${args.includes('--no-digest') ? '无 digest（size-only）' : '带 sha256 digest'}${args.includes('--no-update') ? ' · 无新版本' : ''}`)
    console.log('[mock-update] Ctrl+C 结束')
  }).catch((err) => {
    console.error('[mock-update] 启动失败：', err.message)
    process.exitCode = 1
  })
}
