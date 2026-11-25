// 更新包完整性校验（P1-16 / B01-12）：HTTPS + 大小 + SHA-256
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')
const fsp = fs.promises
const crypto = require('node:crypto')
const test = require('node:test')
const assert = require('node:assert/strict')

const {
  assertHttpsUrl, assertAllowedDownloadUrl, isLocalMockUrl,
  digestFromTrustManifest, resolveDigestTrust,
  sha256File, verifyDownloadedFile, pickSetupAssetName,
} = require('../../../electron/main/main.update-integrity')

const tmpDir = path.join(os.tmpdir(), 'update-integrity-' + process.pid)

test('assertHttpsUrl：只接受 https，拒绝 http/file 与非法串', () => {
  assert.ok(assertHttpsUrl('https://example.com/a.exe'))
  assert.throws(() => assertHttpsUrl('http://example.com/a.exe'), /HTTPS/)
  assert.throws(() => assertHttpsUrl('file:///C:/a.exe'), /HTTPS/)
  assert.throws(() => assertHttpsUrl('not a url'), /无效/)
  assert.throws(() => assertHttpsUrl(''), /无效/)
})

test('assertAllowedDownloadUrl：本地 mock 只放行回环 http，且必须显式允许', () => {
  assert.equal(isLocalMockUrl('http://127.0.0.1:18499/download/a.exe'), true)
  assert.equal(isLocalMockUrl('http://localhost:18499/download/a.exe'), true)
  assert.equal(isLocalMockUrl('http://192.168.1.9:18499/download/a.exe'), false, '局域网地址不放行')
  assert.equal(isLocalMockUrl('https://example.com/a.exe'), false)
  assert.equal(isLocalMockUrl('not a url'), false)

  const mockUrl = 'http://127.0.0.1:18499/download/a.exe'
  assert.ok(assertAllowedDownloadUrl(mockUrl, { allowLocalMock: true }))
  assert.throws(() => assertAllowedDownloadUrl(mockUrl), /HTTPS/, '没开 mock 时 http 必须拒')
  assert.throws(() => assertAllowedDownloadUrl('http://192.168.1.9:18499/a.exe', { allowLocalMock: true }), /HTTPS/)
  assert.ok(assertAllowedDownloadUrl('https://example.com/a.exe', { allowLocalMock: true }), 'https 恒放行')
})

test('digestFromTrustManifest：只认合法 sha256，缺版本/坏 JSON 都返回 null', () => {
  const d = 'sha256:' + 'a'.repeat(64)
  const json = JSON.stringify({ schema: 1, entries: { '0.1.0': d } })
  assert.equal(digestFromTrustManifest(json, '0.1.0'), d)
  assert.equal(digestFromTrustManifest(json, 'v0.1.0'), d, 'tag 带 v 也能取到')
  assert.equal(digestFromTrustManifest(json, '9.9.9'), null)
  assert.equal(digestFromTrustManifest('{bad', '0.1.0'), null)
  assert.equal(digestFromTrustManifest({ entries: { '0.1.0': 'sha256:xyz' } }, '0.1.0'), null)
  assert.equal(digestFromTrustManifest({ entries: [] }, '0.1.0'), null)
})

test('resolveDigestTrust：清单优先，冲突拒装，缺失降级且带告警来源', () => {
  const d = 'sha256:' + 'a'.repeat(64)
  const d2 = 'sha256:' + 'b'.repeat(64)
  assert.deepEqual(resolveDigestTrust({ manifestDigest: d, assetDigest: d }),
    { decision: 'ok', digest: d, source: 'manifest', reason: '' })
  assert.equal(resolveDigestTrust({ manifestDigest: d, assetDigest: null }).source, 'manifest', '清单有、资产无 → 仍走强校验')
  const conflict = resolveDigestTrust({ manifestDigest: d, assetDigest: d2 })
  assert.equal(conflict.decision, 'reject')
  assert.match(conflict.reason, /不一致/)
  const assetOnly = resolveDigestTrust({ manifestDigest: null, assetDigest: d })
  assert.equal(assetOnly.decision, 'warn')
  assert.equal(assetOnly.source, 'asset-only')
  const sizeOnly = resolveDigestTrust({ manifestDigest: null, assetDigest: null })
  assert.equal(sizeOnly.decision, 'warn')
  assert.equal(sizeOnly.source, 'size-only')
  assert.equal(resolveDigestTrust({ manifestDigest: 'sha256:bad', assetDigest: d }).source, 'asset-only', '清单格式非法按缺失处理')
})

test('verifyDownloadedFile：大小与 sha256 校验，缺 digest 时降级为仅大小校验', async () => {
  await fsp.mkdir(tmpDir, { recursive: true })
  const file = path.join(tmpDir, 'setup.exe')
  const data = Buffer.from('fake-installer-bytes')
  await fsp.writeFile(file, data)
  const digest = 'sha256:' + crypto.createHash('sha256').update(data).digest('hex')
  const size = data.length

  // 返回值多了一个 sha256 字段：它是**本次实际算出的**文件哈希，
  // 供 updater.js 留作「安装前复核」的凭据（防止下载后本地被替换的 TOCTOU）。
  assert.deepEqual(
    await verifyDownloadedFile({ filePath: file, expectedSize: size, digest }),
    { ok: true, verified: 'sha256', sha256: digest.slice('sha256:'.length) }
  )
  assert.equal((await verifyDownloadedFile({ filePath: file, expectedSize: size + 1 })).ok, false)

  const bad = await verifyDownloadedFile({ filePath: file, expectedSize: size, digest: 'sha256:' + '0'.repeat(64) })
  assert.equal(bad.ok, false)
  assert.match(bad.error, /SHA-256/)

  // 无 digest 时降级为仅大小校验，但**仍要算出本地哈希** ——
  // 否则 size-only 这条路就失去了「安装前复核」的能力（等于回到只查 existsSync 的老问题）。
  assert.deepEqual(
    await verifyDownloadedFile({ filePath: file, expectedSize: size, digest: '' }),
    { ok: true, verified: 'size-only', sha256: digest.slice('sha256:'.length) }
  )
  assert.equal(await sha256File(file), digest.slice('sha256:'.length))

  await fsp.rm(tmpDir, { recursive: true, force: true })
})

// 安装前的复核凭据（审查 v4 · B01-03 后半句：安装前不复核 sha256 → TOCTOU）
// 场景：下载时校验通过 → 之后文件被本地替换 → 安装前必须能发现。
test('安装前复核：下载时记下的哈希能识别出「下载后被替换」的文件', async () => {
  await fsp.mkdir(tmpDir, { recursive: true })
  const file = path.join(tmpDir, 'setup.exe')
  const original = Buffer.from('original-installer-bytes')
  await fsp.writeFile(file, original)

  // 下载阶段：校验通过，记下哈希
  const verified = await verifyDownloadedFile({
    filePath: file,
    expectedSize: original.length,
    digest: 'sha256:' + crypto.createHash('sha256').update(original).digest('hex'),
  })
  assert.equal(verified.ok, true)
  const recorded = verified.sha256
  assert.equal(recorded, crypto.createHash('sha256').update(original).digest('hex'))

  // 之后文件被换成另一个内容（长度相同，避免被大小校验先挡下）
  // 长度用 Buffer.byteLength 实算，别手数字符（这次就是手写长度写错挂的）
  const tampered = Buffer.alloc(original.length, 0x41)
  assert.equal(tampered.length, original.length)
  assert.notDeepEqual(tampered, original)
  await fsp.writeFile(file, tampered)

  // 安装前复核：哈希必须对不上 → 拒绝安装
  const recheck = await sha256File(file)
  assert.notEqual(recheck, recorded, '被替换的安装包必须与下载时记下的哈希不一致')

  await fsp.rm(tmpDir, { recursive: true, force: true })
})

// ==================== 资产挑选：别把正式版用户升级到 Vue 3.6 预览版 ====================
// 背景：release 里同时挂 ClassNest-Setup-x.exe 与 ClassNest-Vue36-Setup-x.exe，
// 两者都命中 /setup.*\.exe$/。只取「第一个」会随 GitHub 返回顺序漂移，可能选中预览包。
test('pickSetupAssetName：预览包排在前面也不选；只剩预览包时宁可返回 null', () => {
  assert.equal(
    pickSetupAssetName(['ClassNest-Vue36-Setup-0.1.0.exe', 'ClassNest-Setup-0.1.0.exe']),
    'ClassNest-Setup-0.1.0.exe',
    '必须跳过预览包，不能靠资产顺序',
  )
  assert.equal(
    pickSetupAssetName(['ClassNest-Setup-0.1.0.exe.sha256', 'ClassNest-Setup-0.1.0.exe']),
    'ClassNest-Setup-0.1.0.exe',
    '.sha256 不是安装包',
  )
  assert.equal(
    pickSetupAssetName(['ClassNest-Vue36-Setup-0.1.0.exe']),
    null,
    '只有预览包时应放弃更新，而不是装一个写着「仅供体验」的版本',
  )
  assert.equal(pickSetupAssetName(['ClassNest-Portable-0.1.0-win-x64.zip', 'x.txt']), null)
  assert.equal(pickSetupAssetName([]), null)
  assert.equal(pickSetupAssetName(null), null)
})
