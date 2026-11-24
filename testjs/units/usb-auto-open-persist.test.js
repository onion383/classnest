// =========================================================================
// usb-auto-open-persist.test.js —— USB 开关写盘失败不能假装成功（#46）
//
// 原缺陷：saveUsbAutoOpenConfig 吞掉 fs.writeFileSync 的异常且不返回状态；
// IPC 先改运行时开关再调保存，无论写没写成都返回 { enabled }。前端把它当成功，
// 只有 invoke reject 才记错误。于是 userData 不可写时：界面显示「已启用」、
// 当前进程也确实在监听，但文件没写 → 重启后 loadUsbAutoOpenConfig 回退 false，
// 用户的选择静默丢失。
//
// 判据：① 行为：saveUsbAutoOpenConfig 写盘异常时必须报告失败（带原因）；
//       ② 顺序：IPC 先落盘、后改运行时状态，失败分支直接返回且不改开关；
//       ③ 前端：收到 saved:false 时回滚展示值并提示。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const USB = path.join(ROOT, 'electron/main/main.usb.js')
const APPEARANCE = path.join(ROOT, 'student-frontend/src/views/SettingsView/SettingsView.appearance.js')

// 抠普通函数（跳过参数括号，再按大括号配平）
function extractFn(src, name) {
  const start = src.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `找不到 function ${name}`)
  const parenOpen = src.indexOf('(', start)
  let pd = 0
  let parenClose = parenOpen
  for (let i = parenOpen; i < src.length; i += 1) {
    if (src[i] === '(') pd += 1
    else if (src[i] === ')') { pd -= 1; if (pd === 0) { parenClose = i; break } }
  }
  const open = src.indexOf('{', parenClose)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`function ${name} 的大括号没有配平`)
}

// 抠对象方法简写：`async onXxx(v) { ... }`
function extractMethod(src, name) {
  const start = src.indexOf(`async ${name}(`)
  assert.ok(start >= 0, `找不到 async ${name}(`)
  const parenOpen = src.indexOf('(', start)
  let pd = 0
  let parenClose = parenOpen
  for (let i = parenOpen; i < src.length; i += 1) {
    if (src[i] === '(') pd += 1
    else if (src[i] === ')') { pd -= 1; if (pd === 0) { parenClose = i; break } }
  }
  const open = src.indexOf('{', parenClose)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`async ${name} 的大括号没有配平`)
}

function loadUsbSave(writeFileSync) {
  const src = fs.readFileSync(USB, 'utf8')
  const pathFn = extractFn(src, 'getUsbConfigPath')
  const saveFn = extractFn(src, 'saveUsbAutoOpenConfig')
  // saveUsbAutoOpenConfig 已改用 main.atomic-write 的原子写；单测按同一语义注入
  // 一个「直接落盘」的替身（真实原子写另有 atomic-write.test.js 覆盖 tmp+rename）。
  const atomicStub = (file, obj) => writeFileSync(file, JSON.stringify(obj))
  const factory = new Function(
    'fs', 'path', 'app', 'atomicWriteJsonSync',
    `${pathFn}\n${saveFn}\nreturn { getUsbConfigPath, saveUsbAutoOpenConfig };`,
  )
  return factory(
    { writeFileSync },
    path,
    { getPath: () => path.join(ROOT, '.tmp-test-userdata') },
    atomicStub,
  )
}

// 返回一个 (ctx, window, INVOKE) => handler 的装配函数
function loadFrontHandler() {
  const src = fs.readFileSync(APPEARANCE, 'utf8')
  const method = extractMethod(src, 'onUsbAutoOpenChange')
  const factory = new Function(
    'ctx', 'window', 'INVOKE',
    `const obj = { ${method} };\nreturn obj.onUsbAutoOpenChange;`,
  )
  return (ctx, win, INVOKE) => factory(ctx, win, INVOKE)
}

test('写盘成功：返回 ok:true，且文件内容是可读回的 { enabled }', () => {
  let written = null
  const api = loadUsbSave((_file, data) => { written = data })
  const res = api.saveUsbAutoOpenConfig(true)
  assert.equal(res.ok, true)
  assert.deepEqual(JSON.parse(written), { enabled: true })
  assert.ok(api.getUsbConfigPath().endsWith('usb-auto-open.json'))
})

test('写盘失败：必须报告失败与原因，不能静默吞掉', () => {
  const api = loadUsbSave(() => { throw new Error('EACCES: permission denied') })
  const res = api.saveUsbAutoOpenConfig(false)
  assert.equal(res.ok, false, '写盘失败要能被调用方看见')
  assert.match(res.error, /EACCES/, '原因要传出去，便于提示用户')
})

test('IPC 顺序：先落盘成功，才改运行时开关', () => {
  const src = fs.readFileSync(USB, 'utf8')
  const start = src.indexOf('IPC.handle(CH.SET_USB_AUTO_OPEN')
  assert.ok(start >= 0, '找不到 SET_USB_AUTO_OPEN handler')
  const handler = src.slice(start, src.indexOf('\n  })', start))

  const saveAt = handler.indexOf('saveUsbAutoOpenConfig(next)')
  const assignAt = handler.indexOf('usbAutoOpenEnabled = next')
  assert.ok(saveAt >= 0, 'handler 应调用 saveUsbAutoOpenConfig')
  assert.ok(assignAt > saveAt, '必须先落盘再改内存状态（否则失败时界面已显示开启）')
  assert.match(handler, /if \(!saved\.ok\)/, '失败分支必须提前返回')
  assert.match(handler, /saved: false/, '失败要回报给前端')
  assert.match(handler, /saved: true/, '成功也要明确回报')
})

test('前端收到 saved:false：回滚展示值并提示', async () => {
  const mount = loadFrontHandler()
  const ctx = {
    usbAutoOpen: { value: false },
    notices: [],
    notifyError(msg) { this.notices.push(msg) },
  }
  const win = { electron: { invoke: async () => ({ enabled: true, saved: false, error: '磁盘只读' }) } }
  const onUsbAutoOpenChange = mount(ctx, win, { SET_USB_AUTO_OPEN: 'set-usb-auto-open' })

  await onUsbAutoOpenChange(true)

  assert.equal(ctx.usbAutoOpen.value, false, '写盘失败要回到原来的值，不能假装已启用')
  assert.equal(ctx.notices.length, 1, '要告诉用户设置没保存成功')
  assert.match(ctx.notices[0], /磁盘只读/)
})

test('写盘成功：保留新值、不打扰用户', async () => {
  const mount = loadFrontHandler()
  const ctx = {
    usbAutoOpen: { value: false },
    notices: [],
    notifyError(msg) { this.notices.push(msg) },
  }
  const win = { electron: { invoke: async () => ({ enabled: true, saved: true }) } }
  const onUsbAutoOpenChange = mount(ctx, win, { SET_USB_AUTO_OPEN: 'set-usb-auto-open' })

  await onUsbAutoOpenChange(true)

  assert.equal(ctx.usbAutoOpen.value, true)
  assert.deepEqual(ctx.notices, [])
})

test('调用本身抛错：同样回滚（原来只打日志，界面留着假状态）', async () => {
  const mount = loadFrontHandler()
  const ctx = {
    usbAutoOpen: { value: false },
    notices: [],
    notifyError(msg) { this.notices.push(msg) },
  }
  const win = { electron: { invoke: async () => { throw new Error('通道不存在') } } }
  const onUsbAutoOpenChange = mount(ctx, win, { SET_USB_AUTO_OPEN: 'set-usb-auto-open' })

  await onUsbAutoOpenChange(true)
  assert.equal(ctx.usbAutoOpen.value, false, '异常时也要回滚展示值')
})
