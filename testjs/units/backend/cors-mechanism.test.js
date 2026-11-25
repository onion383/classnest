// =========================================================================
// cors-mechanism.test.js —— CORS 白名单 + 暴露头：固定机制，不固定源码写法
//
// WATCH: student-backend/app.js
//
// 从 app.js 用 AST 抽真实的 CORS_ORIGIN_RE / corsOriginAllowed / cors 选项，
// 喂给产品自己的 cors+express 跑真请求。断言的是「白名单来源能读到 X-Photo-Id、
// 黑名单来源被拒」这个机制，而不是源码里有没有某串正则 —— 重构格式不该让它红，
// 真的把头从 exposedHeaders 删掉、或误信了 null 来源，必须让它红。
//
// 文本形态的旧判据仍在 cors-origin-null.test.js（那条还额外真跑了判定函数的边界），
// 两者互补：那条盯边界值，这条盯端到端响应头。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const { read, extractAppCors, startCorsProbe } = require('#testjs/units/_mechanism.cjs')

const appSrc = read('student-backend/app.js')
const { options, corsOriginAllowed } = extractAppCors(appSrc)

test('真跑 cors：白名单来源拿到 X-Photo-Id 暴露头，黑名单来源拿不到', async () => {
  const probe = await startCorsProbe(options)
  try {
    const good = await probe.request('app://local')
    assert.equal(good.status, 200)
    const exposed = good.headers.get('access-control-expose-headers') || ''
    assert.match(exposed, /X-Photo-Id/, '首页要能从缩略图响应头读 id 才能定位到相册那一张')

    const loopback = await probe.request('http://127.0.0.1:8123')
    assert.equal(loopback.status, 200)
    assert.match(loopback.headers.get('access-control-expose-headers') || '', /X-Photo-Id/,
      '本机回环是合法来源，也要能读到暴露头')

    const evil = await probe.request('https://evil.example.com')
    assert.equal(evil.headers.get('access-control-allow-origin'), null,
      '外部站点不能被回显为允许来源')
    assert.equal(evil.headers.get('access-control-expose-headers'), null,
      '外部站点不该拿到任何暴露头')
  } finally {
    await probe.close()
  }
})

test('真跑判定函数：null / file:// 拒绝，无 Origin 与 app:// / 回环放行', () => {
  for (const bad of ['null', 'file:///C:/secret.html', 'https://localhost.evil.com']) {
    assert.equal(corsOriginAllowed(bad), false, `${bad} 必须拒绝`)
  }
  for (const good of [undefined, '', 'app://local/index.html', 'http://localhost:5173', 'http://[::1]:9000']) {
    assert.equal(corsOriginAllowed(good), true, `${String(good)} 应当放行`)
  }
})

test('机制提取对格式不敏感：注释/空白/引号变化不改变行为', () => {
  // 变异反证的正面：把选项对象格式化（空白、注释、引号全改），抽出的机制行为应完全一致。
  const reflowed = appSrc
    .replace('exposedHeaders:', '  exposedHeaders  :')
    .replace("'X-Photo-Id'", '"X-Photo-Id"')
    .replace('credentials: true,', 'credentials:true, // 改为紧凑写法')
  const { options: reflowedOptions, corsOriginAllowed: reflowedAllowed } = extractAppCors(reflowed)
  assert.deepEqual(reflowedOptions.exposedHeaders, options.exposedHeaders)
  assert.equal(reflowedAllowed('app://local'), corsOriginAllowed('app://local'))
  assert.equal(reflowedAllowed('null'), corsOriginAllowed('null'))
})
