// 本机信息恢复（忘记密码）的请求层：登录页的「忘记密码」与设置页「修改密码 → 忘记密码」共用。
//
// 为什么必须单一来源：后端 /api/db-recover 会按账号安全等级分流（password 档签 recover 态只授权改密，
// plain / nopass 直接签常规 token）。前端如果各写一份，两边很快会分叉成「一处处理了 mustChangePassword、
// 另一处没有」，症状就是某一侧卡在设置新密码那屏、或拿着 recover token 去调业务接口被 401。
//
// 这里只做「请求 + 落 token」，不知道调用方是谁：
//   · 登录页恢复成功要 setCurrentUser + 跳首页；
//   · 设置页恢复成功只要关弹窗 + 提示。
// 收尾由调用方决定，所以不把 router / store 引进来。
import axios from 'axios'
import { setToken } from './authStorage.js'
import { storeMediaToken } from './apiUrl.js'

// 本机可恢复的账号（隐私库不列：没有主密钥包裹，本机恢复不适用）
export async function fetchLocalAccounts() {
  const res = await axios.get('/api/accounts')
  const list = (res.data && res.data.accounts) || []
  return list.filter((a) => !a.protect)
}

// 用本机数据库文件恢复登录态。
// file 传 `<slug>.db`；已登录场景再传 username，让后端确认恢复的确实是这个账号
// （库里如果不止一个账号，不校验就可能把登录态签给库里第一个账号）。
// 返回后端响应：{ mustChangePassword, securityLevel, user, token, mediaToken }
export async function recoverFromLocalDb({ file, username }) {
  const payload = { file }
  if (username) payload.username = username
  const res = await axios.post('/api/db-recover', payload)
  const data = res.data || {}
  setToken(data.token)
  storeMediaToken(data.mediaToken)
  return data
}

// 恢复态下设置新密码：后端会吊销旧会话并换发不含 recover 标记的常规 token。
export async function submitRecoveredPassword(newPassword) {
  const res = await axios.put('/api/account/password', { newPassword })
  const data = res.data || {}
  if (data.token) {
    setToken(data.token)
    storeMediaToken(data.mediaToken)
  }
  return data
}
