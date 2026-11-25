// 架构守卫（v6 · 6-2 / 6-3）：表名与 IPC 通道名只能有一个来源，且必须可证明。
//
// 这里检查的不是「功能对不对」，而是「同一份清单有没有被抄成两份」：
//   · schema/*.js 的 CREATE TABLE 与 schema/tableRegistry.js 双向一致
//   · slotStore 的逻辑表名与 registry.LOGICAL 完全一致
//   · 业务层不许再出现表名字面量数组（白名单一律 import registry）
//   · electron 里的通道名必须都在 ipc-channels.json 里
//
// 6-3（防假绿）的做法：把检查逻辑写成「接收源码文本的纯函数」，测试同时喂
// **真实文件**与**人为注入的违规片段**。只跑真实文件的话，检查函数本身写错
// （比如正则永远匹配不到）也会一直绿，这类守卫就变成摆设。

const test = require('node:test');
const { abs } = require('#testjs/paths')
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const registry = require('../../../student-backend/schema/tableRegistry');

function read(rel) {
  // Windows（含 CI）git 会把源码 checkout 成 CRLF；下面的逐行注释剥离用 \n 分行，
  // 不归一化会让行尾残留 \r → 注释剥不掉 → channels.js 注释里的示例被误判成真实调用。
  return fs.readFileSync(abs(rel), 'utf8').replace(/\r\n/g, '\n');
}

// 去掉行注释：注释里举例写 `['students', ...]` 不该被判成违规代码。
// 不处理块注释 —— 本项目业务代码里没有跨行块注释，加上反而容易误伤。
function stripLineComments(src) {
  return src
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

function collectDdl(src) {
  return [...src.matchAll(/CREATE TABLE IF NOT EXISTS\s+([a-z_]+)/g)].map((m) => m[1]);
}

// 表名字面量数组：只认「整串都是字符串」的数组（含 new Set([...])）。
// 故意不碰 `[{ table: 'x' }]` 这类配置数组：那是「一项配置一个表」的领域配置，
// 不是同一份名单的第二次抄写，按名单处理只会制造噪音。
// 只报「命中 2 个及以上已知表名」的数组：单个名字出现在字符串数组里往往另有语义
// （如 AI 的图表域 ['schedule','seat','duty']），误报会逼人流于关闭规则。
function findTableNameArrays(src, names) {
  const hits = [];
  for (const m of stripLineComments(src).matchAll(/\[([^[\]]*)\]/g)) {
    const inner = m[1].trim();
    if (!/^('([^']*)'\s*,\s*)*'([^']*)'$/.test(inner)) continue;
    const found = names.filter((n) => new RegExp(`'${n}'`).test(inner));
    if (found.length >= 2) hits.push({ text: m[0].replace(/\s+/g, ' ').slice(0, 80), names: found });
  }
  return hits;
}

// electron 侧注册 / 发送通道时用的字面量。用常量的地方不匹配，说明它已经走名单。
function findIpcLiterals(src) {
  const out = [];
  const re = /(?:ipcMain\.(?:on|handle|once)|webContents\.send|\.send)\s*\(\s*'([^']+)'/g;
  const code = stripLineComments(src);
  let m;
  while ((m = re.exec(code))) out.push(m[1]);
  return out;
}

// 档 C · M11 的守卫：主进程注册/发送 IPC 时是否还在手写通道名。
// 与 findIpcLiterals 的区别：这里返回「调用形态」而不只是通道名，便于直观看违规写法。
function findInlineIpc(src) {
  const code = stripLineComments(src);
  const out = [];
  for (const m of code.matchAll(/\bipcMain\.(handle|on|once)\s*\(\s*'([^']+)'/g)) {
    out.push(`ipcMain.${m[1]}('${m[2]}')`);
  }
  for (const m of code.matchAll(/\.send\s*\(\s*'([^']+)'/g)) {
    out.push(`send('${m[1]}')`);
  }
  return out;
}

function walk(dir, list = []) {
  for (const e of fs.readdirSync(abs(dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walk(rel, list);
    else if (e.name.endsWith('.js')) list.push(rel);
  }
  return list;
}

// ---------- 6-1 规则要守的同一件事，这里也有断言：业务层不许手抄表名 ----------

test('业务层不出现表名字面量数组（白名单一律 import tableRegistry）', () => {
  const dirs = ['student-backend/services', 'student-backend/routes', 'student-backend/utils'];
  const files = dirs.flatMap((d) => walk(d)).filter((f) => !f.endsWith(`schema/tableRegistry.js`));
  const offenders = [];
  for (const f of files) {
    for (const hit of findTableNameArrays(read(f), registry.ALL_PHYSICAL.concat(registry.ALL_LOGICAL))) {
      offenders.push(`${f}: ${hit.text}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `手抄的表名数组必须改成从 registry 引用：\n${offenders.join('\n')}`);
});

test('6-3 反证：检查函数能抓到注入的违规数组，且不会误报纯字段名数组', () => {
  const names = registry.ALL_PHYSICAL.concat(registry.ALL_LOGICAL);
  // 注入违规：这就是改造前 undo.executors.js 的写法
  const bad = findTableNameArrays("const T = ['students', 'score_records', 'leave_records']", names);
  assert.strictEqual(bad.length, 1);
  assert.deepStrictEqual(bad[0].names.slice().sort(), ['leave_records', 'score_records', 'students']);
  // 负样本：字段名、模式名不是表名，不能报
  assert.deepStrictEqual(findTableNameArrays("const C = ['id', 'position', 'atPosition']", names), []);
  // 注释里的示例不算违规
  assert.deepStrictEqual(findTableNameArrays("// 旧写法 ['students', 'scores'] 已删\nconst x = 1", names), []);
});

// ---------- DDL ↔ registry：双向锁 ----------

test('schema 的 CREATE TABLE 与 registry.PHYSICAL 双向一致', () => {
  const schemaFiles = fs.readdirSync(abs('student-backend/schema'))
    .filter((n) => /^schema\..*\.js$/.test(n));
  const seen = new Map();
  for (const f of schemaFiles) {
    const group = f.replace(/^schema\./, '').replace(/\.js$/, '');
    seen.set(group, collectDdl(read(`student-backend/schema/${f}`)));
  }
  // 每个 schema 文件对应一个分组，分组多一个少一个都要当场发现（新增 schema 文件却忘了登记）
  assert.deepStrictEqual([...seen.keys()].sort(), Object.keys(registry.PHYSICAL).sort());
  for (const [group, tables] of seen) {
    assert.deepStrictEqual([...tables].sort(), [...registry.PHYSICAL[group]].sort(), `schema.${group}.js 的建表名与 registry 不一致`);
  }
  // 物理表名不许重复登记：同一个表被挂进两个分组，白名单就会按分组选错
  const flat = Object.values(registry.PHYSICAL).flat();
  assert.strictEqual(new Set(flat).size, flat.length);
});

test('6-3 反证：DDL 多一张 / 少一张都能被发现', () => {
  const expect = ['students', 'users'];
  const check = (actual) => actual.slice().sort().join() === expect.slice().sort().join();
  assert.strictEqual(check(['students', 'users']), true);
  assert.strictEqual(check(['students', 'users', 'ghost_table']), false);
  assert.strictEqual(check(['students']), false);
});

// ---------- 逻辑表 ↔ slotStore ----------

test('slotStore 的逻辑表名与 registry.LOGICAL 完全一致', () => {
  const src = read('student-backend/services/slotStore.js');
  const pairs = [...src.matchAll(/^\s{2}([a-z_]+):\s*\{\s*table:\s*'([a-z_]+)'/gm)]
    .map((m) => [m[1], m[2]]);
  assert.deepStrictEqual(pairs.map((p) => p[0]).sort(), [...registry.ALL_LOGICAL].sort());
  for (const [logical, table] of pairs) {
    assert.strictEqual(registry.LOGICAL[logical], table, `${logical} 指向的物理表不一致`);
    assert.ok(registry.ALL_PHYSICAL.includes(table), `${logical} 指向了不存在的物理表 ${table}`);
  }
});

// ---------- IPC 通道名 ↔ ipc-channels.json ----------

test('electron 里的通道名全部来自 ipc-channels.json', () => {
  const json = JSON.parse(read('electron/ipc-channels.json'));
  const known = new Set([...json.send, ...json.invoke, ...json.receive]);
  // 名单自身不许重复：重复项会让「有登记」变成假象
  assert.strictEqual(known.size, json.send.length + json.invoke.length + json.receive.length);
  const offenders = [];
  for (const f of walk('electron')) {
    for (const name of findIpcLiterals(read(f))) {
      if (!known.has(name)) offenders.push(`${f}: ${name}`);
    }
  }
  assert.deepStrictEqual(offenders, [], `未登记的 IPC 通道：\n${offenders.join('\n')}`);
});

test('preload 的白名单由 ipc-channels.json 生成，而不是各抄一份', () => {
  const src = read('electron/preload.js');
  assert.ok(/ipc-channels\.json/.test(src), 'preload 必须直接引用 ipc-channels.json');
});

test('6-3 反证：注入一个未登记的通道名必须被识别出来', () => {
  const json = JSON.parse(read('electron/ipc-channels.json'));
  const known = new Set([...json.send, ...json.invoke, ...json.receive]);
  assert.deepStrictEqual(findIpcLiterals("ipcMain.handle('bogus-channel', () => {})").filter((n) => !known.has(n)), ['bogus-channel']);
  // 负样本：真通道不应被误报
  const real = json.invoke[0];
  assert.deepStrictEqual(findIpcLiterals(`ipcMain.handle('${real}', () => {})`).filter((n) => !known.has(n)), []);
});

// ---------- 档 C · M11：主进程注册侧也走同一份名单 ----------

test('主进程 IPC 注册/发送不再手写通道名（全部走 channels.js 常量）', () => {
  const files = walk('electron/main').filter((f) => !f.endsWith('/channels.js'));
  const offenders = [];
  for (const f of files) {
    for (const hit of findInlineIpc(read(f))) offenders.push(`${f}: ${hit}`);
  }
  assert.deepStrictEqual(offenders, [], `主进程仍在内联 IPC 通道名，请改用 CH.*：\n${offenders.join('\n')}`);
});

test('6-3 反证：内联通道名能被识别，常量写法不误报', () => {
  assert.deepStrictEqual(findInlineIpc("ipcMain.handle('quit-app', () => {})"), ["ipcMain.handle('quit-app')"]);
  assert.deepStrictEqual(findInlineIpc("mainWindow.webContents.send('from-main', {})"), ["send('from-main')"]);
  assert.deepStrictEqual(findInlineIpc('// 旧写法 ipcMain.on(\'x\') 已删'), []);
  assert.deepStrictEqual(findInlineIpc('IPC.handle(CH.QUIT_APP, () => {})'), []);
});

test('channels.js 与 ipc-channels.json 同源（生成器幂等，禁止手改）', async () => {
  const { renderChannels } = await import('../../../testjs/tools/gen-channels.mjs');
  const expected = renderChannels(JSON.parse(read('electron/ipc-channels.json')));
  assert.strictEqual(read('electron/main/channels.js'), expected, 'channels.js 已漂移，请运行 npm run channels:gen');
});

// ---------- Q4-01：AI 白名单 / 工具名 / 视图 / 列规则的集合对账 ----------
// 过去只有「物理表 ↔ DDL」「IPC 通道」两条线有集合相等断言，AI 这条后加的链路
// （读写白名单、工具 schema↔dispatch、列规则、逻辑视图）全靠人工审查，漂移可静默存活。

const aiConstants = require('../../../student-backend/routes/ai/ai.constants');
const aiSchema = require('../../../student-backend/routes/ai/ai.tools/tools.schema');
const { COLUMN_RULES } = require('../../../student-backend/services/sanitize');

function keysOf(obj) { return Object.keys(obj || {}); }

// schema/*.js 里 CREATE VIEW 建出来的只读视图（history 三件套等）。
// 它们不是物理表、也不在 LOGICAL（slotStore 只认可写的逻辑表），但同样是合法的读目标；
// 「是否已知表名」要把这部分算进来，否则体检清单引用 seat_history 会被误判成漂移。
function collectSchemaViews() {
  const dir = abs('student-backend/schema');
  const views = new Set();
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.js')) continue;
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    for (const m of src.matchAll(/CREATE VIEW\s+(?:IF NOT EXISTS\s+)?([a-z_]+)/g)) views.add(m[1]);
  }
  return views;
}
const SCHEMA_VIEWS = collectSchemaViews();
function isSchemaName(n) { return registry.isKnownName(n) || SCHEMA_VIEWS.has(n); }
function namesInRegistry(list) {
  return (list || []).filter((n) => !isSchemaName(n));
}

test('Q4-01 写白名单：WRITE / JSON_WRITE / BATCH / DOC_UNDO_KEY 全部来自注册表且键集同源', () => {
  const unknownWrite = namesInRegistry(keysOf(aiConstants.WRITE_TABLES));
  assert.deepStrictEqual(unknownWrite, [], `WRITE_TABLES 出现注册表外的表：${unknownWrite.join(', ')}`);
  const unknownJson = namesInRegistry(keysOf(aiConstants.JSON_WRITE_TABLES));
  assert.deepStrictEqual(unknownJson, [], `JSON_WRITE_TABLES 出现注册表外的表：${unknownJson.join(', ')}`);
  // BATCH_ROW_TABLES = WRITE_TABLES + 两张成员表；集合必须严格包含，不能少也不能乱加
  const batch = keysOf(aiSchema.BATCH_ROW_TABLES);
  assert.deepStrictEqual(
    [...new Set([...keysOf(aiConstants.WRITE_TABLES), 'group_members', 'cadre_members'])].sort(),
    [...batch].sort(),
    'BATCH_ROW_TABLES 必须恰好等于 WRITE_TABLES + group_members/cadre_members'
  );
  assert.deepStrictEqual(keysOf(aiConstants.DOC_UNDO_KEY).sort(), keysOf(aiConstants.JSON_WRITE_TABLES).sort(),
    'DOC_UNDO_KEY 与 JSON_WRITE_TABLES 必须一一对应（新增整块写表时两处一起补）');
});

test('Q4-01 注册表白名单：AI 检索/体检/撤销/座位/值日清单只许出现已知表名', () => {
  const groups = [
    ['AI_SEARCH_TABLES', registry.AI_SEARCH_TABLES],
    ['UNDO_WRITE_TABLES', registry.UNDO_WRITE_TABLES],
    ['UNDO_DOC_TABLES', registry.UNDO_DOC_TABLES],
    ['SEAT_CURRENT_SLOTS', registry.SEAT_CURRENT_SLOTS],
    ['DUTY_TABLES', registry.DUTY_TABLES],
  ];
  for (const [name, list] of groups) {
    const bad = namesInRegistry(list);
    assert.deepStrictEqual(bad, [], `${name} 出现注册表外的表名：${bad.join(', ')}`);
  }
  for (const [name, map] of [['AI_CHECK_RULE_TABLES', registry.AI_CHECK_RULE_TABLES], ['AI_SCORE_TABLES', registry.AI_SCORE_TABLES]]) {
    const bad = Object.values(map).flat().filter((n) => !isSchemaName(n));
    assert.deepStrictEqual(bad, [], `${name} 出现注册表外的表名：${bad.join(', ')}`);
  }
});

test('Q4-01 工具名：schema 里定义的每个工具都必须在 tools.js 有派发 case', () => {
  // 工具对象形如 { type:'function', function:{ name, ... } }
  const schemaNames = Object.values(aiSchema)
    .map((v) => v && v.function && v.function.name)
    .filter((n) => typeof n === 'string');
  assert.ok(schemaNames.length >= 20, `工具 schema 数量异常：${schemaNames.length}`);
  const dispatchSrc = read('student-backend/routes/ai/ai.tools/tools.js');
  const cases = new Set([...dispatchSrc.matchAll(/case\s+'([a-z_]+)'\s*:/g)].map((m) => m[1]));
  const missing = schemaNames.filter((n) => !cases.has(n));
  assert.deepStrictEqual(missing, [], `schema 有、dispatch 缺（模型调到会落空）：${missing.join(', ')}`);
});

test('Q4-01 列规则与逻辑视图：COLUMN_RULES 表名已知，LOGICAL 每项都有对应 CREATE VIEW', () => {
  const badTables = Object.keys(COLUMN_RULES).filter((t) => !isSchemaName(t));
  assert.deepStrictEqual(badTables, [], `COLUMN_RULES 出现未知表：${badTables.join(', ')}`);
  const missing = registry.ALL_LOGICAL.filter((n) => !SCHEMA_VIEWS.has(n));
  assert.deepStrictEqual(missing, [], `LOGICAL 里的表缺少只读视图：${missing.join(', ')}`);
});
