// =========================================================================
// class-scope.test.js —— 「切班不重启」接线判据
//
// 背景：业务页面全被 <KeepAlive> 缓存，切班后组件实例不会自动重挂，
// 早期实现只能 window.location.reload() 整页重来。改成「作废缓存实例」之后，
// 正确性压在两条接线上，且**写漏了都不会报错，只会静默串班**：
//
//   · KeepAlive 的 key 没绑 classScopeKey → key 从不变化，缓存实例永不作废。
//     表现：切班后页面「闪一下」但数据还是旧班的（组件根本没重挂），最难排查。
//   · 先 bump 后 reset → 新挂载的页面先读到还没清掉的模块缓存（仪表盘 dataCache、
//     photoInfoCache），把上一个班的数据又渲染一遍；随后才被清，界面不复原。
//   · 切班路径又出现 reload → 能工作，但丢滚动位置与路由，"不重启"的目标没了。
//
// 组件级行为（key 变化是否真作废缓存）由 testjs/probe/keepalive-key-probe.mjs
// 用真实 Vue 运行时验证，这里不重复造。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = process.env.CLASSNEST_ROOT || path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// 只剥整行注释：注释里大量出现 reload / requestAnimationFrame 等字样，
// 用块注释正则会连注释一起删，让「删掉正常代码」的变异假绿。
function codeOnly(src) {
  return src.split('\n').filter((l) => {
    const t = l.trim()
    return !(t.startsWith('//') || t.startsWith('*') || t.startsWith('/*'))
  }).join('\n')
}

test('班级作用域：KeepAlive 必须绑 classScopeKey', () => {
  const app = codeOnly(read('student-frontend/src/App.vue'))
  assert.match(app, /<KeepAlive\s+:key="classScopeKey"/,
    'KeepAlive 的 key 没绑 classScopeKey → 切班后缓存实例永不作废，页面显示上一个班的数据')
  assert.match(app, /import \{ classScopeKey \} from '\.\/utils\/classScope\.js'/,
    'App.vue 没有引入 classScopeKey')
  // max 是原有行为，不能被顺手删掉
  assert.match(app, /<KeepAlive[^>]*:max="16"/, 'KeepAlive 丢了 max 上限')
})

test('班级作用域：切班不得整页重载', () => {
  const dash = codeOnly(read('student-frontend/src/views/DashboardView.vue'))
  assert.ok(!/window\.location\.reload\(\)/.test(dash),
    '切班又退回整页重载：能工作，但丢掉滚动位置与当前路由，"不重启"名存实亡')
  // 切班与新建班都必须走统一收尾，否则两条路径迟早分叉
  const calls = dash.match(/applyClassSwitch\(/g) || []
  assert.ok(calls.length >= 3, `applyClassSwitch 调用点只有 ${calls.length} 个（含定义应 >=3）：切班/新建班都要走它`)
})

test('班级作用域：先清模块缓存，再作废组件实例', () => {
  const dash = codeOnly(read('student-frontend/src/views/DashboardView.vue'))
  const fn = dash.match(/function applyClassSwitch\([\s\S]{0,600}?\n\}/)
  assert.ok(fn, '没找到 applyClassSwitch：切班的统一收尾被改名或删除')
  const body = fn[0]
  const iReset = body.indexOf('resetUserScopedCaches()')
  const iBump = body.indexOf('bumpClassScope()')
  assert.ok(iReset >= 0, 'applyClassSwitch 没清模块级缓存 → 重新挂载的页面会读回上一个班的数据')
  assert.ok(iBump >= 0, 'applyClassSwitch 没作废 KeepAlive 缓存 → 页面不会重新拉新班数据')
  assert.ok(iReset < iBump,
    '顺序反了：先作废实例会在缓存还没清时重新挂载，页面先渲染一遍旧班数据')
})

test('班级作用域：代次必须真的递增', () => {
  const src = codeOnly(read('student-frontend/src/utils/classScope.js'))
  assert.match(src, /export const classScopeKey = ref\(0\)/,
    'classScopeKey 必须是响应式 ref，普通变量改 App.vue 的 key 不会触发重渲染')
  assert.match(src, /export function bumpClassScope\(\)\s*\{\s*classScopeKey\.value \+= 1/,
    'bumpClassScope 没有递增 classScopeKey')
})

// 「新增班级」是主弹窗里的二级弹窗（ClassInfoDialog → AddClassDialog）。
// 立在 z-index 上：两者都 Teleport 到 body，层级只由 z-index 决定。
// 若二级的 z-index 不高于主弹窗，它会被主弹窗压在下面 —— 表现是"点了 ＋新建班级
// 什么都没发生"，控制台无任何报错，最难排查。
test('新增班级：二级弹窗层级必须高于班级信息弹窗', () => {
  const main = codeOnly(read('student-frontend/src/components/dialogs/ClassInfoDialog.vue'))
  const sub = codeOnly(read('student-frontend/src/components/dialogs/AddClassDialog.vue'))

  assert.match(main, /<AddClassDialog/,
    'ClassInfoDialog 没有挂载 AddClassDialog：新建班级退回了内联表单（会和「改班名」混在同一屏）')
  assert.ok(!/v-model="newName"/.test(main),
    'ClassInfoDialog 里又出现了内联输入框（newName），二级弹窗被回退')

  const zOf = (src, name) => {
    const m = src.match(new RegExp(`<DialogShell[^>]*:z-index="(\\d+)"`))
    assert.ok(m, `${name} 没有显式 z-index，会退到默认 10006 与其它弹窗抢层级`)
    return Number(m[1])
  }
  const zMain = zOf(main, 'ClassInfoDialog')
  const zSub = zOf(sub, 'AddClassDialog')
  assert.ok(zSub > zMain,
    `二级弹窗 z-index(${zSub}) 不高于主弹窗(${zMain})：会被压在下面，点了「新建班级」看起来没反应`)

  assert.match(sub, /新增班级/, '二级弹窗标题丢了')
  assert.match(sub, /班级名称/, '二级弹窗缺少「班级名称」字段')
})

// 班级切换器必须是下拉，不能退回「一列按钮」。
// 理由不是审美：班级一多，一列按钮会把 440px 的弹窗撑到超出屏幕，
// 底部的「班级名称/班训」字段直接被顶出去；下拉有固定高度上限 + 内部滚动。
test('班级切换器用下拉（班级多到装不下时不会撑爆弹窗）', () => {
  const src = codeOnly(read('student-frontend/src/components/dialogs/ClassInfoDialog.vue'))

  assert.match(src, /<AppSelect/,
    '班级切换器退回了自绘列表：班级一多会撑爆弹窗')
  assert.match(src, /:options="classOptions"/, 'AppSelect 没绑 classOptions')
  // value 必须是 slug：切换接口按 slug 定位库，绑成班名会 404（而且班名可改）
  assert.match(src, /value: c\.slug/,
    'options 的 value 必须是 slug，绑班名会在改名后切不过去')
  assert.ok(!/v-for="c in classes"/.test(src),
    '又变回 v-for 一列按钮：这正是要修的问题')

  // 点当前项也会 emit change（AppSelect.commit 不判重），必须自己挡掉
  assert.match(src, /if \(!slug \|\| slug === props\.currentSlug\) return/,
    '没挡「选中的就是当前班」：会发一次无意义的切班请求')
})

// 铅笔内联重命名（下拉 ⇄ 输入框）。
// 这里锁的都是「写漏了不报错、只是行为怪」的点：
//   · 没有幂等守卫：回车提交后元素被移除，浏览器再补一次 blur → 第二次提交
//   · Esc 不取消：用户想放弃修改，结果反而把半截名字写进表单
//   · 直接调接口：这个弹窗的语义是「改完点保存」，提前请求会让「取消」变成假的
//   · 下拉当前项不跟随 form.name：改完名字下拉还显示旧名，用户以为没生效
test('班级切换器：铅笔内联重命名走表单，不直接提交', () => {
  const src = codeOnly(read('student-frontend/src/components/dialogs/ClassInfoDialog.vue'))

  assert.match(src, /:name="renaming \? 'check' : 'edit'"/, '铅笔图标/完成图标没按状态切换')
  assert.match(src, /@click="renaming \? commitRename\(\) : startRename\(\)"/, '铅笔按钮没有进入/提交两条路径')
  assert.match(src, /@keydown\.enter\.prevent="commitRename"/, '回车没有提交')
  assert.match(src, /@keydown\.esc\.prevent="cancelRename"/, 'Esc 没有取消：用户想放弃反而会把半截名字写进表单')
  assert.match(src, /@blur="commitRename"/, '失焦没有提交（点别处时应自动回到下拉）')

  const fn = src.match(/function commitRename\(\)[\s\S]{0,700}?\n\}/)
  assert.ok(fn, '没找到 commitRename')
  assert.ok(/if \(!renaming\.value\) return/.test(fn[0]),
    '缺幂等守卫：回车提交后元素移除会再触发一次 blur，导致重复提交')
  assert.ok(!/axios/.test(src), '重命名不应直接调接口：这个弹窗是「改完点保存」')

  // 当前项的 label 必须跟随表单值，否则改完看不到变化
  assert.match(src, /c\.slug === props\.currentSlug && \(form\.value\.name \|\| ''\)\.trim\(\)/,
    '下拉当前项没跟随 form.name：铅笔改完名字，下拉仍显示旧名')
})

// 切班/建班会重建整个视图树，弹窗会被一起销毁。用户把它当切换器用时，
// 每切一次就被关掉很打断，所以要把「开着」这件事记在视图之外，重建后原地恢复。
// 这条也是静默失效型：忘了恢复不会有任何报错，只是退回「切一次关一次」的老行为。
test('切班/建班后班级信息弹窗原地恢复', () => {
  const scope = codeOnly(read('student-frontend/src/utils/classScope.js'))
  assert.match(scope, /export const classDialogOpen = ref\(false\)/,
    '缺跨重建的弹窗状态：重建后无从得知原来是开着的')

  const dash = codeOnly(read('student-frontend/src/views/DashboardView.vue'))
  assert.match(dash, /import \{ bumpClassScope, classDialogOpen \}/,
    'DashboardView 没有引入 classDialogOpen')
  assert.match(dash, /watch\(showClassModal, \(v\) => \{ classDialogOpen\.value = v \}\)/,
    '没有把显隐同步到模块级状态：用户关掉之后切班还会弹出来（或反之）')
  assert.match(dash, /if \(classDialogOpen\.value\)/,
    'onMounted 没判断是否需要恢复：切一次班弹窗就被关掉')

  // 顺序：先拉数据再显示。反过来的话 ClassInfoDialog 会拿到空的 classData，
  // 而它只在 visible 变化时初始化表单，数据回来也不会补。
  assert.match(
    dash,
    /Promise\.all\(\[loadClassInfo\(\), loadClasses\(\)\]\)\.finally\(\(\) => \{ showClassModal\.value = true \}\)/,
    '恢复时先开弹窗再拉数据，会显示一个字段全空的表单'
  )
})

// 班名只有一个编辑入口（铅笔），不再有独立的「班级名称」输入框。
// 两个入口改同一个字段，用户分不清哪个生效；而且独立输入框只在多班时才有意义，
// 单班账号反而没有切换器可依附。
test('班级名称只有铅笔一个入口', () => {
  const src = codeOnly(read('student-frontend/src/components/dialogs/ClassInfoDialog.vue'))

  assert.ok(!/v-model="form\.name"/.test(src),
    '又出现了独立的班名输入框：与铅笔重复，两个入口改同一个字段会让人不知道哪个生效')
  assert.match(src, /form\.value\.name = v/, '铅笔提交没有写回表单')

  // 分段渲染：多班是下拉，单班是只读班名；铅笔在两者之外，所以单班也能改名
  assert.match(src, /v-else-if="classes\.length > 1"/,
    '下拉没有按班级数收起：单班账号会看到一个只有一项的下拉')
  assert.match(src, /v-else class="class-static"/,
    '单班时没有只读班名兜底：那一行会空着')
  // 铅笔按钮不能挂在「多班」条件里，否则单班没有改班名的入口
  assert.match(src, /ref="renameBtn"/, '铅笔按钮缺失或不在常显位置')
})

// 设置页账号信息区的「当前班级 + 切换」。
// 它和首页那个弹窗是两条独立入口，但切班的收尾必须完全一致 ——
// 顺序写反或漏掉 reset，表现就是「切完还在看上一个班的数据」，而且不报错。
test('设置页账号信息区：当前班级可切换，收尾与首页一致', () => {
  const vue = codeOnly(read('student-frontend/src/views/SettingsView/SettingsView.vue'))
  assert.match(vue, /当前班级：/, '账号信息区没有显示当前班级')
  assert.match(vue, /@click="openClassDialog"/, '没有「切换」入口')
  assert.match(vue, /class="glass-switch"/, '「切换」不是白色毛玻璃按钮')
  assert.match(vue, /v-if="classList\.length > 1"/, '单班账号不该出现切换入口')
  // 切换走的是与首页同一个弹窗，而不是就地展开下拉：两处各做一套迟早行为分叉
  assert.match(vue, /<ClassInfoDialog/, '「切换」没有打开班级弹窗')
  assert.match(vue, /@switch-class="switchClassFromSettings"/, '弹窗的切班事件没接上')
  assert.match(vue, /@create-class="createClassFromSettings"/, '弹窗的建班事件没接上')

  const js = codeOnly(read('student-frontend/src/views/SettingsView/SettingsView.data.js'))
  const at = js.indexOf('async switchClassFromSettings')
  assert.ok(at > 0, 'data.js 里没有 switchClassFromSettings')
  const seg = js.slice(at, at + 900)
  const iReset = seg.indexOf('resetUserScopedCaches()')
  const iBump = seg.indexOf('bumpClassScope()')
  assert.ok(iReset >= 0, '设置页切班没清模块级缓存：会继续显示上一个班的数据')
  assert.ok(iBump > iReset, '设置页切班的顺序反了：必须与首页一致，先清缓存再作废实例')
})

// 设置页的班级弹窗要跨重建存活，且切班/建班时不能被顺手关掉。
// 两条都是静默失效型：
//   · 漏了 onMounted 恢复 → 每切一次班弹窗就消失（用户以为是自己点错了）
//   · 切班路径里写了 classDialogVisible = false → watch 把模块级状态写回 false，
//     重建后不恢复，症状和上一条一样但更难看出原因
test('设置页班级弹窗：切班/建班后原地恢复', () => {
  const vue = codeOnly(read('student-frontend/src/views/SettingsView/SettingsView.vue'))
  const js = codeOnly(read('student-frontend/src/views/SettingsView/SettingsView.data.js'))

  assert.match(vue, /watch\(classDialogVisible, \(v\) => \{ settingsClassDialogOpen\.value = v \}\)/,
    '没有把弹窗显隐同步到模块级状态：重建后无从得知原来开着')
  assert.match(vue, /if \(settingsClassDialogOpen\.value\)/,
    'onMounted 没判断是否需要恢复：设置页切一次班弹窗就被关掉')
  // 顺序与首页一致：先填后显，否则拿到一个字段全空的表单
  assert.match(
    vue,
    /Promise\.all\(\[ctx\.loadClassInfo\(\), ctx\.loadClasses\(\)\]\)\.finally\(\(\) => \{ classDialogVisible\.value = true \}\)/,
    '恢复时先开弹窗再拉数据，会显示一个字段全空的表单'
  )

  // 两个换库路径里都不能出现「关弹窗」
  for (const name of ['createClassFromSettings', 'switchClassFromSettings']) {
    const at = js.indexOf(`async ${name}`)
    assert.ok(at > 0, `data.js 里没有 ${name}`)
    const seg = js.slice(at, js.indexOf('\n    },', at))
    assert.ok(!/classDialogVisible\.value = false/.test(seg),
      `${name} 里关了弹窗：会把 settingsClassDialogOpen 写回 false，重建后不再恢复`)
  }

  // 模板用到的方法必须从 ctx 解构出来，否则是 undefined（运行时才炸）
  const tail = vue.slice(vue.indexOf('} = ctx'))
  const destructure = vue.slice(vue.lastIndexOf('const {', vue.indexOf('} = ctx')), vue.indexOf('} = ctx'))
  for (const m of ['openClassDialog', 'saveClassInfoFromSettings', 'switchClassFromSettings', 'createClassFromSettings']) {
    assert.ok(destructure.includes(m), `模板用到 ${m} 但没从 ctx 解构出来，运行时会是 undefined`)
  }
})

// 设置页那份弹窗只做切换：藏掉口号/班风/学风与保存按钮。
// 连带的关键点：没有保存按钮之后，铅笔改的名字必须**当场落库**，
// 否则用户改完点「关闭」，名字悄悄丢了（不报错、看不出，最容易漏）。
test('设置页弹窗只做切换：藏掉下方文案栏，改名当场落库', () => {
  const dlg = codeOnly(read('student-frontend/src/components/dialogs/ClassInfoDialog.vue'))

  assert.match(dlg, /switchOnly: \{ type: Boolean, default: false \}/, '弹窗没有 switchOnly 开关')
  assert.match(dlg, /v-if="!switchOnly" class="space-y-3 mb-5"/,
    'switchOnly 下没藏掉口号/班风/学风：设置页里这三栏是多余的')
  assert.match(dlg, /switchOnly \? '班级切换' : '班级信息设置'/, '标题没跟着模式变')
  assert.match(dlg, /<template v-if="switchOnly">/, 'switchOnly 下没有单独的页脚')
  assert.match(dlg, /rounded-lg bg-surface-hover border border-border">关闭</,
    'switchOnly 下缺少「关闭」按钮')

  assert.match(dlg, /if \(props\.switchOnly && !nameDuplicate\.value\) emit\('rename-class', v\)/,
    'switchOnly 下改名没提交：弹窗里没有保存按钮，改完一关就丢')

  const vue = codeOnly(read('student-frontend/src/views/SettingsView/SettingsView.vue'))
  assert.match(vue, /\s switch-only\n/, '设置页没传 switch-only')
  assert.match(vue, /@rename-class="renameClassFromSettings"/, '设置页没接改名事件')

  // PUT 是整对象覆盖：只发 name 会把口号/班风/学风抹掉，所以必须先读再写
  const js = codeOnly(read('student-frontend/src/views/SettingsView/SettingsView.data.js'))
  const at = js.indexOf('async renameClassFromSettings')
  assert.ok(at > 0, 'data.js 里没有 renameClassFromSettings')
  const seg = js.slice(at, js.indexOf('\n    },', at))
  const iGet = seg.indexOf("axios.get('/api/widget-settings/class-info')")
  const iPut = seg.indexOf("axios.put('/api/widget-settings/class-info'")
  assert.ok(iGet > 0 && iPut > iGet,
    '改名没先读再写：PUT 是整对象覆盖，只发 name 会把口号/班风/学风清空')
  // 只看 PUT 的入参：下面还有一行 `ctx.classInfo.value = { ...d, name: clean }`，
  // 在整段里搜 `...d` 会误判成「合并了」，实测漏过一次变异。
  const putArgs = (seg.match(/axios\.put\('\/api\/widget-settings\/class-info',\s*(\{[^}]*\})/) || [])[1] || ''
  assert.match(putArgs, /\.\.\.d/,
    'PUT 的入参没合并原有字段：只发 name 会把口号/班风/学风清空')
  assert.match(seg, /loadClasses\(\)/, '改名后没刷新班级列表：下拉仍显示旧名')
})
