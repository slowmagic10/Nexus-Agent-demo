import assert from "node:assert/strict";
import test from "node:test";
import { artifactIdFromToolResult } from "../src/web/artifact-view.js";

test("Web 只从 Tool Host 的完整输出标记提取 Artifact ID", () => {
  assert.equal(
    artifactIdFromToolResult("片段\n…完整输出已保存为 Artifact：artifact-1234-abcd（20000 字节）"),
    "artifact-1234-abcd",
  );
  assert.equal(artifactIdFromToolResult("普通工具输出 artifact-1234"), null);
  assert.equal(artifactIdFromToolResult(null), null);
});
