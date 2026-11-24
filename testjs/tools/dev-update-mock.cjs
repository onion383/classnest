// =========================================================================
// dev-update-mock.cjs —— 一条命令启动「本地 mock Release + 开发版班集」
//
// 用法：
//   npm run dev:update-mock                  # mock + Vite + Electron
//   npm run dev:update-mock -- --no-digest   # 演示发布资产无 digest 的 size-only 降级
//   npm run dev:update-mock -- --no-manifest   # 演示独立清单缺失时的用户可见告警
//   npm run dev:update-mock -- --tamper-manifest # 演示清单与资产摘要冲突 → 拒装
//   npm run dev:update-mock -- --electron-only  # Vite 已在跑时只起 mock + Electron
//
// 启动后进「关于软件 → 版本更新」即可看到完整流程。假包只会被定位、不会被执行。
// =========================================================================
const { spawn } = require('node:child_process')
const path = require('node:path')
const { createMockUpdateServer } = require('./mock-update-server.cjs')

const ROOT = path.resolve(__dirname, '../..')

async function main() {
  const args = process.argv.slice(2)
  const electronOnly = args.includes('--electron-only')
  const withDigest = !args.includes('--no-digest')
  const manifestMode = args.includes('--tamper-manifest') ? 'tampered' : (args.includes('--no-manifest') ? 'absent' : 'ok')
  const mock = createMockUpdateServer({ withDigest, manifestMode })
  const origin = await mock.listen()

  console.log(`[dev-update-mock] mock Release：${origin}/releases/latest`)
  console.log('[dev-update-mock] 进「关于软件 → 版本更新」触发；「打开安装包」只定位假包，不执行。')

  const child = spawn('npm', ['run', electronOnly ? 'electron' : 'electron:dev'], {
    cwd: ROOT,
    env: { ...process.env, CLASSNEST_UPDATE_MOCK_BASE: origin },
    stdio: 'inherit',
    shell: true,
  })

  let closing = false
  const shutdown = async (code) => {
    if (closing) return
    closing = true
    try { child.kill('SIGTERM') } catch (_) { /* 已退出 */ }
    try { await mock.close() } catch (_) { /* 已关闭 */ }
    process.exit(code)
  }
  process.on('SIGINT', () => shutdown(0))
  process.on('SIGTERM', () => shutdown(0))
  child.on('exit', (code) => shutdown(code == null ? 0 : code))
}

main().catch((err) => {
  console.error('[dev-update-mock] 启动失败：', err)
  process.exit(1)
})
