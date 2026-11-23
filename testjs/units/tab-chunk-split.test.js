// =========================================================================
// tab-chunk-split.test.js —— tab 内容分块（异步组件 + hover 预取）的接线判据
//
// 每个被拆的视图必须同时满足：
//   ① 模板里两个 tab 分支都换成 <XxxTab v-if/v-else-if :ctx="tabCtx" />，无内联残留；
//   ② 父组件 defineAsyncComponent 包住命名 loader（loader 才能被 prefetch 复用）；
//   ③ Tabs 挂 @hover 且 onTabHover 对两个 value 都 prefetch 对应 loader；
//   ④ 父组件建了 tabCtx = reactive({...}) 透传状态（数据/undo/focus 留父）。
//
// 判据用源码文本事实，不用正则整块提取模板（内层 }}/</div> 会截断导致假红）。
// 变异反证：抹掉 onTabHover 的一个分支 → 判据 ③ 必须失败。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const VIEW = 'student-frontend/src/views/'

const CASES = [
  {
    name: 'ScoreManagement',
    file: VIEW + 'ScoreManagement.vue',
    tabs: [
      { value: 'today', comp: 'ScoreTodayTab', loader: 'loadTodayTab' },
      { value: 'stats', comp: 'ScoreStatsTab', loader: 'loadStatsTab' },
    ],
  },
  {
    name: 'ActivitiesView',
    file: VIEW + 'ActivitiesView.vue',
    tabs: [
      { value: 'daily', comp: 'ActivitiesDailyTab', loader: 'loadDailyTab' },
      { value: 'countdown', comp: 'ActivitiesCountdownTab', loader: 'loadCountdownTab' },
    ],
  },
  {
    name: 'LeaveManagement',
    file: VIEW + 'LeaveManagement.vue',
    tabs: [
      { value: 'today', comp: 'LeaveTodayTab', loader: 'loadTodayTab' },
      { value: 'records', comp: 'LeaveRecordsTab', loader: 'loadRecordsTab' },
    ],
  },
]

for (const c of CASES) {
  test(`${c.name}: 两个 tab 都换成异步组件，无内联残留`, () => {
    const src = read(c.file)
    for (const t of c.tabs) {
      assert.match(src, new RegExp(`<${t.comp}\\s+v-(else-)?if="activeTab === '${t.value}'"\\s+:ctx="tabCtx"`),
        `${c.name}: ${t.value} 分支没接 ${t.comp}`)
    }
    // 旧的 v-if 内联分支写法必须消失（v-if="activeTab === '<value>'" 后面直接跟 > 或 class，而非组件标签）
    for (const t of c.tabs) {
      assert.doesNotMatch(src, new RegExp(`<div v-if="activeTab === '${t.value}'"`),
        `${c.name}: ${t.value} 的内联 <div> 分支还在`)
    }
  })

  test(`${c.name}: loader 命名 + defineAsyncComponent + hover 预取`, () => {
    const src = read(c.file)
    for (const t of c.tabs) {
      assert.match(src, new RegExp(`const ${t.loader}\\s*=\\s*\\(\\)\\s*=>\\s*import\\(`),
        `${c.name}: ${t.loader} 不是命名 loader`)
      assert.match(src, new RegExp(`defineAsyncComponent\\(${t.loader}\\)`),
        `${c.name}: ${t.comp} 没用 defineAsyncComponent(loader)`)
      assert.match(src, new RegExp(`prefetch\\(${t.loader}\\)`),
        `${c.name}: ${t.loader} 没被 hover 预取`)
    }
    assert.match(src, /@hover="onTabHover"/, `${c.name}: Tabs 没挂 hover`)
  })

  test(`${c.name}: tabCtx = reactive 透传`, () => {
    const src = read(c.file)
    assert.match(src, /const tabCtx\s*=\s*reactive\(\{/, `${c.name}: 没有 tabCtx = reactive({...})`)
    // 子组件必须声明 ctx prop
    for (const t of c.tabs) {
      const child = read(VIEW + t.comp + '.vue')
      assert.match(child, /defineProps\(\{\s*ctx:\s*\{[^}]*required:\s*true/,
        `${t.comp}: 没有必填 ctx prop`)
    }
  })
}

// ————————————————— 变异反证 —————————————————

test('变异反证：抹掉 onTabHover 的一个 prefetch 分支 → hover 判据必须失败', () => {
  const src = read(CASES[0].file)
  const broken = src.replace(/if \(value === 'today'\) prefetch\(loadTodayTab\)/, '')
  assert.notEqual(broken, src, '变异没生效')
  assert.throws(() => assert.match(broken, /prefetch\(loadTodayTab\)/))
})
