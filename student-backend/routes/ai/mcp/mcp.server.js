// =========================================================================
// mcp.server.js —— 方向 B：班集作为 MCP 服务端（本地 HTTP / Streamable HTTP）
//
// 关键设计（与《MCP接入方案》§方向 B 对齐）：
//   · 传输：挂在现有 Express（127.0.0.1:3000）的 /mcp，不新增监听端口，直接继承
//     应用层已有的 Host 校验 + CORS 白名单；SDK 自带 Host/Origin 校验再叠一层。
//   · 鉴权：独立 MCP token（services/mcpTokenStore），不碰 JWT / secureChannel。
//     token 绑定 dbSlug——每个工具调用都在 withDb(slug) 内执行，外部进程拿不到主密钥。
//   · SDK 懒加载：@modelcontextprotocol/* require 约 140ms，不放启动路径。首次 /mcp
//     请求才初始化 handler，之后复用。
//   · 写操作：propose_write 只建提案，get_proposal_result 查结果；真正写入由老师在
//     班集 UI 确认后走 mcpProposalExec.confirm（见 /api/mcp/proposals 路由）。
// =========================================================================

const express = require('express');
const dbManager = require('../../../dbManager/dbManager');
const tokenStore = require('../../../services/mcpTokenStore');
const mcpTools = require('../../../services/mcpTools');

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
      const wrap = (fn) => async (args) => {
        const slug = MCP_SLUG_ALS.getStore();
        if (!slug) return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: '未绑定班级库' }) }] };
        try {
          const result = await dbManager.withDb(slug, () => fn(args || {}));
          return { content: [{ type: 'text', text: mcpTools.toContent(result) }] };
        } catch (e) {
          return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }] };
        }
      };
      server.registerTool('list_tables', {
        title: '列出数据表',
        description: '列出本班可读的数据表及其说明，标注哪些表可写（写仍需老师确认）。',
      }, wrap(() => mcpTools.listTables()));

      server.registerTool('read_table', {
        title: '读取数据表',
        description: '按行读取一张行式数据表（如学生名单、请假、班费）。可分页。整块 JSON 表请用 read_doc。',
        inputSchema: z.object({
          table: z.string().describe('表名，取自 list_tables 的 key'),
          limit: z.number().int().min(1).max(mcpTools.MAX_ROWS).optional().describe('每页行数，默认 50，最多 200'),
          offset: z.number().int().min(0).optional().describe('偏移量，默认 0'),
        }),
      }, wrap(mcpTools.readTable));

      server.registerTool('read_doc', {
        title: '读取整块文档',
        description: '读取整块 JSON 存储的单例表：当前课表/座位表/值日表/权重/模板等。',
        inputSchema: z.object({
          table: z.string().describe('整块文档表名，如 schedule / seat_layout / duty_layout'),
        }),
      }, wrap(mcpTools.readDoc));

      server.registerTool('search', {
        title: '全局搜索',
        description: '跨多张表搜索关键词，返回分组结果（口径与班集标题栏搜索一致）。',
        inputSchema: z.object({ q: z.string().describe('搜索词') }),
      }, wrap(mcpTools.search));

      server.registerTool('propose_write', {
        title: '提交数据修改提案',
        description: '提交新增/修改/删除数据的提案。此工具不会立即改动数据，需老师在班集内确认后才会执行。返回 proposal_id，请用 get_proposal_result 查询结果。',
        inputSchema: z.object({
          table: z.string().describe('要写入的表，须是 list_tables 中 writable 为 true 的 key'),
          operation: z.enum(['add', 'update', 'delete']).describe('操作类型'),
          id: z.number().int().optional().describe('修改/删除时的记录 id（add 不需要）'),
          data: z.record(z.string(), z.unknown()).optional().describe('字段→值的对象。add 为完整字段，update 为要改的字段'),
          label: z.string().optional().describe('给老师看的提案说明'),
        }),
      }, wrap(mcpTools.proposeWrite));

      server.registerTool('get_proposal_result', {
        title: '查询提案结果',
        description: '用 propose_write 返回的 proposal_id 查询老师是否已确认，以及执行结果。',
        inputSchema: z.object({ proposal_id: z.string().describe('提案 id') }),
      }, wrap(mcpTools.getProposalResult));

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

router.post('/', authMcp, async (req, res, next) => {
  try {
    const g = guards();
    if (!g.host(req, res) || !g.origin(req, res)) return;
    const { nodeHandler } = await getHandler();
    // 应用层已 express.json() 解析过 body，必须把 req.body 作为第三参传给 toNodeHandler，
    // 否则 SDK 会去读已消费的流 → "Parse error: Invalid JSON"（生产/测试同此路径）。
    await MCP_SLUG_ALS.run(req.mcpAuth.slug, () => nodeHandler(req, res, req.body));
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
