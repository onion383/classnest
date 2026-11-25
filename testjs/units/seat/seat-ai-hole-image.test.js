// =========================================================================
// seat-ai-hole-image.test.js —— AI 座位图必须把「空位」画出来（4-8 / #80）
//
// 原缺陷：buildSeatImage 只区分「整行走廊」和「空格」，把所有为 null 的格子都输出成空串。
// 但格型矩阵里 types=2 是**空位（HOLE，没有桌子）**，types=0 且 seats 为 null 才是
// 「有桌无人」。两者在排布图上长得一模一样，模型会把没桌子的洞当成空座去安排人。
// 导出表（routes/dataExport.js）早就区分了，AI 出口是漏掉的那一个。
//
// 判据：
//   ① 行为：HOLE 格输出「空位」；同排的座位列空格仍是空串（有桌无人）；走廊格仍是空串；
//   ② 回归：整行走廊仍然写「走廊」（不能为了标空位把走廊行弄丢）；
//   ③ 变异反证：删掉 HOLE 分支后，行为判据必须失败。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')
const { loadMutated } = require('#testjs/units/_mechanism.cjs')

const IMAGE_SRC = 'student-backend/routes/ai/ai.tools/tools.executors/executors.image.js'

const fx = createBackendDb({ label: 'seat-ai-hole' })
const { buildExportImage } = require('../../../student-backend/routes/ai/ai.tools/tools.executors/executors.image')

test.after(() => fx.close())

// 网格 4 列 × 3 行：
//   列1 座位 / 列2 走廊 / 列3 座位（其中第 1 排那格是空位 HOLE）/ 列4 座位
//   第 3 排整行走廊
const TYPES = [
  [0, 1, 2, 0],
  [0, 1, 0, 0],
  [1, 1, 1, 1],
]
const SEATS = [
  [11, null, null, null],
  [null, null, null, 12],
  [null, null, null, null],
]

function seed() {
  const conn = fx.reset()
  conn.prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)').run(11, '张三')
  conn.prepare('INSERT INTO students (id, 姓名) VALUES (?, ?)').run(12, '李四')
  conn.prepare(
    `UPDATE seat_slots SET mode = 'single', rows = ?, cols = ?, seats = ?, types = ? WHERE kind = 'current'`
  ).run(TYPES.length, TYPES[0].length, JSON.stringify(SEATS), JSON.stringify(TYPES))
}

function seatImage() {
  const img = buildExportImage({ targets: 'seat' })
  assert.equal(img.error, undefined, JSON.stringify(img))
  return img.spec.items[0]
}

test('空位（HOLE）输出「空位」，与「有桌无人」的空串区分开', () => {
  seed()
  const img = seatImage()
  // 行首是「第N排」，数据格下标 = 网格列下标 + 1
  assert.equal(img.rows[0][3], '空位', `空位格必须写「空位」，实际：${JSON.stringify(img.rows[0])}`)
  assert.equal(img.rows[0][1], '张三')
  // 同排的座位列空格 = 有桌无人，仍是空串（不能一起标成空位）
  assert.equal(img.rows[0][2], '', '走廊格保持空串')
  assert.equal(img.rows[0][4], '', '座位列空座保持空串（有桌无人）')
  assert.equal(img.rows[1][4], '李四')
})

test('整行走廊仍整排写「走廊」', () => {
  seed()
  const img = seatImage()
  assert.deepEqual(img.rows[2].slice(1), Array(4).fill('走廊'))
})

// 正例与变异反证共用同一判据（T07-02）：变异源码必须回喂它，才算真反证。
function wiringGuard(src) {
  const holeBranch = /t === SEAT_CELL\.HOLE\)\s*\{ line\.push\('空位'\); continue; \}/.test(src)
  const fromSeatGrid = /const \{ SEAT_CELL, columnLabels, rowIsAisle \} = require\([^)]*seatGrid'\)/.test(src)
  return {
    ok: holeBranch && fromSeatGrid,
    why: holeBranch ? (fromSeatGrid ? '' : 'SEAT_CELL 未从 services/seatGrid 取') : '缺少 HOLE→「空位」分支',
  }
}

test('接线：图片执行器按 SEAT_CELL.HOLE 输出「空位」（不是只判「是不是空」）', () => {
  const src = fs.readFileSync(abs(IMAGE_SRC), 'utf8')
  const r = wiringGuard(src)
  assert.ok(r.ok, r.why)
})

test('变异反证：真模块删掉 HOLE 分支后，座位图行为必须退化', () => {
  seed()
  assert.equal(seatImage().rows[0][3], '空位', '基线必须通过，否则反证无意义')
  // N1-28：变异真实模块后调它的真函数，不再只改本地源码串再跑正则。
  const mutated = loadMutated(IMAGE_SRC, (s) => {
    const out = s.replace("if (t === SEAT_CELL.HOLE) { line.push('空位'); continue; }", '/* MUTATED */')
    if (out === s) throw new Error('变异没匹配到 HOLE 分支')
    return out
  })
  const img = mutated.buildExportImage({ targets: 'seat' })
  const val = img.spec.items[0].rows[0][3]
  assert.notEqual(val, '空位', `判据假绿：删掉 HOLE 分支后仍输出「空位」，实际 ${JSON.stringify(val)}`)
})
