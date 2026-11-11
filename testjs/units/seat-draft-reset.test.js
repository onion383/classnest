// =========================================================================
// seat-draft-reset.test.js —— 排表草稿的模块级单例跟着账号走（X2-07）
//
// 事故：`useSeatDraft` 的 draft 是**模块级单例**（所有调用者共用一份），登出/换号时
// 既没人清它、在途的 GET 回来还会把它写满 —— B 登录后打开智能排表，看到的是 A 的草稿。
// 草稿本身在库里按账号隔离，泄漏只发生在这一层内存副本。
//
// 判据：① 换号（resetUserScopedCaches）后草稿归零
//       ② 在途的 fetchDraft 在换号后才返回 → 一个字都不许写进草稿
//       ③ 正常拉取仍然工作（别把功能修死）
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { pathToFileURL } = require('node:url')

const ROOT = path.join(__dirname, '../..')
const DRAFT = pathToFileURL(path.join(ROOT, 'student-frontend/src/composables/useSeatDraft.js')).href
const SCOPED = pathToFileURL(path.join(ROOT, 'student-frontend/src/utils/userScopedCache.js')).href
// 必须用 useSeatDraft 解析到的**同一个** axios 实例（axios 是 ESM 包，CJS require 会是另一份）
const AXIOS = pathToFileURL(path.join(ROOT, 'student-frontend/node_modules/axios/index.js')).href

const draftBody = {
  exists: true, rows: 3, cols: 4, mode: 'single',
  types: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]],
  seats: [[1, null, null, null], [null, null, null, null], [null, null, null, null]],
  conditions: [{ uid: 1 }], savedAt: '2026-11-11 10:00:00',
}

async function setup() {
  const axios = (await import(AXIOS)).default
  const origGet = axios.get
  const { useSeatDraft } = await import(DRAFT)
  const scoped = await import(SCOPED)
  return { axios, origGet, api: useSeatDraft(), scoped }
}

test('正常拉取：草稿被填上', async () => {
  const { axios, origGet, api } = await setup()
  axios.get = async () => ({ data: draftBody })
  try {
    await api.fetchDraft()
    assert.equal(api.draft.exists, true)
    assert.equal(api.draft.rows, 3)
    assert.equal(api.draft.loaded, true)
  } finally { axios.get = origGet }
})

test('换号：草稿归零（B 看不到 A 的排表草稿）', async () => {
  const { axios, origGet, api, scoped } = await setup()
  axios.get = async () => ({ data: draftBody })
  try { await api.fetchDraft() } finally { axios.get = origGet }

  scoped.resetUserScopedCaches()   // 登出/换号统一入口
  assert.equal(api.draft.exists, false, '换号后不能还标着「有草稿」')
  assert.deepEqual(api.draft.seats, [])
  assert.deepEqual(api.draft.conditions, [])
  assert.equal(api.draft.loaded, false, 'loaded 也要归零，否则 App 不会再拉')
  assert.equal(api.draft.rows, 6, '回到初始几何')
  assert.equal(api.draft.cols, 7)
})

test('在途拉取在换号后才返回：一个字都不许写进草稿', async () => {
  const { axios, origGet, api, scoped } = await setup()
  let release
  const gate = new Promise((r) => { release = r })
  axios.get = async () => { await gate; return { data: draftBody } }
  try {
    const pending = api.fetchDraft()   // ① A 账号发起
    scoped.resetUserScopedCaches()     // ② 期间换号
    release()                          // ③ A 的响应回来
    await pending
    assert.equal(api.draft.exists, false, '旧响应不能把 B 的草稿标成「存在」')
    assert.deepEqual(api.draft.seats, [], '旧响应不能把 A 的座位写回来')
    assert.equal(api.draft.loaded, false, '旧响应也不能把 loaded 置 true（否则不再重拉）')
  } finally { axios.get = origGet }
})

test('换号后重新拉：拿到的是新账号的草稿', async () => {
  const { axios, origGet, api, scoped } = await setup()
  axios.get = async () => ({ data: { ...draftBody, rows: 5, seats: [] } })
  try {
    scoped.resetUserScopedCaches()
    await api.fetchDraft()
    assert.equal(api.draft.rows, 5, '新代次的请求必须能正常写入')
  } finally { axios.get = origGet }
})
