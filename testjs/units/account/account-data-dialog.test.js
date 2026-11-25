// =========================================================================
// account-data-dialog.test.js —— 账号数据管理弹窗的接线判据
//
// ① ~ ④：「查看 AI 记录」时管理弹窗必须保留、层级正确
// ⑤ ~ ⑧：档位文案/取消确定/预览确认/关闭主题
// ⑨ ~ ⑩：历史快照行对齐 + 单独一层选择弹窗 + 四层层级
// =========================================================================
const test = require('node:test')
const { abs } = require('#testjs/paths')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const SRC = abs('student-frontend/src')
const read = (p) => fs.readFileSync(path.join(SRC, p), 'utf8')

test('① 点「管理 AI 记录」只 emit view，不关掉账号数据管理弹窗', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  const btn = (src.match(/@click="emit\('view'\)"[\s\S]{0,260}/) || [])[0]
  assert.ok(btn, 'AI 行的「管理」必须 emit view')
  assert.match(btn, />管理<\/button>/, '入口文案统一叫「管理」')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#close
  assert.doesNotMatch(btn, /close\(\)/, '不能再关掉管理弹窗，否则关掉聊天记录后无处可回')
})

test('② 聊天记录弹窗层级走 prop，默认值保持 10001（不改 AI 助手原用法）', () => {
  const src = read('components/data-manage/DataManageDialog.vue')
  // @pin student-frontend/src/components/data-manage/DataManageDialog.vue#zIndex
  assert.match(src, /zIndex:\s*\{\s*type:\s*Number,\s*default:\s*10001/, 'zIndex 必须是可选 prop，默认 10001')
  // @pin student-frontend/src/components/data-manage/DataManageDialog.vue#zIndex
  assert.match(src, /:z-index="zIndex"/, 'DialogShell 必须用 prop 而不是写死层级')
})

test('③ 设置页接住 view 事件，且聊天记录弹窗层级更高', () => {
  const src = read('views/SettingsView/SettingsView.vue')
  const owner = (src.match(/<AccountDataDialog[^>]*>/) || [])[0]
  assert.ok(owner, '设置页未挂 AccountDataDialog')
  assert.match(owner, /@view="openDataManageFromSettings"/, 'AccountDataDialog 的 view 事件必须被接住')
  const tag = (src.match(/<DataManageDialog[^>]*>/) || [])[0]
  assert.ok(tag, '设置页未挂 DataManageDialog')
  const z = Number((tag.match(/:z-index="(\d+)"/) || [])[1])
  assert.ok(Number.isInteger(z) && z > 10013, `层级 ${z} 必须高于管理弹窗 10012 与确认框 10013`)
})

test('④ 首次打开聊天记录弹窗能加载（v-if 懒挂载需 immediate watcher）', () => {
  const src = read('components/data-manage/DataManageDialog.vue')
  assert.match(src, /watch\(\(\)\s*=>\s*props\.visible[\s\S]{0,120}immediate:\s*true/,
    'v-if 懒挂载下必须用 immediate watcher，否则首次打开是空的')
})

test('⑤ 档位文案短且选择器紧凑（避免省略号）', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  assert.match(src, /label:\s*'一个月'/, '不能用会被截断的长文案')
  assert.doesNotMatch(src, /最近一个月/, '长文案会截成省略号')
  assert.match(src, /\bcompact\b/, '应用紧凑模式')
})

test('⑥ 档位选择先进 draft，点确定才提交，取消可还原', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#saveDraft
  assert.match(src, /draft\.messages = v|draft\[row\.key\] = v/, '下拉要写 draft 而不是直接保存')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#cancelDraft
  assert.match(src, /function cancelDraft\(\)[\s\S]{0,80}Object\.assign\(draft, policy\)/, '取消要还原 draft')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#saveDraft
  assert.match(src, /async function saveDraft\(\)/, '确定要走 saveDraft')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#saveDraft
  assert.doesNotMatch(src, /async function setPolicy\(/, '不能再有改档即保存的旧路径')
})

test('⑦ 确定前先预览，有数据要删则弹确认', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#saveDraft
  assert.match(src, /axios\.post\('\/api\/retention\/preview'/, '确定前必须调预览接口')
  assert.ok(src.includes('有部分数据超过了设置的保留时间，点击确定将会删除，确定吗'), '超期确认文案要按指定口径')
  assert.match(src, /confirm\.confirmText = '确定'/, '确认按钮写「确定」，与取消成对')
  assert.match(src, /applyNow:\s*true/, '确认后保存要带立即清理标志')
  const route = fs.readFileSync(abs('student-backend/routes/retention.js'), 'utf8')
  assert.match(route, /router\.post\('\/preview'/, '后端要有预览接口')
})

test('⑧ 关闭按钮用主题适配的 dlg-close', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#close
  assert.match(src, /class="dlg-close"[^>]*@click="close"/, '关闭按钮必须用 dlg-close')
  assert.doesNotMatch(src, /rc-close/, 'rc-close 是收据弹窗样式，主题不适配')
})

test('⑨ 历史快照行只留一个对齐的「管理」，三域选项移到单独一层选择弹窗', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  assert.match(src, /@click="emit\('viewSnapshots'\)"[\s\S]{0,260}>管理<\/button>/, '历史快照行文案也要统一为「管理」')
  assert.ok(!src.includes('管理（'), '不能在行下方平铺三个域按钮')
  assert.ok(!src.includes('SNAPSHOT_DOMAINS'), '旧的三域常量应移除')
  const picker = read('components/dialogs/SnapshotPickerDialog.vue')
  assert.match(picker, /管理快照/, '选择弹窗标题必须是「管理快照」')
  assert.match(picker, />管理（\{\{ d\.label \}\}快照）<\/button>/, '三域按钮文案也用「管理」')
  for (const label of ['座位', '值日', '课表']) {
    assert.match(picker, new RegExp("label: '" + label + "'"), `选择弹窗缺少${label}项`)
  }
  assert.match(picker, /\$emit\('pick', d\.key\)/, '点选项要发 pick 事件')
  const host = read('views/SettingsView/SettingsView.vue')
  assert.match(host, /@view-snapshots="snapshotPickerOpen = true"/, '设置页要接 viewSnapshots 打开选择弹窗')
  assert.match(host, /@pick="openSnapshotDialog"/, '选择弹窗的 pick 要接上')
})

test('⑩ 四层弹窗层级递增：管理 < 选择 < 快照管理 < 内部确认', () => {
  const host = read('views/SettingsView/SettingsView.vue')
  const zOf = (name) => {
    const tag = (host.match(new RegExp('<' + name + '[^>]*>')) || [])[0]
    assert.ok(tag, `设置页缺少 ${name}`)
    return Number((tag.match(/:z-index="(\d+)"/) || [])[1])
  }
  const zManage = 10012
  const zPicker = zOf('SnapshotPickerDialog')
  assert.ok(zPicker > zManage, `选择弹窗 ${zPicker} 必须高于管理弹窗`)
  const tags = host.match(/<(?:SeatRecordSettingsDialog|DutyRecordSettingsDialog|ScheduleRecordDialog)[^>]*>/g) || []
  assert.equal(tags.length, 3, '三域快照弹窗都要挂')
  for (const tag of tags) {
    const z = Number((tag.match(/:z-index="(\d+)"/) || [])[1])
    assert.ok(z > zPicker, `${tag.slice(0, 40)} 层级 ${z} 必须高于选择弹窗 ${zPicker}`)
  }
  for (const f of ['SeatRecordSettingsDialog', 'DutyRecordSettingsDialog', 'ScheduleRecordDialog']) {
    const src = read('components/dialogs/' + f + '.vue')
    assert.match(src, /:z-index="zIndex \+ 1"/, `${f} 的确认框层级必须高于自身`)
  }
})

test('⑪ 回收站两行同款：档位进 draft、删除全部走确认，且有自己的说明', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  for (const [kind, label] of [['albumTrash', '相册回收站'], ['receiptTrash', '收据回收站']]) {
    assert.match(src, new RegExp('aria-label="' + label + '保留期"'), `${label} 行缺少档位选择器`)
    assert.match(src, new RegExp('draft\\.' + kind + ' = v'), `${label} 档位必须写 draft 而不是直接保存`)
    // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#askDelete
    assert.match(src, new RegExp("askDelete\\('" + kind + "', '" + label + "', true\\)"), `${label} 删除全部必须带回收站标记`)
    assert.match(src, new RegExp('stats\\.' + kind + '\\.count'), `${label} 行缺少占用统计`)
  }
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#ALL_KINDS
  assert.match(src, /ALL_KINDS\.some\(k => draft\[k\] !== policy\[k\]\)/, 'dirty 必须覆盖四类')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#ALL_KINDS
  assert.match(src, /ALL_KINDS\.reduce\(\(sum, k\) => sum \+ \(willDelete\[k\] \|\| 0\), 0\)/, '预览确认必须累计四类')
  assert.match(src, /清空回收站后，对应删除不能再撤销还原/, '帮助文案必须提示撤销影响')
  assert.match(src, /对应的删除记录也不能再撤销还原/, '清空确认框必须提示撤销影响')
})

test('⑫ 删除全部与危险区同款 5 秒冷静期，取消/关闭/卸载都要真取消定时器', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  assert.match(src, /:confirm-disabled="confirm\.disabled"/, '确认框必须接 disabled')
  assert.match(src, /let remain = 5/, '必须是 5 秒')
  assert.match(src, /confirm\.confirmText = `删除全部\(\$\{remain\}\)`/, '按钮文案要带倒计时数字')
  assert.match(src, /useDisposables/, '定时器必须走 disposables（项目铁律）')
  assert.match(src, /d\.interval\(/, '用 interval 而非多个 timeout')
  // 三个出口都要停：确认、取消、关闭；卸载还要 dispose
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#onConfirm
  assert.match(src, /function onConfirm\(\)[\s\S]{0,120}if \(confirm\.disabled\) return/, '倒计时未结束再挡一层')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#onCancelConfirm
  assert.match(src, /function onCancelConfirm\(\)[\s\S]{0,60}stopCountdown\(\)/, '取消要停')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#stopCountdown
  assert.match(src, /function close\(\)[\s\S]{0,80}stopCountdown\(\)/, '关闭弹窗要停')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#stopCountdown
  assert.match(src, /onBeforeUnmount\(\(\) => \{ stopCountdown\(\); d\.dispose\(\) \}\)/, '卸载要 dispose')
})

test('⑬ 两类回收站都只有一个「管理」入口；恢复在弹窗内，不另开按钮', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  const views = src.match(/emit\('viewTrash', '(albumTrash|receiptTrash)'\)/g) || []
  assert.equal(views.filter(v => v.includes('albumTrash')).length, 1, '相册只能有一个入口')
  assert.equal(views.filter(v => v.includes('receiptTrash')).length, 1, '收据只能有一个入口，恢复已并入管理弹窗')
  assert.equal((src.match(/>管理<\/button>/g) || []).length, 4, '四行入口文案统一为「管理」')
  assert.ok(!src.includes('>恢复</button>'), '行内不再单列「恢复」按钮')

  const preview = read('components/dialogs/TrashPreviewDialog.vue')
  assert.match(preview, /api\/retention\/trash-file/, '预览要走安全文件接口')
  assert.match(preview, /api\/retention\/restore-receipt/, '恢复要走收据专用接口')
  assert.match(preview, /apiFetch/, '二进制预览必须走带鉴权的 apiFetch，不能裸 img src')
  assert.match(preview, /URL\.revokeObjectURL/, 'objectURL 要释放，避免内存泄漏')
  assert.match(preview, /kind === 'receiptTrash'/, '恢复按钮要按类型显示')
  const host = read('views/SettingsView/SettingsView.vue')
  assert.match(host, /@view-trash="openTrashPreview"/, '设置页要接 viewTrash')
})

test('⑭ 回收站预览首次打开就能加载（v-if 懒挂载需 immediate watcher）', () => {
  const host = read('views/SettingsView/SettingsView.vue')
  const tag = (host.match(/<TrashPreviewDialog[^>]*>/) || [])[0]
  assert.ok(tag, '设置页必须挂 TrashPreviewDialog')
  assert.match(tag, /v-if="trashPreviewKind"/, '弹窗走 v-if 懒挂载')
  assert.match(tag, /:visible="true"/, '宿主用固定 true + v-if 控制显隐，首帧不会有 visible 变化')
  const preview = read('components/dialogs/TrashPreviewDialog.vue')
  assert.match(preview, /watch\(\(\)\s*=>\s*props\.visible[\s\S]{0,160}immediate:\s*true/,
    '没有 immediate，首次挂载时 load() 永远不执行，删掉的文件明明在回收站却显示「暂无文件」')
})

test('⑮ 回收站复刻收据弹窗的列表形态，且没有上传区', () => {
  const src = read('components/dialogs/TrashPreviewDialog.vue')
  const receipt = read('components/dialogs/ReceiptDialog.vue')
  assert.match(receipt, /<MediaViewer/, '参照物本身要保留媒体查看器，避免改名后假绿')
  assert.match(src, /<MediaViewer/, '图片/视频预览要复用管理收据的查看器')
  // @pin student-frontend/src/components/dialogs/TrashPreviewDialog.vue#view
  assert.match(src, /@click="view\(asFile\(it\)\)">\{\{ viewLabel\(it\) \}\}</, '每行保留「直接预览」入口')
  // @pin student-frontend/src/components/dialogs/TrashPreviewDialog.vue#download
  assert.match(src, /@click="download\(asFile\(it\)\)">下载</, '每行保留「下载」按钮')
  // @pin student-frontend/src/components/dialogs/TrashPreviewDialog.vue#restore
  assert.match(src, /@click="restore\(it\)"/, '收据行保留「恢复」按钮（相册没有）')
  // @pin student-frontend/src/components/dialogs/TrashPreviewDialog.vue#close
  assert.match(src, /@click="close">完成<\/button>/, '底部与管理收据一样用「完成」收尾')
  assert.ok(src.includes('共 ${items.length} 个文件'), '底部要显示文件数')
  for (const s of ['dropzone', 'upload-receipt', '点击选择文件']) {
    assert.ok(!src.includes(s), `回收站不该出现上传区：${s}`)
  }
  assert.match(src, /OPEN_UPLOAD_FILE/, 'Office 收据照抄管理收据的本地查看通道')
  assert.match(src, /area: props\.kind/, '本地打开要带 area，不能误去 uploads 根目录找')
  assert.match(src, /m === 'external' \? '本地查看'/, 'Office 行文案与管理收据一致')
})

test('⑯ 底部是常驻普通「取消 / 确定」，不再提示「保留期有改动」', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  assert.ok(!src.includes('保留期有改动'), '不该再有未保存改动提示')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#cancelDraft
  assert.match(src, /function cancelDraft\(\)[\s\S]{0,100}close\(\)/, '取消要关弹窗')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#dirty
  assert.match(src, /if \(!dirty\.value\) \{ close\(\); return \}/, '没改档位时确定就是普通关闭')
  // @pin student-frontend/src/components/dialogs/AccountDataDialog.vue#close
  assert.match(src, /emit\('changed'\)\n    close\(\)/, '保存成功后关弹窗')
})

test('⑰ 按钮尺寸统一，不留小号按钮', () => {
  const src = read('components/dialogs/AccountDataDialog.vue')
  const receipt = read('components/dialogs/ReceiptDialog.vue')
  assert.match(receipt, /width:\s*720px/, '参照弹窗（管理收据）应仍是 720px，避免改名后假绿')
  assert.doesNotMatch(src, /text-xs px-2 py-1|text-xs px-3 py-1\.5/, '不能再留小号按钮')
})
