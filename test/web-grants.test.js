import assert from "node:assert/strict";
import test from "node:test";
import {
  grantExpiryLabel,
  grantResourceLabel,
  grantScopeLabel,
  grantViewModel,
} from "../src/web/grants.js";

test("Grant UI 将 scope、资源和到期时间转换成安全可读视图", () => {
  const now = Date.parse("2026-08-26T00:00:00.000Z");
  const grant = {
    id: "grant-1",
    scope: "project",
    tool: "run_shell",
    resources: [{ kind: "shell_command", valueHash: "1234567890abcdef", access: "execute", match: "exact" }],
    issuedAt: "2026-08-25T00:00:00.000Z",
    expiresAt: "2026-08-28T00:00:00.000Z",
    capabilityHash: "must-not-render",
    policyVersion: "must-not-render",
  };

  assert.equal(grantScopeLabel("project"), "本项目");
  assert.equal(grantExpiryLabel(grant.expiresAt, now), "2 天后到期");
  assert.equal(grantResourceLabel(grant.resources[0]), "Shell 命令 · 摘要 1234567890ab");
  assert.deepEqual(grantViewModel(grant, { scope: "project", now }), {
    id: "grant-1",
    scope: "project",
    scopeLabel: "本项目",
    tool: "run_shell",
    resources: ["Shell 命令 · 摘要 1234567890ab"],
    issuedAt: grant.issuedAt,
    expiresAt: grant.expiresAt,
    expiryLabel: "2 天后到期",
  });
});

test("Grant UI 覆盖 once/session 与常见资源类型", () => {
  assert.equal(grantScopeLabel("once"), "仅本次");
  assert.equal(grantScopeLabel("session"), "本会话");
  assert.equal(grantResourceLabel({ kind: "workspace_path", value: "notes/a.md", access: "write" }), "写入 notes/a.md");
  assert.equal(grantResourceLabel({ kind: "workspace", value: ".", access: "execute" }), "当前工作区 · 执行");
  assert.equal(grantResourceLabel({ kind: "memory_scope", value: "scope-hash", access: "write" }), "长期记忆范围 · 写入");
  assert.equal(grantExpiryLabel("2026-08-26T00:00:20.000Z", Date.parse("2026-08-26T00:00:00.000Z")), "不到 1 分钟到期");
  assert.equal(grantExpiryLabel("2026-08-25T23:59:59.000Z", Date.parse("2026-08-26T00:00:00.000Z")), "已过期");
});
