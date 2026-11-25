// =========================================================================
// mock-update-server.test.js —— 本地 mock Release 判据
//
// 真启动服务、真发 HTTP 请求、真算哈希；并用产品侧的 pickSetupAssetName
// 验证「预览包排在前面也不会被选中」在 mock 场景同样成立。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const http = require('node:http')
const crypto = require('node:crypto')

const { createMockUpdateServer } = require('../../tools/mock-update-server.cjs')
const { pickSetupAssetName, resolveDigestTrust } = require('../../../electron/main/main.update-integrity')

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks) }))
    }).on('error', reject)
  })
}

test('release：正式包 + 预览包都返回，产品侧挑选逻辑选中正式包', async () => {
  const mock = createMockUpdateServer({ port: 0 })
  const origin = await mock.listen()
  try {
    const res = await get(origin + '/releases/latest')
    assert.equal(res.status, 200)
    const release = JSON.parse(res.body.toString())
    assert.equal(release.tag_name, 'v99.0.0')
    const names = release.assets.map((a) => a.name)
    assert.deepEqual(names, [mock.previewName, mock.installerName], '预览包故意排前面')
    assert.equal(pickSetupAssetName(names), mock.installerName)
    assert.equal(release.assets[1].size, mock.installer.length)
    assert.match(release.assets[1].browser_download_url, /^http:\/\/127\.0\.0\.1:\d+\/download\//)
  } finally {
    await mock.close()
  }
})

test('下载：内容哈希与发布资产 digest 一致，且是可被校验的 HTTPS 之外回环地址', async () => {
  const mock = createMockUpdateServer({ port: 0 })
  const origin = await mock.listen()
  try {
    const release = JSON.parse((await get(origin + '/releases/latest')).body.toString())
    const asset = release.assets.find((a) => a.name === mock.installerName)
    assert.ok(asset.digest && asset.digest.startsWith('sha256:'))
    const downloaded = await get(asset.browser_download_url)
    assert.equal(downloaded.status, 200)
    const actual = 'sha256:' + crypto.createHash('sha256').update(downloaded.body).digest('hex')
    assert.equal(actual, asset.digest, 'mock 的 digest 必须与实际下载内容匹配，否则校验永远失败')
  } finally {
    await mock.close()
  }
})

test('场景开关：--no-digest 去掉 digest；--no-update 返回旧版本', async () => {
  const noDigest = createMockUpdateServer({ port: 0, withDigest: false })
  const origin1 = await noDigest.listen()
  try {
    const release = JSON.parse((await get(origin1 + '/releases/latest')).body.toString())
    assert.ok(release.assets.every((a) => !a.digest))
  } finally { await noDigest.close() }

  const noUpdate = createMockUpdateServer({ port: 0, updateAvailable: false })
  const origin2 = await noUpdate.listen()
  try {
    const release = JSON.parse((await get(origin2 + '/releases/latest')).body.toString())
    assert.equal(release.tag_name, 'v0.0.0')
  } finally { await noUpdate.close() }
})

test('独立摘要清单：正常 / 篡改 / 缺失三种场景', async () => {
  const ok = createMockUpdateServer({ port: 0 })
  const o1 = await ok.listen()
  try {
    const res = await get(o1 + '/release-trust.json')
    assert.equal(res.status, 200)
    const manifest = JSON.parse(res.body.toString())
    const release = JSON.parse((await get(o1 + '/releases/latest')).body.toString())
    const asset = release.assets.find((a) => a.name === ok.installerName)
    assert.equal(manifest.entries['99.0.0'], asset.digest, '清单与资产摘要必须一致')
    assert.equal(resolveDigestTrust({ manifestDigest: manifest.entries['99.0.0'], assetDigest: asset.digest }).decision, 'ok')
  } finally { await ok.close() }

  const tampered = createMockUpdateServer({ port: 0, manifestMode: 'tampered' })
  const o2 = await tampered.listen()
  try {
    const manifest = JSON.parse((await get(o2 + '/release-trust.json')).body.toString())
    const release = JSON.parse((await get(o2 + '/releases/latest')).body.toString())
    const asset = release.assets.find((a) => a.name === tampered.installerName)
    assert.equal(resolveDigestTrust({ manifestDigest: manifest.entries['99.0.0'], assetDigest: asset.digest }).decision, 'reject')
  } finally { await tampered.close() }

  const absent = createMockUpdateServer({ port: 0, manifestMode: 'absent' })
  const o3 = await absent.listen()
  try {
    assert.equal((await get(o3 + '/release-trust.json')).status, 404)
  } finally { await absent.close() }
})

test('假包只会定位、不会执行：内容是纯文本占位，不含 PE 头', async () => {
  const mock = createMockUpdateServer({ port: 0 })
  assert.equal(mock.installer.subarray(0, 2).toString(), 'MO', '必须是文本占位（MOCK...），不是 MZ 可执行文件')
  assert.match(mock.installer.subarray(0, 80).toString(), /NOT A REAL EXECUTABLE/)
})
