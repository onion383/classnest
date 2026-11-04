// =========================================================================
// receipt-trash-probe.cjs —— 收据回收站的路径边界
//
// 这个函数会把文件从 uploads 移走，属于「能搬动磁盘文件」的入口，
// 所以判据的重点不是「能删」，而是「删不到 uploads 之外的任何东西」。
//
// 运行：node testjs/probe/receipt-trash-probe.cjs
// =========================================================================
const fs = require('fs')
const os = require('os')
const path = require('path')
const { moveReceiptsToTrash } = require('../../student-backend/services/receiptTrash')

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'trash-probe-'))
const uploads = path.join(root, 'uploads')
const trash = path.join(root, 'receipt-trash')
fs.mkdirSync(uploads, { recursive: true })

let failed = 0
function ok(cond, msg) {
  if (cond) console.log('  ✓ ' + msg)
  else { failed++; console.log('  ✗ ' + msg) }
}

// uploads 里放两个真实文件
fs.writeFileSync(path.join(uploads, 'a.jpg'), 'A')
fs.writeFileSync(path.join(uploads, 'b.pdf'), 'B')
// uploads 之外放一个「诱饵」：穿越攻击的目标
fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET')

console.log('正常移动：')
const moved = moveReceiptsToTrash(['/uploads/a.jpg', '/uploads/b.pdf'], uploads, trash)
ok(moved === 2, `移动了 2 个文件（实际 ${moved}）`)
ok(!fs.existsSync(path.join(uploads, 'a.jpg')), 'a.jpg 已从 uploads 移走')
ok(fs.readdirSync(trash).filter((n) => n.endsWith('a.jpg')).length === 1, '回收站里能找到 a.jpg')
ok(!fs.existsSync(path.join(uploads, 'b.pdf')), 'b.pdf 已从 uploads 移走')

console.log('\n穿越与异常输入：')
// 各种试图跳出 uploads 的写法
const attacks = [
  '../../secret.txt',
  '/../secret.txt',
  path.join(root, 'secret.txt'),      // 绝对路径
  '..\\..\\secret.txt',               // Windows 分隔符
]
const before = fs.existsSync(path.join(root, 'secret.txt'))
moveReceiptsToTrash(attacks, uploads, trash)
ok(before && fs.existsSync(path.join(root, 'secret.txt')), 'uploads 之外的文件没有被移动')
ok(fs.readdirSync(trash).every((n) => !n.endsWith('secret.txt')), '回收站里也没有 secret.txt')

const moved2 = moveReceiptsToTrash(['/uploads/not-exist.pdf'], uploads, trash)
ok(moved2 === 0, '不存在的文件跳过，不报错')
const moved3 = moveReceiptsToTrash([null, 123, {}, '/uploads/'], uploads, trash)
ok(moved3 === 0, '非法输入不抛错、也不移动任何东西')

fs.rmSync(root, { recursive: true, force: true })
console.log(failed ? `\n✗ ${failed} 项失败` : '\n✓ 全部通过')
process.exit(failed ? 1 : 0)
