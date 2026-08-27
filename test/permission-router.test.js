import assert from "node:assert/strict";
import test from "node:test";
import { PermissionToolHostRouter } from "../src/tools/permission-router.js";

test("PermissionToolHostRouter 按 durable Session profile 路由 schema 与执行", async () => {
  const calls = [];
  const host = (profile) => ({
    schemas: () => [{ type: "function", function: { name: profile } }],
    execute: async (call) => { calls.push({ profile, call }); return profile; },
  });
  const router = new PermissionToolHostRouter({
    hosts: {
      "approval-required": host("approval-required"),
      "workspace-confirm": host("workspace-confirm"),
      "workspace-auto": host("workspace-auto"),
    },
    defaultProfile: "workspace-auto",
  });
  const session = { state: { permissionProfile: "approval-required" } };

  assert.equal(router.schemas({ session })[0].function.name, "approval-required");
  assert.equal(await router.execute({ id: "call", name: "test", arguments: {} }, { session }), "approval-required");
  assert.equal(router.schemas()[0].function.name, "workspace-auto");
  assert.deepEqual(router.profiles(), ["approval-required", "workspace-confirm", "workspace-auto"]);
  assert.equal(router.has("danger-full-access"), false);
  assert.equal(calls[0].profile, "approval-required");
});
