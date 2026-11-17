// =========================================================================
// mcp-forwarder.cjs —— 方向 B 的薄 stdio 转发器
//
// Claude Desktop / Cursor 拉起本脚本（stdio），本脚本作为 MCP 客户端连到班集后端
// 的 /mcp（Streamable HTTP），把后端的工具清单原样镜像到 stdio 侧，并把每次调用
// 转发过去。它只拿 URL + token，不碰主密钥 / secureChannel 密钥——那些永远留在
// 班集应用进程里。
//
// 配置（Claude Desktop 的 mcpServers 项）：
//   command: <node 或 ClassNest.exe --run-as-node>
//   args:    [<本脚本绝对路径>]
//   env:     CLASSNEST_MCP_URL=http://127.0.0.1:3000/mcp
//            CLASSNEST_MCP_TOKEN=<在班集设置页生成的 token>
//
// stdout 是 JSON-RPC 通道，任何日志必须走 stderr（见 serveStdio 文档）。
// 注意：打包版用 electron.exe + ELECTRON_RUN_AS_NODE=1 作为 node 运行时；
// 调用方须先 unset ELECTRON_RUN_AS_NODE（避免误判），由启动器按需设置。
// =========================================================================

const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { McpServer, createMcpHandler, fromJsonSchema } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');

const URL_ = String(process.env.CLASSNEST_MCP_URL || 'http://127.0.0.1:3000/mcp');
const TOKEN = String(process.env.CLASSNEST_MCP_TOKEN || '');

if (!TOKEN) {
  console.error('[classnest-mcp] 缺少 CLASSNEST_MCP_TOKEN，请在班集设置页生成 token 并配置到 env');
  process.exit(1);
}

async function main() {
  const client = new Client({ name: 'classnest-forwarder', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  console.error(`[classnest-mcp] 已连接到 ${URL_}`);

  // 从后端拉取工具清单，原样镜像——不在转发器里重复定义 schema。
  const { tools } = await client.listTools();
  console.error(`[classnest-mcp] 镜像 ${tools.length} 个工具`);

  // serveStdio 的 factory 每次连接调用一次：注册镜像工具，调用时转发到后端。
  const handle = serveStdio(() => {
    const server = new McpServer({ name: '班集', version: '1.0.0' });
    for (const tool of tools) {
      const jsonSchema = tool.inputSchema || { type: 'object', properties: {} };
      let inputSchema;
      try { inputSchema = fromJsonSchema(jsonSchema); }
      catch (_) { inputSchema = fromJsonSchema({ type: 'object', properties: {} }); }
      server.registerTool(
        tool.name,
        { title: tool.title || tool.name, description: tool.description || '', inputSchema },
        async (args) => {
          try {
            const res = await client.callTool({ name: tool.name, arguments: args || {} });
            return {
              content: Array.isArray(res.content) ? res.content : [{ type: 'text', text: JSON.stringify(res) }],
              ...(res.isError ? { isError: true } : {}),
            };
          } catch (e) {
            return { content: [{ type: 'text', text: JSON.stringify({ ok: false, error: e.message }) }], isError: true };
          }
        }
      );
    }
    // 客户端断开 pipe 时关闭后端连接，避免悬挂的 HTTP 会话
    server.server.onclose = () => { void client.close().catch(() => {}); };
    return server;
  });

  const shutdown = () => { void handle.close().finally(() => process.exit(0)); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('[classnest-mcp] 启动失败：' + (e && e.message));
  process.exit(1);
});
