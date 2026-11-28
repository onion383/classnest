// V10-U02-01：本文件的源码串副本变异是**静态旁证**，不是真模块回放；真回放范式见 ai-read-scope-gate.test.js（loadMutated + 依赖 stub + 真调函数）。
// =========================================================================
// schedule-import-save.test.js —— 课表 Excel 导入必须调到真的保存方法（v7 §5-7 / #25）
//
// 原缺陷：导入通过校验后先把结果写进 activeCells，再执行 `active.saveMaster()`。
// useScheduleActive() 只提供 saveActive()，saveMaster() 属于 master 对象 ——
// 于是执行到这里抛 TypeError：PUT 没发、撤销没登记、也没有成功提示，
// 但本地表格已经是导入的数据，刷新后「凭空回到旧课表」。
//
// 判据不是钉字符串，而是跨文件核对：`.vue` 里对 `active.` / `master.` 的每一次方法调用，
// 都必须在对应模块 `useScheduleXxx()` 返回的对象里有定义。以后把方法名写错（或改名漏改调用点）
// 都会被这条不变量抓住，不必再靠人眼看。
// =========================================================================
const test = require('node:test')
const { read } = require('#testjs/paths')
const assert = require('node:assert/strict')

const scan = require('#testjs/source-scan')
const VUE = 'student-frontend/src/views/ScheduleView/ScheduleView.vue'
const ACTIVE = 'student-frontend/src/views/ScheduleView/ScheduleView.active.js'
const MASTER = 'student-frontend/src/views/ScheduleView/ScheduleView.master.js'

// 注释里也会出现 `active.saveMaster()` 这种写法（本卡就在注释里解释了原 bug），
// 扫描前必须去掉注释，否则判据会被自己的说明文字带偏。
const stripComments = (s) => s
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

// 模块 return 出去的对象里的键名（T07-10）：
// 原正则只认「4 空格缩进 + name(」，把 `saveActive: async () => {}`、缩进被格式化的
// 方法、简写属性 `return { saveActive }` 全漏掉 —— 漏掉的方法会被当成「未定义」误红，
// 或反过来让真正的未定义调用蒙混过关。改为用 AST 取每个 return 的对象字面量键。
function methodKeys(src) {
  const { ast } = scan.analyze(src)
  const names = new Set()
  scan.walk(ast.program, (node) => {
    if (node.type !== 'ReturnStatement' || !node.argument || node.argument.type !== 'ObjectExpression') return
    for (const p of node.argument.properties) {
      if (p.type !== 'ObjectProperty' && p.type !== 'ObjectMethod') continue
      const k = scan.keyName(p.key)
      if (k) names.add(k)
    }
  })
  return [...names]
}

function missingMethods(vueSrc, moduleSrcs) {
  const code = stripComments(vueSrc)
  const missing = []
  for (const [obj, src] of Object.entries(moduleSrcs)) {
    const defined = new Set(methodKeys(src))
    const re = new RegExp(`\\b${obj}\\.([A-Za-z_$][\\w$]*)\\s*\\(`, 'g')
    for (const m of code.matchAll(re)) {
      if (!defined.has(m[1])) missing.push(`${obj}.${m[1]}`)
    }
  }
  return [...new Set(missing)]
}

test('不变量：.vue 对 active./master. 的方法调用都在对应模块里定义', () => {
  const missing = missingMethods(
    read(VUE),
    { active: read(ACTIVE), master: read(MASTER) },
  )
  assert.deepEqual(missing, [], `调用了不存在的方法：${missing.join('、')}`)
})

test('接线：导入保存按目标表走各自模块的保存方法', () => {
  const src = read(VUE)
  assert.match(
    src,
    /const ok = await \(isMaster \? master\.saveMaster\(\) : active\.saveActive\(\)\)/,
    '实行课表分支必须调 active.saveActive()（原为 active.saveMaster()）',
  )
  // 保存失败要提前返回：不能把「没落库」的导入结果当成已完成（登记撤销 / 提示成功）
  const after = src.slice(src.indexOf('const ok = await (isMaster ? master.saveMaster()'))
  assert.match(after.slice(0, 400), /if \(!ok\) return/, '保存失败必须中止后续的撤销登记与成功提示')
})

test('变异反证：改回 active.saveMaster() 后不变量必须报错', () => {
  const real = read(VUE)
  const mutated = real.replace('active.saveActive()', 'active.saveMaster()')
  assert.ok(mutated !== real, '变异没匹配到调用点')
  const missing = missingMethods(
    mutated,
    { active: read(ACTIVE), master: read(MASTER) },
  )
  assert.deepEqual(missing, ['active.saveMaster'], '判据没有抓住写错的方法名，是假绿')
})
