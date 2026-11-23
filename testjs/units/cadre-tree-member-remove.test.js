// =========================================================================
// cadre-tree-member-remove.test.js —— 递归组件的事件转发必须带全参数（#58）
//
// CadreTreeList 是自递归组件：下级职务还是它自己。事件往上冒时若写成
//   @remove-member="$emit('remove-member', $event)"
// 只能透传**第一个**参数。而「移除担任学生」的原始 emit 是两个
// （node, m），到根组件 CadreManage.onRemoveMember(node, m) 时 m 已经是 undefined，
// 取 m.id 抛错，删除请求都发不出去 —— 且只有嵌套层级的成员会坏，根级正常，
// 属于很难靠手点点出来的那种。
//
// 判据（通用、不是认死某一行）：模板里每个「单参转发」@evt="$emit('evt', $event)"
// 对应的原始 emit 必须只有 1 个参数；多于 1 个就是丢参数。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const TREE = path.join(ROOT, 'student-frontend/src/components/CadreTreeList.vue')
const MANAGE = path.join(ROOT, 'student-frontend/src/components/CadreManage.vue')

const treeSrc = () => fs.readFileSync(TREE, 'utf8')

// 从 emit( 的 `(` 之后数「载荷参数」个数 —— 第一个参数是事件名，要跳过
function countArgs(src, openIdx) {
  let depth = 0
  let commas = 0
  let seen = false
  let pastName = false
  for (let i = openIdx; i < src.length; i += 1) {
    const c = src[i]
    if (c === '(' || c === '[' || c === '{') { depth += 1; continue }
    if (c === ')' || c === ']' || c === '}') {
      depth -= 1
      if (depth === 0) return commas + (seen ? 1 : 0)
      continue
    }
    if (depth !== 1) continue
    if (!pastName) { pastName = c === ','; continue }
    if (c === ',') commas += 1
    else if (!/\s/.test(c)) seen = true
  }
  throw new Error('括号没有配平')
}

// 某个事件在源码里所有 emit 调用的参数个数
function emitArgCounts(src, evt) {
  const re = new RegExp(`\\$?emit\\('${evt.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'`, 'g')
  const out = []
  let m
  while ((m = re.exec(src))) {
    // m[0] 形如 `$emit('select'`，参数列表的 `(` 就在它里面
    const open = m.index + m[0].indexOf('(')
    assert.ok(open > m.index, `emit('${evt}') 后面应有参数列表`)
    out.push(countArgs(src, open))
  }
  return out
}

// 递归子组件那一块模板（从 <CadreTreeList 到 />）
function childBlock(src) {
  const start = src.indexOf('<CadreTreeList')
  assert.ok(start >= 0, '找不到递归子组件用法')
  const end = src.indexOf('/>', start)
  assert.ok(end > start, '找不到递归子组件的闭合')
  return src.slice(start, end)
}

test('递归转发不能把多参事件压成单参', () => {
  const src = treeSrc()
  const block = childBlock(src)
  // 只认「$event 单参转发」这种写法 —— 显式箭头函数不受影响
  const forwards = [...block.matchAll(/@([\w-]+)="\$emit\('([^']+)', \$event\)"/g)]
  assert.ok(forwards.length > 0, '模板里应有若干 $event 转发，判据没匹配到说明解析方式过期了')

  const broken = []
  for (const [, attr, evt] of forwards) {
    const counts = emitArgCounts(src, evt)
    assert.ok(counts.length > 0, `@${attr} 转发的 emit('${evt}') 在组件里找不到原始调用`)
    const max = Math.max(...counts)
    if (max > 1) broken.push(`@${attr}：原始 emit('${evt}') 有 ${max} 个参数，这里只透了 $event`)
  }
  assert.deepEqual(broken, [], `这些事件转发会丢参数：\n${broken.join('\n')}`)
})

test('remove-member 显式透传 (node, member) 两个参数', () => {
  const src = treeSrc()
  const block = childBlock(src)
  const line = block.split('\n').find((l) => l.includes('@remove-member'))
  assert.ok(line, '找不到 @remove-member 的转发')

  assert.doesNotMatch(line, /\$event/, '不能用 $event 单参转发（会把 member 丢掉）')
  const arrow = line.match(/\(([^)]*)\)\s*=>\s*\$emit\('remove-member'([^)]*)\)/)
  assert.ok(arrow, `应写成 (node, member) => $emit('remove-member', node, member)，实际：${line.trim()}`)
  const params = arrow[1].split(',').map((s) => s.trim()).filter(Boolean)
  const args = arrow[2].split(',').map((s) => s.trim()).filter(Boolean)
  assert.equal(params.length, 2, '箭头函数要接住两个参数')
  assert.deepEqual(args, params, '透传的参数名与形参一致，顺序不能换')
})

test('根组件的 onRemoveMember 确实用第二个参数（否则修转发也没用）', () => {
  const src = fs.readFileSync(MANAGE, 'utf8')
  assert.match(src, /@remove-member="onRemoveMember"/, '根组件应把事件接到 onRemoveMember')

  const start = src.indexOf('async function onRemoveMember(')
  assert.ok(start >= 0, '找不到 onRemoveMember')
  const head = src.slice(start, src.indexOf('{', start))
  assert.match(head, /\(node, m\)/, `形参应是 (node, m)，实际：${head}`)
  const body = src.slice(start, src.indexOf('\n}', start))
  assert.match(body, /\bm\.id\b/, '第二参数必须真的被用（构造删除 URL / 查行）')
})
