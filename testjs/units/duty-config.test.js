// =========================================================================
// duty-config.test.js —— 值日「列名按模式 + 时间设置」的后端单元测试
//
// 背景：值日表原本只有一份全局「星期列表」，大扫除和日常值日共用。
// 改成按模式分键后（daily=星期几 / big=分组名+全部），有三个高风险点：
//   1. 读写不对称：读走 dutyConfig.readDays，写走 dutyConfig.writeDays，
//      若其中一个漏了另一个，同一份数据会被解释成不同结构。
//   2. 「全部」列是内置的：写时补、读时在，但不能重复出现。
//   3. 周期命中日：一个月的口径是 4 周，第 N 周的算法决定命中哪天。
// 判据直接跑真实源码（require 后端模块），不复制逻辑 ——
// 复制逻辑的测试在源码改坏时照样通过，是假绿。
// =========================================================================
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const test = require('node:test')
const assert = require('node:assert/strict')

// slotStore / db 需要主密钥与数据目录，先注入测试环境变量
const tmpDir = path.join(os.tmpdir(), 'duty-config-unit-' + process.pid)
fs.rmSync(tmpDir, { recursive: true, force: true })
process.env.DB_MASTER_KEY = process.env.DB_MASTER_KEY || 'unit-test-master-key'
process.env.DATA_DIR = process.env.DATA_DIR || tmpDir

const ROOT = path.resolve(__dirname, '../..')

const dbManager = require('../../student-backend/dbManager/dbManager')
const { db } = require('../../student-backend/db')
const dutyConfig = require('../../student-backend/services/dutyConfig')
const dutyCycle = require('../../student-backend/services/dutyCycle')
const { mondayOf } = require('../../student-backend/utils/date')

// 每个测试用**独立的库**：值日设置是全局单例，共享一个库会让前一个测试的写入
// 泄漏到后一个（列名/配置都会被覆盖），断言就会互相干扰。
let seq = 0
function freshDb() {
  dbManager.ensureIndex()
  const { slug } = dbManager.createTeacher('duty-config-unit', 'x', 'teacher', false)
  seq++
  return slug
}

// 在指定库里跑一段逻辑（dutyConfig 走 db Proxy → dbManager.current()）
function inDb(slug, fn) {
  return dbManager.withDb(slug, fn)
}

// 建一个干净的库并跑逻辑，返回逻辑的返回值
function withFresh(fn) {
  const slug = freshDb()
  try {
    return inDb(slug, fn)
  } finally {
    try { dbManager.deleteTeacher(slug) } catch (_) { /* 清理失败不影响断言 */ }
  }
}

// =========================================================================
// 存储结构
// =========================================================================

test('新库播种：days 按模式分键，settings 是模式配置', () => {
  withFresh(() => {
    const row = db.prepare("SELECT days, items, settings FROM duty_slots WHERE kind = 'settings'").get()
    const days = JSON.parse(row.days)
    assert.ok(Array.isArray(days.daily), 'days.daily 应是数组')
    assert.ok(Array.isArray(days.big), 'days.big 应是数组')
    assert.equal(days.daily.length, 5)
    assert.deepEqual(days.daily, ['周一', '周二', '周三', '周四', '周五'])
    // 大扫除的列名是派生的 → 不落库（只存「任务分组 + 数量」）
    assert.deepEqual(days.big, [], 'days.big 不应存列名（列名由配置派生）')
    const settings = JSON.parse(row.settings)
    assert.ok(settings.daily && typeof settings.daily === 'object', 'settings.daily 应是对象')
    assert.ok(settings.big && typeof settings.big === 'object', 'settings.big 应是对象')
    assert.equal(settings.big.groupType, 'big')
    assert.equal(settings.big.groupCount, 3)
  })
})

test('列名读写往返：daily 与 big 互不干扰', () => {
  withFresh(() => {
    dutyConfig.writeDays('daily', ['周一', '周二', '周三'])
    assert.deepEqual(dutyConfig.readDays('daily'), ['周一', '周二', '周三'])
    // 再写 daily 不能动 big
    dutyConfig.writeDays('daily', ['周一', '周五'])
    assert.deepEqual(dutyConfig.readDays('daily'), ['周一', '周五'])
  })
})

test('大扫除的列名由「任务分组 + 数量」派生（不落库）', () => {
  withFresh(() => {
    dutyConfig.writeConfig('big', { cycle: 'week', weekday: '周三', groupType: 'big', groupCount: 2 })
    assert.deepEqual(dutyConfig.readDays('big'), ['第1大组', '第2大组', '全部'])
    // 换成分组类型 → 列名跟着变
    dutyConfig.writeConfig('big', { cycle: 'week', weekday: '周三', groupType: 'small', groupCount: 2 })
    assert.deepEqual(dutyConfig.readDays('big'), ['第1小组', '第2小组', '全部'])
    // 改数量 → 列名跟着变
    dutyConfig.writeConfig('big', { cycle: 'week', weekday: '周三', groupType: 'big', groupCount: 4 })
    assert.deepEqual(dutyConfig.readDays('big'), ['第1大组', '第2大组', '第3大组', '第4大组', '全部'])
  })
})

test('大扫除的列名不落库（writeDays 对 big 是空操作）', () => {
  withFresh(() => {
    dutyConfig.writeConfig('big', { cycle: 'week', weekday: '周三', groupType: 'big', groupCount: 2 })
    dutyConfig.writeDays('big', ['伪造的列', '另一列'])
    // 写进去的列名不能影响读出来的（列名只由配置派生）
    assert.deepEqual(dutyConfig.readDays('big'), ['第1大组', '第2大组', '全部'])
    const row = db.prepare("SELECT days FROM duty_slots WHERE kind = 'settings'").get()
    assert.deepEqual(JSON.parse(row.days).big, [], 'days.big 不应存列名')
  })
})

test('组数为 0 时只有「全部」列', () => {
  withFresh(() => {
    dutyConfig.writeConfig('big', { cycle: 'week', weekday: '周三', groupType: 'big', groupCount: 0 })
    assert.deepEqual(dutyConfig.readDays('big'), ['全部'])
  })
})

test('组数超上限时被截断（防手滑输 999 造出 1000 列）', () => {
  withFresh(() => {
    dutyConfig.writeConfig('big', { cycle: 'week', weekday: '周三', groupType: 'big', groupCount: 999 })
    assert.equal(dutyConfig.readDays('big').length, 31) // 30 组 + 全部
  })
})

test('列名清洗：去空白 / 去重 / 去空项', () => {
  withFresh(() => {
    dutyConfig.writeDays('daily', [' 周一 ', '周二', '周一', '', '  '])
    assert.deepEqual(dutyConfig.readDays('daily'), ['周一', '周二'])
  })
})

test('非法列名（非字符串）不会把库写坏', () => {
  withFresh(() => {
    dutyConfig.writeDays('daily', [null, undefined, 123, '周一'])
    assert.deepEqual(dutyConfig.readDays('daily'), ['123', '周一'])
  })
})

test('模式配置读写：cycle / weekday / 任务分组 / 数量', () => {
  withFresh(() => {
    dutyConfig.writeConfig('big', { cycle: 'month', weekday: '周三', groupType: 'small', groupCount: 7 })
    const c = dutyConfig.readConfig('big')
    assert.equal(c.cycle, 'month')
    assert.equal(c.weekday, '周三')
    assert.equal(c.groupType, 'small')
    assert.equal(c.groupCount, 7)
    // daily 模式没有模式配置
    assert.deepEqual(dutyConfig.readConfig('daily'), {})
  })
})

test('非法模式配置退回默认值（不能把库写坏）', () => {
  withFresh(() => {
    dutyConfig.writeConfig('big', {
      cycle: '不存在的周期', weekday: '礼拜八', groupType: '不存在的分组', groupCount: -5,
    })
    const c = dutyConfig.readConfig('big')
    assert.equal(c.cycle, 'week')
    assert.equal(c.weekday, '周三')
    assert.equal(c.groupType, 'big')
    assert.ok(c.groupCount >= 0, '组数不能是负数')
  })
})

// =========================================================================
// 周期命中日
// =========================================================================

test('一周：每周的该星期几都命中', () => {
  const base = mondayOf('2026-03-02') // 周一
  const cfg = { cycle: 'week', weekday: '周三' }
  assert.equal(dutyCycle.isHitDate('2026-03-04', cfg, base), true)  // 第 1 周周三
  assert.equal(dutyCycle.isHitDate('2026-03-11', cfg, base), true)  // 第 2 周周三
  assert.equal(dutyCycle.isHitDate('2026-03-18', cfg, base), true)  // 第 3 周周三
  assert.equal(dutyCycle.isHitDate('2026-03-05', cfg, base), false) // 周四
})

test('两周：第 1、3、5… 周命中', () => {
  const base = mondayOf('2026-03-02')
  const cfg = { cycle: 'biweek', weekday: '周三' }
  assert.equal(dutyCycle.isHitDate('2026-03-04', cfg, base), true)   // 第 1 周
  assert.equal(dutyCycle.isHitDate('2026-03-11', cfg, base), false)  // 第 2 周
  assert.equal(dutyCycle.isHitDate('2026-03-18', cfg, base), true)   // 第 3 周
  assert.equal(dutyCycle.isHitDate('2026-03-25', cfg, base), false)  // 第 4 周
  assert.equal(dutyCycle.isHitDate('2026-04-01', cfg, base), true)   // 第 5 周
})

test('一个月：每 4 周命中（第 1、5、9… 周）', () => {
  const base = mondayOf('2026-03-02')
  const cfg = { cycle: 'month', weekday: '周三' }
  assert.equal(dutyCycle.isHitDate('2026-03-04', cfg, base), true)   // 第 1 周
  assert.equal(dutyCycle.isHitDate('2026-03-18', cfg, base), false)  // 第 3 周
  assert.equal(dutyCycle.isHitDate('2026-04-01', cfg, base), true)   // 第 5 周
  assert.equal(dutyCycle.isHitDate('2026-04-29', cfg, base), true)   // 第 9 周
})

test('基准周之前的日期不命中', () => {
  const base = mondayOf('2026-03-02')
  const cfg = { cycle: 'week', weekday: '周三' }
  assert.equal(dutyCycle.isHitDate('2026-02-25', cfg, base), false)
})

test('非法日期 / 缺基准周一：不命中（不抛错）', () => {
  const cfg = { cycle: 'week', weekday: '周三' }
  assert.equal(dutyCycle.isHitDate('不是日期', cfg, mondayOf('2026-03-02')), false)
  assert.equal(dutyCycle.isHitDate('2026-03-04', cfg, ''), false)
})

test('hitDatesBetween 返回区间内的全部命中日（升序）', () => {
  const base = mondayOf('2026-03-02')
  const cfg = { cycle: 'biweek', weekday: '周三' }
  const list = dutyCycle.hitDatesBetween('2026-03-01', '2026-04-30', cfg, base)
  assert.deepEqual(list, ['2026-03-04', '2026-03-18', '2026-04-01', '2026-04-15', '2026-04-29'])
})

test('weekIndexOf：基准周是第 1 周，往后每 7 天加一', () => {
  const base = mondayOf('2026-03-02')
  assert.equal(dutyCycle.weekIndexOf('2026-03-02', base), 1)
  assert.equal(dutyCycle.weekIndexOf('2026-03-09', base), 2)
  assert.equal(dutyCycle.weekIndexOf('2026-03-04', base), 1) // 周三属于基准周
  assert.equal(dutyCycle.weekIndexOf('2026-02-23', base), 0) // 基准之前
})
