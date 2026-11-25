// =========================================================================
// group-dim-naming-guard.test.js —— 维度详情加载失败自动命名改错旧维度（3-8 / #51）
//
// 原缺陷：submitAddDim 里 await selectDim(data.id) 后直接 applyAddDimNames，但 selectDim
// 加载失败时 active 仍是旧维度 → applyAddDimNames 读旧维度 groups 去改名，污染旧记录。
// 修法：selectDim 返回成功状态；submitAddDim 据此决定是否 apply；applyAddDimNames
// 命名前校验 current.id === dimId。
//
// 判据：源码接线 + 变异反证。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const src = fs.readFileSync(abs('student-frontend/src/views/GroupManageView.vue'), 'utf8')

function bodyOf(name) {
  // 按 AST 取：旧的 indexOf('\n}') 在函数缩进后（<script setup> 里）返回 -1，
  // slice(i, -1) 把几乎整份文件当成函数体，判据会跨函数命中。
  return extractFunctionDecl(src, name)
}

test('selectDim 成功/失败/过期都返回状态', () => {
  const b = bodyOf('selectDim')
  assert.match(b, /return true/, '成功要返回 true')
  assert.ok((b.match(/return false/g) || []).length >= 2, '过期 + 失败两条路径都要返回 false')
})

test('submitAddDim 据 selectDim 结果决定是否自动命名', () => {
  const b = bodyOf('submitAddDim')
  assert.match(b, /if \(await selectDim\(data\.id\)\) await applyAddDimNames\(data\.id\)/,
    '详情加载失败时不能自动命名')
})

test('applyAddDimNames 命名前校验当前维度是目标维度', () => {
  const b = bodyOf('applyAddDimNames')
  assert.match(b, /String\(current\.id\) !== String\(dimId\)/, '未校验当前维度归属')
  assert.match(b, /const current = active\.value\?\.dimension/, '未取当前维度详情')
})

test('变异反证：去掉维度校验后判据失败', () => {
  const mutated = src
    .replace(/if \(!current \|\| String\(current\.id\) !== String\(dimId\)\) return;/, '/* 去掉校验 */')
    .replace('if (await selectDim(data.id)) await applyAddDimNames(data.id);', 'await selectDim(data.id); await applyAddDimNames(data.id);')
  assert.ok(mutated !== src, '变异没匹配到守卫')
  assert.doesNotMatch(mutated, /String\(current\.id\) !== String\(dimId\)/, '变异后判据应失败')
})
