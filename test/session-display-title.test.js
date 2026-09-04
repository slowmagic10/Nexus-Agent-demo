import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveSessionDisplayTitle,
  normalizeSessionDisplayTitle,
  PROTECTED_SESSION_DISPLAY_TITLE,
  resolveSessionDisplayTitle,
} from "../src/core/session-display-title.js";

test("Session Display Title 统一压缩空白并限制长度", () => {
  assert.equal(normalizeSessionDisplayTitle("  修复\n登录页面  "), "修复 登录页面");
  assert.equal(normalizeSessionDisplayTitle("甲".repeat(60)), `${"甲".repeat(48)}…`);
});

test("Session Display Title 不暴露凭据、账号或网络端点", () => {
  for (const value of [
    "用 sk-1234567890abcdef 连接模型",
    "登录密码是 'Naddod@123'",
    "SSH 到 root@192.168.121.110 部署",
    "访问 https://internal.example.com/admin",
    "服务器地址: prod.internal",
  ]) {
    assert.equal(normalizeSessionDisplayTitle(value), PROTECTED_SESSION_DISPLAY_TITLE, value);
  }
});

test("Session Display Title 优先使用安全的 durable 自定义标题", () => {
  const messages = [{ role: "user", content: "分析项目结构" }];
  assert.equal(deriveSessionDisplayTitle(messages), "分析项目结构");
  assert.equal(resolveSessionDisplayTitle({ displayTitle: "架构复盘", messages }), "架构复盘");
  assert.equal(resolveSessionDisplayTitle({ displayTitle: null, messages }), "分析项目结构");
  assert.equal(resolveSessionDisplayTitle({ displayTitle: null, messages: [] }), "新任务");
});
