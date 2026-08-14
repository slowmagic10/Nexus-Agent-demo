// FOUNDATION — explicit stdio MCP configuration; commands are never run through a shell.
import { promises as fs } from "node:fs";
import path from "node:path";

export async function loadMcpConfig(file, workspace) {
  if (!file) return [];
  const target = path.resolve(workspace, file);
  let payload;
  try {
    payload = JSON.parse(await fs.readFile(target, "utf8"));
  } catch (error) {
    throw new Error(`无法读取 MCP 配置 ${target}：${error.message}`);
  }
  if (!payload?.servers || typeof payload.servers !== "object" || Array.isArray(payload.servers)) {
    throw new Error("MCP 配置必须包含 servers 对象");
  }

  return Object.entries(payload.servers).map(([name, config]) => {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) throw new Error(`MCP 服务器名称不合法：${name}`);
    if (!config || typeof config.command !== "string" || !config.command.trim()) {
      throw new Error(`MCP 服务器 ${name} 缺少 command`);
    }
    if (config.args !== undefined && (!Array.isArray(config.args) || !config.args.every((arg) => typeof arg === "string"))) {
      throw new Error(`MCP 服务器 ${name} 的 args 必须是字符串数组`);
    }
    if (config.env !== undefined && (!config.env || typeof config.env !== "object" || Array.isArray(config.env))) {
      throw new Error(`MCP 服务器 ${name} 的 env 必须是对象`);
    }
    const env = {};
    for (const [key, value] of Object.entries(config.env || {})) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string") {
        throw new Error(`MCP 服务器 ${name} 包含无效环境变量：${key}`);
      }
      env[key] = value;
    }
    return { name, command: config.command, args: config.args || [], env, cwd: workspace };
  });
}
