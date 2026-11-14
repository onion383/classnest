// =========================================================================
// multi-class.test.js —— 「一个账号多个班级」接线判据
//
// 设计：一班一库（不是一库多班）。每班是独立的加密库，账号凭证统一在 index.db 的
// accounts 表，registry.account_id / class_name 把两者连起来。
//
// 这里只锁**接线形态**（改了会静默坏掉的那种），不放行为断言 ——
// 行为（数据是否真的隔离、越权是否被拒）由 testjs/smoke/multi-class-test.cjs 用真后端覆盖。
//
// 每条判据都对应一个「写漏了不会报错、只会悄悄失效」的点：
//   · 切班不校验归属 → 拿到别人的 slug 就能读别人的库
//   · 切班不重签 token → dbSlug 在 JWT 里，服务端改了前端不知道，看起来点了没反应
//   · 切班不同步会话 dbSlug → 改密按 (userId, dbSlug) 吊销时会漏掉这个 sid
//   · 改密不同步 accounts → 切到另一个班，新密码不生效（校验读的还是旧哈希）
//   · 建库不写 class_name → 登录时列班级全是空名
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// 取某个路由 handler 的正文（从声明到下一个顶层 '\n});'）
function handlerBody(src, marker) {
  const start = src.indexOf(marker)
  assert.ok(start > 0, `没找到 ${marker}`)
  const end = src.indexOf('\n});', start)
  assert.ok(end > start, `${marker} 的 handler 没有正常闭合`)
  return src.slice(start, end)
}

test('多班级：切班必须校验归属、确认能打开、重签 token', () => {
  const src = read('student-backend/routes/account.js')
  const body = handlerBody(src, "router.post('/switch-class'")

  assert.match(body, /rec\.username !== u\.username/,
    '必须校验目标班属于当前账号 —— 否则拿到别人的 slug 就能读到别人的库')
  assert.match(body, /resolveClass\(/,
    '换 token 前必须先确认目标库真能打开，否则切过去每个请求都 500')
  assert.match(body, /useJwt\(\)\.sign\(/,
    '必须重签 token：dbSlug 写在 JWT 里，只改服务端状态前端不知道，看起来就是「点了没反应」')
  assert.match(body, /sessions\.setSlug\(/,
    '会话里的 dbSlug 要同步，否则改密按 (userId, dbSlug) 吊销时会漏掉这个 sid')
})

test('多班级：登录返回班级列表，并把老账号懒迁移到 accounts', () => {
  const src = read('student-backend/routes/auth.js')
  assert.match(src, /classes:\s*dbManager\.listClasses\(/,
    '登录响应必须带班级列表，否则前端没得选')
  assert.match(src, /accountFindByUsername/,
    '登录要先查 accounts（多班级后凭证的权威位置）')
  assert.match(src, /linkAccount\(/,
    '老账号第一次登录时要补 accounts 行并回填归属，否则它永远列不出班级')
  assert.match(src, /resolveClass\(/,
    '登录要支持指定 classSlug（从某个班直接进入）')
})

test('多班级：改密必须同步 accounts.password_hash', () => {
  const src = read('student-backend/routes/account.js')
  const body = handlerBody(src, "router.put('/password'")
  assert.match(body, /accountSetPassword\(/,
    '改密不写 accounts，另一个班登录时用的还是旧哈希 —— 用户会以为密码没改成')
})

test('多班级：建库必须写班名并归属到账号', () => {
  const src = read('student-backend/dbManager/dbManager.account.js')
  const start = src.indexOf('function createTeacher')
  assert.ok(start > 0, '没找到 createTeacher')
  const body = src.slice(start, start + 1600)
  assert.match(body, /registrySetClassName\(slug/,
    '班名要写进 registry —— 登录时列班级读的就是它（那时还没开库）')
  assert.match(body, /linkAccount\(username/,
    '新库要归属到账号，否则切班列表里看不到它')
})

test('多班级：改班名同步到登记表（否则登录列表显示旧名）', () => {
  const src = read('student-backend/routes/widgetSettings.js')
  const body = handlerBody(src, "router.put('/class-info'")
  assert.match(body, /registrySetClassName\(req\.user\.dbSlug/,
    '库内 class_info 是真相，但登录时读不到库；不同步 registry 会一直显示旧班名')
})

test('多班级：改用户名要同步所有班级与 accounts', () => {
  const src = read('student-backend/routes/account.js')
  const body = handlerBody(src, "router.put('/username'")
  assert.match(body, /registryFindAllByUsername\(/,
    '账号名是账号维度属性：只改当前行的 registry，切到别的班按新名一条登记都查不到')
  assert.match(body, /accountRename\(/,
    'accounts.username 是注册查重与登录定位的依据，不跟着改会造出一个「新名字的重复账号」')
})

test('多班级：吊销会话要覆盖该账号全部班级', () => {
  const src = read('student-backend/routes/account.js')
  assert.match(src, /function accountSlugsForRevoke\(user\)[\s\S]{0,600}dbManager\.listClasses\(/,
    '只吊销当前班会让另一个班窗口的旧 token 在改密后继续有效')
  const svc = read('student-backend/services/credentialChange.js')
  assert.match(svc, /Array\.isArray\(dbSlug\)/,
    'revokeAccountSessions 必须支持 slug 数组（多班级账号）')
})

// 登录签发的 username 必须是「账号维度」的名字，不能取库内 users.username。
// 为什么立这条（13:05 冒烟实测 404）：改名只同步 registry / accounts，各库内 users 表
// 刻意不同步（挨个开库改名要 N 次 KDF）。登录时按新名在库里查不到，会退回首条 ——
// 那条的 username 是旧名。用它签 token，switch-class 的归属校验
// （rec.username !== u.username）就把用户自己名下的另一个班判成「班级不存在」。
// 症状是：改名成功、能重新登录、能列出 2 个班，但一点切换就 404。
test('多班级：登录 token 的 username 取自 accounts，不取库内 users 表', () => {
  const src = read('student-backend/routes/auth.js')
  const start = src.indexOf("router.post('/login'")
  assert.ok(start > 0, "没找到 router.post('/login'")
  const body = src.slice(start, src.indexOf("router.post('/register'", start))
  assert.ok(body.length > 0, '/login 段落没有正常闭合')

  assert.match(body, /const authName = \(acc && acc\.username\) \|\| String\(username\)/,
    '缺少 authName：直接用 user.username 会把库内的旧名签进 token')
  assert.match(body, /issueSession\(req, \{\s*userId: user\.id,\s*username: authName/,
    'issueSession 必须用 authName 签发，否则改名后切班 404')
  assert.match(body, /username: authName, role: user\.role, dbSlug/,
    '响应体里的 user.username 也要用 authName，否则前端显示旧名')
})

// 删除当前班级：最容易写错的是「会话迁移」与「吊销」的先后。
// 先吊销再迁移，会把当前窗口自己的 sid 一起删掉 —— 表现是删完班立刻被踢回登录页；
// 迁移放在删库之前，则 token 会短暂指向一个已经不存在的库。
// 唯一班级必须拒绝：删完这个账号就没有任何库可用，而那件事的入口叫「删除账号」。
test('多班级：删除班级只删一个库，会话迁移必须在吊销之前', () => {
  const src = read('student-backend/routes/account.js')
  const body = handlerBody(src, "router.delete('/class'")

  assert.match(body, /classes\.length <= 1/, '唯一班级必须拒绝，不能顺手把账号也删了')
  assert.match(body, /dbManager\.deleteTeacher\(current\)/, '没有真正删库')
  assert.match(body, /X-Renewed-Token/, '新 token 必须随响应头下发，否则前端拿不到切班后的凭据')

  const iSetSlug = body.indexOf('sessions.setSlug(u.sid, target.slug)')
  const iRevoke = body.indexOf('revokeAccountSessions(u.userId, current)')
  assert.ok(iSetSlug > 0, '缺少 sessions.setSlug：会话会一直指着已删的库')
  assert.ok(iRevoke > 0, '缺少对旧班的会话吊销：同班其它窗口会持续请求一个不存在的库')
  assert.ok(iSetSlug < iRevoke,
    '顺序反了：setSlug 必须在吊销之前，否则当前窗口自己也一并被吊销，删完班立刻被踢回登录')
})

// 设置页危险区的「删除该班级」。
// 立这条的两个点都是静默失效型：倒计时删掉不会有任何报错（只是少了一道防误删）；
// classCount 漏拉则入口永远不出现（用户以为功能没做）。
test('设置页：删除该班级入口走 10 秒倒计时，且仅多班级显示', () => {
  const vue = read('student-frontend/src/views/SettingsView/SettingsView.vue')
  assert.match(vue, /@click="openDeleteClass"/, '危险区没有「删除该班级」入口')
  assert.match(vue, /v-if="classCount > 1"/,
    '没有按班级数收起入口：单班账号会看到一个点下去必然被拒的按钮')
  assert.match(vue, /ctx\.loadClasses\(\)/, '没有在初始化时拉班级列表，classCount 永远是 0')

  const js = read('student-frontend/src/views/SettingsView/SettingsView.data.js')
  const start = js.indexOf('async openDeleteClass()')
  assert.ok(start > 0, '没找到 openDeleteClass')
  const seg = js.slice(start, js.indexOf('async performDeleteClass()'))
  assert.match(seg, /confirmText: '确定\(10\)'/, '倒计时初始文案丢了（应显示 确定(10)）')
  assert.match(seg, /confirmDisabled: true/, '确定按钮初始必须置灰，否则倒计时形同虚设')
  assert.match(seg, /ctx\.deleteTimer = setInterval/, '没有倒计时定时器')
  assert.match(seg, /classes\.length <= 1/, '弹窗前应拦住唯一班级，不该让用户数满 10 秒才被拒')

  // 删完是换库，必须和切班走同一条收尾
  const perf = js.slice(js.indexOf('async performDeleteClass()'), js.indexOf('async exportDb()'))
  assert.ok(perf.length > 0, 'performDeleteClass 段落切片失败（方法顺序变了？）')
  assert.match(perf, /resetUserScopedCaches\(\)/, '删班后没清模块级缓存，页面会显示已删班的数据')
  assert.match(perf, /bumpClassScope\(\)/, '删班后没作废缓存的视图实例，界面不会刷新到剩下的班')
})

// 危险区里「删除账号」和「删除该班级」必须是同一套按钮样式。
// 两者都是不可恢复的破坏性操作，样式一实一虚会暗示「其中一个没那么严重」。
test('危险区：两个删除按钮样式一致', () => {
  const vue = read('student-frontend/src/views/SettingsView/SettingsView.vue')

  const account = vue.match(/@click="openDeleteAccount"\s+class="([^"]+)"/)
  assert.ok(account, '没找到删除账号按钮')
  const cls = account[1]
  assert.match(cls, /bg-danger/, '删除账号不是实心红底')

  const at = vue.indexOf('@click="openDeleteClass"')
  assert.ok(at > 0, '危险区缺少删除该班级入口')
  const seg = vue.slice(at, at + 320)
  assert.match(seg, /bg-danger/, '删除该班级没跟删除账号用同一套样式（应为实心红底）')
  assert.ok(!/border-danger/.test(seg),
    '删除该班级又变回描边样式：和删除账号不一致，看起来像"没那么严重"')
})
