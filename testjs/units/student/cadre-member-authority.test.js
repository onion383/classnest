// =========================================================================
// cadre-member-authority.test.js —— cadre_members 的权威字段守门
//
// 约定（2026-11-16 定）：`student_id` 是权威引用，`student_name` 只是快照。
// 这条约定最容易在两个月后失效的方式不是"有人写错代码"，而是
// **有人新写一条 `WHERE student_name = ?`** —— 代码照样跑，只是同一名学生
// 会被当成两个人。所以这里放两道闸：
//
// 闸一（静态）：全库 `student_name` 出现在 WHERE 子句的位置必须在白名单里。
//   新增一处就必须来解释它是哪一类（展示 / 导出 / 快照回填 / 兼容匹配），
//   不解释就红。白名单按文件 + 次数记，不记行号 —— 行号一改就废。
//
// 闸二（行为）：AI 体检的 `cadre_dangling` 必须以 id 判存在性。
//   · id 指向已删除学生 → 报出来（哪怕同一行快照里的姓名还在名册）
//   · id 有效但快照姓名已过期（改名后没同步）→ **不报**
//   第二条是关键：如果读侧拿快照姓名判"这个人还在不在"，改过名的成员会被误报成孤儿。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { createBackendDb } = require('#testjs/units/_db-express-fixture.cjs')

const BACKEND = abs('student-backend')

// ---------------------------------------------------------------------------
// 闸一：student_name 不许随便出现在 WHERE 里
// ---------------------------------------------------------------------------
// 允许的位置，每一条都要能说出理由：
const ALLOWED_WHERE = {
  // 导入查重：Excel 只有姓名文本，同名学生本来就分不开；按姓名去重才能拦住「重复导入同一张表」
  'services/cadreStore.js': 1,
  // 删学生 / 改名时的兼容匹配：`student_id = ? OR TRIM(student_name) = ?`
  // 前半句管新数据，后半句管历史「仅姓名」行（student_id 为 NULL）
  'services/studentRelations.js': 3,
  // 改名联动（studentRename.js）**不在这里**：P2-1 之后它的四条改名语句是
  // `UPDATE ${table} SET ${nameCol} = ? WHERE student_id IS NULL AND TRIM(${nameCol}) = ?`，
  // 列名是参数化的，本判据按字面量 `student_name` 扫不到。
  // 安全性由「(table, nameCol) 只来自该文件里的硬编码调用」保证：
  //   ('score_records','姓名') ('leave_records','姓名')
  //   ('group_members','member_name') ('cadre_members','student_name')
  // 要是哪天有人在别处拼一个表名进来，这条豁免就不再成立 —— 届时改回字面量写法。
}

function walkJs(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === 'app.bundle.js') continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) { walkJs(full, out); continue }
    if (!e.name.endsWith('.js')) continue
    const rel = path.relative(BACKEND, full).split(path.sep).join('/')
    if (rel.startsWith('test') || rel.includes('build.bundle')) continue
    out.push({ rel, full })
  }
  return out
}

// `WHERE` 之后、到语句结束（`'` 或 `"` 或 `)` 或 `;`）之间出现 student_name
const WHERE_STUDENT_NAME = /WHERE[^'"`);]*student_name/

test('闸一：student_name 出现在 WHERE 的位置与白名单一致', () => {
  const hits = {}
  for (const dir of ['routes', 'services']) {
    for (const { rel, full } of walkJs(path.join(BACKEND, dir))) {
      const lines = fs.readFileSync(full, 'utf8').split('\n')
      lines.forEach((ln) => {
        if (/^\s*(\/\/|\*)/.test(ln)) return // 注释行不算（说明文字里会提到这条规则）
        if (WHERE_STUDENT_NAME.test(ln)) hits[rel] = (hits[rel] || 0) + 1
      })
    }
  }
  const detail = Object.entries(hits).map(([f, n]) => `${f} ×${n}`).join(', ') || '（无）'
  assert.deepEqual(hits, ALLOWED_WHERE,
    `student_name 出现在 WHERE 里的位置变了（实际：${detail}）。\n`
    + '新增的那一处要么改成 student_id，要么在 ALLOWED_WHERE 里写清它属于哪一类：\n'
    + '展示 / 导出 / 快照回填 / 兼容匹配。')
})

// ---------------------------------------------------------------------------
// 闸二：读侧以 id 判存在性，不拿快照姓名当权威
// ---------------------------------------------------------------------------
const fx = createBackendDb({ label: 'cadre-member-authority' })
const conn = fx.conn
// 夹具装好 db.db Proxy 之后再 require：executors 内部会 require 多个 store
const { runChecks } = require('../../../student-backend/routes/ai/ai.tools/tools.executors/executors.checks')

test.after(() => fx.close())

test('体检 cadre_dangling 以 student_id 判存在性', () => {
  const stu = conn.prepare("INSERT INTO students (姓名, 学号, is_provisional) VALUES ('张权威', '2026301', 0)").run()
  const stuId = Number(stu.lastInsertRowid)
  const cadre = conn.prepare("INSERT INTO cadres (name, parent_id, max_count, sort_order) VALUES ('班长', 0, 5, 1)").run()
  const cadreId = Number(cadre.lastInsertRowid)

  // ① id 指向一个不存在的学生，但快照姓名还在名册里 → 必须报（id 说了算）
  //    新建的库有外键约束，插不进这种行；老库没有外键（CREATE TABLE IF NOT EXISTS 不改老表），
  //    孤儿就是这么产生的 —— 这里显式关掉 FK 来模拟老库的状态。
  conn.pragma('foreign_keys = OFF')
  try {
    conn.prepare('INSERT INTO cadre_members (cadre_id, student_id, student_name, sort_order) VALUES (?,?,?,1)')
      .run(cadreId, 999999, '张权威')
  } finally {
    conn.pragma('foreign_keys = ON')
  }
  // ② id 有效，但快照姓名是改名前的旧值 → 不能报（拿姓名判会误报成孤儿）
  conn.prepare('INSERT INTO cadre_members (cadre_id, student_id, student_name, sort_order) VALUES (?,?,?,2)')
    .run(cadreId, stuId, '张权威的旧名')
  // ③ id 为空的历史「仅姓名」行，姓名在名册里 → 不报
  conn.prepare('INSERT INTO cadre_members (cadre_id, student_id, student_name, sort_order) VALUES (?,NULL,?,3)')
    .run(cadreId, '张权威')

  const r = runChecks({ checks: ['cadre_dangling'] })
  assert.equal(r.ok, true)
  const issue = (r.issues || []).find((it) => it.type === 'cadre_dangling')
  assert.ok(issue, '第一条是真实的孤儿，必须报出来')
  assert.equal(issue.count, 1, `只该报 1 条，实际 ${issue.count} 条：${JSON.stringify(issue.items)}`)
  assert.equal(issue.items[0].student_id, 999999, '报的必须是 id 断链那一条，不是改名那条')
})
