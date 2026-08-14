#!/usr/bin/env node
// DEMO — deterministic local MCP server for exercising Nexus's stdio client.
import readline from "node:readline";

const input = readline.createInterface({ input: process.stdin });
input.on("line", (line) => {
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  if (message.method === "initialize") {
    reply(message.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {}, resources: {}, prompts: {} },
      serverInfo: { name: "nexus-echo", version: "0.2.0" },
    });
    return;
  }
  if (message.method === "tools/list") {
    reply(message.id, {
      tools: [{
        name: "echo",
        description: "原样返回输入文本，用于验证 MCP 工具调用闭环",
        inputSchema: {
          type: "object",
          properties: { text: { type: "string" } },
          required: ["text"],
          additionalProperties: false,
        },
      }],
    });
    return;
  }
  if (message.method === "tools/call") {
    if (message.params?.name !== "echo") {
      failure(message.id, -32602, "未知工具");
      return;
    }
    reply(message.id, {
      content: [{ type: "text", text: `Echo: ${message.params.arguments?.text || ""}` }],
      isError: false,
    });
    return;
  }
  if (message.method === "resources/list") {
    reply(message.id, { resources: [{ uri: "nexus://echo/about", name: "Echo About", mimeType: "text/plain" }] });
    return;
  }
  if (message.method === "resources/templates/list") {
    reply(message.id, { resourceTemplates: [] });
    return;
  }
  if (message.method === "resources/read") {
    if (message.params?.uri !== "nexus://echo/about") return failure(message.id, -32602, "未知资源");
    reply(message.id, { contents: [{ uri: "nexus://echo/about", mimeType: "text/plain", text: "Nexus Echo MCP resource" }] });
    return;
  }
  if (message.method === "prompts/list") {
    reply(message.id, {
      prompts: [{ name: "echo_prompt", description: "生成回显提示", arguments: [{ name: "text", required: true }] }],
    });
    return;
  }
  if (message.method === "prompts/get") {
    if (message.params?.name !== "echo_prompt") return failure(message.id, -32602, "未知 Prompt");
    reply(message.id, {
      description: "Echo prompt",
      messages: [{ role: "user", content: { type: "text", text: `Echo this: ${message.params.arguments?.text || ""}` } }],
    });
    return;
  }
  if (message.id !== undefined && message.method !== "notifications/initialized") {
    failure(message.id, -32601, "方法不存在");
  }
});

function reply(id, result) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

function failure(id, code, message) {
  process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`);
}
