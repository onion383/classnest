// =========================================================================
// gen-channels.mjs —— 由 electron/ipc-channels.json 生成 electron/main/channels.js
//
// 用法：
//   node testjs/tools/gen-channels.mjs          写入 channels.js
//   node testjs/tools/gen-channels.mjs --check  只检查是否与 JSON 同源（漂移退出码 1）
//
// 为什么不直接 require JSON 当常量用：
//   主进程要的是「拼错的通道名在写代码时就报错」，而不是运行期才发现 undefined。
//   生成常量表后，调用点写 CH.WIDGET_RESIZE，改名时 TypeScript 式的引用能被全局搜索到。
// =========================================================================
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const JSON_PATH = path.join(ROOT, 'electron', 'ipc-channels.json')
export const OUT_PATH = path.join(ROOT, 'electron', 'main', 'channels.js')

// 通道名 → 常量名：kebab-case → UPPER_SNAKE_CASE
export function keyOf(name) {
  return name.toUpperCase().replace(/-/g, '_')
}

const SECTIONS = [
  ['send', 'send —— 渲染层 → 主进程（单向）'],
  ['invoke', 'invoke —— 渲染层 → 主进程（请求-响应）'],
  ['receive', 'receive —— 主进程 → 渲染层（推送）'],
]

// 纯渲染函数：输入解析后的 JSON，输出 channels.js 全文。
// 测试会拿它和仓库里的文件逐字节比对，确保「生成器改了但没重新生成」会变红。
export function renderChannels(json) {
  const keys = new Set()
  const lines = [
    '// =========================================================================',
    '// channels.js —— 主进程 IPC 通道名的唯一来源',
    '//',
    '// 本文件由 testjs/tools/gen-channels.mjs 从 electron/ipc-channels.json 生成，',
    '// **不要手改**：改名单请改 JSON，再运行 `npm run channels:gen`。',
    '//',
    '// 为什么生成而不是手写：ipc-channels.json 已是 preload 白名单与渲染层常量的',
    '// 唯一来源；主进程若继续写 ipcMain.handle(\'...\') 字面量，同一份名单就有两份，',
    '// 改名时只改一侧会变成运行期「通道不存在」。',
    '//',
    '// IPC 包装在调用时才取 ipcMain：main.ipc-auth.js 会在启动最早期替换',
    '// ipcMain.handle / ipcMain.on 挂发送方校验，提前 bind 原始方法会绕过鉴权。',
    '// 同时这里不在顶层 require(\'electron\')，普通 node 单测可以直接 import 本模块。',
    '// =========================================================================',
    '',
    'const CH = Object.freeze({',
  ]

  for (const [section, title] of SECTIONS) {
    const list = json[section]
    if (!Array.isArray(list)) throw new Error(`ipc-channels.json 缺少 ${section} 数组`)
    lines.push(`  // ---- ${title} ----`)
    for (const name of list) {
      const key = keyOf(name)
      if (keys.has(key)) throw new Error(`通道常量重名：${key}（${name}）`)
      keys.add(key)
      lines.push(`  ${key}: '${name}',`)
    }
  }

  lines.push(
    '})',
    '',
    'function getIpcMain() {',
    "  return require('electron').ipcMain",
    '}',
    '',
    'const IPC = Object.freeze({',
    '  handle(channel, listener) {',
    '    return getIpcMain().handle(channel, listener)',
    '  },',
    '  on(channel, listener) {',
    '    return getIpcMain().on(channel, listener)',
    '  },',
    '  once(channel, listener) {',
    '    return getIpcMain().once(channel, listener)',
    '  },',
    '})',
    '',
    'module.exports = { CH, IPC }',
    ''
  )
  return lines.join('\n')
}

export function readChannelsJson() {
  return JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'))
}

export function generate() {
  const text = renderChannels(readChannelsJson())
  fs.writeFileSync(OUT_PATH, text)
  return text
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isCli) {
  const check = process.argv.includes('--check')
  const text = renderChannels(readChannelsJson())
  if (check) {
    const current = fs.existsSync(OUT_PATH) ? fs.readFileSync(OUT_PATH, 'utf8') : ''
    if (current !== text) {
      console.error('channels.js 与 ipc-channels.json 不同源，请运行 npm run channels:gen')
      process.exit(1)
    }
    console.log('channels.js 与 ipc-channels.json 同源')
  } else {
    fs.writeFileSync(OUT_PATH, text)
    console.log(`已生成 ${path.relative(ROOT, OUT_PATH)}`)
  }
}
