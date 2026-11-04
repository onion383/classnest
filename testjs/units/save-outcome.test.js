// =========================================================================
// save-outcome.test.js —— save-file 三态判定（V5-002）正反用例
//
// 报告 V5-002 的根因：判定逻辑散落在多个消费点，AiChart 只判 `result.canceled`，
// 主进程写盘失败（outcome='fail', canceled=false）被当成「已保存」。
// 本用例锁两件事：
//   1) 判函数本身：正常 / 取消 / 失败 / 旧形状 / 脏输入 都必须判对；
//   2) 消费点必须复用判函数，不允许再手写「只判 canceled」的副本。
// =========================================================================

const test = require('node:test')
const assert = require('node:assert')
const fs = require('node:fs')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.resolve(__dirname, '..', '..')
const CLASSIFY_SRC = path.join(ROOT, 'student-frontend/src/utils/saveResult.js')

let seq = 0
async function loadClassify() {
  // 纯函数模块零依赖，可直接在 Node 里跑；用自增序号保证每个用例独立实例
  seq += 1
  const mod = await import(pathToFileURL(CLASSIFY_SRC).href + '?case=' + seq)
  return mod.classifySaveResult
}

test('新契约三态：正常 / 取消 / 失败 各判各的', async () => {
  const classify = await loadClassify()
  assert.strictEqual(classify({ outcome: 'ok', success: true, filePath: '/x.png' }), 'ok')
  assert.strictEqual(classify({ outcome: 'canceled', success: false, canceled: true, error: null }), 'canceled')
  // 关键反例：写盘失败曾被当成取消/成功
  assert.strictEqual(classify({ outcome: 'fail', success: false, canceled: false, error: '磁盘已满' }), 'fail')
})

test('旧形状兼容：canceled / success:false / 只有 filePath', async () => {
  const classify = await loadClassify()
  assert.strictEqual(classify({ canceled: true }), 'canceled')
  assert.strictEqual(classify({ success: false, error: '写入失败' }), 'fail')
  assert.strictEqual(classify({ filePath: '/x.png' }), 'ok')
})

test('脏输入一律按失败：不能静默放行', async () => {
  const classify = await loadClassify()
  for (const bad of [null, undefined, 0, '', 'canceled', [], true]) {
    assert.strictEqual(classify(bad), 'fail', `脏输入 ${String(bad)} 应判 fail`)
  }
})

test('消费点复用统一判定，不允许只判 canceled', async () => {
  const aiChart = fs.readFileSync(path.join(ROOT, 'student-frontend/src/components/AiChart.vue'), 'utf8')
  assert.ok(/classifySaveResult/.test(aiChart), 'AiChart 必须复用统一判定')
  assert.ok(!/result\.canceled/.test(aiChart), 'AiChart 不允许再只判 result.canceled')

  const recovery = fs.readFileSync(path.join(ROOT, 'student-frontend/src/components/dialogs/RecoveryKeyDialog.vue'), 'utf8')
  assert.ok(/classifySaveResult/.test(recovery), 'RecoveryKeyDialog 必须复用统一判定')
  assert.ok(!/res\.canceled/.test(recovery), 'RecoveryKeyDialog 不允许再只判 res.canceled')

  const saveFile = fs.readFileSync(path.join(ROOT, 'student-frontend/src/utils/saveFile.js'), 'utf8')
  assert.ok(/classifySaveResult/.test(saveFile), 'saveFile 必须复用统一判定')
})
