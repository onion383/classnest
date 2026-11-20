// =========================================================================
// mcp-live-connect-probe.cjs —— 用真实 MCP 客户端连**运行中的**后端，
// 验证 token 鉴权、工具清单、一次只读调用。
//
// 与 mcp-server.test.js 的分工：那边在内存库里测逻辑与边界；这边测「装好之后真的能连」，
// 覆盖传输层、Host/Origin 校验、令牌绑定这些只有在真实进程里才成立的环节。
// 只读，不建库、不改数据。
//
// 前置（缺一步都会失败）：
//   1. 启动应用，并在「设置 → MCP 服务管理」打开服务
//   2. 生成或复制一个有效令牌
//   3. 端口默认 3000；不同的话用 CLASSNEST_MCP_URL 覆盖
// 跑法：
//   CLASSNEST_MCP_TOKEN=<令牌> node testjs/probe/mcp-live-connect-probe.cjs
//   CLASSNEST_MCP_TOKEN=<令牌> CLASSNEST_MCP_URL=http://127.0.0.1:3000/mcp node testjs/probe/mcp-live-connect-probe.cjs
// 令牌只走环境变量：不写进文件，也不会被打印。
// 来历：2026-11-21 从 testjs/tmp 转正，tmp 里的原文件已删除，以本文件为准。
// =========================================================================
const path = require('node:path');
const { createRequire } = require('node:module');
const backendRequire = createRequire(path.resolve(__dirname, '../../student-backend/package.json'));
const { Client, StreamableHTTPClientTransport } = backendRequire('@modelcontextprotocol/client');

const URL_ = process.env.CLASSNEST_MCP_URL || 'http://127.0.0.1:3000/mcp';
const TOKEN = process.env.CLASSNEST_MCP_TOKEN || '';

async function main() {
  if (!TOKEN) throw new Error('缺少 CLASSNEST_MCP_TOKEN');
  const client = new Client({ name: 'classnest-connect-test', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(URL_), {
    requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
  });
  await client.connect(transport);
  console.log('[OK] initialize 握手成功');

  const { tools } = await client.listTools();
  console.log(`[OK] 工具清单 ${tools.length} 个: ${tools.map((t) => t.name).join(', ')}`);

  if (tools.some((t) => t.name === 'list_tables')) {
    const res = await client.callTool({ name: 'list_tables', arguments: {} });
    console.log('[OK] list_tables 返回:', JSON.stringify(res).slice(0, 600));
  }
  await client.close();
}

main().catch((e) => {
  console.error('[FAIL]', (e && e.message) || e);
  process.exit(1);
});
