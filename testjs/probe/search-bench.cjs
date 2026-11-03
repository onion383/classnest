// =========================================================================
// search-bench.cjs —— 全局搜索（GET /api/search）的耗时测量
//
// 为什么需要它：这个接口由前端每次输入 debounce 后触发，而 better-sqlite3 是同步的，
// 一次慢查询会卡住整个进程（连 AI / 表格请求一起排队）。所以「改得动」之外还要「测得动」。
//
// 做法：内存库 + 灌一份接近真实规模的数据（学生 60 / 加扣分 20000 / 请假 3000 / 照片 30000），
// 挂 express 发真实 HTTP，取中位数与 P90；再单独测「旧实现的等价成本」作对照：
//   · 旧 SQL：WHERE ... LIMIT 1000（把上千行宽记录拉回 JS）
//   · 旧拼音：1000 行 × 8 列逐列 pinyin-match
//
// 用法：node testjs/probe/search-bench.cjs [--runs=15]
// 输出是耗时数字，不做门限判定（机器不同绝对值不同），退出码恒为 0。
// =========================================================================
const path = require('path')
const http = require('http')

const BACKEND = path.join(__dirname, '../../student-backend')
const Database = require(path.join(BACKEND, 'node_modules/better-sqlite3-multiple-ciphers'))
const express = require(path.join(BACKEND, 'node_modules/express'))
const pinyinMatch = require(path.join(BACKEND, 'node_modules/pinyin-match')).match

const RUNS = Number((process.argv.find(a => a.startsWith('--runs=')) || '').split('=')[1]) || 15

const conn = new Database(':memory:')
require(path.join(BACKEND, 'schema/schema.js')).initSchema(conn)

// ==================== 灌数据 ====================
const SURNAMES = '赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜'
const GIVEN = ['伟', '芳', '娜', '敏', '静', '磊', '洋', '勇', '艳', '杰', '娟', '涛', '明', '超', '秀', '霞', '平', '刚', '桂', '英']
const names = []
for (let i = 0; i < 60; i++) names.push(SURNAMES[i % SURNAMES.length] + GIVEN[i % GIVEN.length] + (i >= 30 ? '二' : '一'))
// 基准目标人名：出现在加扣分前 20 个名字里，因此「精确人名」会命中约 1000 条记录
const TARGET = names[0]

const tSeed = Date.now()
conn.transaction(() => {
  const insS = conn.prepare('INSERT INTO students (学号, 年级, 班级, 姓名, 备注) VALUES (?,?,?,?,?)')
  names.forEach((n, i) => insS.run(String(1000 + i), '初二', '3班', n, i % 5 === 0 ? '数学课代表' : ''))

  // 加扣分 2 万条：姓名从 60 个里轮转，姓名列只把前 20 个名字铺满（模拟少数活跃学生记录最多）
  const insScore = conn.prepare('INSERT INTO score_records (姓名, 学号, 类型, 项目, 原因, 分值, 加分时间) VALUES (?,?,?,?,?,?,?)')
  for (let i = 0; i < 20000; i++) {
    const n = names[i % 20]
    insScore.run(n, String(1000 + (i % 20)), i % 3 === 0 ? '加分' : '扣分', '课堂表现', '帮助同学完成作业', 1, '2026-10-01')
  }

  const insLeave = conn.prepare('INSERT INTO leave_records (姓名, 类型, 开始时间, 结束时间, 状态, 备注) VALUES (?,?,?,?,?,?)')
  for (let i = 0; i < 3000; i++) {
    insLeave.run(names[i % 60], '病假', '2026-10-01 08:00', '2026-10-02 18:00', '已销假', '感冒发烧')
  }

  const albumId = conn.prepare('INSERT INTO albums (name, folder_path) VALUES (?,?)').run('运动会', 'D:/pics').lastInsertRowid
  const insPhoto = conn.prepare('INSERT INTO album_photos (album_id, file_path, file_name, photo_date) VALUES (?,?,?,?)')
  for (let i = 0; i < 30000; i++) {
    insPhoto.run(albumId, `D:/pics/${i}.jpg`, `IMG_${i}.jpg`, '2026-10-20 09:00:00')
  }

  const dimId = conn.prepare('INSERT INTO group_dimensions (name) VALUES (?)').run('宿舍管理').lastInsertRowid
  const insGroup = conn.prepare('INSERT INTO groups (dimension_id, name) VALUES (?,?)')
  const insMember = conn.prepare('INSERT INTO group_members (group_id, member_name, remark) VALUES (?,?,?)')
  for (let g = 0; g < 10; g++) {
    const gid = insGroup.run(dimId, String(301 + g)).lastInsertRowid
    for (let k = 0; k < 6; k++) insMember.run(gid, names[(g * 6 + k) % 60], k === 0 ? '宿舍长' : '')
  }
})()
const seedMs = Date.now() - tSeed

// ==================== 挂路由 ====================
const dbFile = require.resolve(path.join(BACKEND, 'db.js'))
require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: { db: conn } }
const router = require(path.join(BACKEND, 'routes/search.js'))
const app = express()
app.use('/api/search', router)

function get(server, q) {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${server.address().port}/api/search?q=${encodeURIComponent(q)}`, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => resolve(JSON.parse(body)))
    }).on('error', reject)
  })
}

const ms = (a, b) => Number(b - a) / 1e6
const stat = (arr) => {
  const s = [...arr].sort((x, y) => x - y)
  return { p50: s[Math.floor(s.length / 2)], p90: s[Math.min(s.length - 1, Math.floor(s.length * 0.9))] }
}

async function main() {
  const server = app.listen(0)
  await new Promise(r => server.once('listening', r))

  const QUERIES = [
    ['张', '中文宽命中（几百行）'],
    [TARGET, '中文精确人名'],
    ['zwy', '拼音缩写（走 distinct + 回表）'],
    [TARGET + ' 帮助', '多词 AND'],
    ['IMG_1', '照片文件名'],
  ]

  console.log(`数据量：学生 60 / 加扣分 20000 / 请假 3000 / 照片 30000 / 分组成员 60`)
  console.log(`目标人名：${TARGET}（拼音缩写 zwy）`)
  console.log(`灌数据耗时：${seedMs} ms（仅本次探针，不影响结论）\n`)

  // 预热，避开首次 prepare 的编译成本
  for (let i = 0; i < 3; i++) for (const [q] of QUERIES) await get(server, q)

  console.log('=== 新实现：端到端（含 HTTP 与 JSON 序列化）===')
  for (const [q, label] of QUERIES) {
    const times = []
    let groups = 0
    for (let i = 0; i < RUNS; i++) {
      const t0 = process.hrtime.bigint()
      const data = await get(server, q)
      times.push(ms(t0, process.hrtime.bigint()))
      groups = (data.groups || []).length
    }
    const { p50, p90 } = stat(times)
    console.log(`  ${q.padEnd(14, ' ')} ${label.padEnd(28, ' ')} p50 ${p50.toFixed(2)} ms  p90 ${p90.toFixed(2)} ms  (${groups} 组)`)
  }

  // ==================== 旧实现的等价成本（对照） ====================
  console.log('\n=== 对照：旧实现对同一张表的成本 ===')
  const COLS = ['姓名', '学号', '类型', '项目', '原因', '加分时间', 'group_name', 'source']

  let t0 = process.hrtime.bigint()
  let rows = []
  for (let i = 0; i < RUNS; i++) {
    rows = conn.prepare(`SELECT * FROM score_records WHERE "姓名" LIKE ? OR "学号" LIKE ? OR "类型" LIKE ?
      OR "项目" LIKE ? OR "原因" LIKE ? OR "加分时间" LIKE ? OR "group_name" LIKE ? OR "source" LIKE ?
      ORDER BY id LIMIT 1000`).all(...COLS.map(() => `%${TARGET}%`))
  }
  console.log(`  旧 SQL 拉 1000 行宽记录      p50 ${(ms(t0, process.hrtime.bigint()) / RUNS).toFixed(2)} ms  （返回 ${rows.length} 行）`)

  t0 = process.hrtime.bigint()
  let hit = 0
  for (let i = 0; i < 5; i++) {
    hit = 0
    for (const r of rows) for (const c of COLS) {
      const v = r[c]
      if (v == null || v === '') continue
      try { if (pinyinMatch(String(v), 'zwy')) hit++ } catch (_) {}
    }
  }
  console.log(`  旧拼音：1000 行 × 8 列逐格      p50 ${(ms(t0, process.hrtime.bigint()) / 5).toFixed(2)} ms  （命中 ${hit} 格）`)

  t0 = process.hrtime.bigint()
  let vals = []
  for (let i = 0; i < RUNS; i++) {
    vals = conn.prepare(`SELECT DISTINCT "姓名" AS v FROM score_records WHERE "姓名" IS NOT NULL AND "姓名" <> '' LIMIT 400`).all()
  }
  console.log(`  新拼音：主列 distinct          p50 ${(ms(t0, process.hrtime.bigint()) / RUNS).toFixed(2)} ms  （去重后 ${vals.length} 个值）`)

  server.close()
  conn.close()
}

main()
