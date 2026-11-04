// =========================================================================
// mutate-sweep.cjs —— 批 18 的反向验证（变异测试）
//
// 目的：证明 testjs/units/sweep-fixes.test.js 的判据**真的能抓到回归**。
//   做法：逐个把源码里的「被守行为」改坏（变异），跑单测，确认单测变红。
//   如果某个变异跑完单测仍然全绿 → 该条判据是假绿，必须补判据。
//
// ⚠️ 还原必须挂在 process.on('exit') 上：只靠循环末尾还原，
//   一旦中途异常退出就把坏代码留在工作区（2026-11-04 批 17 踩过）。
//
// ⚠️ 锚点匹配要适配行尾：源码可能是 CRLF，用 LF 写的锚点会永远匹配不上
//   → 报「锚点未找到」看着像「源码已变」，其实是行尾不一致（批 17 踩过）。
//
// 用法：node testjs/tools/mutate-sweep.cjs
// 退出码：0 = 全部变异都被抓到；1 = 有漏网。
// =========================================================================
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

const ROOT = path.join(__dirname, '..', '..')
const TEST = path.join(ROOT, 'testjs', 'units', 'sweep-fixes.test.js')

// file → 备份
const FILES = {
  llm: 'student-frontend/src/composables/ai/aiChat.js',
  toast: 'student-frontend/src/components/base/NotificationToast.vue',
  glyph: 'student-frontend/src/components/base/IconGlyph.vue',
  videothumb: 'student-frontend/src/components/import-export/VideoThumb.vue',
  composer: 'student-frontend/src/components/ai/AiComposer/AiComposer.vue',
  timer: 'student-frontend/src/subwindows/widget/Timer.vue',
  setup: 'student-frontend/src/subwindows/setup/Setup.vue',
  albumview: 'student-frontend/src/views/AlbumView.vue',
  settingsdata: 'student-frontend/src/views/SettingsView/SettingsView.data.js',
  searchdialog: 'student-frontend/src/components/base/SearchDialog.vue',
  settingsview: 'student-frontend/src/views/SettingsView/SettingsView.vue',
  mainjs: 'student-frontend/src/main.js',
  migration: 'student-frontend/src/subwindows/migration/main.js',
  setupmain: 'student-frontend/src/subwindows/setup/main.js',
  theme: 'student-frontend/src/stores/theme.js',
  exif: 'student-backend/albumExif.js',
  albumscan: 'student-backend/albumScan.js',
  dataroutes: 'student-backend/routes/ai/ai.dataRoutes.js',
  commonexec: 'student-backend/routes/ai/ai.tools/tools.executors/executors.common.js',
  executors: 'student-backend/routes/ai/ai.tools/tools.executors/executors.js',
  dutybd: 'student-frontend/src/components/dialogs/DutyBackfillDialog.vue',
  dutyview: 'student-frontend/src/views/DutyView.vue',
}

const orig = {}
for (const [k, rel] of Object.entries(FILES)) {
  const p = path.join(ROOT, rel)
  orig[k] = fs.readFileSync(p, 'utf8')
}

const MUTANTS = [
  {
    name: 'M1 日期收口：后端改回各自拼日期',
    file: 'dataroutes',
    from: "const { localDateStr } = require('../../utils/date');",
    to: "const localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;",
  },
  {
    name: 'M2 日期收口：albumScan 改回各自拼日期',
    file: 'albumscan',
    from: "const { localDateStr } = require('./utils/date');",
    to: "const localDateStr = (d) => `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;",
  },
  {
    name: 'M3 日期收口：前端 DutyView 改回内联拼日期',
    file: 'dutyview',
    from: '    const to = localDateStr(y)',
    to: '    const pad = n => String(n).padStart(2, \'0\')\n    const to = `${y.getFullYear()}-${pad(y.getMonth() + 1)}-${pad(y.getDate())}`',
  },
  {
    name: 'M4 日期收口：executors.common 改回各自拼日期',
    file: 'commonexec',
    from: "const { localDateStr: aiDateStr } = require('../../../../utils/date');",
    to: "function aiDateStr(d) { return `${d.getFullYear()}-${aiPad2(d.getMonth()+1)}-${aiPad2(d.getDate())}`; }",
  },
  {
    name: 'M5 下载 blob：revoke 改回同步调用',
    file: 'albumview',
    from: '    setTimeout(() => URL.revokeObjectURL(url), 1000)',
    to: '    URL.revokeObjectURL(url)',
  },
  {
    name: 'M6 下载 blob：SettingsView 改回同步调用',
    file: 'settingsdata',
    from: '        setTimeout(() => URL.revokeObjectURL(url), 1000)',
    to: '        URL.revokeObjectURL(url)',
  },
  {
    name: 'M7 附件读取：去掉 try/catch',
    file: 'composer',
    from: '  try {\n    emit(\'attach\', await readFile(file))\n  } catch (err) {\n    console.error(\'[composer] 读取附件失败\', err)\n    useNotification().error(\'读取文件失败，请重试\')\n  }',
    to: '  emit(\'attach\', await readFile(file))',
  },
  {
    name: 'M8 EXIF 月日：去掉往返校验（2/31 又会滚到 3/2）',
    file: 'exif',
    from: '  if (dt.getMonth() !== mon - 1 || dt.getDate() !== day) return \'\'',
    to: '  // 变异：去掉往返校验',
  },
  {
    name: 'M9 IconGlyph：旋转选择器改回永不匹配的写法',
    file: 'glyph',
    from: '.icon-loading:deep(svg) {',
    to: '.icon-loading :deep(svg) {',
  },
  {
    name: 'M10 常驻通知：去掉 duration=0 保护',
    file: 'toast',
    from: '  if (!item._originalDuration) return',
    to: '  // 变异：去掉常驻通知保护',
  },
  {
    name: 'M11 VideoThumb：去掉 src 复位',
    file: 'videothumb',
    from: 'watch(() => props.src, () => { ok.value = true })',
    to: '// 变异：去掉 src 复位',
  },
  {
    name: 'M12 Setup：改回覆盖用户已选主题',
    file: 'setup',
    from: '  if (!hasSavedTheme) themeStore.setTheme(\'glass\')',
    to: '  if (themeStore.currentTheme !== \'glass\') themeStore.setTheme(\'glass\')',
  },
  {
    name: 'M13 Timer：去掉倒计时归零提示',
    file: 'timer',
    from: "    hint.value = '请先设置倒计时时长（小时 / 分钟 / 秒）'",
    to: "    // 变异：静默 return",
  },
  {
    name: 'M14 busy 复位：executeProposal 不再 await',
    file: 'llm',
    from: '            await ctx.executeProposal(last)',
    to: '            ctx.executeProposal(last)',
  },
  {
    name: 'M15 ffmpeg 超时：去掉 timeout 选项',
    file: 'albumscan',
    from: "          { timeout: FFMPEG_THUMB_TIMEOUT_MS, killSignal: 'SIGKILL' },",
    to: '          {},',
  },
  {
    name: 'M16 migration：去掉 catch 兜底',
    file: 'migration',
    from: "  .catch((err) => {\n    console.error('[migration] 主题样式加载失败，按基础主题继续挂载', err)\n    app.mount('#migration-app')\n  })",
    to: '  // 变异：去掉 catch',
  },
  {
    name: 'M17 setup main：去掉 catch 兜底',
    file: 'setupmain',
    from: '}).catch((err) => {',
    to: '}) // 变异：去掉 catch',
  },
  {
    name: 'M18 theme：去掉补发凭据的 catch',
    file: 'theme',
    from: "        }).catch((e) => {",
    to: "        }) // 变异：去掉 catch",
  },
  {
    name: 'M19 :key 稳定性：SearchDialog 改回含 keyword',
    file: 'searchdialog',
    from: ':key="r.id"',
    to: ':key="keyword + \'#\' + r.id"',
  },
  {
    name: 'M20 :key 稳定性：SettingsView 改回含 settingsSearch',
    file: 'settingsview',
    from: ':key="item.id"',
    to: ':key="settingsSearch + \'#\' + item.id"',
  },
  {
    name: 'M21 启动背景图：改回不走 resourceUrl',
    file: 'mainjs',
    from: '  if (customBg) return resourceUrl(customBg)',
    to: '  if (customBg) return customBg',
  },
  {
    name: 'M22 日期收口：executors.js 改回内联拼日期',
    file: 'executors',
    from: '  const date = aiDateStr(now);',
    to: "  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;",
  },
  {
    name: 'M23 日期收口：DutyBackfillDialog 改回内联',
    file: 'dutybd',
    from: '  const today = localDateStr(new Date())',
    to: "  const d = new Date()\n  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`",
  },
]

// ---------------------------------------------------------------------------
// 还原：挂 exit + finally 双保险
// ---------------------------------------------------------------------------
function restoreAll() {
  for (const [k, rel] of Object.entries(FILES)) {
    fs.writeFileSync(path.join(ROOT, rel), orig[k])
  }
}
process.on('exit', restoreAll)

function applyMutant(m) {
  const p = path.join(ROOT, FILES[m.file])
  let src = fs.readFileSync(p, 'utf8')
  // 锚点适配行尾：文件是 CRLF 时把 LF 锚点也转成 CRLF
  let from = m.from
  let to = m.to
  if (src.includes('\r\n') && !from.includes('\r\n')) {
    from = from.replace(/\n/g, '\r\n')
    to = to.replace(/\n/g, '\r\n')
  }
  if (!src.includes(from)) return false
  fs.writeFileSync(p, src.replace(from, to))
  return true
}

function runTests() {
  // 必须显式指定 TAP：Node 22+ 的默认 reporter 随版本/终端而变（可能是 spec/ℹ 形态），
  // 用 `^not ok` 判断失败就会恒为 false、工具永远 exit 1（审查 v5 · V5-031）。
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', TEST], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env },
  })
  const out = (r.stdout || '') + (r.stderr || '')
  const failed = /^not ok/m.test(out)
  return { failed, out }
}

// ---------------------------------------------------------------------------
let missed = 0
let skipped = 0
console.log('== 反向验证：' + MUTANTS.length + ' 处变异 ==\n')

for (const m of MUTANTS) {
  restoreAll()
  if (!applyMutant(m)) {
    console.log('  SKIP  ' + m.name + ' —— 锚点未找到（源码已变？）')
    skipped++
    missed++
    continue
  }
  const { failed, out } = runTests()
  const mNotOk = (out.match(/^not ok/gm) || []).length
  if (failed) {
    console.log('  ✓ 抓到  ' + m.name + '（' + mNotOk + ' 条变红）')
  } else {
    console.log('  ✗ 漏网  ' + m.name + ' —— 单测仍然全绿（判据太松！）')
    missed++
  }
}

restoreAll()

console.log('')
if (missed) {
  console.error('失败 ' + missed + ' 处（漏网 ' + (missed - skipped) + ' / 锚点未找到 ' + skipped + '）')
  process.exit(1)
}
console.log('全部变异都被精确捕获，0 漏网')
