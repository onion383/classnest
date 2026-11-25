// =========================================================================
// ai-privacy.test.js —— AI 数据保护第 1 批：纯模块判据，不接线、零行为变化
//
// 覆盖清单 §2：确定性 / 唯一性（含撞码加长）/ 双向可逆 / 脏号码不误伤 /
// 路径归一化（Windows + POSIX）/ 守卫不误报 / 流式反查跨分片 / 按 slug 分桶与失效。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

// 第 2 批起模块带 DB 门面（仍无裸 SQL），require 链会碰 dbManager 的主密钥校验
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'ai-privacy-unit-key'
const P = require('../../../student-backend/services/aiPrivacy')

const SEED = 'a'.repeat(64)
const students = [
  { id: 1, 姓名: '张三', 家长联系电话: '13812345678', 学生联系电话: '13900000001' },
  { id: 2, 姓名: '李四', 家长联系电话: '13712345678', 学生联系电话: '' },
  { id: 3, 姓名: '王五', 家长联系电话: '1', 学生联系电话: '' }, // 脏数据：不能把每个 1 都换掉
]
const leaves = [
  { id: 10, 姓名: '张三', 家长联系电话: '13612345678' },
]
const maps = () => P.buildMaps({ students, leaves, seed: SEED })

test('别名/令牌：同种子确定性，换种子必变', () => {
  assert.equal(P.aliasForStudent(1, SEED), P.aliasForStudent(1, SEED))
  assert.equal(P.tokenForPhone('13812345678', SEED), P.tokenForPhone('13812345678', SEED))
  assert.notEqual(P.aliasForStudent(1, SEED), P.aliasForStudent(1, 'b'.repeat(64)))
  assert.notEqual(P.tokenForPhone('13812345678', SEED), P.tokenForPhone('13812345678', 'b'.repeat(64)))
  assert.match(P.aliasForStudent(1, SEED), /^S-[0-9a-f]{6}$/)
  assert.match(P.tokenForPhone('13812345678', SEED), /^P-[0-9a-f]{6}$/)
})

test('唯一性：60 人无碰撞；撞码时加长一位而不是解错人', () => {
  const roster = Array.from({ length: 60 }, (_, i) => ({ id: i + 1, 姓名: `同学${i}` }))
  const m = P.buildMaps({ students: roster, seed: SEED })
  assert.equal(new Set(m.nameToAlias.values()).size, 60)
  assert.equal(new Set(m.aliasToName.keys()).size, 60)

  // 强制前 6 位都撞：第 7 位起才按 id 区分
  const forced = P.buildMaps({
    students: [{ id: 1, 姓名: '甲' }, { id: 2, 姓名: '乙' }],
    seed: SEED,
    deriveAlias: (id, seed, len) => (len === 6 ? 'S-aaaaaa' : `S-${String(id).padStart(len, '0')}`),
  })
  assert.equal(new Set(forced.nameToAlias.values()).size, 2)
  for (const a of forced.nameToAlias.values()) assert.equal(a.length, 9) // S- + 7 位

  const forcedPhone = P.buildMaps({
    students: [{ id: 1, 姓名: '甲', 家长联系电话: '13800000001', 学生联系电话: '13800000002' }],
    seed: SEED,
    deriveToken: (phone, seed, len) => (len === 6 ? 'P-aaaaaa' : `P-${phone.slice(-len)}`),
  })
  assert.equal(new Set(forcedPhone.phoneToToken.values()).size, 2)
  for (const t of forcedPhone.phoneToToken.values()) assert.equal(t.length, 9)
})

test('四张方向表：同名两人共用一个别名，脏号码 1 不进映射', () => {
  const m = maps()
  assert.equal(m.aliasToName.get(m.nameToAlias.get('张三')), '张三')
  assert.equal(m.tokenToPhone.get(m.phoneToToken.get('13812345678')), '13812345678')
  assert.equal(m.phoneToToken.has('1'), false)
  assert.equal(P.substituteOut('今天 1 班有 1 人', m), '今天 1 班有 1 人')
})

test('双向可逆：嵌套结构里的真名/真号出得去、回得来', () => {
  const m = maps()
  const src = {
    text: '张三 家长 13812345678，李四 13900000001',
    rows: [{ 姓名: '王五', note: '张三同班', n: 2, active: true }],
  }
  const out = P.substituteOut(src, m)
  const flat = JSON.stringify(out)
  assert.ok(!flat.includes('张三'))
  assert.ok(!flat.includes('李四'))
  assert.ok(!flat.includes('13812345678'))
  assert.ok(!flat.includes('13900000001'))
  assert.equal(out.rows[0].n, 2, '数字不许被替换')
  assert.deepEqual(P.restoreIn(out, m), src)

  // 未知值原样透传，不猜、不废整批
  assert.equal(P.substituteOut('新同学 王八', m), '新同学 王八')
  assert.equal(P.restoreIn('P-zzzzzz', m), 'P-zzzzzz')
})

test('出站不得把用户复制回来的代号反查成真号', () => {
  const m = maps()
  const alias = m.nameToAlias.get('张三')
  assert.equal(P.substituteOut(`上轮说 ${alias}`, m), `上轮说 ${alias}`)
})

test('路径归一化：Windows / POSIX 都抹掉盘符与用户名', () => {
  const win = P.normalizePaths('C:\\Users\\哇哈哈\\AppData\\Local\\classnest\\data\\content\\album\\IMG_001.jpg',
    'C:\\Users\\哇哈哈\\AppData\\Local\\classnest\\data')
  assert.equal(win, '<数据目录>/content/album/IMG_001.jpg')
  const posix = P.normalizePaths('/home/teacher/data/photos/IMG_001.jpg', '/home/teacher/data')
  assert.equal(posix, '<数据目录>/photos/IMG_001.jpg')
  assert.equal(P.normalizePaths('C:\\Users\\alice\\Desktop\\名单.xlsx'), '<用户目录>/Desktop/名单.xlsx')
  assert.equal(P.normalizePaths('/Users/alice/Desktop/名单.xlsx'), '<用户目录>/Desktop/名单.xlsx')
})

test('写库守卫：代号认得出，短串不误报', () => {
  assert.equal(P.hasUnrestoredToken('S-a3f1c9'), true)
  assert.equal(P.hasUnrestoredToken('备注 S-a3f1c9 未还原'), true)
  assert.equal(P.hasUnrestoredToken('订单号 S-1 共 3 人'), false)
  assert.equal(P.hasUnrestoredToken('这是一段正常中文'), false)
})

test('流式反查：代号跨分片不能漏，flush 补最后一段', () => {
  const m = maps()
  const alias = m.nameToAlias.get('张三')
  const phoneToken = m.phoneToToken.get('13812345678')
  const unmask = P.createStreamUnmasker(m)
  const text = `问 ${alias} 电话 ${phoneToken} 吧`
  const parts = [text.slice(0, 5), text.slice(5, 12), text.slice(12)]
  const got = parts.map((p) => unmask.push(p)).join('') + unmask.flush()
  assert.equal(got, '问 张三 电话 13812345678 吧')
  assert.ok(!parts.join('').includes('张三'))

  // 认不出的代号原样透传，不猜
  const u2 = P.createStreamUnmasker(m)
  assert.equal(u2.push('未知 S-ffffff ') + u2.flush(), '未知 S-ffffff ')
})

test('门面：种子懒生成、按 slug 分桶、失效重建、关闭时零拷贝', () => {
  const seeds = {}
  const rosterA = [{ id: 1, 姓名: '张三', 家长联系电话: '13812345678' }]
  const rosterB = [{ id: 9, 姓名: '赵六' }]
  let writes = 0
  const api = P.createAiPrivacy({
    readSeed: (slug) => seeds[slug] || '',
    writeSeed: (slug, seed) => { seeds[slug] = seed; writes++ },
    listStudents: (slug) => (slug === 'A' ? rosterA : rosterB),
    listLeaves: () => [],
    dataDir: '',
  })
  const a1 = api.substitute('张三 13812345678', 'A')
  assert.equal(writes, 1)
  assert.match(a1, /^S-[0-9a-f]{6} P-[0-9a-f]{6}$/)
  assert.equal(api.substitute('张三 13812345678', 'A'), a1, '同 slug 跨轮稳定')
  assert.equal(api.substitute('张三 13812345678', 'B'), '张三 13812345678', '换库不套用别名')

  rosterA[0].姓名 = '张三丰'
  assert.equal(api.substitute('张三丰', 'A'), `${a1.split(' ')[0]}丰`, '失效前仍是旧映射')
  api.invalidate('A')
  assert.match(api.substitute('张三丰', 'A'), /^S-[0-9a-f]{6}$/, '失效后用新名重建')

  const off = P.createAiPrivacy({ readEnabled: () => false, listStudents: () => rosterA })
  const obj = { text: '张三' }
  assert.strictEqual(off.substitute(obj, 'A'), obj, 'enabled:false 必须零拷贝')
  assert.strictEqual(off.restore(obj, 'A'), obj)
})

test('SQL 出口：隐私模块只经 services 读库，自己不留裸 SQL', () => {
  const src = fs.readFileSync(abs('student-backend/services/aiPrivacy.js'), 'utf8')
  assert.ok(!/require\(['"]\.\.\/db['"]\)/.test(src), '不许直接依赖当前库上下文')
  assert.ok(!/\.prepare\(/.test(src), 'SQL 必须在 aiConfigStore / aiStore')
  assert.match(src, /require\('\.\/aiConfigStore'\)/)
  assert.match(src, /require\('\.\/aiStore'\)/)
})
