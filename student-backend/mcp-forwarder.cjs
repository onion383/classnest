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
//   env:     CLASSNEST_MCP_URL=<班集后端地址>/mcp（由设置页生成的配置自动填好）
//            CLASSNEST_MCP_TOKEN=<在班集设置页生成的 token>
//            CLASSNEST_RUNTIME_FILE=<userData>/runtime-port.json（可选，端口顺延时用来自愈）
//
// 端口为什么不能只信配置：后端首选端口被占用时会顺延（见 app.js MAX_PORT_TRIES），
// 而配置里的 URL 是复制那一刻的快照。这里按「env → 端口发现文件 → 默认端口」逐个试连，
// 已配好的客户端不用重配也能跟上新端口。发现逻辑见 mcpForwarderDiscovery.cjs。
//
// stdout 是 JSON-RPC 通道，任何日志必须走 stderr（见 serveStdio 文档）。
// 注意：打包版用 electron.exe + ELECTRON_RUN_AS_NODE=1 作为 node 运行时；
// 调用方须先 unset ELECTRON_RUN_AS_NODE（避免误判），由启动器按需设置。
// =========================================================================

const { Client, StreamableHTTPClientTransport } = require('@modelcontextprotocol/client');
const { McpServer, createMcpHandler, fromJsonSchema } = require('@modelcontextprotocol/server');
const { serveStdio } = require('@modelcontextprotocol/server/stdio');
const { readRuntimePort, buildCandidates, guessRuntimeFiles } = require('./mcpForwarderDiscovery.cjs');

// 默认端口兜底：开发模式下能读到 config/ports.cjs；打包版它在 asar 里读不到，
// 那时只靠 env 与端口发现文件。
function defaultPort() {
  try { return require('../config/ports.cjs').backendPort; } catch (_) { return 0; }
}

function resolveCandidates() {
  const explicitFile = process.env.CLASSNEST_RUNTIME_FILE;
  // 老配置没有这个 env：按常见 userData 目录猜几份（读不到就是空，成本可忽略）。
  const files = explicitFile ? [explicitFile] : guessRuntimeFiles();
  const runtimeEntries = files.map(readRuntimePort).filter(Boolean);
  return buildCandidates({
    envUrl: process.env.CLASSNEST_MCP_URL,
    runtimeEntries,
    defaultPort: defaultPort(),
  });
}

const TOKEN = String(process.env.CLASSNEST_MCP_TOKEN || '');

if (!TOKEN) {
  console.error('[classnest-mcp] 缺少 CLASSNEST_MCP_TOKEN，请在班集设置页生成 token 并配置到 env');
  process.exit(1);
}

async function main() {
  const candidates = resolveCandidates();
  console.error(`[classnest-mcp] 候选地址：${candidates.join(' | ') || '(空)'}`);

  // 逐个试连：第一个连上的就是当前活着的后端。连失败要 close，
  // 否则 Client 会留着半开的 transport 计时器。
  let client = null;
  let connectedUrl = '';
  const failures = [];
  for (const url of candidates) {
    const probe = new Client({ name: 'classnest-forwarder', version: '1.0.0' });
    let transport;
    try {
      // new URL 必须在 try 内：畸形候选地址会同步抛错，原先绕过连接失败的 catch
      // 直接冒到顶层（K01-05），一个坏地址就让整个转发器起不来。
      transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      });
      await probe.connect(transport);
      client = probe;
      connectedUrl = url;
      break;
    } catch (e) {
      failures.push(`${url}（${e && e.message}）`);
      try { await probe.close(); } catch (_) { /* best-effort: 未连接成功时 close 也可能抛 */ }
    }
  }
  if (!client) {
    throw new Error(
      failures.length
        ? `所有候选地址都连不上：${failures.join('；')}。请确认班集正在运行，或在设置页重新复制客户端配置`
        : '没有可用的后端地址，请在班集设置页重新复制客户端配置'
    );
  }
  console.error(`[classnest-mcp] 已连接到 ${connectedUrl}`);

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
    server.server.onclose = () => { void client.close().catch(() => {}); }; // best-effort: 客户端断开时后端连接可能已关闭
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
