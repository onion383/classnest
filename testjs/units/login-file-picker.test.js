// =========================================================================
// login-file-picker.test.js —— 「从数据库登录」是**唯一**的文件入口
//
// 背景：v3 备份包接入时先加过一个独立的「从备份包恢复」入口，因为主进程的文件选择器
// 只能给路径、渲染层拿不到 File。两个入口 = 用户要在两个按钮之间猜哪个能用。
// 现在统一成渲染层的一个 `<input type="file" accept=".db,.json,.zip">`，按扩展名分派。
//
// 这条通道的清理有**三处**必须同时到位，漏一处就是运行时故障或白名单失配：
//   ① Login.vue 的调用点（改完就没有任何调用方）
//   ② electron/ipc-channels.json（preload 白名单）
//   ③ electron/ipc-policy.json（授权表，生成物，要重跑生成器而不是手改）
// 所以这里的判据不止测 UI，也把这三处钉住 —— 将来谁想加回第二条入口，会先红一次。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')
const test = require('node:test')
const assert = require('node:assert/strict')

const ROOT = path.resolve(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('登录页只有一个文件选择器，且三种扩展名都接受', () => {
  // 注释里会提到 `<input type="file">`（解释为什么用它），先剥掉，否则判据算的是字面量而不是真实元素
  const src = read('student-frontend/src/views/Login.vue')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^\s*\/\/.*$/gm, '')
  const inputs = src.match(/<input[^>]*type="file"[^>]*>/g) || []
  assert.equal(inputs.length, 1, `只该有一个 <input type="file">，实际 ${inputs.length} 个 —— 多出来的就是第二个入口`)
  assert.match(inputs[0], /accept="\.db,\.json,\.zip"/, 'accept 必须覆盖三种：库文件 / 旧备份包 / 整包备份')
  assert.match(inputs[0], /@change="onPickFile"/, '必须挂到统一的分派函数')
})

test('分派函数覆盖三种文件，且 .zip 走 File 句柄而不是路径', () => {
  const src = read('student-frontend/src/views/Login.vue')
  assert.match(src, /\\.zip\$\/i\.test\(name\)/, '缺少 .zip 分支')
  assert.match(src, /\.json\$\/i\.test\(name\)/, '缺少 .json 分支')
  assert.match(src, /axios\.post\('\/api\/db-login', \{ file: name \}\)/, '.db 分支必须只交文件名（后端按名找登记）')
  // 旧的「按路径分流」实现必须彻底删掉，否则两套逻辑并存
  assert.ok(!/openDbPicker/.test(src), '旧的 openDbPicker 必须删除，不能留着当第二条入口')
  assert.ok(!/SELECT_DB_FILE/.test(src), '登录页不该再引用 select-db-file 通道')
})

test('v2 JSON 备份通道已整体下线：解析分支、恢复接口、状态字段都不许回潮', () => {
  const src = read('student-frontend/src/views/Login.vue')
  // 原先这里判的是「v2 的 .json 必须自己判 64MB 上限」—— 那条前提随着 v2 下线消失了。
  // 现在要守的是相反的事：不许有人把 v2 那条「全文读进内存 + base64 恢复」的通路加回来。
  assert.ok(!/pickJsonBundle/.test(src), 'v2 的 JSON 解析函数必须已删除')
  assert.ok(!/restoreBundle/.test(src), 'v2 的整包状态字段必须已删除')
  assert.ok(!/account\/restore-offline/.test(src), 'v2 的离线恢复接口不能再被调用')
  assert.match(src, /旧版 JSON 备份已不再支持/, '选到 .json 要给出可读提示，不能静默什么都不做')
})

test('通道清理三处对账：调用点 / 通道清单 / 授权表都不再有 select-db-file', () => {
  const channels = JSON.parse(read('electron/ipc-channels.json'))
  const all = [...channels.send, ...channels.invoke, ...channels.receive]
  assert.ok(!all.includes('select-db-file'), 'ipc-channels.json 里还留着 —— preload 会继续放行一个没人用的通道')

  const policy = JSON.parse(read('electron/ipc-policy.json'))
  assert.ok(!Object.prototype.hasOwnProperty.call(policy, 'select-db-file'), 'ipc-policy.json 里还留着（它是生成物，要重跑 testjs/probe/ipc-policy-gen.mjs）')

  const dialogs = read('electron/main/main.dialogs.js')
  assert.ok(!/ipcMain\.handle\('select-db-file'/.test(dialogs), '主进程 handler 还留着 = 死代码')
})
