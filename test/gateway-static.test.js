import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { isGatewayStaticAsset, routeGatewayRequest } from "../src/gateway/server.js";

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
  assert.equal(isGatewayStaticAsset("/json-value-equality.js"), true);
  assert.equal(isGatewayStaticAsset("/../package.json"), false);
  assert.equal(isGatewayStaticAsset("/unknown.js"), false);
});

test("Gateway 可直接提供状态补丁及其共享依赖，不需要启动服务", async () => {
  const staticRoot = fileURLToPath(new URL("../src/web/", import.meta.url));
  for (const filename of ["state-patch.js", "json-value-equality.js"]) {
    const response = {
      writeHead(status, headers) { this.status = status; this.headers = headers; },
      end(body) { this.body = body; },
    };
    await routeGatewayRequest({ method: "GET", url: `/${filename}`, headers: {} }, response, {}, staticRoot);
    assert.equal(response.status, 200);
    assert.match(response.headers["content-type"], /^text\/javascript/);
    assert.deepEqual(response.body, readFileSync(new URL(`../src/${filename}`, import.meta.url)));
  }
});
