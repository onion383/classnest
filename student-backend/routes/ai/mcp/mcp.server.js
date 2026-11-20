// =========================================================================
// mcp.server.js —— 方向 B：班集作为 MCP 服务端（本地 HTTP / Streamable HTTP）
//
// 关键设计（与《MCP接入方案》§方向 B 对齐）：
//   · 传输：挂在现有 Express（本机回环端口，见 config/ports.json）的 /mcp，不新增监听端口，
//     直接继承
//     应用层已有的 Host 校验 + CORS 白名单；SDK 自带 Host/Origin 校验再叠一层。
//   · 鉴权：独立 MCP token（services/mcpTokenStore），不碰 JWT / secureChannel。
//     token 绑定 dbSlug——每个工具调用都在 withDb(slug) 内执行，外部进程拿不到主密钥。
//   · SDK 懒加载：@modelcontextprotocol/* require 约 140ms，不放启动路径。首次 /mcp
//     请求才初始化 handler，之后复用。
//   · 写操作：propose_write（单条）/ propose_batch（批量）只建提案，get_proposal_result
//     查结果；真正写入由老师在班集 UI 确认后走 mcpProposalExec.confirm（见 /api/mcp/proposals 路由）。
//     批量提案在同一事务里执行——任一条不通过则整批回滚，不会只改一半。
// =========================================================================

const express = require('express');
const dbManager = require('../../../dbManager/dbManager');
const tokenStore = require('../../../services/mcpTokenStore');
const mcpTools = require('../../../services/mcpTools');
const mcpRateLimit = require('../../../services/mcpRateLimit');
const aiConfigStore = require('../../../services/aiConfigStore');
const accessLog = require('../../../services/accessLogStore');

const router = express.Router();

let _handlerPromise = null;

// 首次请求时加载 SDK 并构造 handler。每请求一个新 McpServer（v2 无状态要求），
// 工具在其中注册；handler 本身可长期复用。
function getHandler() {
  if (_handlerPromise) return _handlerPromise;
  _handlerPromise = (async () => {
    const { McpServer, createMcpHandler } = require('@modelcontextprotocol/server');
    const { z } = require('zod');
    const factory = () => {
      const server = new McpServer({ name: '班集', version: '1.0.0' });
      // 工具 handler 统一包装：从 ALS 取 token 绑定的 slug（外部客户端无法伪造）→ 绑库
      // → 调 mcpTools → 序列化回填文本。args 原样透传，不含任何 slug 字段。
      // 第二参 ctx 显式传 slug 给工具层（走混淆 restore/substitute）——不倒挂 require
      // mcp.server 的 ALS，也不用 currentSlug（测试夹具里 withDb 被 stub 会拿不到）。
      // meta 三件事各管一摊，别混：tool=名字（访问记录/限流留痕用）、logRead=是否算「读」
      // （只有读才进数据访问记录，写走提案 + 更改审查）、rate=走哪个限流桶（read/search/write）。
      const wrap = (fn, meta = {}) => async (args) => {
        const slug = MCP_SLUG_ALS.getStore();
        if (!slug) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '未绑定班级库' }) }] };
        const actor = MCP_ACTOR_ALS.getStore() || '';
        const tool = meta.tool || '';
        try {
          // 频率闸门排在工具执行之前：超限的请求不该走到 SQL / 提案写入。
          // 闸门自己出错就放行——限流不该让老师的 AI 停摆；真有问题下面的业务调用会报真实错误。
          let gate = { ok: true };
          try {
            gate = (await dbManager.withDb(slug, () => mcpRateLimit.check(slug, meta.rate))) || gate;
          } catch (_) { gate = { ok: true }; }
          if (!gate.ok) {
            // 被挡住也要留痕：否则页面上只看到「AI 今天没干活」，看不到被挡了几百次。
            try {
              dbManager.withDb(slug, () => accessLog.record({
                source: 'mcp', actor, tool, target: '', detail: '', amount: 0,
                result: 'denied', reason: gate.error,
              }));
            } catch (_) { /* 忽略 */ }
            return {
              content: [{
                type: 'text',
                text: JSON.stringify({ ok: false, error: gate.error, retry_after: gate.retryAfter }),
              }],
            };
          }
          const result = await dbManager.withDb(slug, () => fn(args || {}, { slug }));
          // 计额度：读/搜索无论成败都算一次（它确实查了库）；写只算真的建出提案的，
          // 参数错被拒的不占额度——否则 AI 改两遍字段名就把自己锁死了。
          if (meta.rate && (meta.rate !== 'write' || (result && result.ok && result.proposal_id))) {
            mcpRateLimit.consume(slug, meta.rate);
          }
          if (meta.logRead) {
            // 记录失败绝不影响这次工具调用（观测不能反过来打断业务）
            try { dbManager.withDb(slug, () => logMcpRead(actor, tool, args, result)); } catch (_) { /* 忽略 */ }
          }
          // 自动执行单独留痕：这是「外部 AI 自己改了数据」，和读表不是一回事。
          // 只在真的执行过（result.auto）时记，未开启自动执行的普通提案不产生噪音。
          if (meta.logWrite && result && result.auto) {
            try { dbManager.withDb(slug, () => logMcpWrite(actor, tool, result)); } catch (_) { /* 忽略 */ }
          }
          return { content: [{ type: 'text', text: mcpTools.toContent(result) }] };
        } catch (e) {
          // 抛异常同样是「这次读没成功」，照样留痕：否则权限配错 / 库锁住时
          // 页面上一片空白，看起来像从来没人读过。
          if (meta.logRead) {
            try {
              dbManager.withDb(slug, () => logMcpRead(actor, tool, args, { ok: false, error: e.message }));
            } catch (_) { /* 忽略 */ }
          }
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }] };
        }
      };
      server.registerTool('list_tables', {
        title: '列出数据表',
        description: '列出本班可读的数据表及其说明，标注哪些表可写（写默认需老师确认）。',
      }, wrap(() => mcpTools.listTables(), { tool: 'list_tables', logRead: true, rate: 'read' }));

      server.registerTool('read_table', {
        title: '读取数据表',
        description: '按行读取一张行式数据表（如学生名单、请假、班费）。可分页。整块 JSON 表请用 read_doc。',
        inputSchema: z.object({
          table: z.string().describe('表名，取自 list_tables 的 key'),
          limit: z.number().int().min(1).max(mcpTools.MAX_ROWS).optional().describe('每页行数，默认 50，最多 200'),
          offset: z.number().int().min(0).optional().describe('偏移量，默认 0'),
        }),
      }, wrap(mcpTools.readTable, { tool: 'read_table', logRead: true, rate: 'read' }));

      server.registerTool('read_doc', {
        title: '读取整块文档',
        description: '读取整块 JSON 存储的单例表：当前课表/座位表/值日表/权重/模板等。',
        inputSchema: z.object({
          table: z.string().describe('整块文档表名，如 schedule / seat_layout / duty_layout'),
        }),
      }, wrap(mcpTools.readDoc, { tool: 'read_doc', logRead: true, rate: 'read' }));

      server.registerTool('search', {
        title: '全局搜索',
        description: '跨多张表搜索关键词，返回分组结果（口径与班集标题栏搜索一致）。',
        inputSchema: z.object({ q: z.string().describe('搜索词') }),
      }, wrap(mcpTools.search, { tool: 'search', logRead: true, rate: 'search' }));

      server.registerTool('propose_write', {
        title: '提交数据修改提案',
        description: '提交新增/修改/删除数据的提案。默认需老师在班集内确认后才执行；若老师开启了「自动执行」，创建后立即生效（返回 status=confirmed）。返回 proposal_id，可用 get_proposal_result 查询结果。',
        inputSchema: z.object({
          table: z.string().describe('要写入的表，须是 list_tables 中 writable 为 true 的 key'),
          operation: z.enum(['add', 'update', 'delete']).describe('操作类型'),
          id: z.number().int().optional().describe('修改/删除时的记录 id（add 不需要）'),
          data: z.record(z.string(), z.unknown()).optional().describe('字段→值的对象。add 为完整字段，update 为要改的字段'),
          label: z.string().optional().describe('给老师看的提案说明'),
        }),
      }, wrap(mcpTools.proposeWrite, { tool: 'propose_write', rate: 'write', logWrite: true }));

      // 批量：整批算一条提案，老师只确认一次。批量导入/批量改名必须用它，
      // 否则「40 个学生 = 40 条提案 = 点 40 次」——审核会被人肉绕过。
      server.registerTool('propose_batch', {
        title: '提交批量数据修改提案',
        description: '一次提交多条新增/修改/删除。整批算一条提案，默认由老师确认一次（开启自动执行时立即生效）；同一事务执行，任一条不通过则整批都不生效。批量导入、批量改名等场景用它，不要循环调用 propose_write。',
        inputSchema: z.object({
          ops: z.array(z.object({
            table: z.string().describe('要写入的表，须是 list_tables 中 writable 为 true 的 key'),
            operation: z.enum(['add', 'update', 'delete']).describe('操作类型'),
            id: z.number().int().optional().describe('修改/删除时的记录 id（add 不需要）'),
            data: z.record(z.string(), z.unknown()).optional().describe('字段→值的对象。add 为完整字段，update 为要改的字段'),
          })).min(1).max(mcpTools.MAX_BATCH_OPS).describe('按顺序执行的操作列表'),
          label: z.string().optional().describe('给老师看的提案说明，例如「导入 3 名学生」'),
        }),
      }, wrap(mcpTools.proposeBatch, { tool: 'propose_batch', rate: 'write', logWrite: true }));

      server.registerTool('get_proposal_result', {
        title: '查询提案结果',
        description: '用 propose_write / propose_batch 返回的 proposal_id 查询老师是否已确认，以及执行结果。',
        inputSchema: z.object({ proposal_id: z.string().describe('提案 id') }),
      }, wrap(mcpTools.getProposalResult, { tool: 'get_proposal_result' }));

      return server;
    };
    const { toNodeHandler } = require('@modelcontextprotocol/node');
    const handler = createMcpHandler(factory);
    return { nodeHandler: toNodeHandler(handler), handler };
  })();
  return _handlerPromise;
}

// slug 用 AsyncLocalStorage 传递：v2 的 factory 每请求新建、tool handler 与 HTTP 请求
// 在同一异步上下文，ALS 能把「token 绑定的 slug」送进工具而不进工具 schema，
// 外部客户端无法在 arguments 里伪造 slug 越权访问别的班级库。
const { AsyncLocalStorage } = require('node:async_hooks');
const MCP_SLUG_ALS = new AsyncLocalStorage();
// 令牌名（人读身份）：单独一条 ALS —— slug 是给工具层绑库用的，身份只用于访问记录，
// 不参与任何鉴权判断；不设也能跑（缺省空串，老调用与测试夹具零影响）。
const MCP_ACTOR_ALS = new AsyncLocalStorage();

// 读操作的访问记录：只落元信息（哪张表 / 多少行 / 结果），不复制任何数据内容。
// 「被拒」= 撞上老师的按表关闭（文案里带「设置中关闭」），这是权限真的生效的证据，
// 必须与普通失败分开记，否则事后无法证明那张表确实挡住了请求。
function logMcpRead(actor, tool, args, result) {
  const a = args || {};
  const r = result || {};
  const err = String(r.error || '');
  const denied = !r.ok && /设置中关闭/.test(err);
  let target = '';
  let detail = '';
  let amount = 0;
  if (tool === 'read_table' || tool === 'read_doc') {
    target = String(a.table || '');
    if (Array.isArray(r.rows)) {
      amount = r.rows.length;
      detail = `${amount} 行${typeof r.total === 'number' && r.total > amount ? ` / 共 ${r.total} 行` : ''}`;
    } else if (r.doc) {
      detail = '整块文档';
    }
  } else if (tool === 'search') {
    target = String(a.q || '');
    if (Array.isArray(r.groups)) {
      amount = r.groups.length;
      detail = `${amount} 组结果`;
    }
  } else if (tool === 'list_tables' && Array.isArray(r.tables)) {
    amount = r.tables.length;
    detail = `${amount} 张表`;
  }
  accessLog.record({
    source: 'mcp',
    actor,
    tool,
    target,
    detail,
    amount,
    result: denied ? 'denied' : (r.ok ? 'ok' : 'failed'),
    reason: r.ok ? '' : err,
  });
}

// 自动执行的访问记录。只落元信息（哪个工具 / 几条 / 成败），不复制任何数据内容。
// 老师开了「自动执行」之后，这里是他唯一能看到「AI 今天自己改了几次」的地方，
// 所以必须每次成功失败都记，且 detail 里写明是自动执行（和人工确认区分开）。
function logMcpWrite(actor, tool, result) {
  const r = result || {};
  const okFlag = String(r.status || '') === 'confirmed' && r.ok !== false;
  const err = String((r.result && r.result.error) || r.error || '');
  const n = Number(r.op_count) || 1;
  accessLog.record({
    source: 'mcp',
    actor,
    tool,
    target: '',
    detail: `${okFlag ? '自动执行' : '自动执行失败'} · ${n} 条`,
    amount: n,
    result: okFlag ? 'ok' : 'failed',
    reason: okFlag ? '' : err,
  });
}

// token 校验中间件：Bearer 或 MCP-Auth-Token 头。失败按 MCP JSON-RPC 错误返回 401。
function authMcp(req, res, next) {
  const header = req.get('authorization') || '';
  const bearer = /^Bearer\s+(.+)$/i.exec(header);
  const token = bearer ? bearer[1] : (req.get('mcp-auth-token') || '');
  const v = tokenStore.verify(token);
  if (!v.ok) {
    res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Invalid or revoked MCP token' }, id: null });
    return;
  }
  // 启用门禁：token 合法还不够，它绑定的那个班级库必须显式开着 MCP 服务。
  // opt-in 默认关闭——装了服务不等于对外开放。库没开时用 403 区分于「token 无效」。
  // 读开关要进 withDb(v.slug)（测试夹具里 withDb 被 stub 成直接执行，同样命中内存库）。
  let enabled = false;
  try { enabled = dbManager.withDb(v.slug, () => aiConfigStore.readMcpEnabled()); }
  catch (_) { enabled = false; }
  if (!enabled) {
    res.status(403).json({ jsonrpc: '2.0', error: { code: -32003, message: 'MCP service is disabled for this class' }, id: null });
    return;
  }
  req.mcpAuth = v;
  next();
}

// POST /mcp —— Streamable HTTP 端点
// Host/Origin 校验叠加在 SDK handler 前（SDK 自己不校验，文档要求在前面挂）。
// 应用层已有全局 Host 校验，这里用 SDK 的 localhost 校验再叠一层，且对无 Origin 的
// stdio 转发器请求放行（localhostOriginValidation 对缺失 Origin 返回 true）。
let _guards = null;
function guards() {
  if (!_guards) {
    const { localhostHostValidation, localhostOriginValidation } = require('@modelcontextprotocol/node');
    _guards = { host: localhostHostValidation(), origin: localhostOriginValidation() };
  }
  return _guards;
}

// 请求体解析必须排在 authMcp **之后**：鉴权前解析，等于让没有 token 的请求也能分配
// 一整份请求体的内存（应用层全局那个 200mb 解析器已对 /mcp 让路，见 app.js）。
// 上限 1mb：MCP 侧报文是 JSON-RPC 请求（批量提案 200 条也远不到 1mb），
// 大体积只出现在响应方向；超限由 body-parser 直接 413，不进 SDK。
const parseMcpJson = express.json({ limit: '1mb' });

router.post('/', authMcp, parseMcpJson, async (req, res, next) => {
  try {
    const g = guards();
    if (!g.host(req, res) || !g.origin(req, res)) return;
    const { nodeHandler } = await getHandler();
    // body 已由 parseMcpJson 解析，必须把 req.body 作为第三参传给 toNodeHandler，
    // 否则 SDK 会去读已消费的流 → "Parse error: Invalid JSON"（生产/测试同此路径）。
    await MCP_SLUG_ALS.run(req.mcpAuth.slug, () =>
      MCP_ACTOR_ALS.run(req.mcpAuth.label || '', () => nodeHandler(req, res, req.body)));
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  }
});

// GET/DELETE /mcp —— 2026-07-28 无状态模式下不需要 GET SSE；明确返回 405，
// 避免暴露一个会挂起的端点。
router.get('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: '仅支持 POST' }));
router.delete('/', (req, res) => res.status(405).set('Allow', 'POST').json({ error: '仅支持 POST' }));

module.exports = {
  router,
  getHandler,
  authMcp,
  MCP_SLUG_ALS,
  _resetForTest: () => { _handlerPromise = null; },
};
