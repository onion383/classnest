// V10-U02-01：本文件的源码串副本变异是**静态旁证**，不是真模块回放；真回放范式见 ai-read-scope-gate.test.js（loadMutated + 依赖 stub + 真调函数）。
// =========================================================================
// ai-rollback-busy.test.js —— 回退会话期间忙碌锁（3-3 / #40）
//
// 原缺陷：rollbackFrom 是 async（多个 await），但入口只检查 busy 没置 busy=true，
// 回退期间用户能再发消息/再点回退 → 并发操作同一批 undoIds，重复撤回/乱序。
// 对照：undoRollback/redoRollback 都已在入口置 busy + finally 释放；只有 rollbackFrom 漏了。
// 修法：入口置 busy=true，try/catch/finally 的 finally 统一释放。
//
// 判据：源码接线（入口置位 + finally 释放 + 异常路径也释放）+ 变异反证。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const SRC = abs('student-frontend/src/composables/ai/aiChat.js')
const src = fs.readFileSync(SRC, 'utf8')

// 按 AST 取方法：旧的 '\n    },' 硬编码 4 空格缩进 + 逗号收尾，缩进/尾逗号
// 任一变化就切错（-1 时 slice 会把后面所有方法都算进来）。
function methodBody(name) {
  return extractFunctionDecl(src, name)
}

const body = methodBody('rollbackFrom')

test('rollbackFrom 入口在 busy 检查后置 busy=true', () => {
  const guard = body.indexOf('if (ctx.busy.value || !ctx.isRollbackable(i)) return')
  const set = body.indexOf('ctx.busy.value = true')
  assert.ok(guard >= 0, '缺 busy 入口检查')
  assert.ok(set > guard, '必须在入口检查之后立即置 busy=true（回退期间占住）')
})

test('rollbackFrom 用 finally 统一释放 busy（异常路径也释放）', () => {
  const fin = body.lastIndexOf('} finally {')
  const release = body.lastIndexOf('ctx.busy.value = false')
  assert.ok(fin >= 0, '缺 finally 块')
  assert.ok(release > fin, 'finally 里必须释放 busy')
  const catchIdx = body.indexOf('} catch (err) {')
  assert.ok(catchIdx > 0 && catchIdx < fin, 'finally 必须在 catch 之后，覆盖异常路径')
})

test('对照：undoRollback 已是同口径（证明这是「一处修了兄弟没修」）', () => {
  const u = methodBody('undoRollback')
  assert.match(u, /ctx\.busy\.value = true/)
  assert.match(u, /finally \{\s*\n\s*ctx\.busy\.value = false/)
})

test('变异反证：去掉入口置位或 finally 释放后判据失败', () => {
  const noSet = body.replace('ctx.busy.value = true', 'void 0')
  assert.ok(noSet !== body, '变异没匹配到入口置位')
  assert.throws(() => {
    const guard = noSet.indexOf('if (ctx.busy.value || !ctx.isRollbackable(i)) return')
    const set = noSet.indexOf('ctx.busy.value = true')
    assert.ok(set > guard, '入口置位被去掉后判据应失败')
  })
  const noRelease = body.replace(/ctx\.busy\.value = false/, 'void 0')
  assert.ok(noRelease !== body, '变异没匹配到 finally 释放')
  assert.throws(() => {
    const fin = noRelease.lastIndexOf('} finally {')
    const release = noRelease.lastIndexOf('ctx.busy.value = false')
    assert.ok(release > fin, '释放被去掉后判据应失败')
  })
})
