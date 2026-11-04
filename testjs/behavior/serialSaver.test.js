// =========================================================================
// serialSaver.test.js —— 串行保存器行为（并发合并 / 失败语义）
//
// 运行：npm run test:behavior
// 被测：student-frontend/src/utils/serialSaver.js
// 这是页面「每次编辑就 PUT 整块」的保存基础设施，行为契约：
//   · 同一时刻最多一个保存请求在途；
//   · 在途期间追加的更新合并成一轮（用 saveFn 读最新状态再存）；
//   · request() 永不 reject（返回 boolean），失败后停止本批不自动重试。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const loadSaver = async () => {
  const mod = await import(pathToFileURL(path.join(__dirname, '../../student-frontend/src/utils/serialSaver.js')).href)
  return mod.createSerialSaver
}

test('serialSaver：保存成功返回 true、error 清空', async () => {
  const createSerialSaver = await loadSaver()
  let calls = 0
  const saver = createSerialSaver(async () => { calls++ })
  const ok = await saver.request()
  assert.equal(ok, true)
  assert.equal(calls, 1)
  assert.equal(saver.error, null)
})

test('serialSaver：保存失败返回 false 并保留 error（不 reject）', async () => {
  const createSerialSaver = await loadSaver()
  const boom = new Error('网络断了')
  const saver = createSerialSaver(async () => { throw boom })
  const ok = await saver.request()
  assert.equal(ok, false)
  assert.equal(saver.error, boom)
})

test('serialSaver：失败后不自动重试（本批只跑一次）', async () => {
  const createSerialSaver = await loadSaver()
  let calls = 0
  const saver = createSerialSaver(async () => { calls++; throw new Error('x') })
  await saver.request()
  await new Promise((r) => setTimeout(r, 10))
  assert.equal(calls, 1)
})

test('serialSaver：saveFn 执行期间的追加请求合并成一轮，两个调用拿到同一结果', async () => {
  const createSerialSaver = await loadSaver()
  let calls = 0
  let release
  let entered
  const gate = new Promise((r) => { release = r })
  const enteredGate = new Promise((r) => { entered = r })
  const saver = createSerialSaver(async () => {
    calls++
    if (calls === 1) { entered(); await gate } // 第一轮挂起，制造并发窗口
  })
  const p1 = saver.request()
  // 等第一轮**真正进入 saveFn**（静默期已过）再追加请求 ——
  // 这才是「保存途中用户又改了」的真实场景。
  // ⚠️ 不能靠固定 sleep 猜：静默期有 300ms，sleep 20ms 时 p1 还在静默期里，
  //   p2 也会落在静默期内 → 被合并成**一次**保存（那是 B11-05 要的效果，不是本例要测的）。
  await enteredGate
  const p2 = saver.request()
  release()
  const [ok1, ok2] = await Promise.all([p1, p2])
  assert.equal(ok1, true)
  assert.equal(ok2, true)
  assert.equal(calls, 2, '第一轮 + 合并后补存一轮，共 2 次（而不是 2 个并发请求各自跑）')
})

test('serialSaver：静默期内的连续请求合并成一次保存（连打 10 字只 PUT 1 次）', async () => {
  const createSerialSaver = await loadSaver()
  let calls = 0
  const saver = createSerialSaver(async () => { calls++ })
  // 模拟「连打 10 个字」：10 次 request 都落在静默期内
  const ps = []
  for (let i = 0; i < 10; i++) ps.push(saver.request())
  const oks = await Promise.all(ps)
  assert.ok(oks.every((o) => o === true), '所有调用都拿到成功结果')
  assert.equal(calls, 1, '静默期内的 10 次请求应合并成 1 次保存（原先是 2 次整表 PUT）')
})

test('serialSaver：失败后不再补存合并轮（不把旧状态又写一遍）', async () => {
  const createSerialSaver = await loadSaver()
  let calls = 0
  let release
  const gate = new Promise((r) => { release = r })
  const saver = createSerialSaver(async () => {
    calls++
    if (calls === 1) await gate
    throw new Error('写库失败')
  })
  const p1 = saver.request()
  await new Promise((r) => setTimeout(r, 20))
  const p2 = saver.request() // 第一轮已在途（保存途中追加）
  release()
  const [ok1, ok2] = await Promise.all([p1, p2])
  assert.equal(ok1, false)
  assert.equal(ok2, false)
  assert.equal(calls, 1, '失败即停，合并轮不再发起')
})

test('serialSaver：成功后合并轮用的是最新状态（saveFn 每轮现取）', async () => {
  const createSerialSaver = await loadSaver()
  let state = '旧'
  const saved = []
  let release
  let entered
  const gate = new Promise((r) => { release = r })
  const enteredGate = new Promise((r) => { entered = r })
  const saver = createSerialSaver(async () => {
    saved.push(state)
    if (saved.length === 1) { entered(); await gate }
  })
  const p1 = saver.request()
  await enteredGate // 等第一轮进入 saveFn
  state = '新' // 在途期间状态又变了（模拟连续编辑）
  const p2 = saver.request()
  release()
  await Promise.all([p1, p2])
  assert.deepEqual(saved, ['旧', '新'], '第二轮保存读到的是「新」状态')
})
