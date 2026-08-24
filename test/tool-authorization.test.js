import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadWorkspacePolicy, normalizeCapability } from "../src/tools/authorization.js";

test("Workspace Policy 从 .nexus/tool-policy.json 加载简单 JSON 规则", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-tool-policy-test-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".nexus", "tool-policy.json"), JSON.stringify({
    rules: [{ id: "deny-shell", tools: ["run_shell"], effects: ["execute"], decision: "deny" }],
  }), "utf8");

  const policy = await loadWorkspacePolicy(workspace);
  const definition = {
    name: "run_shell",
    adapter: "native",
    effects: ["execute"],
    capability: null,
  };
  definition.capability = normalizeCapability(definition);

  assert.match(policy.version, /^[a-f0-9]{64}$/);
  assert.equal(policy.canExpose(definition), false);
});
