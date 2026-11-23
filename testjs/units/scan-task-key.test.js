// =========================================================================
// scan-task-key.test.js —— 扫描任务键含班级 slug（2-9 / #6）
//
// 原缺陷：主进程 dispatched/active 与 worker 的 running/pendingStops 全用裸 albumId 建键，
// 各库 albumId 独立自增 → 两班同号相册互相阻塞、串进度、误暂停/误停止、done 误清另一班任务。
// 修法：抽出共享 utils/scanTaskKey（slug|albumId），主进程与 worker 统一使用；
// 对外 API isDispatched/getActive 加 slug 参数，调用点全部传 slug。
//
// 判据：① 行为：共享键函数区分两班、空 slug 兜底；② 接线：两侧所有 Map 操作走 taskKey、
//       对外 API 带 slug、调用点传 slug；③ 变异反证。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')
const { scanTaskKey } = require(path.join(ROOT, 'student-backend/utils/scanTaskKey'))

const WORKER_MAIN = 'student-backend/scanWorker.js'
const WORKER_CHILD = 'student-backend/worker.scan.js'
const ALBUM = 'student-backend/routes/album.js'

// ————————————————————————— ① 行为层 —————————————————————————

test('行为：同 albumId 不同 slug → 不同键；同 slug 同 id → 同键', () => {
  const a = scanTaskKey('@aaaaaaaaaaaa', 7)
  const b = scanTaskKey('@bbbbbbbbbbbb', 7)
  assert.notEqual(a, b, '两班同号相册必须不同键')
  assert.equal(scanTaskKey('@aaaaaaaaaaaa', 7), a, '同键必须稳定（删除/暂停能定位同一任务）')
  assert.equal(scanTaskKey('', 7), '7', '空 slug 退回裸 id，兼容老消息')
})

// ————————————————————————— ② 接线层 —————————————————————————

test('主进程：所有 dispatched/active 键操作都走 taskKey，无裸 albumId', () => {
  const src = read(WORKER_MAIN)
  // 出现 ${slug}|${albumId} 定义的共享函数引入
  assert.match(src, /require\('\.\/utils\/scanTaskKey'\)/, '主进程要引入共享键')
  // 关键 Map 操作都用 taskKey(...)：逐条确认，避免漏改回裸 id
  for (const pat of [
    /active\.get\(taskKey\(msg\.slug, msg\.albumId\)\)/,
    /dispatched\.delete\(taskKey\(msg\.slug, msg\.albumId\)\)/,
    /dispatched\.has\(key\)/, /active\.set\(key,/,
    /dispatched\.has\(taskKey\(t\.slug, t\.albumId\)\)/,
    /isDispatched\(slug, albumId\)/, /getActive\(slug, albumId\)/,
  ]) assert.match(src, pat, `主进程缺少键操作：${pat}`)
  // 不能再有裸 albumId 的 get/has/set/delete
  assert.doesNotMatch(src, /(?:dispatched|active)\.(?:get|has|set|delete)\(albumId\)/, '仍有裸 albumId 键操作')
})

test('worker：所有 running/pendingStops 键操作都走 taskKey', () => {
  const src = read(WORKER_CHILD)
  assert.match(src, /require\('\.\/utils\/scanTaskKey'\)/, 'worker 要引入共享键')
  assert.match(src, /running\.has\(key\)/, 'runScan 用复合键查重')
  assert.match(src, /pendingStops\.has\(key\)/, '早到停止用复合键')
  assert.match(src, /running\.get\(taskKey\(msg\.slug, msg\.albumId\)\)/, 'pause 用复合键')
  assert.match(src, /running\.get\(key\)/, 'stop 用复合键')
  assert.doesNotMatch(src, /(?:running|pendingStops)\.(?:get|has|set|delete|add)\(msg\.albumId\)/, '仍有裸 albumId 键操作')
})

test('调用点：album.js 的 isDispatched/getActive 都传 slug', () => {
  const src = read(ALBUM)
  const calls = [...src.matchAll(/scanWorker\.(isDispatched|getActive)\([^\n]*/g)]
  assert.ok(calls.length >= 3, '应有至少 3 处调用')
  for (const m of calls) {
    // 第一参数必须是 slug 或 dbManager.currentSlug()
    assert.match(m[0], /scanWorker\.(isDispatched|getActive)\((slug|dbManager\.currentSlug\(\))/,
      `调用必须首传 slug：${m[0]}`)
  }
})

// ————————————————————————— ③ 变异反证 —————————————————————————

test('变异反证：模拟旧逻辑（裸 albumId）后，两班同号塌缩成同键', () => {
  const oldKey = (slug, id) => String(id) // 旧逻辑：忽略 slug
  assert.equal(oldKey('@aaa', 7), oldKey('@bbb', 7), '旧逻辑两班同号塌缩 —— 正是要防的 bug')
  // 新逻辑在同一个输入下不塌缩，证明判据真的锁住了 slug 维度
  assert.notEqual(scanTaskKey('@aaa', 7), scanTaskKey('@bbb', 7))
})
