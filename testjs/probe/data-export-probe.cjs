// 探针：验证设置页「数据管理」的后端链路（表清单 → 取数据 → 打 zip）
// 用临时数据目录建一个明文测试库，写入样例数据后逐项断言。
// 入口：node testjs/probe/data-export-probe.cjs；有断言，属回归资产（改后端表口径后必须重跑）。
const path = require('path')
const fs = require('fs')

const TMP = path.join(__dirname, '..', 'tmp', 'data-probe')
fs.rmSync(TMP, { recursive: true, force: true })
process.env.DATA_DIR = TMP
process.env.DB_MASTER_KEY = 'probe-only-key'

const express = require('../../student-backend/node_modules/express')
const dbManager = require('../../student-backend/dbManager/dbManager')
const { db } = require('../../student-backend/db')

let failed = 0
function check(label, cond, extra) {
  if (cond) console.log(`  ✓ ${label}${extra ? ' — ' + extra : ''}`)
  else { failed++; console.log(`  ✗ ${label}${extra ? ' — ' + extra : ''}`) }
}

dbManager.ensureIndex()
const { slug } = dbManager.createTeacher('probe', 'x', 'teacher', false)

dbManager.withDb(slug, () => {
  db.prepare("INSERT INTO students (position, 学号, 年级, 班级, 姓名, 年龄, 家长联系电话, 备注) VALUES (1,'001','初二','3班','张三',14,'13800000001','')").run()
  db.prepare("INSERT INTO students (position, 学号, 年级, 班级, 姓名, 年龄, 家长联系电话, 备注) VALUES (2,'002','初二','3班','李四',13,'13800000002','')").run()
  db.prepare("INSERT INTO score_records (student_id, 姓名, 学号, 类型, 项目, 分值, 原因, 加分时间, source) VALUES (1,'张三','001','加分','值日','2','主动','2026-11-01','personal')").run()
  db.prepare("INSERT INTO fee_records (position, 收支编码, 收支类型, 收支金额, 收支时间, 备注, 收据) VALUES (1,'F1','收入',100,'2026-11-01','班费','[\"/uploads/a.jpg\",\"/uploads/b.jpg\"]')").run()
  // 第二行用新结构（对象数组）：收据升级后老代码 join 会得到 [object Object]，靠这条守着
  db.prepare("INSERT INTO fee_records (position, 收支编码, 收支类型, 收支金额, 收支时间, 备注, 收据) VALUES (2,'F2','支出',50,'2026-11-02','采购',?)")
    .run(JSON.stringify([{ path: '/uploads/c.pdf', name: '采购单.pdf', size: 1200, kind: 'pdf' }]))
  db.prepare("INSERT INTO leave_records (position, student_id, 姓名, 类型, 开始时间, 结束时间, 状态) VALUES (1,1,'张三','病假','2026-11-02 08:00','2026-11-03 18:00','已返校')").run()
  // 座位：二维数组，数字是 student_id，字符串是临时学生（种子已有 current 行，故用 REPLACE）
  // 座位：走廊是 seats 里的**真实列**（types 里标 1），不再是渲染期插的虚拟列。
  // 2 行 × 5 列，第 2/4 列是走廊 → 座位列 3 个（列1/列2/列3）；
  // 第 2 行第 3 个座位列挖成空位（types=2）→ 导出必须写「空位」而不是留白
  db.prepare("INSERT OR REPLACE INTO seat_slots (kind, rows, cols, seats, types) VALUES ('current', 2, 5, ?, ?)")
    .run(
      JSON.stringify([[1, null, 2, null, null], [null, null, '王五', null, null]]),
      JSON.stringify([[0, 1, 0, 1, 0], [0, 1, 0, 1, 2]])
    )
  // 值日：列名与 cells 都按模式分键（{daily,big}）。
  // 列名是**全局配置**，存在 kind='settings' 那行；current 行的 days 列根本没人读
  // —— 种错行的话导出会退回默认周一到周五，看起来「有值」但列头是错的。
  db.prepare("UPDATE duty_slots SET days = ? WHERE kind = 'settings'")
    .run(JSON.stringify({ daily: ['周一', '周二', '周三'], big: [] }))
  db.prepare("INSERT OR REPLACE INTO duty_slots (kind, cells) VALUES ('current', ?)")
    .run(JSON.stringify({
      daily: { 扫地: { 周一: ['张三'], 周三: ['李四', '王五'] }, 擦窗: { 周二: ['张三'] } },
      big: {},
    }))
  db.prepare("INSERT INTO semesters (name, start_date, end_date, is_current) VALUES ('2026 秋','2026-09-01','2027-01-20',1)").run()
  const dim = db.prepare("INSERT INTO group_dimensions (name) VALUES ('学习小组')").run().lastInsertRowid
  const g = db.prepare("INSERT INTO groups (dimension_id, name) VALUES (?, '第一组')").run(dim).lastInsertRowid
  db.prepare("INSERT INTO group_members (group_id, member_name) VALUES (?,'张三'),(?,'李四')").run(g, g)
  const cad = db.prepare("INSERT INTO cadres (name, parent_id) VALUES ('班长', 0)").run().lastInsertRowid
  db.prepare("INSERT INTO cadre_members (cadre_id, student_name) VALUES (?,'张三')").run(cad)
  db.prepare("INSERT INTO activities (position, 时间, 主题) VALUES (1,'2026-10-01','运动会')").run()
  db.prepare("INSERT INTO countdowns (position, 名称, 截止日, 包含这一天) VALUES (1,'期末', '2027-01-15', 1)").run()
  db.prepare("INSERT INTO albums (name, folder_path, kind) VALUES ('运动会','D:/photos','folder')").run()
  db.prepare("INSERT INTO album_photos (album_id, file_path, file_name, file_size, photo_date) VALUES (1,'D:/photos/a.jpg','a.jpg',204800,'2026-10-01')").run()
  db.prepare("UPDATE ai_settings SET enabled = 1, provider = 'deepseek', api_key = 'sk-secret-value' WHERE id = 1").run()
  // 结构化列：导出时必须展开成人读文本，不能把 JSON 原样塞进单元格
  db.prepare("UPDATE widget_settings SET class_info = ?, desktop_apps = ? WHERE id = 1")
    .run(JSON.stringify({ name: '初二3班', motto: '团结' }), JSON.stringify([{ name: '微信', path: 'C:/wx.exe' }]))
  db.prepare("INSERT INTO domain_history (domain, week_start, snap_date, mode, payload) VALUES ('schedule','2026-11-02','2026-11-02','week',?)")
    .run(JSON.stringify({ cells: [['语文', '数学']], settings: { days: ['周一', '周二'] } }))
  db.prepare("INSERT INTO undo_history (key, type, label, payload, dir, ts) VALUES ('students','update','改姓名',?,1,'2026-11-05 10:00')")
    .run(JSON.stringify({ before: { 姓名: '张三' }, after: { 姓名: '张三丰' } }))
})

const app = express()
app.use(express.json({ limit: '200mb' }))
app.use((req, res, next) => dbManager.withDb(slug, () => next()))
app.use('/api/data', require('../../student-backend/routes/dataExport'))

const server = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}/api/data`
  try {
    const list = (await (await fetch(`${base}/tables`)).json()).tables
    console.log(`\n[1] 表清单 ${list.length} 条`)
    for (const t of list) console.log(`  ${t.label.padEnd(8, '　')} ${t.key.padEnd(16)} ${t.count} 行`)
    // 20 = 学生/成绩/班费/请假/座位/值日/值日大扫除/课程/学期/小组/班干/活动/
    //      倒计时/相册索引/相册照片/课程历史/撤销记录/AI 对话/AI 消息/应用设置
    check('表数量 = 20', list.length === 20, String(list.length))
    check('表 key 不重复（重复会在 byKey 里静默丢一张）',
      new Set(list.map((t) => t.key)).size === list.length, String(new Set(list.map((t) => t.key)).size))

    // 拼音首字母给设置页的搜索框用（输入 xs 要能搜到「学生名单」）。
    // 判据按「表名里的中/英文字数」核对长度 —— 以后改表名忘了改 py 会直接被抓到。
    const badPy = list.filter((t) => {
      const chars = String(t.label).replace(/[^\u4e00-\u9fa5A-Za-z]/g, '').length
      return !t.py || !/^[a-z]+$/.test(t.py) || t.py.length !== chars
    })
    check('每张表都有拼音首字母，且与表名等长', badPy.length === 0, badPy.map((t) => `${t.label}:${t.py}`).join(' '))
    check('拼音首字母能命中表名（xs → 学生名单）',
      list.some((t) => t.label === '学生名单' && t.py.includes('xs')), list.find((t) => t.key === 'students').py)

    const keys = list.map((t) => t.key)
    const src = (await (await fetch(`${base}/sources`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keys }),
    })).json()).tables

    const byKey = Object.fromEntries(src.map((t) => [t.key, t]))
    console.log('\n[2] 表格化结果')
    for (const t of src) {
      const cols = t.fields.map((f) => f.name).join(' / ')
      console.log(`  ${t.label}: ${t.rows.length} 行 | ${cols}`)
      if (t.rows.length) console.log(`      首行 ${JSON.stringify(t.rows[0])}`)
    }

    console.log('\n[3] 断言')
    check('学生名单 2 行', byKey.students.rows.length === 2)
    check('学生名单不含 id/is_provisional', !('id' in byKey.students.rows[0]) && !('is_provisional' in byKey.students.rows[0]))
    // 座位是二维网格，不是「行/列/姓名」明细：走廊列按 types 标「走廊」，座位列按序号标「列N」
    const seatHeaders = byKey.seats.fields.map((f) => f.name).join(',')
    check('座位列头按「列 / 走廊」交替', seatHeaders === '行号,列1,走廊,列2,走廊,列3', seatHeaders)
    check('座位行数 = 讲台 + 2 行', byKey.seats.rows.length === 3, String(byKey.seats.rows.length))
    check('座位第一行是讲台标记', byKey.seats.rows[0]._isPodium === true && byKey.seats.rows[0].行号 === '讲台')
    check('座位行标签是「第N行」', byKey.seats.rows[1].行号 === '第1行' && byKey.seats.rows[2].行号 === '第2行')
    check('座位把 student_id 换成了姓名', byKey.seats.rows[1].列1 === '张三' && byKey.seats.rows[1].列2 === '李四')
    check('座位保留临时学生姓名', byKey.seats.rows[2].列2 === '王五')
    check('走廊列只在第一行写「走廊」', byKey.seats.rows[1].走廊 === '走廊' && byKey.seats.rows[2].走廊 === '')
    // 空位留白就和「空着的座位」分不出来了；导出表是拿去看布局的
    check('空位导出成「空位」而不是留白', byKey.seats.rows[2].列3 === '空位', JSON.stringify(byKey.seats.rows[2]))
    check('同一列的空座位仍是留白', byKey.seats.rows[1].列3 === '', JSON.stringify(byKey.seats.rows[1]))
    const duty = byKey.duties.rows.find((r) => r.项目 === '扫地')
    check('值日按天展开、多个人名顿号连接', duty && duty.周三 === '李四、王五', JSON.stringify(duty))
    check('值日只出现配置里的 3 天', Object.keys(duty).length === 4, Object.keys(duty).join(','))
    // 大扫除的列名是「任务分组 + 数量」的纯函数（种子默认 3 个大组），不落库
    const bigCols = byKey.dutiesBig.fields.map((f) => f.name).join(',')
    check('大扫除列名由「任务分组 + 数量」派生', bigCols === '项目,第1大组,第2大组,第3大组,全部', bigCols)
    check('班费收据逐行列出路径', byKey.fees.rows[0].收据.includes('a.jpg') && byKey.fees.rows[0].收据.includes('\n'))
    // 收据有两种存的形状：老数据是纯路径字符串，新数据是 { path, name, size, kind }
    const feeJson = JSON.stringify(byKey.fees.rows.map((r) => r.收据))
    check('新结构收据取原始文件名，不出 [object Object]',
      byKey.fees.rows[1].收据 === '采购单.pdf' && !feeJson.includes('[object Object]'), byKey.fees.rows[1].收据)
    check('老结构收据取路径里的文件名', byKey.fees.rows[0].收据 === 'a.jpg\nb.jpg', JSON.stringify(byKey.fees.rows[0].收据))
    check('小组带成员', byKey.groups.rows[0].成员 === '张三、李四', byKey.groups.rows[0].成员)
    check('班干带成员', byKey.cadres.rows[0].成员 === '张三')
    check('相册带照片数', byKey.albums.rows[0].照片数 === 1)
    check('API 密钥被打码（不出现在任何单元格）', !JSON.stringify(byKey.settings.rows).includes('sk-secret-value'), JSON.stringify(byKey.settings.rows.find((r) => r.设置项 === 'AI 密钥')))
    check('AI 密钥显示为已设置', byKey.settings.rows.some((r) => r.设置项 === 'AI 密钥' && r.值 === '已设置（不导出）'))
    check('不存在的列不会报错（活动表）', Array.isArray(byKey.activities.rows))

    // 通用判据：任何单元格都不许是「裸 JSON」（以 { 或 [ 开头且能解析）。
    // 逐格扫而不是逐列看定义 —— 新增一列结构化数据时，列定义不会提醒你。
    const bare = []
    for (const t of src) {
      for (const row of t.rows) {
        for (const [col, v] of Object.entries(row)) {
          if (typeof v !== 'string') continue
          const s = v.trim()
          if (!s || (s[0] !== '{' && s[0] !== '[')) continue
          try { JSON.parse(s); bare.push(`${t.label}.${col} = ${s.slice(0, 40)}`) } catch (_) { /* 普通文本 */ }
        }
      }
    }
    check('所有单元格都没有裸 JSON', bare.length === 0, bare.join(' | '))

    // 结构化列展开后不能残留英文键：新增一列 JSON 却没配 labels 时，这里会直接抓到
    const EN_KEYS = [
      'cells', 'settings', 'days', 'items', 'weights', 'seats', 'mode', 'rows', 'cols',
      'conditions', 'savedAt', 'groupsConfig', 'aisleCols',
      'name', 'motto', 'mottoStyle', 'xuefeng', 'before', 'after', 'path', 'icon', 'table', 'fields',
    ]
    const enRe = new RegExp(`(^|[；、])\\s*(${EN_KEYS.join('|')}):`)
    const untranslated = []
    for (const t of src) {
      for (const row of t.rows) {
        for (const [col, v] of Object.entries(row)) {
          if (typeof v !== 'string') continue
          const hit = v.match(enRe)
          if (hit) untranslated.push(`${t.label}.${col} → ${hit[2]}:`)
        }
      }
    }
    check('结构化列展开后没有残留英文键名', untranslated.length === 0, untranslated.join(' | '))

    const hist = byKey.domainHistory.rows[0]
    check('课程历史 payload 展开成中文键值串', /设置: 星期: 周一、周二/.test(hist.内容), hist.内容)
    check('课程历史「类型」译成中文', hist.类型 === '课程表', hist.类型)
    const undoRow = byKey.undoHistory.rows[0]
    check('撤销 payload 展开成中文键值串', /修改前: 姓名: 张三/.test(undoRow.内容) && /修改后: 姓名: 张三丰/.test(undoRow.内容), undoRow.内容)
    check('撤销「类型」译成中文', undoRow.类型 === '修改', undoRow.类型)
    const infoRow = byKey.settings.rows.find((r) => r.设置项 === '班级信息')
    check('班级信息展开成中文键值串', /班名: 初二3班/.test(infoRow.值) && /班级口号: 团结/.test(infoRow.值), infoRow.值)
    const appsRow = byKey.settings.rows.find((r) => r.设置项 === '桌面常用软件')
    check('桌面软件展开成中文键值串', /软件名: 微信/.test(appsRow.值) && /路径: C:\/wx\.exe/.test(appsRow.值), appsRow.值)
    check('相册「类型」译成中文', byKey.albums.rows[0].相册类型 === '文件夹相册', byKey.albums.rows[0].相册类型)

    console.log('\n[4] 打包')
    const entries = src.map((t) => ({
      name: `${t.label}.csv`,
      data: Buffer.from(`${t.fields.map((f) => f.name).join(',')}\n${t.rows.length}`, 'utf8').toString('base64'),
    }))
    const res = await fetch(`${base}/zip`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries, password: 'Test1234', filename: '班级数据/导出' }),
    })
    const buf = Buffer.from(await res.arrayBuffer())
    const zipPath = path.join(__dirname, '..', 'tmp', 'data-export.zip')
    fs.writeFileSync(zipPath, buf)
    console.log(`  zip ${res.status} ${buf.length} 字节 → ${zipPath}`)
    check('zip 返回 200 + application/zip', res.status === 200 && res.headers.get('content-type') === 'application/zip')
    check('Content-Disposition 清洗了非法字符', !(res.headers.get('content-disposition') || '').includes('班级数据/导出'))

    // 收据文件：按「收据文件/收支编码/原文件名」进包
    const upDir = path.join(TMP, 'uploads')
    fs.mkdirSync(upDir, { recursive: true })
    fs.writeFileSync(path.join(upDir, 'r1.pdf'), 'PDFDATA')
    const res2 = await fetch(`${base}/zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: [{ name: '班费记录.xlsx', data: Buffer.from('X').toString('base64') }],
        receiptGroups: [
          { code: 'F001', items: [{ path: '/uploads/r1.pdf', name: '运动会发票.pdf' }] },
          { code: '', items: [{ path: '/uploads/r1.pdf', name: '无编码.jpg' }] },
        ],
      }),
    })
    const buf2 = Buffer.from(await res2.arrayBuffer())
    // zip 的文件名在本地头与中央目录里都是 UTF-8 明文，直接按字节找
    check('收据按「收据文件/编码/原名」进包', buf2.includes(Buffer.from('收据文件/F001/运动会发票.pdf', 'utf8')))
    check('编码为空时落到「未编号」', buf2.includes(Buffer.from('收据文件/未编号/无编码.jpg', 'utf8')))
    fs.writeFileSync(path.join(__dirname, '..', 'tmp', 'data-export-receipts.zip'), buf2)
    check('收据文件读取失败不影响其它条目', buf2.length > 0)

    // 数据管理这条路：前端只有表格化文本，拿不到收据路径，所以传 includeReceipts
    // 让后端按库里的 fee_records 自己分组（编码 → 目录，空编码 → 未编号）
    fs.writeFileSync(path.join(upDir, 'a.jpg'), 'JPGDATA')
    fs.writeFileSync(path.join(upDir, 'c.pdf'), 'PDFDATA2')
    const res3 = await fetch(`${base}/zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entries: [{ name: '班费记录.xlsx', data: Buffer.from('X').toString('base64') }],
        includeReceipts: true,
      }),
    })
    const buf3 = Buffer.from(await res3.arrayBuffer())
    check('includeReceipts：后端自己按库分组', buf3.includes(Buffer.from('收据文件/F2/采购单.pdf', 'utf8')))
    check('includeReceipts：老格式（纯路径）也能进包', buf3.includes(Buffer.from('收据文件/F1/a.jpg', 'utf8')))
    check('includeReceipts：库里不存在的文件被跳过而非报错', !buf3.includes(Buffer.from('收据文件/F1/b.jpg', 'utf8')))
    fs.writeFileSync(path.join(__dirname, '..', 'tmp', 'data-export-include-receipts.zip'), buf3)

    // 不传就不该带收据目录（默认关闭，别让「导个表」莫名其妙多出几百 MB）
    const res4 = await fetch(`${base}/zip`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entries: [{ name: '班费记录.xlsx', data: Buffer.from('X').toString('base64') }] }),
    })
    const buf4 = Buffer.from(await res4.arrayBuffer())
    check('不传 includeReceipts 时不带收据目录', !buf4.includes(Buffer.from('收据文件/', 'utf8')))
  } catch (err) {
    failed++
    console.error('探针异常：', err)
  } finally {
    server.close()
    console.log(failed ? `\n❌ ${failed} 项失败` : '\n✅ 全部通过')
    process.exit(failed ? 1 : 0)
  }
})
