// =========================================================================
// not-found-404.test.js —— PUT/DELETE 不存在的 id 必须 404（4-3）
//
// 原缺陷：activities / countdowns 的编辑与删除、album 的删除都不看写入返回的
// changes，命中 0 行照样回「修改成功 / 删除成功」。多窗口或删除后立刻再点一次时，
// 用户看不到任何异常，以为改动已保存（而库里根本没有这一行）。
//
// 判据：
//   ① 行为：不存在的 id 四个写入口都 404；存在的 id 仍然成功（不能为了 404 把正常路径弄坏）；
//   ② 接线：每处 404 都由「命中 0 行」触发（而不是无条件 404）；
//   ③ 变异反证：抹掉 changes 判据后，接线判据必须失败。
//
// 复核后**不入卡**的三格（矩阵规则只看有没有 404 字样，属于误报）：
//   · dynamicTable PUT/DELETE —— updateRow/deleteRow 内部已 throw「记录不存在」，路由回 400；
//     语义正确，只是状态码不是 404。
//   · ai.conversations 的 last-assistant —— 契约是幂等 { success:true, removed:false }，
//     前端重试前清理用，removed 已如实表示「没删到」。
//   · undo DELETE —— 幂等删除，前端不展示「删除成功」提示，重复删除无副作用。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const { createBackendDb } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'not-found-404', currentSlug: 'not-found-class' })
let conn

test.before(async () => {
  await fx.mount('/api/activities', 'student-backend/routes/activities.js')
  await fx.mount('/api/countdowns', 'student-backend/routes/countdowns.js')
  await fx.mount('/api/album', 'student-backend/routes/album.js')
})
test.after(() => fx.close())
test.beforeEach(() => { conn = fx.reset() })

const MISSING = 999999

// ————————————————————————— ① 行为 —————————————————————————

test('活动：编辑/删除不存在的 id → 404', async () => {
  const put = await fx.call('PUT', `/api/activities/${MISSING}`, { 主题: '不存在' })
  assert.equal(put.status, 404, `编辑不存在的活动必须 404（收到 ${put.status}）：${put.text}`)
  const del = await fx.call('DELETE', `/api/activities/${MISSING}`)
  assert.equal(del.status, 404, `删除不存在的活动必须 404（收到 ${del.status}）：${del.text}`)
})

test('活动：存在的 id 仍能编辑与删除（404 判据不能误伤正常路径）', async () => {
  const created = await fx.call('POST', '/api/activities', { 时间: '2026-11-05', 主题: '原主题' })
  assert.equal(created.status, 200, created.text)
  const id = created.json.id

  const put = await fx.call('PUT', `/api/activities/${id}`, { 主题: '新主题' })
  assert.equal(put.status, 200, put.text)
  assert.equal(conn.prepare('SELECT 主题 FROM activities WHERE id = ?').get(id).主题, '新主题')

  const del = await fx.call('DELETE', `/api/activities/${id}`)
  assert.equal(del.status, 200, del.text)
  assert.equal(conn.prepare('SELECT COUNT(*) AS n FROM activities').get().n, 0)
})

test('倒计时：编辑/删除不存在的 id → 404，存在的 id 正常', async () => {
  const put = await fx.call('PUT', `/api/countdowns/${MISSING}`, { 名称: '不存在' })
  assert.equal(put.status, 404, `编辑不存在的倒计时必须 404（收到 ${put.status}）：${put.text}`)
  const del = await fx.call('DELETE', `/api/countdowns/${MISSING}`)
  assert.equal(del.status, 404, `删除不存在的倒计时必须 404（收到 ${del.status}）：${del.text}`)

  const created = await fx.call('POST', '/api/countdowns', { 名称: '期末考试', 截止日: '2026-12-31' })
  assert.equal(created.status, 200, created.text)
  const id = created.json.id
  assert.equal((await fx.call('PUT', `/api/countdowns/${id}`, { 名称: '改名' })).status, 200)
  assert.equal((await fx.call('DELETE', `/api/countdowns/${id}`)).status, 200)
})

test('相册：删除不存在的 id → 404', async () => {
  const del = await fx.call('DELETE', `/api/album/${MISSING}`)
  assert.equal(del.status, 404, `删除不存在的相册必须 404（收到 ${del.status}）：${del.text}`)
})

// ————————————————————————— ② 接线 —————————————————————————

function handlerOf(file, method, routePath) {
  const src = read(file)
  const parts = src.split(/(?=router\.(?:get|post|put|patch|delete)\s*\()/)
  const h = parts.find((p) => p.startsWith(`router.${method}('${routePath}'`))
  assert.ok(h, `未找到 ${method.toUpperCase()} ${routePath}（${file}）`)
  return h
}

test('接线：四处 404 都由「命中 0 行」触发', () => {
  for (const [file, method, routePath] of [
    ['student-backend/routes/activities.js', 'put', '/:id'],
    ['student-backend/routes/activities.js', 'delete', '/:id'],
    ['student-backend/routes/countdowns.js', 'put', '/:id'],
    ['student-backend/routes/countdowns.js', 'delete', '/:id'],
  ]) {
    const h = handlerOf(file, method, routePath)
    assert.match(h, /changes === 0\)[\s\S]{0,80}status\(404\)/,
      `${method.toUpperCase()} ${routePath}（${file}）必须按 changes === 0 回 404`)
  }
  // 相册是「先查存在」而非 changes：删除前的缩略图清理有副作用，必须先挡住
  const albumDelete = handlerOf('student-backend/routes/album.js', 'delete', '/:id')
  const checkAt = albumDelete.indexOf('albumById(albumId)')
  const thumbsAt = albumDelete.indexOf('thumbRefsOfAlbum')
  assert.ok(checkAt >= 0, '删除相册必须先查 albumById')
  assert.ok(thumbsAt > checkAt, '存在性检查必须在删缩略图之前（否则 404 时已产生副作用）')
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：抹掉 changes 判据后，接线判据必须失败', () => {
  for (const file of ['student-backend/routes/activities.js', 'student-backend/routes/countdowns.js']) {
    const src = read(file)
    const mutated = src
      .replace(/if \(result\.changes === 0\) return res\.status\(404\)\.json\(\{ error: '(?:活动|倒计时)不存在' \}\);\r?\n/g, '')
    assert.ok(mutated !== src, `${file} 的变异没命中`)
    assert.doesNotMatch(mutated, /changes === 0\)[\s\S]{0,80}status\(404\)/,
      `${file} 变异后应无 changes 判据，接线判据须判失败`)
  }
})
