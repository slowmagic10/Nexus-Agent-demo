import assert from "node:assert/strict";
import test from "node:test";
import { formatMaxSteps, parseMaxSteps, readRuntimeOptions } from "../src/runtime-options.js";

test("步骤上限默认是八步并支持命令行覆盖环境变量", () => {
  assert.equal(readRuntimeOptions([], {}).maxSteps, 8);
  assert.equal(readRuntimeOptions([], { NEXUS_MAX_STEPS: "24" }).maxSteps, 24);
  assert.equal(readRuntimeOptions(["--max-steps=12"], { NEXUS_MAX_STEPS: "24" }).maxSteps, 12);
});

test("unlimited 和 0 都表示无限步骤", () => {
  assert.equal(parseMaxSteps("unlimited"), Infinity);
  assert.equal(parseMaxSteps("0"), Infinity);
  assert.equal(formatMaxSteps(Infinity), "不限制");
});

test("无效步骤配置会在启动时明确失败", () => {
  assert.throws(() => parseMaxSteps("many"), /正整数/);
  assert.throws(() => parseMaxSteps("-1"), /正整数/);
});
