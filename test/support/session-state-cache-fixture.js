import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { AgentSession } from "../../src/core/session.js";
import { createSession, reduceSession } from "../../src/core/state.js";
import { GatewaySessionManager } from "../../src/gateway/session-manager.js";
import { attachSessionStateCache } from "../../src/gateway/session-state-cache.js";
import { SessionStore } from "../../src/persistence/session-store.js";

export function createStateCacheFixture({ eager = false, turns = 4, beforeAttach } = {}) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "nexus-state-cache-"));
  const workspace = "/synthetic-gateway-state-cache";
  const store = new SessionStore(path.join(directory, "session.db"), { workspace, checkpointInterval: 100 });
  try {
    const seed = createSession({ id: "synthetic-gateway-state-cache", provider: "offline-cache",
      workspace, createdAt: cacheActionTime(0) });
    for (let index = 0; index < turns; index++) {
      seed.messages.push({ role: "user", content: `合成请求 ${index}` },
        { role: "assistant", content: "读取文件", tool_calls: [{ id: `call-${index}`, type: "function",
          function: { name: "read_file", arguments: JSON.stringify({ path: `${index}.txt` }) } }] },
        { role: "tool", tool_call_id: `call-${index}`, content: "合成历史 ABC 中文。".repeat(120) },
        { role: "assistant", content: "历史任务已完成" });
    }
    const session = new AgentSession({ state: seed, reducer: reduceSession, journal: store });
    const nativeUpdate = GatewaySessionManager.prototype.update;
    const manager = { store, update: nativeUpdate };
    const entry = { session, state: session.state, subscribers: new Set() };
    beforeAttach?.({ store, session, manager, entry });
    if (eager) {
      // Frozen stage-19 binding; only the Gateway cache subscription differs.
      session.subscribe((next) => manager.update(entry, next));
    } else {
      attachSessionStateCache(entry, manager, nativeUpdate);
    }
    return { store, session, manager, entry, seed,
      close() { session.close(); store.close(); rmSync(directory, { recursive: true, force: true }); } };
  } catch (error) {
    store.close();
    rmSync(directory, { recursive: true, force: true });
    throw error;
  }
}

export function cacheActionTime(index) { return new Date(Date.UTC(2026, 8, 10, 0, 0, index)).toISOString(); }

export async function countStateClones(operation, sessionId = "synthetic-gateway-state-cache") {
  const clone = globalThis.structuredClone;
  const metrics = { structuredCloneCalls: 0, fullStateClones: 0, cloneInputJsonUtf8Bytes: 0, fullStateCloneInputJsonUtf8Bytes: 0 };
  globalThis.structuredClone = function (value, ...options) {
    metrics.structuredCloneCalls++;
    const bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
    metrics.cloneInputJsonUtf8Bytes += bytes;
    if (value?.id === sessionId && Array.isArray(value.messages) && Array.isArray(value.events)) {
      metrics.fullStateClones++;
      metrics.fullStateCloneInputJsonUtf8Bytes += bytes;
    }
    return Reflect.apply(clone, globalThis, [value, ...options]);
  };
  try { return { result: await operation(), metrics }; }
  finally { globalThis.structuredClone = clone; }
}
