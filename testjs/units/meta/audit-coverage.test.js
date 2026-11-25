// =========================================================================
// audit-coverage.test.js —— 覆盖矩阵检查器的自测与变异反证
//
// 光有矩阵不算覆盖：这里故意造一个迷你仓库，先让检查器报出缺口，
// 再把每条守卫“修回去”，要求同一批格子全部变 PASS。
// 如果移除/补回守卫对结果没有影响，就是这个检查规则的假绿。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const auditPromise = import('../../tools/audit-coverage.mjs')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-coverage-'))
const write = (rel, content) => {
  const abs = path.join(root, rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

write('student-backend/routes/demo.js', `
const express = require('express');
const router = express.Router();
router.get('/', (req, res) => res.json({ ok: true }));
router.put('/:id', (req, res) => {
  const result = update(req.params.id, req.body);
  res.json({ message: '修改成功' });
});
module.exports = router;
`)
write('student-backend/routes/auth.js', `
const opts = signOptsFor(user.dbSlug);
router.post('/db-recover', (req, res) => {
  const resolved = dbManager.resolveByUsername(name);
  if (!resolved) return res.status(400).json({ error: '无账号' });
  res.json({ ok: true });
});
router.post('/recover-password', async (req, res) => {
  const hash = await bcryptHash(req.body.password, 10);
  userStore.setPasswordByName(conn, req.body.username, hash);
  revokeAccountSessions(user.id, resolved.slug);
  res.json({ message: '密码已重置' });
});
`)
write('student-backend/routes/ai/ai.dataRoutes.js', `
router.post('/apply-batch', async (req, res) => {
  applyRowStudentRef(table, row);
  purgeStudentRelations(id);
  aiStore.updateColumns('students', id, ['姓名'], [row['姓名']]);
  res.json({ ok: true });
});
`)
write('student-backend/routes/ai/ai.tools/tools.executors/executors.checks.js', `
function checkHealth() {
  const rows = activityStore.readAll();
  return rows.length;
}
module.exports = { checkHealth };
`)
write('student-backend/routes/leaves.js', `
router.post('/import', (req, res) => {
  const rows = req.body.rows.map((name) => tryResolve(name));
  db.transaction(() => insertMany(rows))();
  res.json({ ok: true });
});
`)
write('student-backend/services/backupArchive.js', `
function extractZip(zip, root) {
  zip.on('entry', (entry) => {
    const target = path.join(root, entry.fileName);
    if (isUnsafeName(target)) return;
    fs.mkdirSync(path.dirname(target), { recursive: true });
  });
}
`)
write('student-backend/routes/ai/privacy.shared.js', `
function setTableLevel(table, level, io) {
  const closed = new Set();
  const ro = new Set();
  closed.delete(key); ro.delete(key);
  if (lv === 'none') closed.add(key);
  if (lv === 'read' && supportsWrite(key)) ro.add(key);
  return io.set({ closed_tables: [...closed], readonly_tables: [...ro] });
}
`)
write('student-backend/services/aiWriteScope.js', `
function isTableWritable(table) {
  return !readonlyTables().includes(table);
}
`)
write('student-backend/services/undoStore.js', `
db.prepare('UPDATE undo_history SET dir = ? WHERE id = ? AND dir = ?').run(dir, id, oldDir);
`)
write('electron/ipc-channels.json', JSON.stringify({ send: ['known-channel'], invoke: ['unknown-channel'] }))
write('electron/ipc-policy.json', JSON.stringify({ 'known-channel': ['main'], _comment: 'fixture' }))
write('electron/main/main.dev-loader.js', `
function loadUrlWithRetry(win, url) {
  const http = require('http');
  http.get(url, (res) => { res.resume(); win.loadURL(url); });
}
function looksLikeOurVite(html) { return html.includes('vite'); }
`)
write('electron/main/main.updater.js', `
const child = spawn(resolved, ['/SILENT'], { detached: true, stdio: 'ignore' });
child.unref();
launched = true;
`)
write('student-frontend/src/components/Demo.vue', `
<template><div /></template>
<script setup>
import { onUnmounted } from 'vue'
const timer = setTimeout(() => {}, 1000)
onUnmounted(() => clearTimeout(timer))
</script>
`)
write('student-backend/routes/schedule.js', `
router.put('/:id', (req, res) => {
  const cells = req.body.cells;
  if (!Array.isArray(cells)) return res.status(400).json({ error: 'bad' });
  update(req.params.id, { cells: JSON.stringify(cells) });
  res.json({ message: '修改成功' });
});
`)
write('student-backend/routes/seats.js', `
router.patch('/cell', (req, res) => {
  setCell(req.body.row, req.body.col, req.body.value);
  res.json({ ok: true });
});
`)
write('student-backend/routes/undo/undo.executors.js', `
function gridCellUndo(payload) {
  const oldCols = payload.oldCols;
  writeCell(payload.row, payload.col);
}
`)
write('student-backend/dbManager/dbManager.account.js', `
function registryListValid() {
  return db.prepare('SELECT 1 FROM users WHERE username = ?').all(registry.username);
}
`)
write('student-backend/services/sessions.js', `
function has(sid) {
  return !!sessions[sid];
}
`)
write('electron/main/main.backend.js', `
const child = spawn(process.execPath, [script]);
child.kill();
`)
write('student-frontend/src/components/SaveDemo.vue', `
const result = await saveFile(blob);
if (result.canceled) return;
success('已保存');
`)
write('student-frontend/src/composables/useInflightDemo.js', `
async function load(key) {
  inFlight.add(key);
  const rows = await fetchRows();
  inFlight.delete(key);
  return rows;
}
`)

function cellOf(result, invariant, predicate) {
  return result.cells.find((c) => c.invariant === invariant && predicate(c))
}

test.after(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

test('首轮：所有已知缺口都被判为 GAP，已声明的通道为 PASS', async () => {
  const { runAudit } = await auditPromise
  const result = runAudit({ root, date: '2026-01-01', write: false })
  const expectGap = [
    ['route.not_found_404', (c) => c.file.endsWith('demo.js') && c.entry.includes(':put:')],
    ['route.not_found_404', (c) => c.file.endsWith('schedule.js') && c.entry.includes(':put:')],
    ['auth.account_hash_sync', (c) => c.entry.includes('recover-password')],
    ['auth.revoke_all_slugs', (c) => c.entry.includes('recover-password')],
    ['auth.session_opts_key', (c) => c.file.endsWith('routes/auth.js')],
    ['auth.recovery_rename_fallback', (c) => c.entry.includes('db-recover')],
    ['student.rename_cascade', (c) => c.file.endsWith('ai.dataRoutes.js')],
    ['undo.cascade_delete_snapshot', (c) => c.file.endsWith('ai.dataRoutes.js')],
    ['ai.privacy_read', (c) => c.file.endsWith('executors.checks.js')],
    ['write.transaction_scope', (c) => c.file.endsWith('leaves.js')],
    ['restore.path_containment', (c) => c.file.endsWith('backupArchive.js')],
    ['write.sanitize_gate', (c) => c.file.endsWith('schedule.js')],
    ['seat.single_cell_validation', (c) => c.file.endsWith('routes/seats.js')],
    ['undo.cell_layout_guard', (c) => c.file.endsWith('undo.executors.js')],
    ['undo.geometry_authoritative', (c) => c.file.endsWith('undo.executors.js')],
    ['account.rename_list_visibility', (c) => c.file.endsWith('dbManager.account.js')],
    ['process.kill_tree_detached', (c) => c.file.endsWith('main.backend.js')],
    ['process.startup_singleflight', (c) => c.file.endsWith('main.backend.js')],
    ['ipc.save_result_discriminator', (c) => c.file.endsWith('SaveDemo.vue')],
    ['async.inflight_cleanup', (c) => c.file.endsWith('useInflightDemo.js')],
    ['auth.session_idle_ttl', (c) => c.file.endsWith('sessions.js')],
    ['privacy.write_scope', (c) => c.file.endsWith('privacy.shared.js')],
    ['dev.subwindow_identity', (c) => c.file.endsWith('main.dev-loader.js')],
    ['lifecycle.resource_disposal', (c) => c.file.endsWith('Demo.vue')],
    ['ipc.policy_declared', (c) => c.entry.includes('unknown-channel')],
  ]
  for (const [invariant, predicate] of expectGap) {
    const cell = cellOf(result, invariant, predicate)
    assert.ok(cell, `缺少格子：${invariant}`)
    assert.equal(cell.status, 'GAP', `${invariant} 应为 GAP，实际 ${cell.status}`)
  }
  const known = cellOf(result, 'ipc.policy_declared', (c) => c.entry.includes('known-channel'))
  assert.equal(known.status, 'PASS')
  assert.ok(result.markdown.includes('## GAP 明细'))
  assert.ok(result.summary.uniqueGAP >= expectGap.length)
})

test('变异反证：补回每条守卫后，同一批格子全部变 PASS', async () => {
  const { runAudit } = await auditPromise
  write('student-backend/routes/demo.js', `
const router = express.Router();
router.put('/:id', (req, res) => {
  const result = update(req.params.id, req.body);
  if (result.changes === 0) return res.status(404).json({ error: '不存在' });
  res.json({ message: '修改成功' });
});
`)
  write('student-backend/routes/auth.js', `
const opts = signOptsFor(user.username);
router.post('/db-recover', (req, res) => {
  const resolved = dbManager.resolveByUsername(name)
    || userStore.findFirstUser(conn);
  if (!resolved) return res.status(400).json({ error: '无账号' });
  res.json({ ok: true });
});
router.post('/recover-password', async (req, res) => {
  userStore.setPasswordByName(conn, name, hash);
  dbManager.accountSetPassword(acc.id, hash);
  rotateAccountSessions(acc.id);
  res.json({ message: '密码已重置' });
});
`)
  write('student-backend/routes/ai/ai.dataRoutes.js', `
router.post('/apply-batch', async (req, res) => {
  const guard = writeScope.isTableWritable('students');
  if (guard.error) return res.status(403).json(guard);
  applyRowStudentRef(table, row);
  renameStudentRefs(oldName, row['姓名'], id);
  const relations = purgeStudentRelations(id);
  recordUndo('student_cascade_delete', relations);
  aiStore.updateColumns('students', id, ['姓名'], [row['姓名']]);
  res.json({ ok: true });
});
`)
  write('student-backend/routes/ai/ai.tools/tools.executors/executors.checks.js', `
function checkHealth() {
  if (!readScope.isTableReadable('activities')) return { error: 'closed' };
  const rows = activityStore.readAll();
  return rows.length;
}
`)
  write('student-backend/routes/leaves.js', `
router.post('/import', (req, res) => {
  db.transaction(() => {
    const rows = req.body.rows.map((name) => tryResolve(name));
    insertMany(rows);
  })();
  res.json({ ok: true });
});
`)
  write('student-backend/services/backupArchive.js', `
function extractZip(zip, root) {
  zip.on('entry', (entry) => {
    try {
      const target = path.join(root, entry.fileName);
      if (isUnsafeName(target)) return;
      fs.mkdirSync(path.dirname(target), { recursive: true });
    } catch (err) { throw err }
  });
}
`)
  write('student-backend/routes/ai/privacy.shared.js', `
function setTableLevel(table, level, io) {
  const closed = new Set();
  const ro = new Set();
  if (lv === 'none') { closed.add(key); ro.add(key); }
  return io.set({ closed_tables: [...closed], readonly_tables: [...ro] });
}
`)
  write('student-backend/services/aiWriteScope.js', `
function isTableWritable(table) {
  return !readonlyTables().includes(table) && !closed_tables.includes(table);
}
`)
  write('electron/main/main.dev-loader.js', `
function loadUrlWithRetry(win, url) {
  if (!looksLikeOurVite(url)) return;
  win.loadURL(url);
}
function looksLikeOurVite(html) { return html.includes('vite'); }
`)
  write('electron/main/main.updater.js', `
const child = spawn(resolved, ['/SILENT'], { detached: true, stdio: 'ignore' });
child.once('error', (err) => setUpdateState({ status: 'error', error: err.message }));
child.unref();
`)
  write('student-frontend/src/components/Demo.vue', `
<template><div /></template>
<script setup>
import { d } from 'utils/disposables'
d.timeout(() => {}, 1000)
</script>
`)
  write('student-backend/routes/schedule.js', `
router.put('/:id', (req, res) => {
  const cells = sanitizeField(req.body.cells, 'schedule', 'cells');
  const result = update(req.params.id, { cells: JSON.stringify(cells) });
  if (result.changes === 0) return res.status(404).json({ error: '不存在' });
  res.json({ message: '修改成功' });
});
`)
  write('student-backend/routes/seats.js', `
router.patch('/cell', (req, res) => {
  seatWrite.assertCellInLayout(req.body.row, req.body.col);
  setCell(req.body.row, req.body.col, req.body.value);
  res.json({ ok: true });
});
`)
  write('student-backend/routes/undo/undo.executors.js', `
function gridCellUndo(payload) {
  const oldCols = payload.oldCols;
  assertCellInLayout(payload.row, payload.col, authoritativeLayout());
  writeCell(payload.row, payload.col);
}
`)
  write('student-backend/dbManager/dbManager.account.js', `
function registryListValid() {
  return db.prepare('SELECT 1 FROM users WHERE slug = ?').all(registry.slug);
}
`)
  write('student-backend/services/sessions.js', `
function has(sid) {
  if (!sessions[sid]) return false;
  sessions[sid].at = Date.now();
  return true;
}
`)
  write('electron/main/main.backend.js', `
const { createSingleFlight } = require('./main.single-flight');
const child = spawn(process.execPath, [script], { detached: true });
taskkill(['/PID', child.pid, '/T', '/F']);
const startBackend = createSingleFlight(async () => { await compile(); });
`)
  write('student-frontend/src/components/SaveDemo.vue', `
const result = await saveFile(blob);
if (result.outcome === 'canceled') return;
if (result.outcome === 'error') return fail();
success('已保存');
`)
  write('student-frontend/src/composables/useInflightDemo.js', `
async function load(key) {
  inFlight.add(key);
  try {
    return await fetchRows();
  } finally {
    inFlight.delete(key);
  }
}
`)
  write('electron/ipc-policy.json', JSON.stringify({
    'known-channel': ['main'],
    'unknown-channel': ['main'],
    _comment: 'fixture',
  }))

  const result = runAudit({ root, date: '2026-01-02', write: false })
  const expectPass = [
    ['route.not_found_404', (c) => c.file.endsWith('demo.js') && c.entry.includes(':put:')],
    ['route.not_found_404', (c) => c.file.endsWith('schedule.js') && c.entry.includes(':put:')],
    ['auth.account_hash_sync', (c) => c.entry.includes('recover-password')],
    ['auth.revoke_all_slugs', (c) => c.entry.includes('recover-password')],
    ['auth.session_opts_key', (c) => c.file.endsWith('routes/auth.js')],
    ['auth.recovery_rename_fallback', (c) => c.entry.includes('db-recover')],
    ['student.rename_cascade', (c) => c.file.endsWith('ai.dataRoutes.js')],
    ['undo.cascade_delete_snapshot', (c) => c.file.endsWith('ai.dataRoutes.js')],
    ['ai.privacy_read', (c) => c.file.endsWith('executors.checks.js')],
    ['write.transaction_scope', (c) => c.file.endsWith('leaves.js')],
    ['restore.path_containment', (c) => c.file.endsWith('backupArchive.js')],
    ['write.sanitize_gate', (c) => c.file.endsWith('schedule.js')],
    ['seat.single_cell_validation', (c) => c.file.endsWith('routes/seats.js')],
    ['undo.cell_layout_guard', (c) => c.file.endsWith('undo.executors.js')],
    ['undo.geometry_authoritative', (c) => c.file.endsWith('undo.executors.js')],
    ['account.rename_list_visibility', (c) => c.file.endsWith('dbManager.account.js')],
    ['process.kill_tree_detached', (c) => c.file.endsWith('main.backend.js')],
    ['process.startup_singleflight', (c) => c.file.endsWith('main.backend.js')],
    ['ipc.save_result_discriminator', (c) => c.file.endsWith('SaveDemo.vue')],
    ['async.inflight_cleanup', (c) => c.file.endsWith('useInflightDemo.js')],
    ['auth.session_idle_ttl', (c) => c.file.endsWith('sessions.js')],
    ['privacy.write_scope', (c) => c.file.endsWith('privacy.shared.js')],
    ['dev.subwindow_identity', (c) => c.file.endsWith('main.dev-loader.js')],
    ['lifecycle.resource_disposal', (c) => c.file.endsWith('Demo.vue')],
    ['ipc.policy_declared', (c) => c.entry.includes('unknown-channel')],
  ]
  for (const [invariant, predicate] of expectPass) {
    const cell = cellOf(result, invariant, predicate)
    assert.ok(cell, `缺少格子：${invariant}`)
    assert.equal(cell.status, 'PASS', `变异反证失败：${invariant} 仍为 ${cell.status}`)
  }
  const remaining = [...new Set(result.cells.filter((c) => c.status === 'GAP').map((c) => c.findingKey))]
  assert.equal(result.summary.uniqueGAP, 0, `补回全部守卫后不应再有 GAP：${remaining.join(', ')}`)
})

test('save_result_discriminator：间接经统一 saveFile 封装消费三态也算 PASS（7-9 人工复核）', async () => {
  const { runAudit } = await auditPromise
  const r2 = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-save-indirect-'))
  try {
    const put = (rel, text) => {
      const abs = path.join(r2, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, text, 'utf8')
    }
    put('student-frontend/src/utils/saveFile.js', `
      import { classifySaveResult } from './saveResult.js';
      const kind = classifySaveResult(result);
      if (kind === 'canceled') return '';
      throw new Error('保存失败');
    `)
    put('student-frontend/src/components/Indirect.vue', `
      import { saveBlobWithDialog as saveFile } from '../../utils/saveFile.js';
      export async function go(blob) { return await saveFile('x.txt', blob); }
    `)
    const res = runAudit({ root: r2, date: '2026-01-01', write: false })
    const cell = cellOf(res, 'ipc.save_result_discriminator', (c) => c.file.endsWith('Indirect.vue'))
    assert.ok(cell, '应有格子')
    assert.equal(cell.status, 'PASS', '经统一封装消费三态应判 PASS')

    // 变异：把封装改成"只看 canceled"（写盘失败被当成取消）→ 应转 GAP
    put('student-frontend/src/utils/saveFile.js', `
      if (result.canceled) return '';
      return result.filePath;
    `)
    const bad = runAudit({ root: r2, date: '2026-01-01', write: false })
    const badCell = cellOf(bad, 'ipc.save_result_discriminator', (c) => c.file.endsWith('Indirect.vue'))
    assert.equal(badCell.status, 'GAP', '封装退化成只看 canceled 必须转 GAP')
  } finally {
    fs.rmSync(r2, { recursive: true, force: true })
  }
})
