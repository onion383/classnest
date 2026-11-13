// =========================================================================
// backend-sideeffect.test.js —— 「校验阶段副作用」与「文件+索引非原子」的行为断言
//
// 覆盖 v4 台账 B04-05 / B04-08（批 16）：
//   · B04-08 assertDutyRefs 在**校验阶段**就写库（建临时学生）。而 resolveNames
//     自带事务 → **提前提交**；后续 duty.js 的 setDoc 失败时救不回来 → 名册里
//     凭空多出一个学生，值日表却没存进去（孤儿）。
//   · B04-05 photo_trash 的 undo：先把文件从回收站搬回原位，再 INSERT 索引。
//     两步非原子 → 中间态「文件在、索引不在」，用户看不到这张照片，但文件已归位。
//
// 手法：用公共夹具（_db-express-fixture.cjs，faults:true）—— require.cache 换掉 db.js 的
//      db 导出（代理到真内存库 + 第 K 次写抛错），同进程起 Express 挂真实 router，
//      fetch 打真实 HTTP。
//
// 运行：npm run test:units
// =========================================================================
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb } = require('./_db-express-fixture.cjs')

// albumOps 的回收站路径由 DATA_DIR 派生，这里必须和造文件用的目录是同一个
const TMP = path.join(os.tmpdir(), 'sideeffect-unit-' + process.pid)
const fx = createBackendDb({
  label: 'sideeffect',
  dataDir: TMP,
  faults: true,
  extraDbExports: { renumber: () => {} },
})

test.before(() => fx.mount('/api/duty', 'student-backend/routes/duty.js'))
test.after(() => fx.close())

// 配置值日项目（assertDutyRefs 会读 duty_settings 校验项目/星期是否已配置）
function seedDutySettings(conn, items, days) {
  conn.prepare('UPDATE duty_slots SET days = ?, items = ? WHERE kind = ?')
    .run(JSON.stringify(days), JSON.stringify(items), 'settings')
}

// ---------------------------------------------------------------------------
// B04-08：校验阶段的建档副作用
// ---------------------------------------------------------------------------

test('值日保存失败时不能留下孤儿临时学生（校验阶段建档的副作用必须与写库同生共死）', async () => {
  const conn = fx.reset()
  // 值日设置：新结构 —— days 按模式分键的星期数组，items 按模式分键的项目数组
  seedDutySettings(conn, { daily: [{ name: '扫地', count: 1 }] }, { daily: ['周一'] })
  // 建临时学生（students 表）成功后，让「值日表落库」这一步失败 —— 按 SQL 锁定注入点，
  // 不依赖「第 2 次写」这种会被新增写操作改掉的序号
  fx.inject({ failMatch: /duty_slots/i, failAtMatch: 1 })

  const r = await fx.call('PUT', '/api/duty', {
    mode: 'daily',
    cells: { 扫地: { 周一: ['新来的同学'] } },
  })
  assert.ok(r.status >= 400, '值日表写失败应报错（实际 ' + r.status + '：' + r.text.slice(0, 200) + '）')

  const students = conn.prepare("SELECT 姓名 FROM students WHERE 姓名 = '新来的同学'").all()
  assert.equal(
    students.length, 0,
    '值日表没存进去时，名册里不能凭空多出一个「新来的同学」（实际有 ' + students.length + ' 条）'
  )
})

test('值日保存成功时，名册外的姓名必须照常建档（不能为了修副作用把功能改没了）', async () => {
  const conn = fx.reset()
  // 值日设置：新结构 —— days 按模式分键的星期数组，items 按模式分键的项目数组
  seedDutySettings(conn, { daily: [{ name: '扫地', count: 1 }] }, { daily: ['周一'] })

  const r = await fx.call('PUT', '/api/duty', {
    mode: 'daily',
    cells: { 扫地: { 周一: ['新来的同学'] } },
  })
  assert.equal(r.status, 200, '保存应成功（实际 ' + r.status + '：' + r.text.slice(0, 200) + '）')

  const students = conn.prepare("SELECT 姓名 FROM students WHERE 姓名 = '新来的同学'").all()
  assert.equal(students.length, 1, '名册外姓名必须建成学生（实际 ' + students.length + ' 条）')
})

// ---------------------------------------------------------------------------
// B04-05：photo_trash 撤销的文件 + 索引原子性
// ---------------------------------------------------------------------------

test('photo_trash 的 undo：文件搬回与索引插入必须同生共死（不能留「文件在、索引不在」）', async () => {
  const conn = fx.reset()

  // 直接调执行器：把「文件搬回成功、索引插入失败」这个中间态造出来
  const { executors } = require('../../student-backend/routes/undo/undo.executors')
  const ex = executors.photo_trash
  assert.ok(ex, 'photo_trash 执行器必须存在')

  // 造一个真实的文件：原路径 + 回收站副本
  const photoDir = path.join(TMP, 'photos')
  fs.mkdirSync(photoDir, { recursive: true })
  const originalPath = path.join(photoDir, 'a.jpg')
  fs.writeFileSync(originalPath, 'PHOTO')

  const albumOps = require('../../student-backend/albumOps')
  // ⚠️ trashPathFor 的文件名来自 photo.file_name —— 造数据与调用必须用**同一个** photo 对象，
  //    否则算出两个不同的回收站路径 → restoreToOriginal 找不到源文件直接 return false，
  //    「文件没被搬走」这个断言就假绿了。
  const photo = { id: 9001, album_id: 1, file_path: originalPath, file_name: 'a.jpg' }
  const trashSrc = albumOps.trashPathFor(photo)

  // 把文件放进回收站（模拟已删除状态）
  fs.mkdirSync(path.dirname(trashSrc), { recursive: true })
  fs.copyFileSync(originalPath, trashSrc)
  fs.unlinkSync(originalPath)

  // 让「索引插入」这一步失败：按 SQL 锁定 album_photos 的写入（不依赖绝对序号）
  fx.inject({ failMatch: /album_photos/i, failAtMatch: 1 })
  await assert.rejects(
    () => ex.undo({ photo }),
    '索引插入失败时应抛错'
  )

  // 关键断言：文件不应留在原位（否则就是「文件在、索引不在」的中间态）
  assert.equal(
    fs.existsSync(originalPath), false,
    '索引没插进去时，文件必须留在回收站（实际已搬回原位 → 照片在磁盘上但索引里没有，用户看不到也清不掉）'
  )
})
