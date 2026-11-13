// =========================================================================
// album-scan-two-phase.test.js —— 全量扫描「先建索引，再补缩略图」的接线守则
// 运行：npm run test:units
//
// 背景（实测 1000 张 4000×3000 手机原图）：
//   索引（stat + 读 EXIF）      4.8 ms/张 → 全部 4.8 秒
//   缩略图（decode+resize+写盘） 83 ms/张  → 83 秒
// 原来两者在同一个循环里交替，用户要干等 ~88 秒才能看到完整网格。
// 拆开后 5 秒就有完整索引（能排序、能滚动、张数正确），图在后面慢慢补。
//
// 这条链一旦被改回交替，用户不会看到任何报错，只会觉得「加个相册要一分半」——
// 所以用源码结构钉住两个阶段的存在与先后。
// 行为层由 testjs/smoke/album-scan-two-phase-test.cjs 钉（真扫描 + 采样）。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const SCAN = path.join(ROOT, 'student-backend/albumScan.js')
const WORKER = path.join(ROOT, 'student-backend/worker.scan.js')
const ROUTE = path.join(ROOT, 'student-backend/routes/album.js')

const read = (p) => fs.readFileSync(p, 'utf8')

/** 取某个顶层函数的函数体（按 `async function 名字(` 或 `function 名字(` 定位，花括号配平） */
function fnBody(code, name) {
  let at = code.indexOf(`async function ${name}(`)
  if (at < 0) at = code.indexOf(`function ${name}(`)
  assert.ok(at >= 0, `找不到 function ${name}(`)
  const open = code.indexOf('{', at)
  let depth = 0
  for (let i = open; i < code.length; i++) {
    if (code[i] === '{') depth++
    else if (code[i] === '}') {
      depth--
      if (!depth) return code.slice(open + 1, i)
    }
  }
  throw new Error(`${name} 的花括号没有配平`)
}

test('fullScan 有两个阶段，且阶段 1 不生成缩略图', () => {
  const body = fnBody(read(SCAN), 'fullScan')

  const indexAt = body.indexOf("task.phase = 'index'")
  const thumbAt = body.indexOf("task.phase = 'thumb'")
  assert.ok(indexAt > 0, "找不到 task.phase = 'index'（阶段 1 不存在了？）")
  assert.ok(thumbAt > indexAt, "找不到 task.phase = 'thumb'，或它排在了 index 之前")

  const endAt = body.indexOf('if (!thumbCompleted) return')
  assert.ok(endAt > thumbAt, '找不到阶段 2 的结束标记 if (!thumbCompleted) return')

  const phase1 = body.slice(indexAt, thumbAt)
  const phase2 = body.slice(thumbAt, endAt)

  // 这是整件事的核心：索引阶段一个 genThumb 都不能有。
  // 有的话就退回「每张索引完立刻生成缩略图」，用户又得干等 88 秒。
  assert.ok(!/genThumb\(/.test(phase1), '阶段 1（建索引）里还在调 genThumb —— 两阶段又合并回交替了')
  assert.match(phase2, /genThumb\(/, '阶段 2（补缩略图）必须真的生成缩略图')
  // 全量扫描的语义：无条件重建（不判 thumb_path 有没有），用户点它就是为了刷缓存
  assert.ok(!/thumb_path/.test(phase2), '阶段 2 不许按 thumb_path 跳过 —— 全量更新的语义是无条件重建')
})

test('续扫能区分「索引没跑完」和「只差补图」', () => {
  const body = fnBody(read(SCAN), 'fullScan')
  assert.match(body, /resumingPhase === 'thumb'/, '必须用上次记录的 phase 判断索引是否已完整')
  // 索引已完成时不许再跑阶段 1（否则续扫会把全部 EXIF 重读一遍）
  assert.match(body, /if \(!indexDone\) \{[\s\S]{0,200}?for \(let i = startIdx/, '阶段 1 必须被 if (!indexDone) 包住')
})

test('续扫时 claimScanTask 不许把 phase 覆盖成固定值', () => {
  const body = fnBody(read(SCAN), 'claimScanTask')
  // 续扫分支
  const resumeAt = body.indexOf('if (resumeFrom) {')
  assert.ok(resumeAt >= 0, '找不到续扫分支')
  const elseAt = body.indexOf('} else {', resumeAt)
  const seg = body.slice(resumeAt, elseAt > 0 ? elseAt : body.length)
  assert.ok(!/phase\s*=/.test(seg),
    '续扫分支覆盖了 phase —— 会分不清「索引没跑完」与「只差补图」，续扫得重读全部 EXIF')
  // 从头扫的分支仍然要重置 phase
  assert.match(body, /phase = 'collect'/, '从头扫描必须把 phase 重置成 collect')
})

test('进度从子进程一路带到前端（两阶段各自 0→100%，不报阶段名就会往回跳）', () => {
  assert.match(read(WORKER), /phase: t\.phase/, 'worker 的 progress 消息必须带 phase')
  assert.match(read(path.join(ROOT, 'student-backend/scanWorker.js')), /t\.phase = msg\.phase/,
    '主进程收到 progress 必须保存 phase')
  const route = read(ROUTE)
  assert.match(route, /phase: task\.phase \|\| 'process',/, '/status 必须返回 phase')
  assert.match(route, /phase: task\.phase \|\| 'process',\n\s*startedAt/, '/tasks 必须返回 phase')
})

test('前端把阶段名显示出来（否则进度条 100%→0% 看着像任务重跑）', () => {
  const dlg = read(path.join(ROOT, 'student-frontend/src/components/dialogs/AlbumTaskDialog.vue'))
  assert.match(dlg, /phaseLabel\(taskOf\(a\.id\)\)/, '任务行必须用 phaseLabel 而不是裸 modeLabel')
  assert.match(dlg, /t\.phase === 'index'/, 'phaseLabel 必须识别 index 阶段')
  assert.match(dlg, /t\.phase === 'thumb'/, 'phaseLabel 必须识别 thumb 阶段')
})
