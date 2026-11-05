// =========================================================================
// duty-big-mode.test.js —— 大扫除「组列 + 周期设置」的前后端接线断言
//
// 背景：值日表原本只有一份全局「星期列表」，大扫除和日常值日共用一套列。
// 改成按模式分键后，接线点很多，漏一处就会出现「界面上是组名、库里还是星期」
// 或「大扫除补存了天天有的快照（次数不变 → 指数不变）」这类症状。
//
// 判据读**真实源码**（不复制逻辑）：改坏源码时断言要能失败，否则是假绿。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.resolve(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

const FE = 'student-frontend/src'
const BE = 'student-backend'

// =========================================================================
// 后端：列名按模式分键 + 单源入口
// =========================================================================

test('后端：列名与模式配置统一走 dutyConfig（不再直接 SELECT days）', () => {
  // 6 处后端读点里，除了 dutyConfig 自己，不该再有直接读 days 列的地方
  const readers = [
    `${BE}/routes/duty.js`,
    `${BE}/routes/search.js`,
    `${BE}/routes/ai/ai.tools/tools.executors/executors.image.js`,
    `${BE}/routes/dataExport.js`,
    `${BE}/services/businessRules.js`,
  ]
  for (const f of readers) {
    const s = read(f)
    assert.ok(/dutyConfig/.test(s), `${f} 没有引用 dutyConfig`)
    // 直接 SELECT days 会绕过单源入口（漏一处就出「AI 出图列名对不上」）
    assert.ok(!/SELECT days FROM duty_settings/.test(s), `${f} 仍在直接 SELECT days`)
  }
})

test('后端：读列名的入口只有 dutyConfig 一个', () => {
  const s = read(`${BE}/services/dutyConfig.js`)
  // days 的读写都在这个文件里
  assert.ok(/function readDays/.test(s))
  assert.ok(/function writeDays/.test(s))
  assert.ok(/function readConfig/.test(s))
  assert.ok(/function writeConfig/.test(s))
})

test('后端：days 与 items 同样按模式分键（结构对称）', () => {
  const s = read(`${BE}/schema/schema.duty.js`)
  // days 列的默认值必须是按模式分键的 {daily:[...],big:[...]}（与 items 同构）。
  // 判据直接解析 DEFAULT 里的 JSON 字面量（用正则抓容易漏转义 → 假绿）。
  const m = /days TEXT NOT NULL DEFAULT '(\{[^']*\})'/.exec(s)
  assert.ok(m, '应能找到 days 列的 DEFAULT 定义')
  const days = JSON.parse(m[1])
  assert.deepEqual(days.daily, ['周一', '周二', '周三', '周四', '周五'])
  // 大扫除的列名是派生的 → big 分键不存列名
  assert.deepEqual(days.big, [], 'days.big 不应存列名（列名由配置派生）')
  // 视图要暴露 settings 列（模式配置）
  assert.ok(/SELECT 1 AS id, days, items, settings FROM duty_slots/.test(s), 'duty_settings 视图应暴露 settings 列')
})

test('前后端：大扫除的列名派生规则一致（任务分组 + 数量 → 列名）', () => {
  // 两边各有一份实现（后端 CJS / 前端 ESM），规则必须一致：
  // 不一致的症状是「界面上列头写第1大组、后端校验说是非法列」。
  const be = read(`${BE}/services/dutyConfig.js`)
  const fe = read(`${FE}/utils/dutyColumns.js`)
  // 组类型 → 显示名（两边的映射表必须一模一样）
  const beTypes = /GROUP_TYPES = \{([^}]*)\}/.exec(be)
  const feTypes = /GROUP_TYPE_LABELS = \{([^}]*)\}/.exec(fe)
  assert.ok(beTypes && feTypes, '两端都应有任务分组映射表')
  const beMap = Object.fromEntries([...beTypes[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]))
  const feMap = Object.fromEntries([...feTypes[1].matchAll(/(\w+):\s*'([^']+)'/g)].map((m) => [m[1], m[2]]))
  assert.deepEqual(feMap, beMap, '前后端的任务分组映射必须一致')
  assert.deepEqual(beMap, { big: '大组', small: '小组' })
  // 派生的标签必须**取自映射表**，不能写死（写死 → 换组类型时前后端对不上）
  for (const [src, label] of [[be, '后端'], [fe, '前端']]) {
    assert.ok(/GROUP_TYPE[S]?\w*\s*\[/.test(src), `${label}的派生标签应取自映射表，不能写死`)
    assert.ok(/第\$\{i\}/.test(src), `${label}的派生应产出「第{i}组名」`)
  }
  // 「全部」列在末尾
  assert.ok(/out\.push\(ALL_COLUMN\)/.test(be), '后端应在末尾追加「全部」列')
  assert.ok(/out\.push\(ALL_COLUMN\)/.test(fe), '前端应在末尾追加「全部」列')
  // 组数上限一致
  const beMax = /MAX_GROUPS = (\d+)/.exec(be)
  const feMax = /MAX_GROUPS = (\d+)/.exec(fe)
  assert.ok(beMax && feMax, '两端都应有组数上限')
  assert.equal(beMax[1], feMax[1], '前后端的组数上限必须一致')
})

test('后端：大扫除补存只在命中日（次数随周期变少）', () => {
  const s = read(`${BE}/routes/duty.js`)
  assert.ok(/dutyCycle\.isHitDate/.test(s), 'backfill 应按命中日过滤')
  // 日常值日仍逐日补（大扫除才受周期约束）
  assert.ok(/isHit\(cur\)/.test(s), 'backfill 循环应跳过非命中日')
})

test('后端：命中日计算在 dutyCycle.js 单源（前端不再各算一份）', () => {
  const s = read(`${BE}/services/dutyCycle.js`)
  assert.ok(/function isHitDate/.test(s))
  assert.ok(/function hitDatesBetween/.test(s))
  // 一个月 = 4 周
  assert.ok(/month: 4/.test(s), '一个月的间隔周数应为 4')
})

test('后端：提供大扫除发生日接口（前端只显示，不自己算）', () => {
  const s = read(`${BE}/routes/duty.js`)
  assert.ok(/router\.get\('\/big-dates'/.test(s), '应有 /big-dates 接口')
  assert.ok(/dutyCycle\.hitDatesBetween/.test(s))
})

test('后端：导出按模式各导一张（列名不同不能混在一张表）', () => {
  const s = read(`${BE}/routes/dataExport.js`)
  assert.ok(/tDuties\('daily'\)/.test(s), '应有日常值日的导出')
  assert.ok(/tDuties\('big'\)/.test(s), '应有大扫除的导出')
})

// =========================================================================
// 前端：设置弹窗按模式切换「星期勾选」与「分组 + 周期」
// =========================================================================

test('前端：设置弹窗按模式切换两种列名来源', () => {
  const s = read(`${FE}/components/dialogs/DutySettingsDialog.vue`)
  // 日常值日：勾星期；大扫除：任务分组（大组/小组）+ 数量 + 周期
  assert.ok(/isBigMode/.test(s), '设置弹窗应按模式分支')
  assert.ok(/localConfig\.cycle/.test(s), '大扫除应有周期设置')
  assert.ok(/localConfig\.groupType/.test(s), '大扫除应有任务分组选择（大组/小组）')
  assert.ok(/localConfig\.groupCount/.test(s), '大扫除应有分组数量')
  // 组是内置的，不再从「分组管理」读维度
  assert.ok(!/group-manage/.test(s), '大扫除的组是内置的，不该再从分组管理读')
})

test('前端：保存时按模式构造载荷（大扫除传配置，日常传星期）', () => {
  const s = read(`${FE}/components/dialogs/DutySettingsDialog.vue`)
  // 大扫除：列名由配置派生 → 只传 config，不传 days
  assert.ok(/payload\.config = \{/.test(s), '大扫除应传模式配置')
  assert.ok(/groupType: localConfig\.value\.groupType/.test(s), '配置应含任务分组')
  assert.ok(/groupCount:/.test(s), '配置应含分组数量')
  // 日常：传勾选的星期
  assert.ok(/payload\.days = WEEK\.filter\(d => localDays\.value\.includes\(d\)\)/.test(s), '日常应传星期作为列名')
})

test('前端：内置列「全部」不由用户维护（后端派生，前端不存）', () => {
  const s = read(`${FE}/utils/dutyColumns.js`)
  assert.ok(/export const ALL_COLUMN = '全部'/.test(s), '前端应有内置列常量')
  assert.ok(/withoutAllColumn/.test(s), '前端应有剔除内置列的工具')
  // 大扫除时不能传 days（列名由后端按配置派生）：
  // 传了会与配置打架 —— 后端按 mode 分键写，big 的 days 分键本来就不存列名。
  const dlg = read(`${FE}/components/dialogs/DutySettingsDialog.vue`)
  const fn = /function buildPayload\(\)\s*\{([\s\S]*?)\n\}/.exec(dlg)
  assert.ok(fn, '应能找到 buildPayload')
  const body = fn[1]
  // payload.days 只能赋值一次，且必须在「日常值日」分支里（大扫除不传 days）
  const assigns = [...body.matchAll(/payload\.days\s*=/g)]
  assert.equal(assigns.length, 1, `payload.days 应只赋值一次（实际 ${assigns.length} 次）`)
  // 赋值点之前必须已经有 else（大扫除的 if 分支在前面，不经过这里）
  const beforeDays = body.slice(0, assigns[0].index)
  assert.ok(/\}\s*else\s*\{/.test(beforeDays), 'payload.days 的赋值应在 else 分支（大扫除分支不传 days）')
  // 大扫除分支（if 到 else 之间）里不能出现 payload.days
  const elseIdx = beforeDays.lastIndexOf('}')
  const bigBranch = beforeDays.slice(0, elseIdx)
  assert.ok(!/payload\.days\s*=/.test(bigBranch), '大扫除分支里不应给 payload.days 赋值')
})

test('前端：值日页把模式与配置传给设置弹窗和排班弹窗', () => {
  const s = read(`${FE}/views/DutyView.vue`)
  assert.ok(/:mode="dutyMode"/.test(s), '设置弹窗应收到当前模式')
  assert.ok(/:config="settingsConfig"/.test(s), '设置弹窗应收到模式配置')
  assert.ok(/:big-cleanup="dutyMode === 'big'"/.test(s), '排班弹窗应收到「是否大扫除」')
  assert.ok(/payload\.config = settingsConfig\.value/.test(s), '保存时应带上模式配置')
  // 大扫除不传 days（列名由后端派生）
  assert.ok(/if \(dutyMode\.value === 'daily'\) payload\.days = settingsDays\.value/.test(s), '大扫除不应传 days')
})

test('前端：排班时大扫除整表去重（同一人不能同时扫两个区域）', () => {
  const s = read(`${FE}/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.pipeline.js`)
  assert.ok(/dedupeWholeTable/.test(s), '排班应支持「整表去重」')
  assert.ok(/wholeTable \? '__all__' : day/.test(s), '大扫除时去重范围应是整张表')
})

test('前端：排班弹窗收到「是否大扫除」标记', () => {
  const s = read(`${FE}/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.vue`)
  assert.ok(/bigCleanup/.test(s), '排班弹窗应有 bigCleanup prop')
  assert.ok(/dedupeWholeTable: computed\(\(\) => props\.bigCleanup\)/.test(s), '应把 bigCleanup 接到去重开关')
})

// 回归：dimension.js 里的方法经 Object.assign 挂到 ctx 上，<script setup> 的作用域里
// **没有**这些变量 —— 裸调用会在运行时报 "xxx is not defined"（构建期抓不到）。
// 判据：dimension.js 导出的方法，若在 .vue 里被**裸调用**（前面不是 ctx. / pipeline. 等），
// 必须能从作用域拿到 —— 即从 dimension / pipeline / options 解构出来的局部变量。
test('前端：排班弹窗调用 dimension.js 的方法时必须在作用域里拿得到', () => {
  const vue = read(`${FE}/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.vue`)
  const dim = read(`${FE}/components/dialogs/DutyArrangementDialog/DutyArrangementDialog.dimension.js`)
  // dimension.js 导出的方法名（可能带 async 前缀）
  const methods = [...dim.matchAll(/^\s{4}(?:async\s+)?([a-zA-Z_][\w]*)\s*\(/gm)].map((m) => m[1])
  assert.ok(methods.length, '应能从 dimension.js 解析出方法名')
  assert.ok(methods.includes('fetchDimensions'), '应能解析出 fetchDimensions（async 方法也要能识别）')
  // .vue 里从 dimension / pipeline / options 解构出来的局部变量
  const destructured = new Set()
  const dRe = /const\s*\{([^}]+)\}\s*=\s*(dimension|pipeline|options)\b/g
  let dm
  while ((dm = dRe.exec(vue))) {
    dm[1].split(',').forEach((x) => {
      const name = x.split(':').pop().trim()
      if (name) destructured.add(name)
    })
  }
  for (const name of methods) {
    // 找出所有调用点：前面不能是 . 或 标识符字符（即「裸调用」）
    const re = new RegExp(`(?<![.\\w])${name}\\s*\\(`, 'g')
    let hit
    while ((hit = re.exec(vue))) {
      // 调用行：注释里的不算
      const line = vue.slice(vue.lastIndexOf('\n', hit.index) + 1, vue.indexOf('\n', hit.index))
      if (/^\s*\/\//.test(line)) continue
      assert.ok(
        destructured.has(name),
        `${name}() 裸调用但不在作用域里（dimension.js 的方法要先解构出来再用）`,
      )
    }
  }
})

// =========================================================================
// 一致性：前后端的内置列名与周期枚举必须一致
// =========================================================================

test('前后端：内置列名「全部」一致', () => {
  const be = read(`${BE}/services/dutyConfig.js`)
  const fe = read(`${FE}/utils/dutyColumns.js`)
  assert.ok(/ALL_COLUMN = '全部'/.test(be), '后端内置列名应是「全部」')
  assert.ok(/ALL_COLUMN = '全部'/.test(fe), '前端内置列名应是「全部」')
})

test('前后端：任务分组枚举一致（大组 / 小组）', () => {
  const be = read(`${BE}/services/dutyConfig.js`)
  const fe = read(`${FE}/utils/dutyColumns.js`)
  for (const [k, label] of [['big', '大组'], ['small', '小组']]) {
    assert.ok(be.includes(`${k}: '${label}'`), `后端缺少任务分组 ${k}`)
    assert.ok(fe.includes(`${k}: '${label}'`), `前端缺少任务分组 ${k}`)
  }
})

test('前后端：周期枚举一致（week / biweek / month）', () => {
  const be = read(`${BE}/services/dutyConfig.js`)
  const fe = read(`${FE}/utils/dutyColumns.js`)
  for (const c of ['week', 'biweek', 'month']) {
    assert.ok(be.includes(`'${c}'`), `后端缺少周期 ${c}`)
    assert.ok(fe.includes(`'${c}'`), `前端缺少周期 ${c}`)
  }
})

test('前端：下拉用内置 AppSelect（不用原生 select —— 毛玻璃主题下样式对不上）', () => {
  // 全库惯例：只有 AppSelect 组件自身用原生 <select>，别处一律用 AppSelect
  const dlg = read(`${FE}/components/dialogs/DutySettingsDialog.vue`)
  assert.ok(!/<select[\s>]/.test(dlg), '值日设置弹窗不应出现原生 <select>')
  assert.ok(/AppSelect/.test(dlg), '值日设置弹窗应使用 AppSelect')
  assert.ok(/import AppSelect from/.test(dlg), '应 import AppSelect')
})
