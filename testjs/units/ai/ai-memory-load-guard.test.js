// =========================================================================
// ai-memory-load-guard.test.js —— V10-F02-03：AI 记忆读取失败不得静默回空后覆盖
//
// 根因：loadMemory 的 catch 把内容置空且不提示，编辑框看到空白，一保存就整体清空
// 已有记忆。修法：读取失败可见（notifyError）+ 保留旧内容 + 守卫拦住失败态的保存。
//
// 判据分层：
//   1) 纯函数 memorySaveGuard 真跑（非源码正则）：失败态禁写、技能文件不受影响、成功放行。
//   2) loadMutated 变异反证：删掉失败态分支 → 判据必须红；改掉 target 判断也红。
//   3) 组件接线静态断言：catch 保留旧内容 + notifyError、保存/编辑/导出都过守卫。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { pathToFileURL } = require('node:url')
const { read, abs } = require('#testjs/paths')

const GUARD_PATH = abs('student-frontend/src/utils/aiMemoryGuard.js')
const GUARD_URL = pathToFileURL(GUARD_PATH).href
const loadGuard = () => import(GUARD_URL)

// 把真源码变异后经 data: URL 加载，避开 ESM 缓存、不污染工作区。
async function loadMutated(mutate) {
  const src = fs.readFileSync(GUARD_PATH, 'utf8')
  const broken = mutate(src)
  assert.notEqual(broken, src, '变异没生效：锚点没匹配上')
  return import('data:text/javascript;base64,' + Buffer.from(broken).toString('base64'))
}

test('守卫真跑：记忆读取失败态一律禁写，技能文件不受影响', async () => {
  const { memorySaveGuard } = await loadGuard()

  const failed = memorySaveGuard({ target: 'memory', loadFailed: true, content: '' })
  assert.equal(failed.allowed, false, '失败态必须禁写')
  assert.match(failed.reason || '', /加载失败/, '禁写要给可读原因')

  const ok = memorySaveGuard({ target: 'memory', loadFailed: false, content: '' })
  assert.equal(ok.allowed, true, '读取成功时空记忆是合法内容，允许保存')

  const skill = memorySaveGuard({ target: 'skill', loadFailed: true, content: '' })
  assert.equal(skill.allowed, true, '技能文件有自己的读取路径，不受记忆失败态影响')

  const noCtx = memorySaveGuard()
  assert.equal(noCtx.allowed, true, '无上下文时按非记忆处理，不误伤')
})

test('变异反证：删掉失败态分支 → 守卫判据必须红', async () => {
  const { memorySaveGuard } = await loadMutated((s) => s.replace(
    /if \(loadFailed\) \{\s*return \{ allowed: false, reason: [^}]+\}\s*\}/,
    'if (loadFailed) { /* mutated: 允许保存 */ }'
  ))
  const failed = memorySaveGuard({ target: 'memory', loadFailed: true, content: '' })
  assert.equal(failed.allowed, true, '变异后失败态被放行 → 原判据确实在防这件事')
})

test('变异反证：target 判断反转 → 技能文件被误伤，判据必须红', async () => {
  const { memorySaveGuard } = await loadMutated((s) => s.replace(
    "if (target !== 'memory') return { allowed: true }",
    "if (target === 'memory') return { allowed: true }"
  ))
  const skill = memorySaveGuard({ target: 'skill', loadFailed: true, content: '' })
  assert.equal(skill.allowed, false, '变异后技能被拦 → 原判据确实在保护技能路径')
})

test('组件接线：失败可见 + 保留旧内容 + 编辑/保存/导出三处过守卫', () => {
  const dm = read('student-frontend/src/components/data-manage/DataManageDialog.vue')

  assert.match(dm, /memoryLoadFailed\.value = true[\s\S]*?notifyError\(errMsg\(err\)\)/,
    'loadMemory 失败必须置失败态并给出可见错误') // @pin student-frontend/src/components/data-manage/DataManageDialog.vue#loadMemory
  assert.ok(!/catch \(_\) \{ memoryContent\.value = '' \}/.test(dm),
    '不能再静默把记忆内容置空（失败伪装成空数据）')
  assert.match(dm, /memoryLoadFailed\.value = false/, '读取成功要清掉失败态')

  const guardCalls = dm.match(/memorySaveGuard\(/g) || []
  assert.ok(guardCalls.length >= 3,
    `守卫调用点只有 ${guardCalls.length} 个：编辑、保存、导出都要过守卫`)
  assert.match(dm, /function openEditMemory\(\)[\s\S]*?if \(!guard\.allowed\) \{ notifyError\(guard\.reason\); return \}/,
    '编辑入口要在失败态拒绝打开')
  assert.match(dm, /if \(dlg\.target === 'memory'\)[\s\S]*?if \(!guard\.allowed\) \{ notifyError\(guard\.reason\); return \}/,
    '保存入口要在失败态拒绝写库（双保险）')
})
