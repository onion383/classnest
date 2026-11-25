// =========================================================================
// receipt-download-all.test.js —— 「管理收据 / 查看收据 / 下载全部」接线
//
// 判据（不是只数字符串）：
//   1. 标题行右侧有按钮，@click 指向 downloadAll，禁用态与单条下载共用 downloading；
//   2. downloadAll 把当前列表（含外国人改过的 name）交给 saveZipWithDialog 的
//      receiptGroups，走磁盘中转，而不是逐条 saveBlobWithDialog 弹 N 次保存框；
//   3. 用户取消（返回 ''）不提示，失败才提示；
//   4. 变异反证：把 saveZipWithDialog 换成逐条保存后，判据必须变红。
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const { extractFunctionDecl } = require('#testjs/units/_mechanism.cjs')
const path = require('node:path')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const VUE = 'student-frontend/src/components/dialogs/ReceiptDialog.vue'
const src = fs.readFileSync(abs(VUE), 'utf8')

function runDownloadAll(srcUnderTest, { saved = '/tmp/receipts.zip', throws = null } = {}) {
  const calls = []
  const notices = []
  const downloading = { value: false }
  const localItems = { value: [
    { path: '/uploads/a.png', name: '原始名.png' },
    { path: '/uploads/b.pdf', name: '改名.pdf' },
  ] }
  const saveZipWithDialog = async (...args) => {
    calls.push(['zip', ...args])
    if (throws) throw throws
    return saved
  }
  const saveBlobWithDialog = async (...args) => {
    calls.push(['blob', ...args])
    return '/tmp/single'
  }
  const factory = new Function(
    'saveZipWithDialog', 'saveBlobWithDialog', 'notifySuccess', 'notifyError', 'localItems', 'downloading',
    `${extractFunctionDecl(srcUnderTest, 'downloadAll')}\nreturn downloadAll;`,
  )
  const fn = factory(
    saveZipWithDialog,
    saveBlobWithDialog,
    (msg) => notices.push(['ok', msg]),
    (msg) => notices.push(['err', msg]),
    localItems, downloading,
  )
  return { fn, calls, notices, downloading }
}

test('接线：按钮在「查看收据」标题行，且与单条下载共用禁用态', () => {
  const start = src.indexOf('<template v-if="localItems.length">')
  const row = src.slice(start, src.indexOf('rc-list', start))
  assert.match(row, /@click="downloadAll"/, '按钮没接 downloadAll')
  assert.match(row, /:disabled="downloading"/, '下载中应禁用，避免并发弹两个保存框')
  assert.match(src, /saveBlobWithDialog, saveZipWithDialog/, '未从统一出口引入 saveZipWithDialog')
})

test('行为：一次打包当前列表的全部收据，路径与名字都传原值', async () => {
  const { fn, calls, notices, downloading } = runDownloadAll(src)
  await fn()
  assert.equal(calls.length, 1, '只能弹一次保存框')
  assert.equal(calls[0][0], 'zip', '必须走磁盘中转打包，不能逐条 blob 保存')
  assert.equal(calls[0][1], '收据')
  assert.deepEqual(calls[0][2].receiptGroups, [{
    code: '',
    items: [
      { path: '/uploads/a.png', name: '原始名.png' },
      { path: '/uploads/b.pdf', name: '改名.pdf' },
    ],
  }])
  assert.deepEqual(notices, [['ok', '已保存']])
  assert.equal(downloading.value, false, '结束后必须放开禁用态')
})

test('行为：取消保存不提示，失败才提示，且都放开禁用态', async () => {
  const canceled = runDownloadAll(src, { saved: '' })
  await canceled.fn()
  assert.deepEqual(canceled.notices, [], '用户点取消不该打扰')

  const failed = runDownloadAll(src, { throws: new Error('写盘失败') })
  await failed.fn()
  assert.deepEqual(failed.notices, [['err', '写盘失败']])
  assert.equal(failed.downloading.value, false)
})

test('行为：空列表直接返回，不发请求', async () => {
  const env = runDownloadAll(src)
  env.notices.length = 0
  const factory = new Function(
    'saveZipWithDialog', 'saveBlobWithDialog', 'notifySuccess', 'notifyError', 'localItems', 'downloading',
    `${extractFunctionDecl(src, 'downloadAll')}\nreturn downloadAll;`,
  )
  const fn = factory(
    () => { throw new Error('不该打包') },
    () => { throw new Error('不该逐条保存') },
    () => {}, () => {},
    { value: [] }, env.downloading,
  )
  await fn()
  assert.equal(env.downloading.value, false)
})

test('变异反证：换成逐条 saveBlobWithDialog 后判据必红', async () => {
  const mutated = src.replace(
    /const saved = await saveZipWithDialog\('收据', \{[\s\S]*?\}\)/,
    "const saved = await saveBlobWithDialog('收据', new Blob([]))",
  )
  assert.ok(mutated !== src, '变异没匹配到 downloadAll 的打包调用')
  const { fn, calls } = runDownloadAll(mutated)
  await fn()
  assert.equal(calls[0][0], 'blob', '判据没抓住「逐条保存」变异')
})
