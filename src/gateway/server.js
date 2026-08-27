// FOUNDATION — loopback-only HTTP/SSE shell around GatewaySessionManager.
import http from "node:http";
import { promises as fs } from "node:fs";
import path from "node:path";
import { GatewayError } from "./session-manager.js";

const STATIC_ASSETS = new Set(["/", "/app.js", "/styles.css", "/state-patch.js", "/keyboard.js", "/grants.js", "/plan-view.js"]);

export function isGatewayStaticAsset(pathname) {
  return STATIC_ASSETS.has(pathname);
}

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

  if (request.method === "GET" && staticRoot && isGatewayStaticAsset(url.pathname)) {
    await sendStatic(response, staticRoot, url.pathname);
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    sendJson(response, 200, { ok: true, service: "nexus-gateway", transport: ["http", "sse"] });
    return;
  }

  if (request.method === "GET" && url.pathname === "/runtime") {
    sendJson(response, 200, manager.runtimeInfo());
    return;
  }

  if (request.method === "GET" && url.pathname === "/sessions") {
    sendJson(response, 200, { sessions: manager.list() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/memories") {
    sendJson(response, 200, { memories: await manager.listMemories(url.searchParams.get("query") || "") });
    return;
  }

  if (request.method === "GET" && url.pathname === "/memory-candidates") {
    sendJson(response, 200, { candidates: await manager.listMemoryCandidates() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/memories") {
    const body = await readJson(request);
    sendJson(response, 201, { memory: await manager.addMemory(body.content, body.tags || []) });
    return;
  }

  if (request.method === "GET" && parts[0] === "memories" && parts[1] && parts.length === 2) {
    sendJson(response, 200, { memory: await manager.verifyMemory(parts[1]) });
    return;
  }

  if (request.method === "DELETE" && parts[0] === "memories" && parts[1] && parts.length === 2) {
    await manager.deleteMemory(parts[1], url.searchParams.get("reason") || "用户通过 Gateway 请求删除");
    sendJson(response, 200, { deleted: true });
    return;
  }

  if (request.method === "POST" && url.pathname === "/sessions") {
    const body = await readJson(request);
    const state = await manager.create({
      resume: body.resume,
      permissionProfile: body.permissionProfile,
      permissionConfirmation: body.permissionConfirmation,
    });
    sendJson(response, 201, { session: state });
    return;
  }

  if (request.method === "POST" && url.pathname === "/sessions/imports") {
    const body = await readJson(request, { maxBytes: 10_000_000 });
    if (!body.archive) throw new GatewayError(400, "archive 必须是 portable journal 对象");
    const state = await manager.importSession(body.archive, { id: body.id });
    sendJson(response, 201, { session: state });
    return;
  }

  if (parts[0] === "sessions" && parts[1]) {
    const id = parts[1];
    if (request.method === "GET" && parts.length === 2) {
      const view = await manager.view(id);
      sendJson(response, 200, {
        session: view.state,
        cursor: view.cursor,
      });
      return;
    }
    if (request.method === "GET" && parts[2] === "export" && parts.length === 3) {
      sendJson(response, 200, await manager.exportSession(id));
      return;
    }
    if (request.method === "GET" && parts[2] === "events" && parts.length === 3) {
      await openEventStream(request, response, manager, id, eventCursor(url, request));
      return;
    }
    if (request.method === "POST" && parts[2] === "memory-mutations" && parts[3] && parts.length === 5) {
      const mutationId = parts[3];
      const action = parts[4];
      const body = await readJson(request);
      let state;
      if (action === "retry") state = await manager.retryMemoryMutation(id, mutationId);
      else if (action === "discard") state = await manager.discardMemoryMutation(id, mutationId, body.reason);
      else if (action === "resolve") state = await manager.resolveMemoryMutation(id, mutationId, body.memoryId || null);
      else throw new GatewayError(404, "未知 Memory mutation 操作");
      sendJson(response, 200, { session: state });
      return;
    }
    if (request.method === "POST" && parts[2] === "memory-candidates" && parts[3] && parts.length === 5) {
      const memoryId = parts[3];
      const action = parts[4];
      const body = await readJson(request);
      if (action === "approve") {
        sendJson(response, 200, { memory: await manager.approveMemoryCandidate(id, memoryId) });
      } else if (action === "reject") {
        await manager.rejectMemoryCandidate(id, memoryId, body.reason || "用户拒绝候选记忆");
        sendJson(response, 200, { rejected: true });
      } else {
        throw new GatewayError(404, "未知候选记忆操作");
      }
      return;
    }
    if (request.method === "POST" && parts[2] === "messages" && parts.length === 3) {
      const body = await readJson(request);
      const state = await manager.sendMessage(id, body.content);
      sendJson(response, 202, { accepted: true, session: state });
      return;
    }
    if (request.method === "POST" && parts[2] === "permission-profile" && parts.length === 3) {
      const body = await readJson(request);
      const state = await manager.setPermissionProfile(id, body.profile, { confirmation: body.confirmation });
      sendJson(response, 200, { session: state });
      return;
    }
    if (request.method === "POST" && parts[2] === "branches" && parts.length === 3) {
      const body = await readJson(request);
      const state = await manager.branch(id, { cursor: body.cursor });
      sendJson(response, 201, { session: state });
      return;
    }
    if (request.method === "POST" && parts[2] === "cancel" && parts.length === 3) {
      const state = await manager.cancel(id);
      sendJson(response, 202, { accepted: true, session: state });
      return;
    }
    if (request.method === "POST" && parts[2] === "approvals" && parts[3] && parts.length === 4) {
      const body = await readJson(request);
      const state = await manager.decideApproval(id, parts[3], body.approved, body.scope || "once");
      sendJson(response, 202, { accepted: true, session: state });
      return;
    }
    if (request.method === "GET" && parts[2] === "grants" && parts.length === 3) {
      sendJson(response, 200, { grants: await manager.listGrants(id) });
      return;
    }
    if (request.method === "POST" && parts[2] === "grants" && parts[3] && parts[4] === "revoke" && parts.length === 5) {
      const body = await readJson(request);
      const grants = await manager.revokeGrant(id, parts[3], body.scope, body.reason);
      sendJson(response, 200, { grants });
      return;
    }
  }

  throw new GatewayError(404, "接口不存在");
}

async function openEventStream(request, response, manager, id, after) {
  await manager.get(id);
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.flushHeaders?.();
  const unsubscribe = await manager.subscribeEvents(id, (event) => {
    response.write(`id: ${event.cursor}\nevent: session_event\ndata: ${JSON.stringify(event)}\n\n`);
  }, { after });
  const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
  request.once("close", () => {
    clearInterval(heartbeat);
    unsubscribe();
  });
}

function eventCursor(url, request) {
  const query = parseCursor(url.searchParams.get("after"), "after");
  const lastEventId = parseCursor(request.headers["last-event-id"], "Last-Event-ID");
  return Math.max(query, lastEventId);
}

function parseCursor(value, label) {
  if (value === null || value === undefined || value === "") return 0;
  if (!/^\d+$/.test(String(value))) throw new GatewayError(400, `${label} 必须是非负整数`);
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor)) throw new GatewayError(400, `${label} 超出安全整数范围`);
  return cursor;
}

async function readJson(request, { maxBytes = 1_000_000 } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBytes) {
      throw new GatewayError(413, `请求体超过 ${formatByteLimit(maxBytes)}`);
    }
    chunks.push(buffer);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new GatewayError(400, "请求体必须是合法 JSON");
  }
}

function formatByteLimit(bytes) {
  return Number.isInteger(bytes / 1_000_000) ? `${bytes / 1_000_000} MB` : `${bytes} bytes`;
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
  const target = file === "state-patch.js" ? path.resolve(root, "..", file) : path.join(root, file);
  const body = await fs.readFile(target);
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
