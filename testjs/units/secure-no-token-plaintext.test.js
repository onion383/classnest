// =========================================================================
// secure-no-token-plaintext.test.js —— 无登录态请求必须走明文（0da1458 回归）
//
// 原缺陷：secure-write-proof 给安全信道加了「加密写请求必须带 X-Auth-Proof」门禁，
// 其前提是「登录/注册是明文请求，requestDecrypt 不会设 sessionId」。但前端
// secureAxios 的加密拦截器无条件 encryptBody()，无 token 时也把 body 封成
// { session, d } —— 后端据此置上 req.sessionId，随后 requestAuthProof 判
// 「写请求缺少安全凭据」→ 401。而没 token 时 applyAuthHeader 首行就 return，
// 生成不出凭据，重试同样 401。
//
// 症状：登录页的公开写接口全部 401 —— /api/login、/api/register、/api/db-login、
// /api/db-recover、/api/recover-password、restore-zip-offline。其中「忘记密码 →
// 本机恢复」最致命：恢复的用途本就是「没有登录态」，被这道门禁锁死成死循环。
//
// 修法（不动后端门禁，防护不打折）：
//   httpClient 凭据拦截器  → 每次请求重算 config.__noToken = !token
//   secureAxios 加密拦截器  → __noToken 时早退，不加密请求体
// 两处必须同时存在且顺序正确：光有标记不早退 = 照旧加密；光早退不标记 = 永远不加密
// （全站失去保密性）。所以下面既有正向接线，也有各自的变异反证。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const ROOT = path.join(__dirname, '../..')
const HTTP = path.join(ROOT, 'student-frontend/src/utils/httpClient.js')
const SECURE = path.join(ROOT, 'student-frontend/src/composables/secureAxios.js')

// 去掉注释再匹配：注释里也写着 __noToken 这几个字，不去掉会让「删掉代码仍 PASS」。
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '')
}
function read(p) { return stripComments(fs.readFileSync(p, 'utf8')) }

// 取「凭据拦截器」体内的一段：从 getToken 取到 applyAuthHeader 之前。
function credentialBlock(src) {
  const start = src.indexOf('const token = await getToken()')
  // 不能用 'applyAuthHeader' 定位：文件第 3 行的 import 语句就含有这个词，会切出一个空段
  const end = src.indexOf('await applyAuthHeader(')
  assert.ok(start > 0 && end > start, '找不到凭据拦截器的 getToken → applyAuthHeader 段')
  return src.slice(start, end)
}
// 取「加密拦截器」体内的一段：从 __retrySecure 早退到 encryptBody 调用。
// 取「加密拦截器」体内的一段：从 __retrySecure 早退到 encryptBody 调用（含调用本身，
// 因为下面要断言早退排在它之前 —— 截到调用前面会让 encryptAt 恒为 -1）。
function encryptBlock(src) {
  const start = src.indexOf('if (config.__retrySecure === true) return config')
  const marker = 'await encryptBody(d'
  const hit = src.indexOf(marker)
  assert.ok(start > 0 && hit > start, '找不到加密拦截器的 __retrySecure → encryptBody 段')
  return src.slice(start, hit + marker.length)
}

// ————————————————————————— ① 接线：两处都在位 —————————————————————————

test('接线：凭据拦截器在 !token 时把 config.__noToken 置为 true', () => {
  const block = credentialBlock(read(HTTP))
  assert.match(block, /config\.__noToken\s*=\s*!token/,
    '没给无登录态的请求打标 → 加密拦截器无从判断')
  const markAt = block.search(/config\.__noToken\s*=\s*!token/)
  const earlyAt = block.search(/if \(!token\) return config/)
  assert.ok(markAt >= 0 && earlyAt > markAt,
    '__noToken 必须在 `if (!token) return config` 之前赋值 —— 放到后面永远执行不到')
})

test('接线：加密拦截器在 __noToken 时早退，且发生在 encryptBody 之前', () => {
  const block = encryptBlock(read(SECURE))
  assert.match(block, /if \(config\.__noToken === true\) return config/,
    '加密拦截器没有 __noToken 早退 → 无 token 的写请求仍会被加密成 { session, d }')
  const skipAt = block.search(/config\.__noToken === true/)
  const encryptAt = block.search(/await encryptBody\(/)
  assert.ok(skipAt >= 0 && encryptAt > skipAt,
    '__noToken 早退必须排在 encryptBody 调用之前')
})

test('接线：早退不能顺手把重试信封 / FormData 的既有豁免删掉', () => {
  const block = encryptBlock(read(SECURE))
  assert.match(block, /__retrySecure === true/, '__retrySecure 早退被删了（会二次封装密文）')
  const src = read(SECURE)
  assert.match(src, /d instanceof FormData/, 'FormData 直通的判定被删了')
})

// ————————————————————————— ② 变异反证 —————————————————————————

test('变异：去掉加密拦截器的 __noToken 早退后，判据必须失败', () => {
  const src = read(SECURE)
  const block = encryptBlock(src)
  const mutated = block.replace(/if \(config\.__noToken === true\) return config/, '/*MUTATED*/')
  assert.ok(mutated !== block, '变异没匹配到早退语句')
  assert.ok(!/__noToken === true/.test(mutated),
    '变异后应不再有早退 —— 判据（要求匹配早退且排在 encryptBody 前）此时应判失败')
})

test('变异：把 __noToken 赋值挪到 `!token` 早退之后，判据必须失败', () => {
  const src = read(HTTP)
  const block = credentialBlock(src)
  // 模拟「先 return 再赋值」：把赋值行删掉，等价于执行不到。
  // 收尾用 \s* 而不是 \n：仓库文件是 CRLF，只匹配 \n 会在 \r 处失配（变异落空 → 假绿）。
  const mutated = block.replace(/config\.__noToken\s*=\s*!token\s*/, '')
  assert.ok(mutated !== block, '变异没匹配到 __noToken 赋值')
  const markAt = mutated.search(/config\.__noToken\s*=\s*!token/)
  assert.equal(markAt, -1, '变异后不该再匹配到赋值 —— 判据应判失败')
})

test('变异：把 __noToken 改成恒 false（等于只打标不生效）必须被判据抓到', () => {
  const src = read(HTTP)
  const block = credentialBlock(src)
  const mutated = block.replace(/config\.__noToken\s*=\s*!token/, 'config.__noToken = false')
  assert.ok(mutated !== block, '变异没匹配到赋值表达式')
  assert.doesNotMatch(mutated, /config\.__noToken\s*=\s*!token/,
    '恒 false 后无 token 也不跳过加密 —— 判据应判失败')
})
