// =========================================================================
// ipc-handler-contract.test.js —— 主进程 invoke 处理器必须有统一错误出口
//
// 为什么钉住：渲染层拿到的错误形态取决于主进程写法。没有包装时，处理器里抛出的
// 异常会变成 "Error invoking remote method ..." 这种带内部栈的串；有包装时统一是
// ok()/fail() 对象或可读 message。新增通道漏包装很难在代码评审里看出来，用探针兜住。
//
// 例外白名单只有两类（与 E01-03 / X1-04 的结论一致）：
//   1) 纯内存 getter：不碰磁盘/网络，正常路径不会抛；
//   2) 文件内已自带 try/catch（自己 return fail/ok）。
// 新增例外必须在这里登记并写理由，否则测试失败。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const MAIN_DIR = abs('electron/main')

// 例外通道 → 理由
const ALLOW = new Map([
  ['APPS_RESOLVE_PATHS', '内部逐路径 try/catch，失败项直接跳过'],
  ['BACKEND_FAILURE', '纯内存 getter'],
  ['BACKEND_STATUS', '纯内存 getter'],
  ['BOOT_STATUS', '纯内存 getter'],
  ['GET_MCP_LAUNCH_INFO', '纯内存 getter'],
  ['GET_DATA_DIRECTORIES', '纯内存 getter'],
  ['OPEN_EXTERNAL', 'shell.openExternal 自带 .catch'],
  ['GET_MASTER_KEY', '纯内存 getter'],
  ['SET_CONTENT_PROTECTION', '内部原生调用已 try/catch'],
  ['GET_PENDING_NOTIFICATION', '纯内存 getter'],
  ['LAUNCH_PLAN', '纯内存 getter'],
  ['GET_SETUP_WARMUP', '纯内存 getter'],
  ['PERF_RESTART_FRONTEND', '纯内存/窗口调用，异常可忽略'],
  ['PERF_RESTART_WIDGET', '内部重建已 try/catch'],
  ['PERF_RELAUNCH_APP', 'app.relaunch/quit 无异步失败面'],
  ['PERF_STARTUP', '纯内存 getter'],
  ['GET_APP_VERSION', '纯内存 getter'],
  ['GET_USB_AUTO_OPEN', '纯内存 getter'],
  ['GET_DESKTOP_LAYER_STATE', '纯内存 getter'],
  ['GET_SESSION_WIDGET_VISIBLE', '纯内存 getter'],
  ['SECURE_HANDSHAKE', '内部 try/catch 后 return fail'],
  ['PERF_DISK_USAGE', '内部 try/catch 后 return fail'],
  ['PERF_LOGS_CLEAR', '内部逐文件 try/catch，整体再兜一层'],
  ['PERF_CACHE_CLEAR', '内部逐目录 try/catch，整体再兜一层'],
])

test('所有 IPC.handle 处理器要么走 safe/safeReject，要么在例外白名单里', () => {
  const bare = []
  let total = 0
  for (const file of fs.readdirSync(MAIN_DIR)) {
    if (!file.endsWith('.js')) continue
    const src = fs.readFileSync(path.join(MAIN_DIR, file), 'utf8')
    const re = /IPC\.handle\(\s*CH\.([A-Z0-9_]+)\s*,\s*([^\n]*)/g
    let m
    while ((m = re.exec(src))) {
      total += 1
      const [, channel, handler] = m
      if (/contract\.safe|safeReject|\bsafe\(/.test(handler)) continue
      if (ALLOW.has(channel)) continue
      bare.push(`${file}:${channel}`)
    }
  }
  assert.ok(total >= 40, `只扫到 ${total} 个处理器，扫描规则可能失效`)
  assert.deepEqual(bare, [], `以下处理器没有统一错误出口：\n${bare.join('\n')}`)
})

test('例外白名单没有过期项（避免删了通道还留着豁免）', () => {
  const seen = new Set()
  for (const file of fs.readdirSync(MAIN_DIR)) {
    if (!file.endsWith('.js')) continue
    const src = fs.readFileSync(path.join(MAIN_DIR, file), 'utf8')
    for (const m of src.matchAll(/IPC\.handle\(\s*CH\.([A-Z0-9_]+)/g)) seen.add(m[1])
  }
  const stale = [...ALLOW.keys()].filter((k) => !seen.has(k))
  assert.deepEqual(stale, [], `白名单里的通道已不存在：${stale.join(', ')}`)
})
