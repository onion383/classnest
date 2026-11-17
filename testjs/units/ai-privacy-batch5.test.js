// =========================================================================
// ai-privacy-batch5.test.js —— AI 数据保护第 5 批：电话宽松格式校验
//
// 清单 §5：「先统计现状能否通过，避免拒掉历史脏数据」。
//   统计结论：库里存在「家长联系电话='1'」历史脏数据，严格手机号 ^1[3-9]\d{9}$
//   会拒掉它 → 所以用【宽松校验】：放行一切纯数字（含短串/座机/11 位），
//   只拦绝不可能的电话（字母/汉字/emoji/其它符号/超长）。
// 判据：纯函数 + 两张表的 COLUMN_RULES 接线 + 变异反证（去掉 phone 规则应变红）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const fs = require('node:fs')

const { ROOT } = require('./_db-express-fixture.cjs')
const sanitizePath = path.join(ROOT, 'student-backend/services/sanitize.js')
const sanitize = require(sanitizePath)

test('§5 统计固化：历史脏数据（纯数字短串）必须放行，不被严格手机号校验拒掉', () => {
  // 清单统计发现的真实脏数据 '1'：宽松校验放行，且原样保留
  assert.equal(sanitize.sanitizeField('1', 'students', '家长联系电话', '文字'), '1')
  assert.equal(sanitize.sanitizeField('0', 'leave_records', '学生联系电话', '文字'), '0')
  // 各种历史纯数字形态全部放行
  for (const v of ['13812345678', '075512345678', '1234567', '1', '00']) {
    assert.equal(sanitize.sanitizeField(v, 'students', '家长联系电话', '文字'), v, `纯数字 ${v} 不得被拒`)
  }
  // 空值归一为 null（与既有清洗口径一致）
  assert.equal(sanitize.sanitizeField('', 'students', '家长联系电话', '文字'), null)
  assert.equal(sanitize.sanitizeField('   ', 'students', '家长联系电话', '文字'), null)
  // null/undefined 必须归一为 null，不能变成字符串 'undefined' 被当成含字母的电话拒掉
  // （请假/学生写入常带 undefined 电话，曾因此误伤整条写入）
  assert.equal(sanitize.sanitizeField(null, 'students', '家长联系电话', '文字'), null)
  assert.equal(sanitize.sanitizeField(undefined, 'students', '家长联系电话', '文字'), null)
})

test('§5 合法符号（座机/国际号）放行，非法字符与超长被拒', () => {
  // 必须走 sanitizeField（真实写入接线路径），否则去掉 applyRule 的 phone 分支时
  // 直接调 cleanPhone 仍能拦 → 判据假绿，反证抓不到。
  for (const v of ['+86 138 1234 5678', '010-12345678', '(0755) 1234-5678']) {
    assert.equal(sanitize.sanitizeField(v, 'students', '家长联系电话', '文字'), v)
  }
  // 字母 / 汉字 / emoji / 斜杠之类绝不可能出现在电话字段
  for (const bad of ['1381234abcd', '张三电话', '138😀5678', '138/1234', '138abc']) {
    assert.throws(() => sanitize.sanitizeField(bad, 'students', '家长联系电话', '文字'), /合法电话号码/, `应拒绝 ${bad}`)
  }
  assert.throws(() => sanitize.sanitizeField('1'.repeat(26), 'students', '家长联系电话', '文字'), /过长/)
})

test('§5 规则接线：students / leave_records 两表两列都走 phone 规则', () => {
  const rules = sanitize.COLUMN_RULES
  for (const table of ['students', 'leave_records']) {
    for (const col of ['家长联系电话', '学生联系电话']) {
      assert.equal(rules[table][col].kind, 'phone', `${table}.${col} 必须挂 phone 规则`)
    }
  }
})

test('§5 变异反证：去掉 phone 规则后，历史脏数据之外的垃圾值不再被拒 → 判据必须变红', () => {
  // 这条用源码判据钉住「规则确实生效」：把 COLUMN_RULES 里的 phone 改成不在 switch 分支的
  // 未知 kind，会走 default 分支（cleanByType 文字，只 trim 不拒字母）→ 垃圾值放行。
  // 这里验证 switch 分支存在，确保上面的拒垃圾判据不是假绿。
  const src = fs.readFileSync(sanitizePath, 'utf8')
  assert.match(src, /case 'phone':\s*\n\s*return cleanPhone\(value, name\)/, 'applyRule 必须有 phone 分支')
  assert.match(src, /function cleanPhone/, 'cleanPhone 必须存在')
  assert.match(src, /PHONE_ALLOWED_RE\.test\(s\)/, 'cleanPhone 必须做字符白名单校验')
})
