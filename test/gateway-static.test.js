import assert from "node:assert/strict";
import test from "node:test";
import { isGatewayStaticAsset } from "../src/gateway/server.js";

test("Gateway 静态资源白名单包含 Web 子模块且拒绝任意路径", () => {
  assert.equal(isGatewayStaticAsset("/grants.js"), true);
  assert.equal(isGatewayStaticAsset("/plan-view.js"), true);
  assert.equal(isGatewayStaticAsset("/profile-view.js"), true);
  assert.equal(isGatewayStaticAsset("/artifact-view.js"), true);
  assert.equal(isGatewayStaticAsset("/context-view.js"), true);
  assert.equal(isGatewayStaticAsset("/session-projection.js"), true);
  assert.equal(isGatewayStaticAsset("/turn-view.js"), true);
  assert.equal(isGatewayStaticAsset("/task-navigation.js"), true);
  assert.equal(isGatewayStaticAsset("/execution-summary.js"), true);
  assert.equal(isGatewayStaticAsset("/inspector-shell.js"), true);
  assert.equal(isGatewayStaticAsset("/review-workspace.js"), true);
  assert.equal(isGatewayStaticAsset("/task-thread.js"), true);
  assert.equal(isGatewayStaticAsset("/composer.js"), true);
  assert.equal(isGatewayStaticAsset("/project-picker.js"), true);
  assert.equal(isGatewayStaticAsset("/keyboard.js"), false);
  assert.equal(isGatewayStaticAsset("/app.js"), true);
  assert.equal(isGatewayStaticAsset("/../package.json"), false);
  assert.equal(isGatewayStaticAsset("/unknown.js"), false);
});
