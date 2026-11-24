// =========================================================================
// lifecycle-cleanup.test.js —— v8 审查 B-2（RC-LIFECYCLE）资源/会话/监听器生命周期
//
// 覆盖：
//   E01-06 主密钥备份轮转、K01-18 连接硬顶摘除即 close、K05-04 撤销记录 TTL（行为在
//   undo-retention）、P2-02 信道会话硬顶、P2-03 扫描计数 TTL、P2-04 取消条目宽限回收、
//   X3-15 登出销毁信道会话、F01-08 CadreManage 代次、F02-05 手写弹窗 Esc、
//   F02-12 关窗后泵停止、F04-04 waitScan 可 settle、F04-09 轮询资源随账号释放、
//   F06-04 拖拽卸载回收、F06-09 懒加载重试/rAF 回收、T02/T03 测试资产不落仓库。
// 变异反证：去掉任一清理点，对应断言即红。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

test('E01-06：主密钥备份保留最近 N 份，两条备份路径都轮转', () => {
  const src = read('electron/main/main.config.js')
  assert.match(src, /const KEY_BACKUP_KEEP = 5/)
  assert.match(src, /function pruneKeyBackups\(keyFile\)/)
  const calls = src.match(/^\s+pruneKeyBackups\(keyFile\)/gm) || []
  assert.ok(calls.length >= 2, `重加密与解密失败两条路径都要轮转，实际 ${calls.length} 处`)
})

test('K01-18：连接硬顶摘除当前连接时先 close', () => {
  const src = read('student-backend/dbManager/dbManager.base.js')
  const i = src.indexOf('if (connCache.size > CONN_CACHE_HARD_MAX)')
  assert.ok(i > 0, '找不到硬顶分支')
  const end = src.indexOf("throw new Error('同时打开的数据库连接过多", i)
  assert.ok(end > i, '硬顶分支结构变了')
  const seg = src.slice(i, end)
  assert.match(seg, /connCache\.delete\(slug\)/)
  assert.match(seg, /conn\.close\(\)/, '摘除不 close 会把句柄留在悬空态')
})

test('P2-02 / X3-15：信道会话有条数硬顶，登出后销毁当前信道', () => {
  const sc = read('student-backend/services/secureChannel.js')
  assert.match(sc, /const SESSION_MAX = 2000/)
  assert.match(sc, /while \(sessions\.size > SESSION_MAX\)/)
  const auth = read('student-backend/routes/auth.js')
  assert.match(auth, /secureChannel\.destroySession\(channelSid\)/, '登出后不能只解绑、不销毁')
})

test('P2-03 / P2-04：扫描计数与取消条目都有回收路径', () => {
  const scan = read('student-backend/albumScan.js')
  assert.match(scan, /PERSIST_COUNTER_TTL_MS/)
  assert.match(scan, /for \(const \[k, v\] of persistCounters\)/)
  const worker = read('student-backend/scanWorker.js')
  assert.match(worker, /CANCEL_LINGER_MS/)
  assert.match(worker, /if \(active\.get\(key\) === t && t\.cancelled\) active\.delete\(key\)/)
})

test('F01-08：CadreManage 两条加载都有代次守卫，学生列表失败不再静默', () => {
  const src = read('student-frontend/src/components/CadreManage.vue')
  assert.match(src, /const treeSeq = createLatest\(\)/)
  assert.match(src, /const studentsSeq = createLatest\(\)/)
  assert.match(src, /if \(!treeSeq\.isCurrent\(my\)\) return false/)
  assert.match(src, /if \(!studentsSeq\.isCurrent\(my\)\) return/)
  assert.match(src, /学生列表加载失败/, '失败不能与「名册为空」共用空态')
})

test('F02-05：六个手写弹窗都接入 dialogStack 的 Esc 关闭（DialogShell 或 useDialogEscape）', () => {
  const files = [
    'student-frontend/src/components/data-manage/DataManageDialog.vue',
    'student-frontend/src/components/data-manage/ExportChatDialog.vue',
    'student-frontend/src/components/data-manage/ExportMarkdownDialog.vue',
    'student-frontend/src/components/data-manage/MarkdownEditDialog.vue',
    'student-frontend/src/components/dialogs/ProvisionalStudentsDialog.vue',
    'student-frontend/src/components/dialogs/ReceiptDialog.vue',
  ]
  for (const f of files) {
    const src = read(f)
    // N5-11：已迁到 DialogShell 的走 @overlay（Esc 与点遮罩同义，由 dialogStack 判最上层）；
    // 仍是手写遮罩的走 useDialogEscape
    const viaShell = /<DialogShell[^>]*@overlay=/.test(src)
    const viaHelper = /useDialogEscape\(\(\) => props\.visible/.test(src)
    assert.ok(viaShell || viaHelper, `${f} 未接 Esc`)
    assert.ok(!(viaShell && viaHelper), `${f} 同时挂了 DialogShell 与 useDialogEscape，Esc 会走两套`)
  }
  const helper = read('student-frontend/src/composables/useDialogEscape.js')
  assert.match(helper, /pushDialog\(self\)/)
  assert.match(helper, /isTopDialog\(self\)/, '只有最上层响应 Esc')
})

test('F02-12：AlbumTaskDialog 卸载后泵不再提交/回写', () => {
  const src = read('student-frontend/src/components/dialogs/AlbumTaskDialog.vue')
  assert.match(src, /let disposed = false/)
  assert.match(src, /while \(queue\.value\.length && !disposed\)/)
  assert.match(src, /if \(!disposed\) fetchTasks\(\)/)
  assert.match(src, /onBeforeUnmount\(\(\) => \{\s*disposed = true/)
})

test('F04-04 / F04-09：轮询 Promise 可 settle，账号级资源随登出释放', () => {
  const scan = read('student-frontend/src/composables/useAlbumScan.js')
  assert.match(scan, /const pendingDones = new Set\(\)/)
  assert.match(scan, /for \(const done of Array\.from\(pendingDones\)\) done\(\)/)
  for (const f of ['student-frontend/src/composables/useTodoCenter.js', 'student-frontend/src/composables/useOverdueLeaveBadge.js']) {
    const src = read(f)
    assert.match(src, /if \(disposables\) \{ disposables\.dispose\(\); disposables = null \}/, `${f} 未释放定时器/监听`)
  }
})

test('F06-04 / F06-09：拖拽与懒加载定时器在卸载时回收', () => {
  const group = read('student-frontend/src/views/GroupManageView.vue')
  assert.match(group, /function disposeMemberDrag\(\)/)
  assert.match(group, /onBeforeUnmount\(disposeMemberDrag\)/)
  assert.match(group, /d\.ghost\.remove\(\)/)
  const ai = read('student-frontend/src/views/AiAssistant.vue')
  assert.match(ai, /const _lazyTimers = new Set\(\)/)
  assert.match(ai, /for \(const t of _lazyTimers\) clearTimeout\(t\)/)
  assert.match(ai, /cancelAnimationFrame\(_scrollRaf\)/)
})

test('T02/T03：测试资产的临时产物不落仓库、失败路径有清理', () => {
  assert.match(read('testjs/probe/_sample-big.cjs'), /os\.tmpdir\(\), 'classnest-probe'/)
  assert.match(read('testjs/probe/vapor-bench.mjs'), /OUT_DIR = path\.join\(os\.tmpdir\(\), 'classnest-probe'\)/)
  assert.match(read('testjs/smoke/pdf-subset-verify.mjs'), /os\.tmpdir\(\), 'classnest-smoke'/)
  assert.match(read('testjs/smoke/pptx-guard-test.cjs'), /process\.on\('exit', \(\) => \{ try \{ fs\.rmSync\(TMP/)
  assert.match(read('testjs/tools/mutate-sweep.cjs'), /for \(const sig of \['SIGINT', 'SIGTERM'\]\)/)
  assert.match(read('testjs/smoke/album-scan-two-phase-test.cjs'), /失败路径也要回收隔离数据目录/)
})
