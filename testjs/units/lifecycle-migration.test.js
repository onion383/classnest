// =========================================================================
// lifecycle-migration.test.js —— §5-17 生命周期批的**结构判据**
//
// 这一批做的事是把「定时器/监听器」从「创建处与销毁处靠人脑配对」搬进 disposables，
// 顺带查出底座本身的窟窿：listen 返回的只是「撤销登记」，调用方以为摘掉了监听器。
// 逐条语义已由 disposables.test.js 卡住（含 §5-17 四条）；这里卡的是另一半——
// 「改过的文件真的改干净了」，以及「人工复核表不许变成静默豁免」。
//
// 为什么要有第二部分：GAP/UNKNOWN 清零可以靠往表里塞文件做到，那张表一旦没人管，
// 就会从「签字」退化成「掩盖」。所以要求：理由必须写、文件必须还在、
// 而且已经用上 disposables 的文件不许再留在这张表里（否则表会一直显示旧结论）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const SRC = path.join(ROOT, 'student-frontend/src')
const AUDIT = path.join(ROOT, 'testjs/tools/audit-coverage.mjs')

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

// ——————————————— 一、本批迁移过的文件必须真的走 disposables ———————————————

const MIGRATED = [
  'student-frontend/src/App.vue',
  'student-frontend/src/components/tables/GridView/GridView.vue',
  'student-frontend/src/subwindows/setup/Setup.vue',
  'student-frontend/src/subwindows/widget/WidgetApp.vue',
  'student-frontend/src/components/base/CustomScrollbar.vue',
  'student-frontend/src/components/base/AppSelect.vue',
  'student-frontend/src/components/base/ContextMenu.vue',
  'student-frontend/src/components/base/DialogShell.vue',
  'student-frontend/src/components/base/AppHelp.vue',
  'student-frontend/src/components/album/AlbumYearRuler.vue',
  'student-frontend/src/subwindows/widget/Note.vue',
]

test('§5-17：迁移过的文件必须引入 disposables 并真的登记资源', () => {
  for (const rel of MIGRATED) {
    const src = read(rel)
    assert.match(src, /utils\/disposables/, `${rel} 必须 import utils/disposables`)
    assert.match(
      src,
      /\b(d|disposables|sub)\.(listen|timeout|interval|defer|add|abort)\(/,
      `${rel} 必须真的调用登记 API，而不是只写个 import`,
    )
  }
})

test('§5-17：根组件不再手写「与 disposables 重复的第二遍清理」', () => {
  const src = read('student-frontend/src/App.vue')
  // 这几个监听已经登记进 disposables，onBeforeUnmount 里再 remove 一遍是双份维护：
  // 一旦两处写法不一致（例如 capture 选项漏了），就变成「看起来清了其实没清」。
  assert.doesNotMatch(src, /removeEventListener\('resize', onWindowResize\)/, 'resize 监听应交给 disposables')
  assert.doesNotMatch(src, /removeEventListener\('ai-config-changed'/, 'ai-config-changed 监听应交给 disposables')
  assert.doesNotMatch(src, /removeEventListener\('mousedown', onDocMouseDown\)/, 'mousedown 监听应交给 disposables')
  // 真正只属于本组件的收尾动作仍要在
  assert.match(src, /stopUnitDrag\(\)/, '拖动中的临时监听仍要在卸载时收尾')
  assert.match(src, /albumTaskResume\?\.cancel\(\)/, '相册恢复排期仍要取消')
})

test('§5-17：GridView 的测量防抖改用 defer，且不再残留旧的 timer 句柄', () => {
  const src = read('student-frontend/src/components/tables/GridView/GridView.vue')
  assert.match(src, /_measureTimer:\s*d\.defer\(\)/, '测量防抖应改为 defer 调度器')
  assert.doesNotMatch(src, /clearTimeout\(ctx\._measureTimer\)/, 'defer 自带撤销，不该再手写 clearTimeout')
  assert.doesNotMatch(src, /ctx\._measureTimer\s*=\s*setTimeout\(/, '不该再把 timer id 写回字段')
})

test('§5-17：WidgetApp 的三个排期改用 defer 后不得残留旧变量名', () => {
  const src = read('student-frontend/src/subwindows/widget/WidgetApp.vue')
  for (const dead of ['toolOpenTimer', 'toolCloseTimer', 'iconShrinkTimer']) {
    assert.ok(!src.includes(dead), `${dead} 已被 defer 取代，残留会让人以为还有第二个真源`)
  }
  assert.match(src, /scheduleToolOpen\(/, '开工具仍要排期')
  assert.match(src, /scheduleToolClose\(/, '收工具仍要排期')
  assert.match(src, /scheduleIconShrink\(/, '收起动画后收缩窗口仍要排期')
})

// ——————————————— 二、人工复核表不能变成静默豁免 ———————————————

// 从审查工具里把 LIFECYCLE_REVIEWED 的字面量抠出来（工具本身是 mjs，直接 import 会执行全仓扫描）
function reviewedTable() {
  const src = fs.readFileSync(AUDIT, 'utf8')
  const start = src.indexOf('const LIFECYCLE_REVIEWED = Object.freeze({')
  assert.ok(start > 0, 'audit-coverage.mjs 里找不到 LIFECYCLE_REVIEWED')
  const end = src.indexOf('})', start)
  const body = src.slice(start, end)
  const entries = []
  const re = /'(fe:[^']+)':\s*\n?\s*'([^']*)'/g
  let m
  while ((m = re.exec(body))) entries.push({ id: m[1], reason: m[2] })
  return entries
}

test('§5-17：人工复核表每条都必须写理由，且理由要说明「谁负责释放」', () => {
  const entries = reviewedTable()
  assert.ok(entries.length > 0, '表被抠空了，判据失效')
  for (const { id, reason } of entries) {
    assert.ok(reason.length >= 10, `${id} 的理由太短（${reason.length} 字），等于没签字`)
    assert.match(
      reason,
      /onBeforeUnmount|onDeactivated|卸载|释放|取消|退订|cancel|stopAll|dispose|abort|清|一次性|窗口关闭|随元素回收|随 Promise|随进程/,
      `${id} 的理由没说清释放者：${reason}`,
    )
  }
})

// 底座自己是实现文件，当然处处是 disposables —— 「过期结论」判据对它没有意义。
const STALENESS_EXEMPT = new Set(['fe:student-frontend/src/utils/disposables.js'])

test('§5-17：人工复核表里的文件必须还在，且不许已经是 disposables 文件（防过期结论）', () => {
  for (const { id } of reviewedTable()) {
    const rel = id.slice('fe:'.length)
    const abs = path.join(ROOT, rel)
    assert.ok(fs.existsSync(abs), `${id} 指向的文件已不存在，表该更新`)
    if (STALENESS_EXEMPT.has(id)) continue
    const src = fs.readFileSync(abs, 'utf8')
    assert.doesNotMatch(
      src,
      /utils\/disposables|(?:^|[^.\w])(?:d|disposables)\.(?:listen|timeout|interval|defer)\(/m,
      `${id} 已经改用 disposables 了，应从复核表里删掉（否则矩阵永远显示旧结论）`,
    )
  }
})

// ——————————————— 三、全库通用判据：周期定时器必须有对应的停法 ———————————————

// 唯一豁免：dev 探针。installInpProbe 有 observer 短路，进程内只会有一个定时器，
// 页面级探针不提供停止入口（utils/inpProbe.js 里已写明）。
const INTERVAL_ALLOWED = new Set(['student-frontend/src/utils/inpProbe.js'])

function walk(dir, out = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) walk(p, out)
    else if (/\.(js|mjs|vue)$/.test(ent.name)) out.push(p)
  }
  return out
}

test('§5-17：文件里出现 setInterval 就必须有 clearInterval（否则必然漏清理）', () => {
  const offenders = []
  for (const abs of walk(SRC)) {
    const rel = path.relative(ROOT, abs).split(path.sep).join('/')
    if (INTERVAL_ALLOWED.has(rel)) continue
    const src = fs.readFileSync(abs, 'utf8')
    if (/setInterval\(/.test(src) && !/clearInterval\(/.test(src)) offenders.push(rel)
  }
  assert.deepEqual(offenders, [], '这些文件起了周期定时器却没有停法')
})
