// =========================================================================
// search-sources-probe.cjs —— 核对 /api/search 各数据源能否命中、focus 是否正确
//
// 为什么需要它：search.js 的每个数据源都是「表名 + 列名白名单 + focus 串」的手写配置，
// 错一处不会报错，只会「搜不到」或「点进去跳错地方」——后者尤其难发现（要真的去点一次）。
// 本探针把真实请求打进去，逐条断言返回的分组与 focus 串。
//
// 做法：建内存库 → initSchema → 灌少量样本 → 用 require.cache 把 routes/search.js
// 依赖的 ../db 换成这个连接 → 挂 express 发真实 HTTP → 断言 → 进程退出。
// 不碰真实班级库，可重复运行。
//
// 为什么放在 probe 层而不是 units：本层约定「不覆盖 HTTP 路由、不碰真实数据」，
// 而本脚本要经过一次真实路由调用才验证得了 focus 串；它没有外部依赖、毫秒级、退出码可用，
// 但按分层约定仍不进 CI（判据类检查放 smoke）。
//
// 用法：node testjs/probe/search-sources-probe.cjs
// 退出码：有断言失败 → 1，否则 0。
// =========================================================================
const path = require('path')
// 关服务要强制断开存量 keep-alive 连接，否则事件循环仍有活 handle → 脚本永不退出
const { closeServer } = require('../tools/closeServer.cjs')
const http = require('http')
const assert = require('assert/strict')

const BACKEND = path.join(__dirname, '../../student-backend')
const Database = require(path.join(BACKEND, 'node_modules/better-sqlite3-multiple-ciphers'))
const express = require(path.join(BACKEND, 'node_modules/express'))

const conn = new Database(':memory:')
require(path.join(BACKEND, 'schema/schema.js')).initSchema(conn)

// ==================== 样本数据 ====================
const insStudent = conn.prepare('INSERT INTO students (学号, 年级, 班级, 姓名, 备注) VALUES (?,?,?,?,?)')
insStudent.run('1001', '初二', '3班', '张三', '数学课代表')
insStudent.run('1002', '初二', '3班', '李四', '')
// 备注里带「张三」：用来验证「主列命中排在非主列命中之前」
insStudent.run('1003', '初二', '3班', '王小明', '张三的同桌')
// 备注里带时间：验证「12:30」这种冒号写法不会被当成字段限定
insStudent.run('1004', '初二', '3班', '赵六', '12:30 到校')
// 自定义列：加列 + 写 table_meta（等价于界面上「添加列」）
conn.exec('ALTER TABLE students ADD COLUMN "兴趣" TEXT')
conn.prepare('INSERT INTO table_meta (table_name, column_name, data_type, sort_order) VALUES (?,?,?,?)')
  .run('students', '兴趣', '文字', 99)
conn.prepare('UPDATE students SET 兴趣 = ? WHERE 姓名 = ?').run('篮球社', '李四')

conn.prepare('INSERT INTO semesters (name, start_date, end_date, is_current) VALUES (?,?,?,1)')
  .run('2026 秋季学期', '2026-09-01', '2027-01-20')

const dimDorm = conn.prepare('INSERT INTO group_dimensions (name) VALUES (?)').run('宿舍管理').lastInsertRowid
const dimStudy = conn.prepare('INSERT INTO group_dimensions (name) VALUES (?)').run('学习小组').lastInsertRowid
const g302 = conn.prepare('INSERT INTO groups (dimension_id, name) VALUES (?,?)').run(dimDorm, '302').lastInsertRowid
conn.prepare('INSERT INTO groups (dimension_id, name) VALUES (?,?)').run(dimStudy, '第一组')
conn.prepare('INSERT INTO group_members (group_id, member_name, remark) VALUES (?,?,?)').run(g302, '张三', '宿舍长')
conn.prepare('INSERT INTO group_members (group_id, member_name, remark) VALUES (?,?,?)').run(g302, '王五', '')

const albumId = conn.prepare('INSERT INTO albums (name, folder_path) VALUES (?,?)').run('运动会', 'D:/pics/ydh').lastInsertRowid
conn.prepare('INSERT INTO album_photos (album_id, file_path, file_name, photo_date) VALUES (?,?,?,?)')
  .run(albumId, 'D:/pics/ydh/IMG_2048.jpg', 'IMG_2048.jpg', '2026-10-20 09:00:00')

// 班干部：一个职务 + 一个担任人（职务名命中与担任人命中是两条不同的结果）
const zhangsanId = conn.prepare('SELECT id FROM students WHERE 姓名 = ?').get('张三').id
const cadreId = conn.prepare('INSERT INTO cadres (name, parent_id, max_count, sort_order) VALUES (?,0,1,0)').run('班长').lastInsertRowid
conn.prepare('INSERT INTO cadre_members (cadre_id, student_id, student_name, sort_order) VALUES (?,?,?,0)')
  .run(cadreId, zhangsanId, '张三')

// 值日：schema 的默认种子是「扁平数组」，而 unpackMode 只认 {daily,big} 分键结构，
// 所以这里按界面保存一次之后的真实形状写。
conn.prepare('UPDATE duty_slots SET items = ? WHERE kind = ?').run(
  JSON.stringify({ daily: [{ name: '擦黑板', count: 1 }, { name: '扫地', count: 2 }], big: [] }),
  'settings'
)
conn.prepare('UPDATE duty_slots SET cells = ? WHERE kind = ?')
  .run(JSON.stringify({ daily: { 擦黑板: { 周一: ['王五'] } }, big: {} }), 'current')

// 加扣分：同一人两条，用来验证「同级按 id 倒序（最近的先出）」
const insScore = conn.prepare('INSERT INTO score_records (姓名, 类型, 项目, 原因, 分值, 加分时间) VALUES (?,?,?,?,?,?)')
insScore.run('张三', '加分', '助人为乐', '帮助同学', 2, '2026-10-01')
insScore.run('张三', '扣分', '纪律', '迟到扣分', -1, '2026-10-30')

// 班费：收据列存路径，必须被排除（否则搜 jpg 会命中半张表）
const insFee = conn.prepare('INSERT INTO fee_records (收支编码, 收支类型, 收支金额, 收支时间, 备注, 收据) VALUES (?,?,?,?,?,?)')
insFee.run('F001', '班费支出', 50, '2026-10-01', '买扫把', 'D:/receipts/r1.jpg')
insFee.run('F002', '班费收入', 200, '2026-09-15', '班费收取', '')

// ==================== 替换 ../db 并挂路由 ====================
const dbFile = require.resolve(path.join(BACKEND, 'db.js'))
require.cache[dbFile] = { id: dbFile, filename: dbFile, loaded: true, exports: { db: conn } }

const router = require(path.join(BACKEND, 'routes/search.js'))
const app = express()
app.use('/api/search', router)

function get(server, q) {
  return new Promise((resolve, reject) => {
    const url = `http://127.0.0.1:${server.address().port}/api/search?q=${encodeURIComponent(q)}`
    http.get(url, (res) => {
      let body = ''
      res.on('data', (c) => { body += c })
      res.on('end', () => { try { resolve(JSON.parse(body)) } catch (e) { reject(new Error(body)) } })
    }).on('error', reject)
  })
}

// 用例：q → 期望返回的分组名集合（严格相等，多返回也会报错，防「顺手带出一堆无关分组」）
const CASES = [
  {
    q: '张三',
    groups: ['学生', '加扣分记录', '分组成员', '班干部任职'],
    check: {
      // 相关性排序：主列（姓名）命中的张三排第一，备注命中「张三的同桌」的王小明在后
      学生: (it) => assert.equal(it.label, '张三'),
      // 同级按 id 倒序：最近那条「纪律」在前，老那条「助人为乐」在后
      加扣分记录: (it) => assert.match(it.label, /纪律/),
      分组成员: (it) => assert.match(it.focus, /^dim:\d+:\d+$/),
      班干部任职: (it) => {
        assert.equal(it.focus, 'cadre:' + cadreId)
        assert.equal(it.sub, '班长')
      },
    },
  },
  { q: 'zs', groups: ['学生', '加扣分记录', '分组成员', '班干部任职'] },
  // 多词 AND：仅当两个词都命中同一行才出（王小明备注里没有「数学」，被排除）
  { q: '张三 数学', groups: ['学生'], check: { 学生: (it) => assert.equal(it.label, '张三') } },
  // 多词 AND 的反例：没有任何一行同时含「张三」和「请假」
  { q: '张三 请假', groups: [] },
  {
    q: '班长',
    groups: ['班干部职务'],
    check: {
      班干部职务: (it) => {
        assert.equal(it.focus, 'cadre:' + cadreId)
        assert.match(it.sub, /张三/)
      },
    },
  },
  { q: '宿舍管理', groups: ['分组'], check: { 分组: (it) => assert.match(it.sub, /宿舍管理/) } },
  { q: '302', groups: ['分组'], check: { 分组: (it) => assert.match(it.focus, /^dim:\d+:\d+$/) } },
  { q: '运动会', groups: ['相册'] },
  { q: 'IMG_2048', groups: ['照片'], check: { 照片: (it) => assert.equal(it.focus, String(albumId)) } },
  { q: '擦黑板', groups: ['值日项目'], check: { 值日项目: (it) => assert.equal(it.focus, 'duty:daily:0:0') } },
  { q: '秋季', groups: ['学期'], check: { 学期: (it) => assert.equal(it.focus, 'semester') } },
  { q: '篮球社', groups: ['学生'] },
  // 回归：原有数据源不能坏
  { q: '王五', groups: ['值日 · 当前值日', '分组成员'] },
  { q: '初二', groups: ['学生'] },
  { q: '买扫把', groups: ['班费记录'], check: { 班费记录: (it) => assert.match(it.sub, /命中「备注」/) } },
  // ===== 字段限定（C1）=====
  {
    // 只在姓名列搜：备注命中「张三的同桌」的王小明不该出现
    q: '姓名:张三',
    groups: ['学生', '加扣分记录', '分组成员', '班干部任职'],
    check: {
      学生: (it, g) => {
        assert.equal(it.label, '张三')
        assert.equal(g.items.length, 1, '姓名字段限定后不该带出备注命中的行')
      },
    },
  },
  { q: '备注:数学', groups: ['学生'], check: { 学生: (it) => assert.equal(it.label, '张三') } },
  { q: '姓名:张三 请假', groups: [] },
  { q: '文件:IMG_2048', groups: ['照片'], check: { 照片: (it) => assert.match(it.label, /IMG_2048/) } },
  { q: '姓名:zs', groups: ['学生', '加扣分记录', '分组成员', '班干部任职'] },
  // 冒号不是字段（12 不在别名表里）→ 当普通文本搜，能命中备注里的「12:30 到校」
  { q: '12:30', groups: ['学生'], check: { 学生: (it) => assert.equal(it.label, '赵六') } },
  // 收据列必须被排除：搜 jpg 只出照片，不出班费
  { q: 'jpg', groups: ['照片'] },
]

async function run() {
  const server = app.listen(0, '127.0.0.1')
  await new Promise((r) => server.once('listening', r))
  let failed = 0
  for (const c of CASES) {
    try {
      const { groups } = await get(server, c.q)
      const got = (groups || []).map((g) => g.group)
      assert.deepEqual(got, c.groups, `分组不符：期望 ${JSON.stringify(c.groups)}，实际 ${JSON.stringify(got)}`)
      for (const [name, fn] of Object.entries(c.check || {})) {
        const g = groups.find((x) => x.group === name)
        assert.ok(g && g.items.length, `分组「${name}」没有结果`)
        fn(g.items[0], g)
      }
      console.log(`  ✓ ${c.q} → ${got.join(' / ')}`)
    } catch (e) {
      failed++
      console.log(`  ✗ ${c.q} → ${e.message}`)
    }
  }
  await closeServer(server)
  conn.close()
  console.log(failed ? `\n${failed}/${CASES.length} 条失败` : `\n全部通过（${CASES.length} 条）`)
  process.exit(failed ? 1 : 0)
}

run()
