// =========================================================================
// receipt-attach-rollback.test.js —— 收据关联写库失败要回滚弹窗列表（v7 §5-9 / #28）
//
// 原缺陷：FeeManagement.onReceiptChange 在 PUT 失败时只弹错误提示，弹窗里的
// localItems 还留着刚上传/刚删的那一项 → 用户看到「已附上」，库里没有这条关联，
// 刷新后凭空消失（文件在磁盘上，但没人引用它）。
// 修法：失败分支把父级 items 还原成库里的值（d.row['收据']，只有成功分支才更新），
// 收据弹窗按路径签名监听 props.receipts，签名变了才把 localItems 拉回父级那份。
//
// 这两个组件都是 .vue，不能直接 import；判据是「接线 + 顺序 + 变异反证」。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const PARENT = 'student-frontend/src/views/FeeManagement.vue'
const CHILD = 'student-frontend/src/components/dialogs/ReceiptDialog.vue'
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8')

function functionSource(src, name, { async = true } = {}) {
  const start = src.indexOf(`${async ? 'async ' : ''}function ${name}(`)
  assert.ok(start >= 0, `找不到 function ${name}`)
  // 跳过参数列表（`onReceiptChange({ items, removed })` 的参数里也有大括号，
  // 直接从函数名后找第一个 `{` 会在参数处收尾，把函数体截断）
  const parenOpen = src.indexOf('(', start)
  let pd = 0
  let parenClose = parenOpen
  for (let i = parenOpen; i < src.length; i += 1) {
    if (src[i] === '(') pd += 1
    else if (src[i] === ')') { pd -= 1; if (pd === 0) { parenClose = i; break } }
  }
  const open = src.indexOf('{', parenClose)
  let depth = 0
  for (let i = open; i < src.length; i += 1) {
    if (src[i] === '{') depth += 1
    else if (src[i] === '}') {
      depth -= 1
      if (depth === 0) return src.slice(start, i + 1)
    }
  }
  throw new Error(`function ${name} 的大括号没有配平`)
}

const parentSrc = read(PARENT)
const childSrc = read(CHILD)
const commitBody = functionSource(parentSrc, 'onReceiptChange')

test('父级：失败分支把 items 还原成库里的值，且还原在提示之前', () => {
  const catchAt = commitBody.indexOf('} catch (err) {')
  assert.ok(catchAt > 0, '找不到 onReceiptChange 的 catch')
  const catchBody = commitBody.slice(catchAt)
  assert.match(catchBody, /d\.items = normalizeReceipts\(d\.row\['收据'\]\)/,
    '失败分支没有把弹窗列表拉回库里的值')
  const idxRevert = catchBody.indexOf('d.items = normalizeReceipts')
  const idxNotify = catchBody.indexOf('notifyError')
  assert.ok(idxRevert >= 0 && idxRevert < idxNotify, '先还原再提示（提示之后就没机会改了）')
})

test('父级：只有成功分支才更新 d.row，否则还原出来的还是脏值', () => {
  const okIdx = commitBody.indexOf("d.row['收据'] = json")
  const catchAt = commitBody.indexOf('} catch (err) {')
  assert.ok(okIdx > 0 && okIdx < catchAt, "d.row['收据'] 必须在 try 的成功路径里更新")
})

test('弹窗：按路径签名监听 props.receipts，签名变了才同步', () => {
  assert.match(childSrc, /const receiptPathSig = \(list\) =>/, '缺少签名函数')
  const watchAt = childSrc.indexOf('watch(() => receiptPathSig(props.receipts)')
  assert.ok(watchAt > 0, '没有监听 props.receipts 的 watcher（父级回滚接不住）')
  const body = childSrc.slice(watchAt, watchAt + 500)
  assert.match(body, /if \(!props\.visible \|\| sig === prev\) return/, '必须先比较签名，避免自己 emit 的内容绕回来重置')
  assert.match(body, /localItems\.value = \(props\.receipts \|\| \[\]\)\.map/, '签名变化后要把 localItems 拉回父级那份')
})

test('弹窗：打开时的初始化 watcher 仍在（不能因为加了回滚把首开初始化弄丢）', () => {
  assert.match(childSrc, /watch\(\(\) => props\.visible, \(v\) => \{[\s\S]{0,200}localItems\.value = \(props\.receipts \|\| \[\]\)\.map/,
    'visible watcher 的初始化被改坏了')
})

test('变异反证：删掉父级还原语句后判据必红', () => {
  const mutated = parentSrc.replace(/\n *d\.items = normalizeReceipts\(d\.row\['收据'\]\)\r?\n/, '\n')
  assert.ok(mutated !== parentSrc, '变异没匹配到还原语句')
  const body = functionSource(mutated, 'onReceiptChange')
  assert.doesNotMatch(body.slice(body.indexOf('} catch (err) {')), /d\.items = normalizeReceipts/,
    '判据没有抓住缺失的还原语句')
})
