// =========================================================================
// draft-release-assets.test.js —— 草稿发布的产物 glob 必须匹配实际下载层级
//
// 根因：upload-artifact 上传 release/*.exe 与 release36/*.exe 时保留了子目录，
// download-artifact 下载到 artifacts/ 后实际是 artifacts/release/*.exe；
// 草稿发布却用 artifacts/*.exe（只匹配根层），永远找不到文件。
// 修法：不写死层级，用 find 递归收集 exe/zip/sha256，空产物显式失败。
//
// 判据：①静态核验 ci.yml 不再有 artifacts/*.exe 这类根层 glob，且有递归收集 + 空判失败；
//       ②真跑 same find 命令，验子目录里的产物被收集、非产物文件被排除。
// =========================================================================
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '../..')
const CI = path.join(ROOT, '.github/workflows/ci.yml')

test('ci.yml：草稿发布不再用根层 glob，改为递归收集且空产物判失败', () => {
  const ci = fs.readFileSync(CI, 'utf8')
  const draft = ci.slice(ci.indexOf('创建或更新草稿发布'), ci.indexOf('# ------', ci.indexOf('创建或更新草稿发布')) > 0
    ? ci.indexOf('# ------', ci.indexOf('创建或更新草稿发布')) : undefined)
  assert.ok(!/artifacts\/\*\.(exe|zip|sha256)/.test(draft), '不许再用只匹配根层的 artifacts/*.exe')
  assert.ok(/find artifacts[\s\S]{0,200}name .*\.exe/.test(draft), '必须递归找 exe')
  assert.ok(draft.includes("-name '*.zip'"), '必须收集 zip')
  assert.ok(draft.includes("-name '*.sha256'"), '必须收集 sha256')
  assert.match(draft, /mapfile -t ASSETS/, '收集到的产物要进数组')
  assert.match(draft, /\$\{ASSETS\[@\]\}/, 'create/upload 都要用数组展开')
  assert.ok(draft.includes('ASSETS[@]} -eq 0') && /exit 1/.test(draft.slice(draft.indexOf('ASSETS[@]} -eq 0'), draft.indexOf('ASSETS[@]} -eq 0') + 160)), '空产物必须让 CI 失败')
  const createAt = draft.indexOf('gh release create')
  const uploadAt = draft.indexOf('gh release upload')
  assert.ok(createAt > 0 && draft.slice(createAt, createAt + 100).includes('${ASSETS[@]}'), 'create 必须用收集到的资产')
  assert.ok(uploadAt > 0 && draft.slice(uploadAt, uploadAt + 100).includes('${ASSETS[@]}'), 'upload 必须用收集到的资产')
})

test('真跑 find：子目录里的 exe/zip/sha256 全被收集，无关文件排除', () => {
  if (process.platform === 'win32' && !process.env.GIT_BASH_AVAILABLE) {
    // Git Bash 在 CI 的 ubuntu runner 一定有；本机 Windows 也带，直接试，失败则跳过
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'draft-assets-'))
  const expected = [
    'release/ClassNest-Setup-1.0.0.exe',
    'release/ClassNest-Portable-1.0.0.zip',
    'release36/ClassNest-Vue36-Setup-1.0.0.exe',
    'release36/ClassNest-Vue36-Setup-1.0.0.exe.sha256',
  ]
  try {
    for (const rel of expected) {
      const p = path.join(tmp, 'artifacts', rel)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, 'x')
    }
    fs.writeFileSync(path.join(tmp, 'artifacts', 'notes.txt'), 'not an asset')
    let out
    try {
      out = execFileSync('bash', ['-c',
        "cd \"$1\" && find artifacts -type f \\( -name '*.exe' -o -name '*.zip' -o -name '*.sha256' \\) -print | sort",
        'bash', tmp], { encoding: 'utf8' })
    } catch (e) {
      if (e.code === 'ENOENT') return // 本机没 bash 就跳过（CI 的 ubuntu runner 必有）
      throw e
    }
    const got = out.trim().split(/\r?\n/).map((l) => l.replace(/\\/g, '/'))
    assert.deepEqual(got.sort(), expected.map((e) => 'artifacts/' + e).sort(), '子目录产物必须全被收集')
    assert.ok(!out.includes('notes.txt'), '非产物文件不能混入')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
})
