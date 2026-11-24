// =========================================================================
// ipc-binary-payload.test.js —— IPC 大对象载荷（v8 · P3-07 / N2-07）
//
// 事故面：
//   ① 背景图大于 2MB 时前端 FileReader 读成 base64 再 invoke —— 字符串凭空放大 4/3，
//      主进程还要再解码出一份等量 Buffer，峰值内存 ≈ 原件 × 3。
//   ② 业务 ZIP 整包经 SAVE_FILE 进 IPC，50MB 以上直接被拒，且整包要过两次拷贝。
// 判据：
//   ① 背景图走 ArrayBuffer（二进制），main 只接受 ArrayBuffer/TypedArray，且不再出现 base64；
//   ② 业务 ZIP 走磁盘中转：后端落临时目录 → 主进程只搬文件，且只允许搬该目录内的 .zip。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const { ROOT } = require('./_db-express-fixture.cjs')
const { analyze, walk } = require('../_source-scan.cjs')

/** 找到 IPC.handle(CH.<name>, handler) 的 handler 实参范围。 */
function handlerRange(srcAst, src, channelName) {
  let found = null
  walk(srcAst, (node) => {
    if (found) return
    if (node.type !== 'CallExpression') return
    const callee = node.callee
    if (callee.type !== 'MemberExpression' || callee.property.name !== 'handle') return
    const first = node.arguments[0]
    const handler = node.arguments[node.arguments.length - 1]
    if (!first || !handler || first.start == null) return
    if (src.slice(first.start, first.end).includes(channelName)) {
      found = { start: handler.start, end: handler.end }
    }
  })
  return found
}

test('背景图：大于 2MB 走 ArrayBuffer，主进程拒收非二进制', () => {
  const front = fs.readFileSync(path.join(
    ROOT, 'student-frontend/src/views/SettingsView/SettingsView.appearance.js'), 'utf8')
  assert.ok(front.includes('buffer: await file.arrayBuffer()'), '大图必须直接传 ArrayBuffer')
  assert.ok(!front.includes('base64Data'), '大图分支不能再出现 base64 中转')

  const main = fs.readFileSync(path.join(ROOT, 'electron/main/main.dialogs.js'), 'utf8')
  const range = handlerRange(analyze(main).ast, main, 'SAVE_BACKGROUND_IMAGE')
  assert.ok(range, '找不到 SAVE_BACKGROUND_IMAGE 处理器')
  const body = main.slice(range.start, range.end)
  assert.match(body, /buffer instanceof ArrayBuffer/, '必须以 ArrayBuffer 为入参')
  assert.ok(!body.includes('base64'), '处理器里不能再解 base64')
})

test('业务 ZIP：磁盘中转 + 只允许搬导出临时目录内的 .zip', () => {
  const backend = fs.readFileSync(path.join(ROOT, 'student-backend/routes/dataExport.js'), 'utf8')
  assert.ok(backend.includes("'/zip-to-file'"), '后端必须提供磁盘中转端点')
  assert.ok(backend.includes("require('os').tmpdir(), 'classnest-export'"), '临时目录必须与主进程同名')

  const saveFile = fs.readFileSync(path.join(ROOT, 'student-frontend/src/utils/saveFile.js'), 'utf8')
  assert.ok(saveFile.includes('/api/data/zip-to-file'), '前端必须调用中转端点')
  assert.ok(saveFile.includes('SAVE_FILE_FROM_PATH'), '前端必须用搬文件通道而不是 SAVE_FILE')

  const main = fs.readFileSync(path.join(ROOT, 'electron/main/main.dialogs.js'), 'utf8')
  const range = handlerRange(analyze(main).ast, main, 'SAVE_FILE_FROM_PATH')
  assert.ok(range, '找不到 SAVE_FILE_FROM_PATH 处理器')
  const body = main.slice(range.start, range.end)
  assert.ok(main.includes("require('os').tmpdir(), 'classnest-export'"), '必须与后端的临时目录同名')
  assert.match(body, /path\.resolve\(EXPORT_TMP_DIR\)/, '必须用同一临时目录做白名单')
  assert.match(body, /startsWith\(tmpRoot \+ path\.sep\)/, '必须限制源路径在临时目录内')
  assert.match(body, /!== '\.zip'/, '只允许搬 zip')
  assert.ok(!body.includes('MAX_WRITE_BYTES'), '磁盘中转不应再受 50MB IPC 上限')
})
