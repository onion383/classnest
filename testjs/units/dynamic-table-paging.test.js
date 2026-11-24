// =========================================================================
// dynamic-table-paging.test.js —— 动态表分页（v8 · P3-10）
//
// 事故面：GET /api/students 全量下发，万行时序列化 + 反序列化吃掉整段首帧。
// 判据：
//   ① 不传 limit：行为与改造前一致（整表 + fields，不多回分页字段）；
//   ② 传 limit/offset：按 position 排序切片，并回 total/limit/offset；
//   ③ 非法分页参数一律 400（limit 0/非整数/超上限、offset 负数）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')

const { createBackendDb } = require('./_db-express-fixture.cjs')

const fx = createBackendDb({ label: 'dynamic-table-paging' })
const conn = fx.conn
// 必须等 createBackendDb 设好主密钥环境后再加载路由（与 batch-delete 同一顺序）
const { createDynamicTableRouter } = require('../../student-backend/routes/dynamicTable')

test.before(async () => {
  const ins = conn.prepare('INSERT INTO students (姓名, position) VALUES (?, ?)')
  ;['张三', '李四', '王五', '赵六'].forEach((n, i) => ins.run(n, i + 1))
  await fx.mount('/api/students', createDynamicTableRouter('students'))
})
test.after(() => fx.close())

test('不传 limit：整表返回，行为与改造前一致', async () => {
  const r = await fx.call('GET', '/api/students')
  assert.equal(r.status, 200)
  assert.equal(r.json.data.length, 4)
  assert.ok(Array.isArray(r.json.fields) && r.json.fields.length > 0)
  assert.equal(r.json.total, undefined, '不传分页参数时不应多回 total')
  assert.equal(r.json.limit, undefined)
})

test('limit/offset：按 position 切片并回 total', async () => {
  const r = await fx.call('GET', '/api/students?limit=2&offset=1')
  assert.equal(r.status, 200)
  assert.deepEqual(r.json.data.map((x) => x.姓名), ['李四', '王五'])
  assert.equal(r.json.total, 4)
  assert.equal(r.json.limit, 2)
  assert.equal(r.json.offset, 1)

  const tail = await fx.call('GET', '/api/students?limit=10&offset=3')
  assert.deepEqual(tail.json.data.map((x) => x.姓名), ['赵六'])

  const bare = await fx.call('GET', '/api/students?limit=2')
  assert.deepEqual(bare.json.data.map((x) => x.姓名), ['张三', '李四'], 'offset 缺省为 0')
})

test('非法分页参数一律 400', async () => {
  for (const q of ['limit=0', 'limit=-2', 'limit=abc', 'limit=1.5', 'limit=5001', 'limit=2&offset=-1', 'limit=2&offset=abc']) {
    const r = await fx.call('GET', `/api/students?${q}`)
    assert.equal(r.status, 400, `${q} 必须 400`)
    assert.ok(r.json.error, `${q} 必须带可读错误`)
  }
})
