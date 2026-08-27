import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createProjectGrant } from "../src/tools/authorization.js";
import { ProjectGrantStore, projectIdentity } from "../src/tools/project-grant-store.js";

test("ProjectGrantStore 私有持久化、撤销并绑定规范 workspace 身份", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-grants-"));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const file = path.join(root, "private", "grants.db");
  const store = new ProjectGrantStore(file);
  t.after(async () => {
    store.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  const grant = createProjectGrant({
    workspace,
    tool: "run_shell",
    capabilityHash: "capability",
    policyVersion: "policy",
    resources: [{ kind: "shell_command", value: "npm test", access: "execute" }],
  });

  store.issue(grant);
  assert.equal(store.list({ workspace }).length, 1);
  assert.equal(store.list({ workspace: path.join(workspace, "..", "workspace") })[0].projectId, projectIdentity(workspace));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  store.revoke(grant.id, "用户撤销");
  assert.deepEqual(store.list({ workspace }), []);
  assert.equal(store.list({ workspace, includeInactive: true })[0].revokedReason, "用户撤销");
});
