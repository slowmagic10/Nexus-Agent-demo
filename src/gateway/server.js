// FOUNDATION — loopback-only HTTP/SSE shell around GatewaySessionManager.
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GatewayError } from "./session-manager.js";

export function createGatewayServer({ manager, host = "127.0.0.1", port = 4317, staticRoot }) {
  if (!isLoopback(host)) throw new Error("基础版 Gateway 只允许绑定本机回环地址");

  const server = http.createServer(async (request, response) => {
    try {
      await route(request, response, manager, staticRoot);
    } catch (error) {
      if (response.headersSent) {
        response.end();
        return;
      }
      sendJson(response, error instanceof GatewayError ? error.status : 500, {
        error: error instanceof GatewayError ? error.message : "Gateway 内部错误",
      });
    }
  });

  return {
    async listen() {
      await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolve);
      });
      const address = server.address();
      return { host, port: address.port, url: `http://${host}:${address.port}` };
    },
    async close() {
      await manager.close();
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
    },
  };
}

async function route(request, response, manager, staticRoot) {
  const url = new URL(request.url, "http://localhost");
  const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  validateBrowserOrigin(request);
  if (request.method === "POST" && !request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
    throw new GatewayError(415, "POST 请求必须使用 application/json");
  }

  if (request.method === "GET" && staticRoot && ["/", "/app.js", "/styles.css"].includes(url.pathname)) {
    await sendStatic(response, staticRoot, url.pathname);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "nexus-gateway", transport: ["http", "sse"] });
    return;
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    sendJson(response, 200, { sessions: manager.list() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/memories") {
    sendJson(response, 200, { memories: manager.listMemories(url.searchParams.get("query") || "") });
    return;
  }

  if (request.method === "POST" && url.pathname === "/memories") {
    const body = await readJson(request);
    sendJson(response, 201, { memory: manager.addMemory(body.content, body.tags || []) });
    return;
  }

  if (request.method === "DELETE" && parts[0] === "memories" && parts[1] && parts.length === 2) {
    manager.deleteMemory(parts[1]);
    sendJson(response, 200, { deleted: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/sessions") {
    const body = await readJson(request);
    const state = manager.create({ resume: body.resume });
    sendJson(response, 201, { session: state });
    return;
  }

  if (parts[0] === "sessions" && parts[1]) {
    const id = parts[1];
    if (request.method === "GET" && parts.length === 2) {
      sendJson(response, 200, { session: manager.get(id) });
      return;
    }
    if (request.method === "GET" && parts[2] === "export" && parts.length === 3) {
      sendJson(response, 200, { exportedAt: new Date().toISOString(), session: manager.get(id) });
      return;
    }
    if (request.method === "GET" && parts[2] === "events" && parts.length === 3) {
      openEventStream(request, response, manager, id);
      return;
    }
    if (request.method === "POST" && parts[2] === "messages" && parts.length === 3) {
      const body = await readJson(request);
      const state = manager.sendMessage(id, body.content);
      sendJson(response, 202, { accepted: true, session: state });
      return;
    }
    if (request.method === "POST" && parts[2] === "cancel" && parts.length === 3) {
      const state = manager.cancel(id);
      sendJson(response, 202, { accepted: true, session: state });
      return;
    }
    if (request.method === "POST" && parts[2] === "approvals" && parts[3] && parts.length === 4) {
      const body = await readJson(request);
      const state = manager.decideApproval(id, parts[3], body.approved);
      sendJson(response, 202, { accepted: true, session: state });
      return;
    }
  }

  throw new GatewayError(404, "接口不存在");
}

function openEventStream(request, response, manager, id) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  const unsubscribe = manager.subscribe(id, (state) => {
    response.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);
  });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  request.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

async function readJson(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (Buffer.byteLength(body) > 1_000_000) throw new GatewayError(413, "请求体超过 1 MB");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new GatewayError(400, "请求体必须是合法 JSON");
  }
}

function sendJson(response, status, payload) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
  });
  response.end(body);
}

function isLoopback(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(host);
}

async function sendStatic(response, root, pathname) {
  const file = pathname === "/" ? "index.html" : pathname.slice(1);
  const body = await fs.readFile(path.join(root, file));
  const type = file.endsWith(".html") ? "text/html" : file.endsWith(".js") ? "text/javascript" : "text/css";
  response.writeHead(200, {
    "content-type": `${type}; charset=utf-8`,
    "content-length": body.length,
    "cache-control": "no-cache",
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(body);
}

function validateBrowserOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return;
  try {
    if (isLoopback(new URL(origin).hostname)) return;
  } catch {}
  throw new GatewayError(403, "拒绝来自非本机页面的请求");
}
