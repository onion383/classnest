import axios from 'axios'

// 撤销/重做域的统一接口层。收拢散落在各页面的 /api/undo* 调用，避免接口 URL 到处重拼。
// 必须走全局 axios 实例：secureAxios 对全局实例打了补丁做请求加密/响应解密，
// 换用其它实例会绕过安全通道。
// 各函数直接返回 axios 响应（Promise），便于调用方继续 .then/.catch 或解构 { data }。

// 登记一条撤销记录：body 结构由后端按 type 解析（cell_update / grid_cell / grid_snapshot /
// row_insert / row_delete / row_update / group_snapshot / album_* 等）
export function pushUndo(body) {
  return axios.post('/api/undo', body)
}

// 按批次整批撤销/重做（origin 为一次动作的批次标识）。
// 与 undoById 的区别：批次里可能有多条记录，一次调用全部回退。
export function undoBatch(origin) {
  return axios.post(`/api/undo/origin/${encodeURIComponent(origin)}/undo`)
}

export function redoBatch(origin) {
  return axios.post(`/api/undo/origin/${encodeURIComponent(origin)}/redo`)
}

// 拉取全部撤销记录（设置页「更改审查」列表，按表分组返回）
export function listUndo() {
  return axios.get('/api/undo')
}

// 某张表里「现在还撤得动吗」：只返回失效的那几条（id → 原因）。
// 与列表分开取：列表本身不做任何数据比对，先回来把面板铺开；
// 失效要读值日/座位/行数据逐条比，只算当前正在看的那张表。
export function listUndoStale(key) {
  return axios.get('/api/undo/stale', { params: { key } })
}

// 按记录 id 撤销一条（行类记录会先比对该行快照：这行后来又被改过就拒绝）
export function undoById(id) {
  return axios.post(`/api/undo/${id}/undo`)
}

// 按记录 id 重做一条
export function redoById(id) {
  return axios.post(`/api/undo/${id}/redo`)
}

// 只撤这一条（跳过它后面的记录）：仅限「格子级」记录（值日/座位单格、动态表单字段）。
// 与 undoById 的区别：undoById 是底层翻一条、不做冲突判定；这条带判据 ——
// 这一格后来又被改过就拒绝（否则会把手改无声吞掉），整块快照类型也一律拒绝。
export function undoOnly(id) {
  return axios.post(`/api/undo/${id}/only`)
}

// 回退到这条记录之前 / 重做到这条（全局时间线，跨表跨来源整批原子）。
// 与 undoById/redoById 的区别：后者只翻单条；这两个退/进「这条及其后/前」的全部改动，
// 后端用 SAVEPOINT 包住整批，中途失败整批回滚。
export function rewindTo(id) {
  return axios.post(`/api/undo/${id}/rewind`)
}

export function replayTo(id) {
  return axios.post(`/api/undo/${id}/replay`)
}

// 清空撤销记录；key 默认 'all'（清空全部表）
export function clearUndo(key = 'all') {
  return axios.delete('/api/undo', { params: { key } })
}

// 查询某张表的撤销可用态（canUndo/canRedo + 标签）
export function undoStatus(key) {
  return axios.get(`/api/undo/table/${encodeURIComponent(key)}/status`)
}

// 对某张表执行撤销/重做（redo=true 为重做）
// 按 key 撤销/重做最近一步（Ctrl+Z / Ctrl+Shift+Z 走这里）。
// skip：已确认失效的记录（ids / origins），后端会跳过它们继续往前找 ——
// 只在用户「再按一次」后才传，第一次撞上失效要先让他看到原因。
export function applyUndo(key, redo = false, skip = null) {
  const body = skip && (skip.ids?.size || skip.origins?.size)
    ? { skipIds: [...skip.ids], skipOrigins: [...skip.origins] }
    : undefined
  return axios.post(`/api/undo/table/${encodeURIComponent(key)}/${redo ? 'redo' : 'undo'}`, body)
}
