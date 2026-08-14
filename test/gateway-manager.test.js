import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GatewaySessionManager } from "../src/gateway/session-manager.js";
import { SessionStore } from "../src/persistence/session-store.js";

test("关闭 Gateway 会取消仍在运行的任务", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-gateway-test-"));
  const store = new SessionStore(path.join(workspace, ".nexus", "nexus.db"));
  t.after(async () => {
    store.close();
    await fs.rm(workspace, { recursive: true, force: true });
  });

  const provider = {
    name: "waiting-provider",
    complete: async ({ signal }) => new Promise((resolve, reject) => {
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    }),
  };
  const manager = new GatewaySessionManager({
    workspace,
    provider,
    tools: { schemas: () => [], get: () => null },
    systemPrompt: () => "test",
    store,
  });
  const session = manager.create();
  manager.sendMessage(session.id, "保持运行");

  await manager.close();

  assert.equal(manager.get(session.id).phase, "cancelled");
  assert.equal(manager.get(session.id).lastError, "Gateway 正在关闭");
});
