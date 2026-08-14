// FOUNDATION — local MCP stdio client for Tools, Resources and Prompts.
import { spawn } from "node:child_process";
import readline from "node:readline";

const PROTOCOL_VERSION = "2025-06-18";

export class McpStdioClient {
  constructor({ name, command, args = [], env = {}, cwd, timeout = 30_000 }) {
    this.name = name;
    this.timeout = timeout;
    this.nextId = 1;
    this.pending = new Map();
    this.stderr = "";
    this.closed = false;
    this.child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
    });
    this.lines = readline.createInterface({ input: this.child.stdout });
    this.lines.on("line", (line) => this.onLine(line));
    this.child.stderr.on("data", (chunk) => {
      this.stderr = `${this.stderr}${chunk}`.slice(-4_000);
    });
    this.child.stdin.on("error", (error) => this.failAll(error));
    this.child.once("error", (error) => this.failAll(error));
    this.child.once("exit", (code, signal) => {
      this.closed = true;
      this.failAll(new Error(`MCP 服务器 ${name} 已退出（code=${code}, signal=${signal}）${this.stderr ? `\n${this.stderr.trim()}` : ""}`));
    });
  }

  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "nexus-agent", version: "0.2.0" },
    }, 10_000);
    if (result?.protocolVersion !== PROTOCOL_VERSION || !result?.serverInfo) {
      throw new Error(`MCP 服务器 ${this.name} 返回了无效 initialize 结果`);
    }
    this.notify("notifications/initialized");
    return result;
  }

  async listTools() {
    return this.listPaginated("tools/list", "tools");
  }

  async listResources() {
    return this.listPaginated("resources/list", "resources");
  }

  async listResourceTemplates() {
    return this.listPaginated("resources/templates/list", "resourceTemplates");
  }

  readResource(uri, signal) {
    return this.request("resources/read", { uri }, this.timeout, signal);
  }

  async listPrompts() {
    return this.listPaginated("prompts/list", "prompts");
  }

  getPrompt(name, argumentsValue, signal) {
    return this.request("prompts/get", { name, arguments: argumentsValue || {} }, this.timeout, signal);
  }

  async listPaginated(method, field) {
    const tools = [];
    let cursor;
    let pages = 0;
    do {
      pages += 1;
      if (pages > 100) throw new Error(`MCP 服务器 ${this.name} 的工具分页超过安全上限`);
      const result = await this.request(method, cursor ? { cursor } : {});
      if (!Array.isArray(result?.[field])) throw new Error(`MCP 服务器 ${this.name} 返回了无效 ${field} 列表`);
      tools.push(...result[field]);
      cursor = result.nextCursor;
    } while (cursor);
    return tools;
  }

  callTool(name, argumentsValue, signal) {
    return this.request("tools/call", { name, arguments: argumentsValue || {} }, this.timeout, signal);
  }

  request(method, params = {}, timeout = this.timeout, signal) {
    if (this.closed) return Promise.reject(new Error(`MCP 服务器 ${this.name} 已关闭`));
    if (signal?.aborted) return Promise.reject(signal.reason || new Error("任务已取消"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        signal?.removeEventListener("abort", onAbort);
        reject(new Error(`MCP 请求超时：${this.name}/${method}`));
      }, timeout);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        this.notify("notifications/cancelled", { requestId: id, reason: signal.reason?.message || "任务已取消" });
        reject(signal.reason || new Error("任务已取消"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.set(id, { resolve, reject, timer, method, signal, onAbort });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method, params = {}) {
    if (!this.closed) this.send({ jsonrpc: "2.0", method, params });
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.lines.close();
    this.child.stdin.end();
    this.child.kill("SIGTERM");
    this.failAll(new Error(`MCP 服务器 ${this.name} 已关闭`));
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`, (error) => {
      if (error) this.failAll(error);
    });
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      const error = new Error(`MCP 服务器 ${this.name} 输出了无效 JSON：${line.slice(0, 300)}`);
      this.closed = true;
      this.child.kill("SIGTERM");
      this.failAll(error);
      return;
    }
    if (message.id !== undefined && (message.result !== undefined || message.error)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(`MCP ${pending.method} 失败：${message.error.message}`));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined && message.method) {
      const result = message.method === "ping" ? {} : null;
      this.send(result === null
        ? { jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Nexus 基础版不支持该客户端能力" } }
        : { jsonrpc: "2.0", id: message.id, result });
    }
  }

  failAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener("abort", pending.onAbort);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
