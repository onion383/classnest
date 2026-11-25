// ==================== 迁移运行器（尚未接入任何启动路径） ====================
//
// 这里是「打开某个库时要不要升级它」的唯一入口。**目前没有被任何代码 require**，
// 所以它一行都不会执行 —— 这是故意的：先有零件，等第一版发布前再接线。
//
// 一次升级的四步（对应草案 §5）：
//   1. 版本链：user_version 落后 → 逐条跑 STEPS 里更新的步骤（每步：结构声明 → 搬数据 → 记账）
//   2. 结构保底：converge(expected) —— 补上「加了列但忘了写版本文件」的差异
//   3. 终检：assertConverged —— 还有差异就抛，绝不带着半对的结构继续跑
//   4. 写版本：每步结束时把 user_version 推到该步（在事务内，回滚则不动）
//
// 四道闸门：
//   · 版本相等 → 直接返回（绝大多数启动走这条，只读一次库头）；
//   · 库版本 > 程序版本 → 拒启（用户回退 exe / 多装一份时，这是唯一能保住数据的选择）；
//   · 升级前备份一次（由调用方注入 backup 函数，本目录不许 require 业务代码）；
//   · 一版一事务（连续的纯结构步骤会合并成一批，搬数据的步骤各自单独开事务）。
const ledger = require('./ledger')
const { converge, assertConverged } = require('./converge')

// 版本清单。**空数组 = 现在没有任何迁移**：全新库由 schema 层直接建到最新形态，
// 不需要从 v1 逐个补。等第一版发出去以后，加字段就在下面追加一条。
//
// 一条步骤长这样（只声明自己那一版新增的东西，绝不引用「当前全量清单」）：
//   {
//     version: 2,                      // 整数，与 user_version 同口径
//     name: 'students-show-column',    // 账本里给人看，改完就别再动
//     structure: { students: { 是否住校: "TEXT NOT NULL DEFAULT ''" } },
//     data(db) { /* 只有要 SELECT 出数据时才写；写了就自动单独开事务 */ },
//   }
const STEPS = []

// 代码认知的最新版本：清单里最大那个；没有迁移时是 0。
function codeVersion(steps) {
  return (steps || []).reduce((max, s) => Math.max(max, Number(s.version) || 0), 0)
}

// 版本步骤里的 structure 两种写法都收：
//   { students: ['是否住校'] }                    只有列名（不能自动 ADD，会明确报「缺列定义」）
//   { students: { 是否住校: "TEXT NOT NULL DEFAULT ''" } }   带定义（可自愈）
//   { indexes: {...}, views: {...} }              与 tables 同级
// 为什么允许「只有列名」：声明本身就是文档；缺定义时 converge 会把原因说清楚，
// 比硬塞一个猜出来的类型安全得多。
function normalizeStructure(structure) {
  const out = { tables: {}, indexes: {}, views: {} }
  for (const [table, cols] of Object.entries(structure || {})) {
    if (table === 'indexes' || table === 'views') {
      Object.assign(out[table], cols || {})
      continue
    }
    if (Array.isArray(cols)) out.tables[table] = Object.fromEntries(cols.map((c) => [c, '']))
    else out.tables[table] = cols || {}
  }
  return out
}

// 跑一条步骤：结构声明 → 搬数据 → 记账 → 推版本。四件事必须在同一事务里，
// 否则会出现「表改了、版本没推进」（下次重跑）或「版本推进了、表没改」（永久错位）。
function applyStep(db, step, expected) {
  if (step.structure) {
    const shape = normalizeStructure(step.structure)
    if (expected) {
      // 有全量清单时，确认这一版声明的表确实在清单里 —— 防止写错表名后「静默什么都没做」
      for (const table of Object.keys(shape.tables)) {
        if (!Object.prototype.hasOwnProperty.call(expected.tables || {}, table)) {
          throw new Error(`迁移 ${step.version} 声明了清单里没有的表：${table}`)
        }
      }
    }
    const res = converge(db, shape)
    if (res.blocked.length) {
      const detail = res.blocked.map((b) => `${b.target}：${b.reason}`).join('；')
      throw new Error(`迁移 ${step.version} 的结构声明无法自动执行（${detail}）`)
    }
  }
  if (typeof step.data === 'function') step.data(db)
  ledger.record(db, step, ledger.checksumOf(step))
  ledger.writeVersion(db, step.version)
}

function inTx(db, fn) {
  db.exec('BEGIN IMMEDIATE')
  try {
    fn()
    db.exec('COMMIT')
  } catch (e) {
    try { db.exec('ROLLBACK') } catch (_) { /* best-effort: 事务可能已被 SQLite 自动回滚 */ }
    throw e
  }
}

// 连续的结构步骤合并成一个事务（各自不失败），搬数据的步骤单独开事务：
// 前者省掉几十次 COMMIT 的落盘开销，后者保证「强杀后只损失这一条、下次从它重来」。
// 但两者不能混在一个事务里 —— 一旦最后一步搬数据失败，前面的结构步骤会白跑一遍。
function runSteps(db, todo, expected, onProgress) {
  const report = (step, index) => {
    if (typeof onProgress === 'function') {
      try { onProgress({ index: index + 1, total: todo.length, step }) } catch (_) { /* best-effort: 进度回调不该影响迁移 */ }
    }
  }
  let batch = []
  let consumed = 0
  const flush = () => {
    if (!batch.length) return
    const group = batch
    batch = []
    inTx(db, () => { for (const s of group) applyStep(db, s, expected) })
    for (const s of group) report(s, consumed++)
  }
  for (const step of todo) {
    if (typeof step.data === 'function') {
      flush()
      inTx(db, () => applyStep(db, step, expected))
      report(step, consumed++)
    } else {
      batch.push(step)
    }
  }
  flush()
}

/**
 * 打开库之后调用一次。返回一份摘要（方便日志与断言），不抛以外的副作用。
 *
 * @param {object} db      better-sqlite3 连接（已解密、已打开）
 * @param {object} [opts]
 * @param {Array}  [opts.steps]     版本清单，默认 STEPS（测试可传自己的）
 * @param {object} [opts.expected]  全量结构清单（snapshot.js 的 EXPECTED），传了才做保底与终检
 * @param {Function} [opts.backup]  升级前备份：({fromVersion, toVersion}) => void。没传就跳过备份
 * @param {Function} [opts.onProgress] 逐条进度回调，接启动页的「正在升级数据 2/3」
 */
function runMigrations(db, { steps = STEPS, expected = null, backup = null, onProgress = null } = {}) {
  const list = [...(steps || [])].sort((a, b) => Number(a.version) - Number(b.version))
  const code = codeVersion(list)
  const current = ledger.readVersion(db)

  if (current > code) {
    throw new Error(
      `这个库的结构版本是 ${current}，高于当前程序支持的 ${code}。`
      + '请升级到更新的版本，或从升级前的备份恢复 —— 用旧程序打开新库会静默丢字段。',
    )
  }

  const todo = list.filter((s) => Number(s.version) > current)
  if (!todo.length) {
    // 常见路径：版本已经对齐。仍然做一次结构终检（很便宜，一次 PRAGMA 全表），
    // 因为它能抓住「代码加了列但忘了写版本文件」——那正是纯加法开发时最容易出的错。
    if (expected) assertConverged(db, expected)
    return { skipped: true, from: current, to: code, applied: [] }
  }

  const drift = ledger.verify(db, list)
  if (drift.length) {
    throw new Error(`迁移账本与代码不一致：\n- ${drift.map((d) => `v${d.version}：${d.reason}`).join('\n- ')}`)
  }

  // 备份**只做一次**，在改动任何东西之前。每条迁移都备份一次是最容易把升级拖成几秒的写法。
  // 备份实现由调用方注入（生产用 dbManager.backup.js）：WAL 模式下自己 copyFile 拿到的是残缺快照。
  if (typeof backup === 'function') backup({ fromVersion: current, toVersion: code })

  ledger.ensure(db)
  runSteps(db, todo, expected, onProgress)

  // 保底 + 终检。保底补的是「忘了写版本文件」的差异，终检保证修不了的一律报错。
  if (expected) {
    inTx(db, () => { converge(db, expected) })
    assertConverged(db, expected)
  }

  return { skipped: false, from: current, to: code, applied: todo.map((s) => Number(s.version)) }
}

// 诊断用：这个库还有哪些版本没跑（不写库、不备份）。给「设置 → 关于」或排障脚本用。
function pending(db, steps = STEPS) {
  const list = [...(steps || [])].sort((a, b) => Number(a.version) - Number(b.version))
  const current = ledger.readVersion(db)
  return list.filter((s) => Number(s.version) > current).map((s) => ({ version: Number(s.version), name: s.name }))
}

module.exports = { STEPS, codeVersion, normalizeStructure, runMigrations, pending }
