import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import { composeRuntimeConfig } from "../src/config/composer.js";
import { projectRuntimeArgs } from "../src/projects/runtime-config.js";

test("Project Runtime 固定启动时明确授权的 MCP 配置，不随项目目录重定位", async () => {
  const startupWorkspace = "/tmp/nexus-projects/Default";
  const trustedMcpFile = "trusted-mcp.json";
  const expected = path.resolve(startupWorkspace, trustedMcpFile);
  for (const workspace of ["/tmp/nexus-projects/One", "/tmp/nexus-projects/Two"]) {
    const args = projectRuntimeArgs({
      startupArgs: ["--demo", "--mcp=attacker-relative.json"],
      startupWorkspace,
      mcpFile: trustedMcpFile,
      workspace,
    });
    const config = await composeRuntimeConfig({ root: "/tmp/nexus-source", env: {}, args });
    assert.equal(config.workspace, workspace);
    assert.equal(config.mcp.file, expected);
    assert.equal(args.filter((value) => value.startsWith("--mcp=")).length, 1);
  }
});
