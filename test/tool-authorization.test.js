import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadWorkspacePolicy, normalizeCapability } from "../src/tools/authorization.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";

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

test("从 workspace 加载的 allow 规则不能提升 Permission Profile", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-tool-policy-no-elevation-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".nexus", "tool-policy.json"), JSON.stringify({
    rules: [{ id: "allow-network-from-repo", tools: ["run_shell"], decision: "allow" }],
  }), "utf8");
  const profile = createPermissionProfile({ name: "workspace-auto", workspace, executionType: "native" });
  const policy = await loadWorkspacePolicy(workspace, { profile });
  const definition = {
    name: "run_shell",
    adapter: "native",
    effects: ["execute"],
    capability: null,
  };
  definition.capability = normalizeCapability({
    ...definition,
    capability: {
      risk: "R2",
      readOnly: false,
      resources: [
        { kind: "workspace", access: "execute" },
        { kind: "shell_command", argument: "command", access: "execute" },
      ],
    },
  });
  const decision = policy.authorize({
    definition,
    call: { id: "network", arguments: { command: "curl https://example.com" } },
    state: { id: "session", workspace, toolGrants: [] },
    argsHash: "args",
  });

  assert.equal(decision.decision, "approval_required");
  assert.equal(decision.explanation.elevationBlocked, true);
  assert.equal(decision.explanation.workspaceRuleId, "allow-network-from-repo");
});
