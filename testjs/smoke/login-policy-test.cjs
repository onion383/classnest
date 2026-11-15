/**
 * login-policy-test.cjs —— 「登录保持天数」真实 HTTP 回归
 *
 * 单元测（units/auth-policy.test.js）只能证明策略函数自洽，证明不了：
 *   · 接口按**账号**存，而不是按班级 —— 切班后设置必须还在（源码判据抓不到这条，
 *     只有真的建两个班、切过去再看一眼才知道）；
 *   · POST 之后返回的 token，exp 是否真的按新天数重签（改小天数要当场生效）；
 *   · 改设置不吊销任何会话 —— 旧 token 必须继续可用（不是「顺手把全端踢下线」）。
 *
 * 跑法：node testjs/smoke/login-policy-test.cjs
 * 退出码：0 = 全部通过；1 = 有断言失败
 */
const { startIsolatedBackend } = require('./_isolated-backend.cjs')

let failed = 0
const check = (name, ok, detail) => {
  if (!ok) failed++
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : `  → ${detail}`}`)
}
const DAY_MS = 24 * 60 * 60 * 1000

// 解出 JWT payload（只看 exp，不验签 —— 这里测的是「签了多久」，不是「签得对不对」）
function jwtPayload(token) {
  try {
    return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8'))
  } catch (_) { return null }
}
// token 剩余天数（四舍五入到 0.1 天，抵消签发与断言之间的毫秒级误差）
function daysLeft(token) {
  const p = jwtPayload(token)
  if (!p || !p.exp) return NaN
  return Math.round(((p.exp * 1000 - Date.now()) / DAY_MS) * 10) / 10
}

;(async () => {
  const h = await startIsolatedBackend()
  const api = async (method, p, { token, body } = {}) => {
    const headers = {}
    if (token) headers.Authorization = `Bearer ${token}`
    if (body) headers['Content-Type'] = 'application/json'
    const r = await fetch(h.base + p, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    })
    let json = null
    try { json = await r.json() } catch (_) { /* 非 JSON 响应 */ }
    return { status: r.status, json }
  }

  try {
    // ---- 1. 注册（注册即签发登录态）----
    const reg = await api('POST', '/api/register', {
      body: { username: '保持天数甲', password: 'pw123456', role: 'teacher', level: 'password', className: '初三一班' },
    })
    check('注册成功并签发登录态', reg.status === 200 && !!reg.json?.token,
      `status=${reg.status} body=${JSON.stringify(reg.json)}`)
    const tokenA = reg.json?.token
    check('默认登录保持 30 天（与改动前行为一致）', daysLeft(tokenA) === 30, `实际 ${daysLeft(tokenA)} 天`)

    // ---- 2. 读设置 ----
    const get1 = await api('GET', '/api/account/login-policy', { token: tokenA })
    check('GET 返回当前天数与可选档位',
      get1.status === 200 && get1.json?.days === 30 && Array.isArray(get1.json?.options) && get1.json.options.includes(7),
      `status=${get1.status} body=${JSON.stringify(get1.json)}`)

    // ---- 3. 改成 7 天：当场重签 ----
    const set7 = await api('POST', '/api/account/login-policy', { token: tokenA, body: { days: 7 } })
    check('POST 改 7 天成功', set7.status === 200 && set7.json?.days === 7,
      `status=${set7.status} body=${JSON.stringify(set7.json)}`)
    const tokenB = set7.json?.token
    check('返回了一份新 token（当场重签，不是等下次登录）', !!tokenB && tokenB !== tokenA, '没有返回新 token')
    check('新 token 的有效期就是 7 天（改小要马上变严）', daysLeft(tokenB) === 7, `实际 ${daysLeft(tokenB)} 天`)
    check('同时换发了媒体凭据', !!set7.json?.mediaToken, '响应里没有 mediaToken')
    check('新 token 里 sid 不变（会话没被重建）',
      jwtPayload(tokenB)?.sid === jwtPayload(tokenA)?.sid,
      `${jwtPayload(tokenA)?.sid} vs ${jwtPayload(tokenB)?.sid}`)

    // ---- 4. 旧 token 不被吊销：改设置不把全端踢下线 ----
    const meOld = await api('GET', '/api/me', { token: tokenA })
    check('旧 token 仍然可用（改设置不吊销会话）', meOld.status === 200, `status=${meOld.status}`)

    // ---- 5. 切班后设置仍在（按账号存的关键判据）----
    const add = await api('POST', '/api/account/class', { token: tokenB, body: { className: '初三二班' } })
    check('新建第二个班成功', add.status === 200 && !!add.json?.slug, `status=${add.status}`)
    const sw = await api('POST', '/api/account/switch-class', { token: tokenB, body: { slug: add.json?.slug } })
    check('切到第二个班成功', sw.status === 200 && !!sw.json?.token, `status=${sw.status}`)
    const tokenC = sw.json?.token || tokenB
    const get2 = await api('GET', '/api/account/login-policy', { token: tokenC })
    check('切班后登录保持仍是 7 天（按账号存，不是按班级）', get2.json?.days === 7,
      `切班后读到 ${get2.json?.days} 天 —— 若为 30 说明键用错了维度（dbSlug）`)
    check('切班重签的 token 也按账号天数（7 天）', daysLeft(tokenC) === 7, `实际 ${daysLeft(tokenC)} 天`)

    // ---- 6. 参数收敛 ----
    for (const bad of [0, -1, 366, 7.5, 'abc']) {
      const r = await api('POST', '/api/account/login-policy', { token: tokenC, body: { days: bad } })
      check(`非法天数 ${JSON.stringify(bad)} 被拒（400）`, r.status === 400, `status=${r.status} body=${JSON.stringify(r.json)}`)
    }
    const get3 = await api('GET', '/api/account/login-policy', { token: tokenC })
    check('非法提交没有改动已存的设置', get3.json?.days === 7, `现在读到 ${get3.json?.days} 天`)

    // ---- 7. 改回默认，确认可逆 ----
    const set30 = await api('POST', '/api/account/login-policy', { token: tokenC, body: { days: 30 } })
    check('可以改回 30 天', set30.status === 200 && set30.json?.days === 30, `status=${set30.status}`)
    check('改回后 token 有效期也回到 30 天', daysLeft(set30.json?.token) === 30, `实际 ${daysLeft(set30.json?.token)} 天`)

    // ---- 8. 越权：没有 token 读不到 ----
    const noAuth = await api('GET', '/api/account/login-policy')
    check('未登录读不到设置（401）', noAuth.status === 401, `status=${noAuth.status}`)
  } catch (err) {
    failed++
    console.log('✗ 脚本异常：' + (err && err.stack || err))
    console.log(h.log())
  } finally {
    await h.stop()
  }

  console.log(failed ? `\n${failed} 条断言失败` : '\n全部断言通过')
  process.exit(failed ? 1 : 0)
})()
