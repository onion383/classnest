// =========================================================================
// album-scan-incremental-thumb.test.js —— 增量「跳过已有、补齐丢的」 vs 全量「无条件重建」
//
// 用户拍板（刻意相反的两套语义，别合并）：
//   · 增量更新：已有缩略图就跳过（不管预览现场生成的还是之前扫描生成的），只补丢的
//   · 全量更新：有没有都重新生成 —— 它是「修坏图 / 刷缓存」的唯一入口
// 判据只判文件在不在，不读内容（已生成的 jpg 不太可能自己损坏）。
//
// 行为层由 testjs/smoke/album-scan-incremental-thumb-test.cjs 钉（真扫描 + mtime 比对），
// 这里守接线：最容易发生的退化是「把增量的 present 判据顺手搬进全量阶段 2」。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const SCAN = path.join(ROOT, 'student-backend/albumScan.js')
const read = () => fs.readFileSync(SCAN, 'utf8')

/** 去掉注释：这些判据在解释「为什么不能这么写」的注释里恰好也会出现同名文本 */
function stripComments(code) {
  return code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}

/** 取顶层函数的函数体：先跳过参数表，再按花括号配平 */
function fnBody(code, name) {
  const at = code.indexOf(`function ${name}(`)
  assert.ok(at >= 0, `找不到 function ${name}(`)
  const paren = at + `function ${name}`.length
  let pd = 0
  let close = -1
  for (let i = paren; i < code.length; i++) {
    if (code[i] === '(') pd++
    else if (code[i] === ')') { pd--; if (!pd) { close = i; break } }
  }
  assert.ok(close > 0, `${name} 的参数表没闭合`)
  const open = code.indexOf('{', close)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') { depth--; if (!depth) return code.slice(open + 1, i) }
  }
  throw new Error(`${name} 花括号没配平`)
}

/** 全量扫描的「阶段 2」片段：从 phase='thumb' 到 thumbWriter.flush() */
function fullPhase2(code) {
  const at = code.indexOf("task.phase = 'thumb'")
  assert.ok(at > 0, "找不到 task.phase = 'thumb'")
  const end = code.indexOf('thumbWriter.flush()', at)
  assert.ok(end > at, '找不到阶段 2 的收尾')
  return code.slice(at, end)
}

test('增量用一次 readdir 拿已落盘 id，不逐张 stat、不用同步 IO', () => {
  const code = stripComments(read())
  const body = fnBody(code, 'presentThumbIds')
  assert.match(body, /fsp\.readdir\(/, '必须一次 readdir 拿目录清单（53016 次 stat 太贵）')
  assert.ok(!/existsSync/.test(code), '不许用 fs.existsSync：同步 IO 会阻塞整个后端事件循环')
  assert.match(body, /\.jpg/, '只认 .jpg（临时文件 {id}.{ts}.jpg 靠 Number 得 NaN 天然排除）')
})

test('增量主循环：mtime 相同但缩略图丢了 → 必须补生成', () => {
  const body = fnBody(stripComments(read()), 'incrementalScan')
  assert.match(body, /const present = await presentThumbIds\(slug\)/, '必须先拿到已落盘集合')
  assert.match(body, /else if \(\(old\.thumb_v \|\| 0\) < THUMB_VERSION \|\| !present\.has\(old\.id\)\)/,
    'mtime 相同分支必须判「版本或文件」，不能只 continue（这就是原来漏掉补图的坑）')
  assert.match(body, /present\.add\(old\.id\)/, '补完要把 id 记进集合，避免同一轮重复生成')
})

test('增量：mtime 变了仍无条件重建（源图变了，跳过会显示旧图）', () => {
  const body = fnBody(stripComments(read()), 'incrementalScan')
  const changedAt = body.indexOf('if (old.mtime !== mtime)')
  assert.ok(changedAt > 0, '找不到 mtime 变化分支')
  const seg = body.slice(changedAt, body.indexOf('} else if', changedAt))
  assert.match(seg, /genThumb\(/, 'mtime 变了必须重新生成，不能因为「已有缩略图」就跳过')
  assert.ok(!/present\.has/.test(seg), 'mtime 变化分支不许判 present —— 那会留着旧图')
})

test('增量续扫补缺也用同一判据（版本 + 文件在不在），不能只看 thumb_path', () => {
  const body = fnBody(stripComments(read()), 'incrementalScan')
  assert.match(body, /\(old\.thumb_v \|\| 0\) >= THUMB_VERSION && present\.has\(old\.id\)\) continue/,
    '续扫分支必须同时看版本和文件')
  assert.ok(!/old\.thumb_path && \(old\.thumb_v/.test(body),
    '不许退回「thumb_path 非空就算有」—— 清理微缩图后路径还在、文件早没了')
})

test('全量阶段 2 保持无条件重建：不许搬进增量的 present 判据', () => {
  const seg = fullPhase2(stripComments(read()))
  assert.match(seg, /genThumb\(row\.id/, '阶段 2 必须真的调用 genThumb')
  assert.ok(!/present/.test(seg), '全量不许判 present：它是「修坏图 / 刷缓存」的唯一入口')
  assert.ok(!/thumb_v/.test(seg), '全量不许按 thumb_v 跳过')
  assert.ok(!/existsSync|readdir/.test(seg), '全量不该去查文件在不在')
})
