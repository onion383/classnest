// =========================================================================
// zip-peek.test.js —— 「这个备份包要不要口令」的判断必须和真包对得上
//
// 判据的价值全在「猜错」的代价上：
//   · 误判「不用口令」→ 输入框藏了，后端解不出钥匙 → 用户卡住且不知道该填什么
//   · 误判「要口令」  → 多问一句，最多少一次点击
// 所以解析不出来时必须降级成「要」。
// =========================================================================
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const test = require('node:test')
const assert = require('node:assert/strict')

const ROOT = path.resolve(__dirname, '../..')
const { writeBundle } = require('../../student-backend/services/backupArchive')
const { peekBundleMeta, bundleNeedsSecret, isEncryptedMeta } = require('../../student-frontend/src/utils/zipPeek.js')

const WORK = fs.mkdtempSync(path.join(os.tmpdir(), 'zippeek-'))
let seq = 0
const tmp = (name) => path.join(WORK, `${++seq}-${name}`)

// 造一个真包：bundle.json + 可选的一个大文件（用来证「只读开头就够」）
async function makeZip(meta, { withBigFile = false } = {}) {
  const plan = { meta }
  if (withBigFile) {
    const big = tmp('big.bin')
    fs.writeFileSync(big, Buffer.alloc(2 * 1024 * 1024, 7)) // 2MB，远超 peek 的 64KB
    plan.files = [{ name: 'uploads/big.bin', path: big }]
  }
  const zipPath = tmp('b.zip')
  const ws = fs.createWriteStream(zipPath)
  await writeBundle(plan, ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))
  const buf = fs.readFileSync(zipPath)
  return new Blob([buf])
}

const SLUG = '@a1b2c3d4e5f6'

test('能读出声明的账号与库标识（不必读整个包）', async () => {
  const blob = await makeZip({ version: 3, slug: SLUG, username: '张三', encrypted: true, key: 'K' }, { withBigFile: true })
  const meta = await peekBundleMeta(blob)
  assert.equal(meta.slug, SLUG)
  assert.equal(meta.username, '张三')
})

test('明文库包：不用任何口令', async () => {
  const blob = await makeZip({ version: 3, slug: SLUG, username: '张三', encrypted: false, key: null })
  assert.equal(bundleNeedsSecret(await peekBundleMeta(blob)), false)
})

test('加密库 + 钥匙明文随包：换机免密恢复，也不用口令', async () => {
  const blob = await makeZip({ version: 3, slug: SLUG, username: '张三', encrypted: true, key: 'plain-key-in-package' })
  assert.equal(bundleNeedsSecret(await peekBundleMeta(blob)), false)
})

test('只给了 wrappedByPassword：必须输密码', async () => {
  const blob = await makeZip({ version: 3, slug: SLUG, username: '张三', encrypted: true, wrappedByPassword: { s: 1, i: 2, c: 'xx' } })
  assert.equal(bundleNeedsSecret(await peekBundleMeta(blob)), true)
})

test('只给了 wrappedByMnemonic：也必须输（助记词）', async () => {
  const blob = await makeZip({ version: 3, slug: SLUG, username: '张三', encrypted: true, wrappedByMnemonic: { s: 1, i: 2, c: 'xx' } })
  assert.equal(bundleNeedsSecret(await peekBundleMeta(blob)), true)
})

test('encrypted 写成 0 / "0" 也算明文（与后端口径一致）', async () => {
  for (const v of [0, '0', false]) {
    assert.equal(isEncryptedMeta({ encrypted: v }), false, `encrypted=${JSON.stringify(v)} 应判为明文`)
  }
  for (const v of [1, '1', true, undefined]) {
    assert.equal(isEncryptedMeta({ encrypted: v }), true, `encrypted=${JSON.stringify(v)} 应判为加密（未标注按加密，兼容旧包）`)
  }
})

test('解析不出来时保守地要求口令（不是「不用」）', async () => {
  assert.equal(bundleNeedsSecret(null), true)
  assert.equal(bundleNeedsSecret({}), true, '空 meta：不知道有没有钥匙 → 要问')
  assert.equal(bundleNeedsSecret({ encrypted: true }), true)
})

test('不是 ZIP / 不是我们的包 → null', async () => {
  assert.equal(await peekBundleMeta(new Blob([Buffer.from('这不是压缩包，只是一段文本内容而已')])), null)
  assert.equal(await peekBundleMeta(new Blob([])), null)
  assert.equal(await peekBundleMeta(null), null)
})

test('第一个条目不是 bundle.json → null（格式变了就别猜）', async () => {
  const zipPath = tmp('other.zip')
  const ws = fs.createWriteStream(zipPath)
  const { writeZip } = require('../../student-backend/services/zipStream')
  await writeZip([{ name: 'other.json', data: JSON.stringify({ slug: SLUG }) }], ws)
  ws.end()
  await new Promise((r) => ws.on('close', r))
  const blob = new Blob([fs.readFileSync(zipPath)])
  assert.equal(await peekBundleMeta(blob), null)
})

test('口径对账：前后端的「是否加密」判断必须是同一个表达式', () => {
  const front = fs.readFileSync(path.join(ROOT, 'student-frontend/src/utils/zipPeek.js'), 'utf8')
  const back = fs.readFileSync(path.join(ROOT, 'student-backend/services/bundleRestore.js'), 'utf8')
  const expr = "!(meta.encrypted === false || meta.encrypted === 0 || meta.encrypted === '0')"
  assert.ok(front.includes(expr), '前端 zipPeek 的 isEncryptedMeta 缺少与后端一致的表达式')
  assert.ok(back.includes(expr), '后端 bundleRestore 的 isEncrypted 改了却没同步前端 —— 会导致输入框藏了但后端要密码')
})

test.after(() => {
  try { fs.rmSync(WORK, { recursive: true, force: true }) } catch (_) { /* 清理失败不影响结论 */ }
})
