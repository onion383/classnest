// =========================================================================
// album-paging.test.js —— 相册照片「日期索引 + 日期游标分页」（v6 性能专题 · 2-23）
//
// 背景：GET /api/album/:id/photos 原本没有 LIMIT，五万张照片一次吐出十几 MB JSON。
// 相册页是无限滚动，只要一屏；但同一条接口还有三处「必须全量」的消费方
// （导出、删除前抓撤销快照、首页随机图），所以分页只能 opt-in。
//
// 本用例锁六件事：
//   ① 不带 days 时仍是全量，且分组顺序与旧实现一致（photo_date DESC，未知时间在最后）；
//   ② days 逐页拼接 == 全量顺序（不重不漏）；
//   ③ 同一天绝不被拆到两页（拆了分组头与「N 张」就都错了）；
//   ④ 未知时间组只能出现在最后一页，不能漏也不能重复；
//   ⑤ 单日张数超过行数上限时整日返回，不拆也不死循环；
//   ⑥ /dates 的日期与张数必须与 /photos 的分组逐项对上（前端靠它算总高度）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { createBackendDb } = require('./_db-express-fixture.cjs')

// 公共夹具：内存库 + db.js Proxy / dbManager.current 的进程级 stub（见 _db-express-fixture.cjs）
const fx = createBackendDb({ label: 'album-paging' })
const conn = fx.conn

const ALBUM_ID = 1
const ins = conn.prepare(
  'INSERT INTO album_photos (album_id, file_path, file_name, file_size, mtime, photo_date, exif_date, date_src) VALUES (?,?,?,?,?,?,?,?)'
)

// 20 个正常日期：每天张数不同（含一天 1 张、一天 160 张），外加 7 张无 EXIF
// 再加一个「单日超肥」的相册（一天 1600 张 > ROWS_PER_PAGE=1500）
const DAY_COUNTS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 160, 4, 6, 7, 9, 10, 11, 12, 14, 15]
const UNKNOWN_COUNT = 7
const FAT_ALBUM_ID = 2
const FAT_DAY_COUNT = 1600
// 第三个相册专测「行数上限」：5 天 × 500 张 = 2500 行，
// days=10 时按行数上限（1500）会在第 3 天停下，不是按天数停下。
const CAP_ALBUM_ID = 3
const CAP_DAYS = 5
const CAP_PER_DAY = 500

const dayOf = (i) => {
  const d = new Date(Date.UTC(2025, 0, 1) + i * 86400000)
  return d.toISOString().slice(0, 10)
}

conn.transaction(() => {
  conn.prepare("INSERT INTO albums (id, name, folder_path, kind) VALUES (?,?,?,?)").run(ALBUM_ID, '测试相册', 'D:\\p', 'folder')
  conn.prepare("INSERT INTO albums (id, name, folder_path, kind) VALUES (?,?,?,?)").run(FAT_ALBUM_ID, '肥日相册', 'D:\\q', 'folder')
  conn.prepare("INSERT INTO albums (id, name, folder_path, kind) VALUES (?,?,?,?)").run(CAP_ALBUM_ID, '上限相册', 'D:\\r', 'folder')
  let n = 0
  for (let d = 0; d < DAY_COUNTS.length; d++) {
    const day = dayOf(d)
    for (let i = 0; i < DAY_COUNTS[d]; i++, n++) {
      ins.run(ALBUM_ID, `D:\\p\\${day}\\IMG_${n}.jpg`, `IMG_${n}.jpg`, 1000 + n,
        `${day} 18:${String(i % 60).padStart(2, '0')}:00`, day, `${day} 15:00:00`, 'exif')
    }
  }
  for (let i = 0; i < UNKNOWN_COUNT; i++, n++) {
    ins.run(ALBUM_ID, `D:\\p\\noexif\\V_${i}.mp4`, `V_${i}.mp4`, 5000 + i, `2020-03-0${(i % 9) + 1} 09:00:00`, '', '', 'none')
  }
  for (let i = 0; i < FAT_DAY_COUNT; i++) {
    ins.run(FAT_ALBUM_ID, `D:\\q\\2025-06-01\\F_${i}.jpg`, `F_${i}.jpg`, 2000 + i,
      `2025-06-01 10:${String(i % 60).padStart(2, '0')}:00`, '2025-06-01', '2025-06-01 10:00:00', 'exif')
  }
  for (let d = 0; d < CAP_DAYS; d++) {
    const day = dayOf(300 + d)
    for (let i = 0; i < CAP_PER_DAY; i++) {
      ins.run(CAP_ALBUM_ID, `D:\\r\\${day}\\C_${d}_${i}.jpg`, `C_${d}_${i}.jpg`, 3000 + i,
        `${day} 11:${String(i % 60).padStart(2, '0')}:00`, day, `${day} 11:00:00`, 'exif')
    }
  }
})()

let base
test.before(async () => {
  base = await fx.mount('/api/album', 'student-backend/routes/album.js')
})
test.after(() => fx.close())

const get = async (p) => (await fetch(base + p)).json()
const flatten = (groups) => {
  const out = []
  for (const g of groups) for (const x of g.photos) out.push(x.id)
  return out
}

test('不带 days：仍是全量，分组顺序 = photo_date DESC、未知时间在最后', async () => {
  const j = await get(`/${ALBUM_ID}/photos`)
  const total = DAY_COUNTS.reduce((a, b) => a + b, 0) + UNKNOWN_COUNT
  assert.equal(flatten(j.data).length, total)
  assert.equal(j.hasMore, undefined, '全量路径不带分页字段')
  assert.equal(j.data[j.data.length - 1].date, '未知时间')
  assert.deepEqual(
    j.data.slice(0, -1).map((g) => g.date),
    [...DAY_COUNTS.keys()].map(dayOf).reverse(),
    '正常日期组必须严格倒序'
  )
})

test('分页：逐页拼接 == 全量顺序（不重不漏）', async () => {
  const all = flatten((await get(`/${ALBUM_ID}/photos`)).data)
  const paged = []
  let before = ''
  for (let guard = 0; guard < 200; guard++) {
    const qs = `?days=4${before ? `&before=${before}` : ''}`
    const j = await get(`/${ALBUM_ID}/photos${qs}`)
    paged.push(...flatten(j.data))
    if (!j.hasMore) break
    before = j.cursor
  }
  assert.deepEqual(paged, all)
})

test('同一天绝不跨页', async () => {
  const seen = new Map() // date -> 出现在第几页
  let before = ''
  let page = 0
  for (let guard = 0; guard < 200; guard++) {
    const qs = `?days=3${before ? `&before=${before}` : ''}`
    const j = await get(`/${ALBUM_ID}/photos${qs}`)
    for (const g of j.data) {
      if (seen.has(g.date)) assert.fail(`日期 ${g.date} 同时出现在第 ${seen.get(g.date)} 页和第 ${page} 页`)
      seen.set(g.date, page)
      const expect = g.date === '未知时间' ? UNKNOWN_COUNT : DAY_COUNTS[[...DAY_COUNTS.keys()].map(dayOf).indexOf(g.date)]
      assert.equal(g.photos.length, expect, `日期 ${g.date} 的整组必须一次性给全`)
    }
    if (!j.hasMore) break
    before = j.cursor
    page++
  }
  assert.equal(seen.size, DAY_COUNTS.length + 1, '20 个日期 + 未知时间，一组都不能漏')
})

test('未知时间组只出现在最后一页', async () => {
  let before = ''
  let page = 0
  const hits = []
  for (let guard = 0; guard < 200; guard++) {
    const qs = `?days=2${before ? `&before=${before}` : ''}`
    const j = await get(`/${ALBUM_ID}/photos${qs}`)
    if (j.data.some((g) => g.date === '未知时间')) hits.push(page)
    if (!j.hasMore) break
    before = j.cursor
    page++
  }
  assert.deepEqual(hits, [page], '未知时间组只能在最后一页、且只出现一次')
})

test('单日张数超过行数上限：整日返回，不拆也不死循环', async () => {
  const j = await get(`/${FAT_ALBUM_ID}/photos?days=10`)
  assert.equal(j.data.length, 1, '只有一天')
  assert.equal(j.data[0].photos.length, FAT_DAY_COUNT, '这一天必须整组给全（1600 > 1500 行上限）')
  assert.equal(j.hasMore, false)
})

test('行数上限：days=10 但第 3 天就顶到 1500 行 → 这一页只给 3 天，剩下的留给下一页', async () => {
  const j = await get(`/${CAP_ALBUM_ID}/photos?days=10`)
  assert.equal(j.data.length, 3, '3 × 500 = 1500 正好到上限；第 4 天会超，所以停在第 3 天')
  assert.equal(j.data.reduce((a, g) => a + g.photos.length, 0), 1500)
  assert.equal(j.hasMore, true, '还剩 2 天没给')
  // 继续翻完，必须不重不漏
  const paged = flatten(j.data)
  let before = j.cursor
  for (let guard = 0; guard < 20; guard++) {
    const k = await get(`/${CAP_ALBUM_ID}/photos?days=10&before=${before}`)
    paged.push(...flatten(k.data))
    if (!k.hasMore) break
    before = k.cursor
  }
  assert.equal(paged.length, CAP_DAYS * CAP_PER_DAY)
  assert.equal(new Set(paged).size, CAP_DAYS * CAP_PER_DAY, '不能重复')
})

test('/dates：日期与张数必须与 /photos 的分组逐项对上', async () => {  const d = (await get(`/${ALBUM_ID}/dates`)).data
  const groups = (await get(`/${ALBUM_ID}/photos`)).data
  assert.equal(d.length, groups.length, '日期条数 = 分组数')
  for (let i = 0; i < groups.length; i++) {
    const expectDate = groups[i].date === '未知时间' ? '' : groups[i].date
    assert.equal(d[i].date, expectDate, `第 ${i} 组的日期键必须一致（未知时间在接口里是空串）`)
    assert.equal(d[i].count, groups[i].photos.length, `第 ${i} 组的张数必须一致`)
  }
})

test('参数校验：days 越界 / before 格式错 → 400，不是 500', async () => {
  for (const qs of ['?days=0', '?days=999', '?days=abc', '?days=1.5']) {
    const r = await fetch(`${base}/${ALBUM_ID}/photos${qs}`)
    assert.equal(r.status, 400, `${qs} 应被拒绝`)
  }
  const r = await fetch(`${base}/${ALBUM_ID}/photos?days=3&before=2025-1-1`)
  assert.equal(r.status, 400, 'before 必须是补零的 YYYY-MM-DD')
})
