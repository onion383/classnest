// =========================================================================
// lazy-dialog-first-open.test.js —— v-if 懒挂载弹窗的「首次打开」必须初始化（v7 §5-3）
//
// 宿主是 `v-if="xxxMounted"` + `:visible`：点按钮时先置 visible=true，
// 宿主 watcher 再把 mounted 置真，于是子组件**挂载那一刻 props.visible 已经是 true**。
// 子组件的 `watch(() => props.visible, ...)` 若不是 immediate，建立时这次变化已经过去，
// 首次打开什么都不加载 —— 补录页空白、去重弹窗字段列表为空、设置弹窗的星期一个都没勾。
// 第二次打开才对，所以这种 bug 常被当成「偶发」。
//
// 判据不写死名单：扫所有 .vue 模板，凡是「同一标签既有 v-if 又有 :visible」的组件，
// 一律要求它的 visible watcher 带 immediate。这样以后新加一个懒挂载弹窗会被自动抓住。
// 常驻弹窗（无 v-if）不受约束 —— 它们的非 immediate watcher 是正确的。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { loadVue } = require('#testjs/units/_vue-loader.cjs')
const { analyzeSfc, walk: walkAst } = require('#testjs/units/_mechanism.cjs')

const SRC = abs('student-frontend/src')

// 递归收集 .vue 文件（跳过 node_modules，本项目 src 里也没有）
function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (ent.name.endsWith('.vue')) out.push(p)
  }
  return out
}

// 复核过、确认「首开不初始化也无损」的懒挂载弹窗（写清理由，不是静默豁免）：
//   · MediaViewer      —— 挂载即新实例，视角/缩放/播放态本来就是初始值；画面显隐由媒体
//                         事件（@load/@loadeddata）驱动，不依赖 watcher 复位（v7 §5-16 另有条目）。
//   · RecoveryKeyDialog—— watcher 只在「关闭 / 换一份恢复词」时清零下载与抄写状态，
//                         ref 初值恰好就是清零后的值，首开无需再跑一次。
//   · ImportExcel      —— watcher 只在 visible 变 false 时 resetState()，打开方向本就无需动作。
//   · SearchDialog     —— 用 onMounted 兜底（`onMounted(() => { if (props.visible) onOpened() })`），
//                         与 immediate 等价，故判据接受 onMounted 兜底这一写法。
const LAZY_DIALOG_REVIEWED = {
  MediaViewer: '挂载即初始态，画面显隐由媒体事件驱动',
  RecoveryKeyDialog: 'ref 初值即清零后的值，首开无需重置',
  ImportExcel: '只在 visible→false 时 resetState()',
  SearchDialog: 'onMounted 已兜底（等价 immediate）',
}

// 取「以 visible 为源的 watcher」整段调用文本（单值源 `props.visible`、数组源 `[props.visible, ...]` 都算）。
// 边界用 AST 定：源函数里带对象字面量、或字符串里有括号时，手写配平会数错 —— 原来这 18 行就是手写的。
function visibleWatchBlock(src) {
  const { ast, code } = analyzeSfc(src)
  const isVisibleSource = (node) => {
    if (!node) return false
    if (node.type === 'MemberExpression') return code.slice(node.start, node.end) === 'props.visible'
    if (node.type === 'ArrayExpression' && node.elements[0]) {
      return code.slice(node.elements[0].start, node.elements[0].end) === 'props.visible'
    }
    return false
  }
  let hit = ''
  walkAst(ast.program, (n) => {
    if (hit || n.type !== 'CallExpression') return
    if (!(n.callee.type === 'Identifier' && n.callee.name === 'watch')) return
    const first = n.arguments[0]
    if (!first || !isVisibleSource(first.body)) return
    hit = code.slice(n.start, n.end)
  })
  return hit
}

// 懒挂载组件名集合（同一标签同时带 v-if 与 :visible / v-model:visible）
function lazyMountedComponents() {
  const found = new Map() // name -> [宿主文件相对路径]
  for (const file of walk(SRC)) {
    const src = fs.readFileSync(file, 'utf8')
    const re = /<([A-Z][A-Za-z0-9]*)\s([^>]*?)\/?>/g
    let m
    while ((m = re.exec(src))) {
      const name = m[1]
      const attrs = m[2]
      if (!/\bv-if=/.test(attrs)) continue
      if (!/(:visible=|v-model:visible=)/.test(attrs)) continue
      if (!found.has(name)) found.set(name, [])
      found.get(name).push(path.relative(SRC, file))
    }
  }
  return found
}

// 组件名 → 定义文件（本项目弹窗组件名与文件名一致）
function componentFile(name) {
  const hit = walk(SRC).find((p) => path.basename(p, '.vue') === name)
  return hit ? fs.readFileSync(hit, 'utf8') : ''
}

test('§5-3：所有「v-if + :visible」懒挂载弹窗的 visible watcher 必须初始化（immediate 或 onMounted 兜底）', () => {
  const lazy = lazyMountedComponents()
  assert.ok(lazy.size >= 10, `只找到 ${lazy.size} 个懒挂载弹窗，扫描逻辑可能失效`)

  const offenders = []
  let checked = 0
  for (const [name, hosts] of lazy) {
    if (LAZY_DIALOG_REVIEWED[name]) continue
    const src = componentFile(name)
    if (!src) continue
    const block = visibleWatchBlock(src)
    // 不看 visible 做初始化的组件不在这条判据范围内（它们的初始化另有来源）
    if (!block) continue
    checked++
    const hasImmediate = /immediate:\s*true/.test(block)
    const hasOnMountedFallback = /onMounted\(\(\)\s*=>\s*\{[\s\S]{0,200}?props\.visible/.test(src)
    if (!hasImmediate && !hasOnMountedFallback) offenders.push(`${name}（宿主 ${hosts.join('、')}）`)
  }
  assert.ok(checked >= 13, `只检查了 ${checked} 个组件的 visible watcher，判据可能空转`)
  assert.deepEqual(offenders, [], `首次打开会不初始化：${offenders.join('；')}`)
})

test('§5-3：本次修复的四个补录/记录弹窗 + 五个编辑弹窗都在扫描范围内（防判据空转）', () => {
  const lazy = lazyMountedComponents()
  const must = [
    'DutyBackfillDialog', 'DutyRecordSettingsDialog', 'SeatBackfillDialog', 'SeatRecordSettingsDialog',
    'WeightAlgorithmDialog', 'DutyWeightAlgorithmDialog',
    'AddActivityDialog', 'AddCountdownDialog', 'AddLeaveDialog', 'AddScoreDialog',
    'DutySettingsDialog', 'SeatSettingsDialog', 'DeduplicateDialog',
  ]
  for (const name of must) assert.ok(lazy.has(name), `${name} 应被识别为懒挂载弹窗（宿主的 v-if 写法变了？）`)
})

test('§5-3：常驻弹窗不该被这条判据约束（无 v-if 时非 immediate 是正确写法）', () => {
  const lazy = lazyMountedComponents()
  // 这几个是常驻挂载（ReceiptDialog 用 v-model:visible 但无 v-if，ClassInfoDialog / AddClassDialog 同理）
  for (const name of ['ReceiptDialog', 'ClassInfoDialog', 'AddClassDialog']) {
    assert.ok(!lazy.has(name), `${name} 没有 v-if 懒挂载，不该被要求 immediate`)
  }
})

test('§5-3 语义：挂载时 visible 已为 true —— immediate 才会触发，非 immediate 会漏', async () => {
  const { ref, watch } = await loadVue()

  // 模拟「宿主先置 true，再挂载子组件」：ref 直接以 true 起始
  let eager = 0
  let lazy = 0
  const visibleA = ref(true)
  watch(() => visibleA.value, (v) => { if (v) eager++ }, { immediate: true })
  const visibleB = ref(true)
  watch(() => visibleB.value, (v) => { if (v) lazy++ })

  assert.equal(eager, 1, 'immediate watcher 在建立时就应跑一次（首开初始化）')
  assert.equal(lazy, 0, '非 immediate watcher 在这个场景下永远不触发 —— 正是本卡的 bug')
})
