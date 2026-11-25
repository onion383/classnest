// =========================================================================
// about-deps-inventory.test.js —— 关于页「使用的开源项目」清单的完整性判据
//
// 版本号本身不写死：构建期从三份 package.json 读声明版本（AboutView.declaredVersions）。
// 真正会失效的是「漏列」——加了运行时依赖却没进 libGroups，随包分发的第三方组件
// 就少了许可证展示，属合规缺口。本文件把这件事变成可自动检查的不变量。
// =========================================================================
const { test } = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')

const ABOUT = fs.readFileSync(abs('student-frontend/src/views/AboutView.vue'), 'utf8')
const PKGS = [
  'package.json',
  'student-frontend/package.json',
  'student-backend/package.json',
]

function listedNames(src) {
  const at = src.indexOf('const libGroups')
  assert.ok(at > 0, '找不到 libGroups')
  return [...src.slice(at).matchAll(/name:\s*'([^']+)'/g)].map((m) => m[1])
}

function aliasMap(src) {
  const at = src.indexOf('const PKG_ALIAS')
  assert.ok(at > 0, '找不到 PKG_ALIAS')
  const end = src.indexOf('}', at)
  const out = {}
  for (const m of src.slice(at, end).matchAll(/'([^']+)':\s*'([^']+)'/g)) out[m[1]] = m[2]
  return out
}

const declared = (() => {
  const out = {}
  for (const p of PKGS) {
    const pkg = JSON.parse(fs.readFileSync(abs(p), 'utf8'))
    Object.assign(out, pkg.dependencies || {}, pkg.devDependencies || {})
  }
  return out
})()

test('三份 package.json 的运行时依赖全部出现在关于页清单里', () => {
  const alias = aliasMap(ABOUT)
  const covered = new Set(listedNames(ABOUT).map((n) => alias[n] || n.toLowerCase()))
  for (const p of PKGS) {
    const pkg = JSON.parse(fs.readFileSync(abs(p), 'utf8'))
    for (const name of Object.keys(pkg.dependencies || {})) {
      assert.ok(covered.has(name), `${p} 的运行时依赖 ${name} 没列进关于页清单（随包分发却缺许可证展示）`)
    }
  }
})

test('清单每一项都能解析到版本来源，不会显示空白版本号', () => {
  const alias = aliasMap(ABOUT)
  // 非 npm 项：版本另有来源（FFmpeg=随包构建信息，harfbuzzjs=wasm 来源注释，素材类无版本）
  const special = ['FFmpeg（LGPL 构建）', 'harfbuzzjs', 'Pixabay', 'Noto Sans SC']
  for (const n of listedNames(ABOUT)) {
    if (special.includes(n)) continue
    const key = alias[n] || n.toLowerCase()
    assert.ok(declared[key], `清单项 ${n} → ${key} 在三份 package.json 中都没有声明，版本号会空白`)
  }
})

test('新增的 MCP / zod 四项按实际许可证标注且链接指向官方仓库', () => {
  const added = [
    ['@modelcontextprotocol/server', 'Apache-2.0', 'github.com/modelcontextprotocol/typescript-sdk'],
    ['@modelcontextprotocol/client', 'Apache-2.0', 'github.com/modelcontextprotocol/typescript-sdk'],
    ['@modelcontextprotocol/node', 'Apache-2.0', 'github.com/modelcontextprotocol/typescript-sdk'],
    ['zod', 'MIT', 'github.com/colinhacks/zod'],
  ]
  for (const [name, license, url] of added) {
    const re = new RegExp(`name:\\s*'${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}'[^\\n]*license:\\s*'${license}'`)
    assert.match(ABOUT, re, `${name} 的许可证标注应为 ${license}`)
    const line = ABOUT.split('\n').find((l) => l.includes(`name: '${name}'`))
    assert.ok(line && line.includes(url), `${name} 的链接应指向 ${url}`)
  }
})
