import assert from "node:assert/strict";
import test from "node:test";
import { isGatewayStaticAsset } from "../src/gateway/server.js";

test("Gateway 静态资源白名单包含 Web 子模块且拒绝任意路径", () => {
  assert.equal(isGatewayStaticAsset("/grants.js"), true);
  assert.equal(isGatewayStaticAsset("/plan-view.js"), true);
  assert.equal(isGatewayStaticAsset("/app.js"), true);
  assert.equal(isGatewayStaticAsset("/../package.json"), false);
  assert.equal(isGatewayStaticAsset("/unknown.js"), false);
});
