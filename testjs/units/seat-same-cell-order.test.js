// =========================================================================
// seat-same-cell-order.test.js —— 同格快速编辑乱序落库（3-10 / #23）
//
// 原缺陷：onCellsUpdate 每次调用各自起 IIFE 并发 PATCH，同一格两次编辑 slow-first /
// fast-second 时后端先收新值再收旧值，最终库里是旧值；且 next 是 seats.value 引用，
// 排队期间被后续编辑改写，撤销记录也错。
// 修法：commitQueue 把每次提交串行化 + next 用快照。
//
// 判据：源码接线（队列 + 快照 + catch 兜底）+ 变异反证。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const src = fs.readFileSync(path.join(ROOT, 'student-frontend/src/composables/useSeatGrid.js'), 'utf8')
const body = src.slice(src.indexOf('async function onCellsUpdate'), src.indexOf('\n  }', src.indexOf('async function onCellsUpdate') + 2000))

test('onCellsUpdate 有串行提交队列，单格 PATCH 排在队列尾', () => {
  assert.match(src, /let commitQueue = Promise\.resolve\(\)/, '缺提交队列')
  assert.match(body, /commitQueue = commitQueue\.catch\(\(\) => \{\}\)\.then\(async \(\) => \{/,
    '单格提交必须排到串行队列尾（且 catch 兜底不让队列断掉）')
})

test('next 用快照而非 seats.value 引用', () => {
  assert.match(body, /const next = seats\.value\.map\(r => \[\.\.\.r\]\)/, 'next 必须是快照')
  assert.doesNotMatch(body, /const next = seats\.value\s*\n/, '不能再用引用')
})

test('撤销记录与提交都基于同一次调用的 prev/next 快照', () => {
  // 队列回调里仍用闭包捕获的 prev/next（已被快照固定）
  const queue = body.slice(body.indexOf('commitQueue = commitQueue'))
  assert.match(queue, /recordGridCellUndo\(undo\.key, undo\.table, r, c, prev\[r\]\?\.\[c\] \?\? null, next\[r\]\?\.\[c\] \?\? null/)
})

test('变异反证：去掉队列/快照后判据失败', () => {
  const mutated = body
    .replace('commitQueue = commitQueue.catch(() => {}).then(async () => {', ';(async () => {')
    .replace('const next = seats.value.map(r => [...r])', 'const next = seats.value')
  assert.ok(mutated !== body, '变异没匹配到队列/快照')
  assert.doesNotMatch(mutated, /commitQueue = commitQueue\.catch/, '变异后队列判据应失败')
  assert.doesNotMatch(mutated, /const next = seats\.value\.map/, '变异后快照判据应失败')
})
