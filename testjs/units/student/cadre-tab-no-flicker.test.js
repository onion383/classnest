// =========================================================================
// cadre-tab-no-flicker.test.js —— 班干部 tab 反复切换不闪跳（保活）
//
// 症状：学生信息 ↔ 班干部管理 来回切时，班干部页每次都先闪「还没有任何职务」
// 空态、再被职务树替换；且选中/折叠/滚动状态丢失、/cadres + /students 重复拉取。
// 根因：原用 v-if，切走即卸载、切回即重新挂载（tree 重置为 []、loading=false →
//       模板空态条件 !loading && tree.length===0 命中，闪一下）。
//
// 修法：改用 v-show 保活（Vapor 下 KeepAlive 包 v-if 异步组件会编译崩溃，已实测），
// + 悬停标签 prefetch chunk（首次切换不等下载）。
//
// 判据（源码文本事实 + 变异反证）：
//   ① 班干部组件用 v-show="activeTab === 'cadres'"，不是 v-if；
//   ② 学生分支配对改成 v-show="activeTab !== 'cadres'"，且不再是 template v-else；
//   ③ CadreManage 仍是 defineAsyncComponent(loadCadreManage) 懒加载 + onTabHover prefetch；
//   ④ 变异反证：把 v-show 换回 v-if → 判据 ① 必须失败。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')

const PARENT = 'student-frontend/src/views/ClassroomView.vue'
const CHILD = 'student-frontend/src/components/CadreManage.vue'

test('班干部 tab 用 v-show 保活（不是 v-if）', () => {
  const src = read(PARENT)
  // @pin student-frontend/src/views/ClassroomView.vue#CadreManage
  assert.match(src, /<CadreManage\s+v-show="activeTab === 'cadres'"/,
    '班干部组件必须是 v-show（保活，切走不卸载）')
  // @pin student-frontend/src/views/ClassroomView.vue#CadreManage
  assert.doesNotMatch(src, /<CadreManage\s+v-if="activeTab === 'cadres'"/,
    '班干部组件不能退回 v-if（会重新挂载导致空态闪跳）')
})

test('学生分支配对改成 v-show，不再是 template v-else', () => {
  const src = read(PARENT)
  assert.match(src, /<div\s+v-show="activeTab !== 'cadres'">/,
    '学生分支必须是 v-show 容器')
  assert.doesNotMatch(src, /<template\s+v-else>/, '学生分支不能还是 v-else')
})

test('仍是异步懒加载 + hover 预取（保活不牺牲首次加载）', () => {
  const src = read(PARENT)
  // @pin student-frontend/src/views/ClassroomView.vue#loadCadreManage
  assert.match(src, /const loadCadreManage\s*=\s*\(\)\s*=>\s*import\(/, 'loader 必须是命名函数')
  // @pin student-frontend/src/views/ClassroomView.vue#loadCadreManage
  assert.match(src, /defineAsyncComponent\(loadCadreManage\)/, '仍是异步组件')
  // @pin student-frontend/src/views/ClassroomView.vue#onTabHover
  assert.match(src, /@hover="onTabHover"/, 'Tabs 必须挂 hover')
  // @pin student-frontend/src/views/ClassroomView.vue#loadCadreManage
  assert.match(src, /if \(value === 'cadres'\) prefetch\(loadCadreManage\)/, 'hover 必须预取 loader')
})

test('CadreManage 有 name（保活/调试标识）', () => {
  assert.match(read(CHILD), /defineOptions\(\{\s*name:\s*'CadreManage'\s*\}\)/
    || /defineOptions\(\{ name: 'CadreManage' \}\)/)
})

test('刷新职务树：内容未变时不替换 tree.value（避免列表整体重画闪跳）', () => {
  const src = read(CHILD)
  const fn = src.match(/async function loadTree\(\)[\s\S]*?\n\}/)
  assert.ok(fn, '找不到 loadTree')
  // 新树落到局部变量，再与旧树比较；内容一致就不赋值
  assert.match(fn[0], /const\s+next\s*=\s*res\.data\.tree/, '新树应先落到局部变量 next')
  assert.match(fn[0], /JSON\.stringify\([^)]*next[^)]*\)\s*[!=]==\s*JSON\.stringify\(tree\.value\)/,
    '应比较 next 与现有 tree 内容')
  assert.match(fn[0], /tree\.value\s*=\s*next/,
    '内容有变才整体替换')
  // loading 翻转仍在（反馈不能丢）
  assert.match(fn[0], /loading\.value\s*=\s*true/)
  assert.match(fn[0], /loading\.value\s*=\s*false/)
})

// ————————————————— 变异反证 —————————————————

test('变异反证：把 v-show 换回 v-if → 保活判据必须失败', () => {
  const original = read(PARENT)
  const broken = original.replace(
    /<CadreManage\s+v-show="activeTab === 'cadres'"/,
    `<CadreManage v-if="activeTab === 'cadres'"`
  )
  assert.notEqual(broken, original, '变异没生效')
  assert.throws(() => assert.match(broken, /<CadreManage\s+v-show="activeTab === 'cadres'"/))
})
