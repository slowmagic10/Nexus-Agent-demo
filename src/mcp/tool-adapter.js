// FOUNDATION — maps MCP capabilities into Nexus tool registry entries.
import { McpStdioClient } from "./stdio-client.js";

export async function connectMcpTools(configs) {
  const clients = [];
  const tools = [];
  const names = new Set();
  try {
    for (const config of configs) {
      const client = new McpStdioClient(config);
      clients.push(client);
      const initialized = await client.initialize();
      const serverTools = initialized.capabilities?.tools ? await client.listTools() : [];
      for (const tool of serverTools) {
        validateTool(config.name, tool);
        const exposedName = exposeName(config.name, tool.name);
        if (names.has(exposedName)) throw new Error(`MCP 工具名称冲突：${exposedName}`);
        names.add(exposedName);
        tools.push({
          name: exposedName,
          description: `[MCP: ${initialized.serverInfo.name}] ${tool.description || tool.title || tool.name}。外部工具，按 Workspace Policy 与 Session Grant 授权。`,
          approval: "always",
          effects: ["network"],
          idempotency: "unknown",
          adapter: "mcp",
          capability: mcpCapability(config.name, false),
          parameters: tool.inputSchema,
          execute: async (args, context) => formatToolResult(await client.callTool(tool.name, args, context.signal)),
        });
      }
      if (initialized.capabilities?.resources) {
        addTool(tools, names, {
          name: exposeName(config.name, "resources_list"),
          description: `[MCP: ${initialized.serverInfo.name}] 列出服务器公开的 Resources 与 Resource Templates。外部网络读取，未获 Session Grant 时需要审批。`,
          approval: "always",
          effects: ["read", "network"],
          idempotency: "safe",
          adapter: "mcp",
          capability: mcpCapability(config.name, true),
          parameters: objectSchema({}),
          execute: async () => JSON.stringify({
            resources: await client.listResources(),
            templates: await client.listResourceTemplates(),
          }, null, 2),
        });
        addTool(tools, names, {
          name: exposeName(config.name, "resource_read"),
          description: `[MCP: ${initialized.serverInfo.name}] 按 URI 读取 Resource。外部网络读取，未获 Session Grant 时需要审批。`,
          approval: "always",
          effects: ["read", "network"],
          idempotency: "safe",
          adapter: "mcp",
          capability: mcpCapability(config.name, true),
          parameters: objectSchema({ uri: { type: "string" } }, ["uri"]),
          execute: async ({ uri }, context) => formatResourceResult(await client.readResource(uri, context.signal)),
        });
      }
      if (initialized.capabilities?.prompts) {
        addTool(tools, names, {
          name: exposeName(config.name, "prompts_list"),
          description: `[MCP: ${initialized.serverInfo.name}] 列出服务器公开的 Prompts。外部网络读取，未获 Session Grant 时需要审批。`,
          approval: "always",
          effects: ["read", "network"],
          idempotency: "safe",
          adapter: "mcp",
          capability: mcpCapability(config.name, true),
          parameters: objectSchema({}),
          execute: async () => JSON.stringify(await client.listPrompts(), null, 2),
        });
        addTool(tools, names, {
          name: exposeName(config.name, "prompt_get"),
          description: `[MCP: ${initialized.serverInfo.name}] 获取一个 Prompt 及其消息。外部网络读取，未获 Session Grant 时需要审批。`,
          approval: "always",
          effects: ["read", "network"],
          idempotency: "safe",
          adapter: "mcp",
          capability: mcpCapability(config.name, true),
          parameters: objectSchema({
            name: { type: "string" },
            arguments: { type: "object", additionalProperties: { type: "string" } },
          }, ["name"]),
          execute: async ({ name, arguments: args = {} }, context) => formatPromptResult(await client.getPrompt(name, args, context.signal)),
        });
      }
    }
    return {
      tools,
      servers: configs.map((config) => config.name),
      close: () => Promise.allSettled(clients.map((client) => client.close())),
    };
  } catch (error) {
    await Promise.allSettled(clients.map((client) => client.close()));
    throw error;
  }
}

function validateTool(server, tool) {
  if (!tool || typeof tool.name !== "string" || !tool.name) throw new Error(`MCP 服务器 ${server} 返回了无效工具`);
  if (!tool.inputSchema || tool.inputSchema.type !== "object") {
    throw new Error(`MCP 工具 ${server}/${tool.name} 缺少 object inputSchema`);
  }
}

function exposeName(server, tool) {
  const safeTool = tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  const value = `mcp__${server}__${safeTool}`;
  if (value.length > 64) throw new Error(`MCP 工具名称超过 64 字符：${server}/${tool}`);
  return value;
}

function addTool(tools, names, tool) {
  if (names.has(tool.name)) throw new Error(`MCP 工具名称冲突：${tool.name}`);
  names.add(tool.name);
  tools.push(tool);
}

function objectSchema(properties, required = []) {
  return { type: "object", properties, required, additionalProperties: false };
}

function mcpCapability(server, readOnly) {
  return {
    risk: "R2",
    readOnly,
    resources: [{ kind: "mcp_server", value: server, access: readOnly ? "read" : "write" }],
  };
}

function formatToolResult(result) {
  const parts = [];
  for (const item of result?.content || []) {
    if (item.type === "text") parts.push(item.text);
    else if (item.type === "resource_link") parts.push(`[资源] ${item.name || item.uri}: ${item.uri}`);
    else if (item.type === "resource") parts.push(`[嵌入资源] ${item.resource?.uri || "unknown"}`);
    else if (item.type === "image") parts.push(`[图片 ${item.mimeType || "unknown"}，${item.data?.length || 0} 字符]`);
    else if (item.type === "audio") parts.push(`[音频 ${item.mimeType || "unknown"}，${item.data?.length || 0} 字符]`);
    else parts.push(JSON.stringify(item));
  }
  if (result?.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent, null, 2));
  const raw = parts.filter(Boolean).join("\n\n") || "（MCP 工具无输出）";
  const output = raw.length > 12_000 ? `${raw.slice(0, 12_000)}\n…（已截断）` : raw;
  if (result?.isError) throw new Error(output);
  return output;
}

function formatResourceResult(result) {
  return (result?.contents || []).map((item) => {
    if (item.text !== undefined) return `${item.uri}\n${item.text}`;
    return `${item.uri}\n[${item.mimeType || "binary"} blob，${item.blob?.length || 0} 字符]`;
  }).join("\n\n") || "（Resource 无内容）";
}

function formatPromptResult(result) {
  const messages = (result?.messages || []).map((message) => {
    const content = message.content?.type === "text" ? message.content.text : JSON.stringify(message.content);
    return `${message.role}: ${content}`;
  });
  return [result?.description, ...messages].filter(Boolean).join("\n\n") || "（Prompt 无内容）";
}
