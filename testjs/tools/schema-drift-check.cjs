// =========================================================================
// schema-drift-check.cjs —— 结构清单 vs 真实建库结果的对账
//
// 干什么：空库跑一次真实的 initSchema，再拿 `migrations/snapshot.js` 的 EXPECTED 对账。
// 期望结果：缺列 0 处、自愈不了 0 处。有输出就说明「清单过期了」或「建表漏了列」——
// 前者跑一遍 schema-snapshot-gen.cjs 重生成，后者是真 bug。
//
// 为什么不做成单测：它是**维护期的体检**，不是行为契约。放进 CI 的话，
// 每次加列都得先重生成清单，忘了就红一片，会逼着人「为了变绿而重生成」——
// 那正好丢掉了它本来要抓的东西。等迁移体系正式接入时再考虑转成单测。
//
// 用法：
//   node testjs/tools/schema-drift-check.cjs
// 退出码 0 = 干净；1 = 有缺列或不可自愈的差异。
// =========================================================================
const path = require('node:path')
const { createRequire } = require('node:module')

const ROOT = path.resolve(__dirname, '../..')
const backendRequire = createRequire(path.join(ROOT, 'student-backend/package.json'))
const Database = backendRequire('better-sqlite3-multiple-ciphers')
const { initSchema } = require(path.join(ROOT, 'student-backend/schema/schema.js'))
const { EXPECTED } = require(path.join(ROOT, 'student-backend/migrations/snapshot.js'))
const { diffSchema } = require(path.join(ROOT, 'student-backend/migrations/converge.js'))

function main() {
  const db = new Database(':memory:')
  try {
    initSchema(db)
    const diff = diffSchema(db, EXPECTED)

    console.log(`清单：表 ${Object.keys(EXPECTED.tables).length} · 索引 ${Object.keys(EXPECTED.indexes).length} · 视图 ${Object.keys(EXPECTED.views).length}`)

    if (diff.missing.length) {
      console.log(`\n缺列 / 缺索引 / 缺视图（${diff.missing.length}）—— 清单比库新，或建表漏了：`)
      for (const m of diff.missing) console.log(`  · ${m.kind} ${m.target}`)
    }
    if (diff.blocked.length) {
      console.log(`\n不可自愈（${diff.blocked.length}）：`)
      for (const b of diff.blocked) console.log(`  · ${b.kind} ${b.target}：${b.reason}`)
    }
    if (diff.extra.length) {
      // 空库上出现「多出来的列」只有一种解释：清单漏登记了这一列（用户自定义列在空库上不存在）
      console.log(`\n库里多出来、清单没登记（${diff.extra.length}）—— 跑一次生成器即可：`)
      for (const e of diff.extra) console.log(`  · ${e.kind} ${e.target}`)
    }

    const bad = diff.missing.length + diff.blocked.length + diff.extra.length
    if (!bad) {
      console.log('\n对账通过：清单与建库结果完全一致。')
      return 0
    }
    return 1
  } finally {
    db.close()
  }
}

process.exit(main())
