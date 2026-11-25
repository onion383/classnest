// =========================================================================
// importBatch.js —— 批量导入幂等（F07-04）
//
// 问题：成绩导入是 append-only，同一份 Excel 导入两次就产生两份记录。但"重复"没有
// 天然的业务定义——同一学生同一天同一项目加两次分是合法的。所以不按内容去重，
// 改按"是不是同一份文件"：对导入入参算稳定指纹，命中就返回上次结果、不新建行。
//
// 指纹覆盖 fields / rows / mode / studentIds（同名选人结果），任一项变了就是另一份
// 导入。序列化按键排序，保证同一份输入无论对象键书写顺序如何都得到同一 hash。
//
// 存储用独立表 import_batches（见 schema.score.js），不动主表——老库 CREATE IF NOT
// EXISTS 即可，无需 ALTER / 数据迁移。
// =========================================================================
const crypto = require('node:crypto')
const { db } = require('../db')
const { now } = require('../utils/sql')

// 稳定序列化：对象键递归排序，数组保序。NaN / undefined 归一成 null 以免 hash 漂移。
function stableStringify(v) {
  if (v === null || typeof v !== 'object') {
    if (typeof v === 'number' && !Number.isFinite(v)) return 'null'
    return JSON.stringify(v) === undefined ? 'null' : JSON.stringify(v)
  }
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
}

/** 对一次导入的入参算指纹（纯函数，便于行为测试） */
function fingerprintOf({ fields, rows, mode, studentIds } = {}) {
  return crypto.createHash('sha256')
    .update(stableStringify({ fields, rows, mode, studentIds }))
    .digest('hex')
}

/** 查已有批次：命中返回新建行 id 列表，未命中返回 null */
function findBatch(fingerprint) {
  const row = db.prepare('SELECT created_json FROM import_batches WHERE fingerprint = ?').get(fingerprint)
  if (!row) return null
  try {
    const ids = JSON.parse(row.created_json)
    return Array.isArray(ids) ? ids : null
  } catch (_) {
    return null // 脏数据当未命中，不让一条坏记录挡住导入
  }
}

/** 记批次：与导入写记录同事务（调用方把 db.transaction 包住两步） */
function recordBatch(fingerprint, ids) {
  // 覆盖而非 DO NOTHING：force 新建后批次必须指向最新那批，否则默认重放仍命中旧 id。
  db.prepare(`INSERT INTO import_batches (fingerprint, created_json, created_at)
    VALUES (?, ?, ?)
    ON CONFLICT(fingerprint) DO UPDATE SET created_json=excluded.created_json, created_at=excluded.created_at`)
    .run(fingerprint, JSON.stringify(ids), now())
}

module.exports = { stableStringify, fingerprintOf, findBatch, recordBatch }
