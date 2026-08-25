import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  composeRuntimeConfig,
  createConfiguredProvider,
  inspectRuntimeConfig,
} from "../src/config/composer.js";

test("Config Composition 默认生成可运行的 Demo 配置", async () => {
  const config = await composeRuntimeConfig({ root: "/tmp", env: {} });

  assert.equal(config.workspace, "/tmp");
  assert.equal(config.provider.type, "demo");
  assert.equal(config.provider.model, "gpt-4.1-mini");
  assert.equal(config.runtime.maxSteps, 8);
  assert.equal(config.gateway.port, 4317);
  assert.equal(config.sources["provider.type"], "derived:default");
  assert.equal(createConfiguredProvider(config).name, "offline-demo");
});

test("配置按 profile、local、environment、CLI 的确定顺序覆盖", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-compose-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({
    provider: { type: "openai-compatible", model: "profile-model", baseUrl: "https://profile.example/v1" },
    runtime: { maxSteps: 10 },
    gateway: { port: 4100 },
  }), "utf8");
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    provider: { apiKey: "local-secret", model: "local-model" },
    runtime: { maxSteps: 20 },
  }), "utf8");
  const env = {
    OPENAI_MODEL: "environment-model",
    NEXUS_MAX_STEPS: "30",
    NEXUS_GATEWAY_PORT: "4200",
  };
  const args = [
    `--workspace=${workspace}`,
    "--model=cli-model",
    "--max-steps=unlimited",
    "--mcp=cli-mcp.json",
    "--port=4300",
  ];

  const config = await composeRuntimeConfig({
    root: "/ignored",
    args,
    env,
    localEnvironment: { file: "/private/.env.local", appliedKeys: ["NEXUS_GATEWAY_PORT"] },
  });

  assert.equal(config.provider.type, "openai-compatible");
  assert.equal(config.provider.apiKey, "local-secret");
  assert.equal(config.provider.model, "cli-model");
  assert.equal(config.provider.baseUrl, "https://profile.example/v1");
  assert.equal(config.runtime.maxSteps, Infinity);
  assert.equal(config.mcp.file, "cli-mcp.json");
  assert.equal(config.gateway.port, 4300);
  assert.equal(config.sources["provider.apiKey"], "local_private");
  assert.equal(config.sources["provider.model"], "cli");
  assert.equal(config.sources["provider.baseUrl"], "workspace_profile");
  assert.equal(config.sources["gateway.port"], "cli");
});

test("共享 profile 禁止 API Key，未知字段和无效值 fail closed", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-invalid-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({
    provider: { apiKey: "must-not-commit" },
  }), "utf8");

  await assert.rejects(composeRuntimeConfig({ root: workspace, env: {} }), /不允许保存 provider\.apiKey/);
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({ unexpected: true }), "utf8");
  await assert.rejects(composeRuntimeConfig({ root: workspace, env: {} }), /未知字段 unexpected/);
  await fs.writeFile(path.join(workspace, "nexus.config.json"), "{}", "utf8");
  await assert.rejects(composeRuntimeConfig({ root: workspace, env: {}, args: ["--port=70000"] }), /0 到 65535/);
  await assert.rejects(composeRuntimeConfig({ root: workspace, env: {}, args: ["--demo", "--provider=openai-compatible"] }), /不能与 --provider/);
});

test("共享 profile 不能启用会启动本地进程的 MCP", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-untrusted-mcp-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({
    mcp: { file: "untrusted-mcp.json" },
  }), "utf8");

  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: {} }),
    /workspace profile 不允许启用 MCP/,
  );

  await fs.writeFile(path.join(workspace, "nexus.config.json"), "{}", "utf8");
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    mcp: { file: "also-untrusted-mcp.json" },
  }), "utf8");
  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: {} }),
    /local private config 不允许启用 MCP/,
  );
});

test("最终生效配置输出会脱敏 Key 并序列化无限步骤", async () => {
  const config = await composeRuntimeConfig({
    root: "/tmp",
    env: { OPENAI_API_KEY: "secret-key", NEXUS_MAX_STEPS: "unlimited" },
  });

  const inspected = inspectRuntimeConfig(config);

  assert.equal(inspected.provider.apiKey, "[REDACTED]");
  assert.equal(inspected.runtime.maxSteps, "不限制");
  assert.equal(JSON.stringify(inspected).includes("secret-key"), false);
  assert.equal(createConfiguredProvider(config).name, "openai-compatible/gpt-4.1-mini");
});
