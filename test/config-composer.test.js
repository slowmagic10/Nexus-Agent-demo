import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  composeRuntimeConfig,
  createConfiguredAgentProviders,
  createConfiguredProvider,
  inspectRuntimeConfig,
} from "../src/config/composer.js";

test("Config Composition 默认生成可运行的 Demo 配置", async () => {
  const config = await composeRuntimeConfig({ root: "/tmp", env: {} });

  assert.equal(config.workspace, "/tmp");
  assert.equal(config.provider.type, "demo");
  assert.equal(config.provider.model, "gpt-4.1-mini");
  assert.equal(config.runtime.maxSteps, Infinity);
  assert.equal(config.runtime.maxTokensPerTurn, Infinity);
  assert.deepEqual(config.execution, { type: "native", dockerImage: null });
  assert.deepEqual(config.network, { targets: [] });
  assert.deepEqual(config.permission, { profile: "workspace-auto" });
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

test("本地私有配置可定义具名 Agent Profile 并由 CLI 显式选择", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-agents-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    agents: {
      default: "coding",
      profiles: {
        coding: { label: "开发", instructions: "专注实现", maxSteps: 30 },
        review: { label: "审查", permissionProfile: "read-only", maxTokensPerTurn: 4_000 },
      },
    },
  }), "utf8");

  const config = await composeRuntimeConfig({ root: workspace, env: {}, args: ["--agent-profile=review"] });
  assert.equal(config.agents.defaultProfile, "review");
  assert.equal(config.agents.profiles.find((profile) => profile.id === "coding").maxSteps, 30);
  assert.equal(config.agents.profiles.find((profile) => profile.id === "review").permissionProfile, "read-only");
  const inspected = inspectRuntimeConfig(config);
  assert.equal(inspected.agents.defaultProfile, "review");
  assert.doesNotMatch(JSON.stringify(inspected), /专注实现/);

  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({ agents: { profiles: {} } }), "utf8");
  await assert.rejects(composeRuntimeConfig({ root: workspace, env: {} }), /未知字段 agents/);
});

test("具名 Agent Profile 可显式绑定不同模型且 inspection 不暴露密钥", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-agent-router-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    provider: {
      type: "openai-compatible",
      apiKey: "shared-router-secret",
      baseUrl: "https://router.example/v1",
      model: "base-model"
    },
    agents: {
      default: "fast",
      profiles: {
        fast: { provider: { model: "fast-model" } },
        deep: { provider: { model: "deep-model", apiKey: "deep-router-secret" } }
      }
    }
  }), "utf8");

  const config = await composeRuntimeConfig({ root: workspace, env: {} });
  const providers = createConfiguredAgentProviders(config);
  assert.equal(providers.get("fast").provider.name, "openai-compatible/fast-model");
  assert.equal(providers.get("deep").provider.name, "openai-compatible/deep-model");
  assert.equal(providers.get("deep").provider.apiKey, "deep-router-secret");
  const inspected = JSON.stringify(inspectRuntimeConfig(config));
  assert.doesNotMatch(inspected, /shared-router-secret|deep-router-secret/);
  assert.match(inspected, /fast-model|deep-model/);
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

test("Docker 执行只能由可信环境或 CLI 显式启用", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-docker-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({
    execution: { type: "docker", dockerImage: "evil:latest" },
  }), "utf8");
  await assert.rejects(composeRuntimeConfig({ root: workspace, env: {} }), /未知字段 execution/);

  await fs.writeFile(path.join(workspace, "nexus.config.json"), "{}", "utf8");
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    execution: { type: "local" },
  }), "utf8");
  await assert.rejects(composeRuntimeConfig({ root: workspace, env: {} }), /未知字段 execution/);
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), "{}", "utf8");

  const fromEnvironment = await composeRuntimeConfig({
    root: workspace,
    env: { NEXUS_EXECUTION: "docker", NEXUS_DOCKER_IMAGE: "node:22-alpine" },
  });
  assert.deepEqual(fromEnvironment.execution, { type: "docker", dockerImage: "node:22-alpine" });
  assert.equal(fromEnvironment.sources["execution.type"], "environment");

  const fromCli = await composeRuntimeConfig({
    root: workspace,
    env: { NEXUS_EXECUTION: "docker", NEXUS_DOCKER_IMAGE: "node:20-alpine" },
    args: ["--execution=docker", "--docker-image=node:22-alpine"],
  });
  assert.deepEqual(fromCli.execution, { type: "docker", dockerImage: "node:22-alpine" });
  assert.equal(fromCli.sources["execution.dockerImage"], "cli");
});

test("Docker 执行配置缺失或组合冲突时 fail closed", async () => {
  await assert.rejects(
    composeRuntimeConfig({ root: "/tmp", env: {}, args: ["--execution=docker"] }),
    /需要显式配置 execution\.dockerImage/,
  );
  await assert.rejects(
    composeRuntimeConfig({ root: "/tmp", env: {}, args: ["--docker-image=node:22-alpine"] }),
    /只能与 execution\.type=docker/,
  );
  await assert.rejects(
    composeRuntimeConfig({ root: "/tmp", env: {}, args: ["--execution=docker", "--docker-image=--privileged"] }),
    /合法的非空镜像引用/,
  );
});

test("安全 Permission Profile 只能由可信环境或 CLI 选择", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-permission-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({
    permission: { profile: "danger-full-access" },
  }), "utf8");
  await assert.rejects(composeRuntimeConfig({ root: workspace, env: {} }), /未知字段 permission/);

  await fs.writeFile(path.join(workspace, "nexus.config.json"), "{}", "utf8");
  const config = await composeRuntimeConfig({
    root: workspace,
    env: { NEXUS_PERMISSION_PROFILE: "workspace-auto" },
    args: ["--permission-profile=workspace-auto"],
  });
  assert.equal(config.permission.profile, "workspace-auto");
  assert.equal(config.sources["permission.profile"], "cli");
  const untrusted = await composeRuntimeConfig({
    root: workspace,
    env: { NEXUS_PERMISSION_PROFILE: "workspace-untrusted" },
  });
  assert.equal(untrusted.permission.profile, "workspace-untrusted");
  const readOnly = await composeRuntimeConfig({
    root: workspace,
    env: { NEXUS_PERMISSION_PROFILE: "read-only" },
  });
  assert.equal(readOnly.permission.profile, "read-only");
  const approvalRequired = await composeRuntimeConfig({
    root: workspace,
    args: ["--permission-profile=approval-required"],
  });
  assert.equal(approvalRequired.permission.profile, "approval-required");
  const workspaceConfirm = await composeRuntimeConfig({
    root: workspace,
    args: ["--permission-profile=workspace-confirm"],
  });
  assert.equal(workspaceConfirm.permission.profile, "workspace-confirm");
  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: { NEXUS_PERMISSION_PROFILE: "danger-full-access" } }),
    /permission\.profile 必须是安全档位/,
  );
});

test("网络目标只能由可信环境或 CLI 为 Native Sandbox 声明", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-network-target-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({
    network: { targets: ["192.168.121.110:22"] },
  }), "utf8");
  await assert.rejects(composeRuntimeConfig({ root: workspace, env: {} }), /未知字段 network/);

  await fs.writeFile(path.join(workspace, "nexus.config.json"), "{}", "utf8");
  const fromEnvironment = await composeRuntimeConfig({
    root: workspace,
    env: { NEXUS_NETWORK_TARGETS: "192.168.121.110:22,10.0.0.8:443" },
  });
  assert.deepEqual(fromEnvironment.network.targets, [
    { host: "10.0.0.8", port: 443 },
    { host: "192.168.121.110", port: 22 },
  ]);
  assert.equal(fromEnvironment.sources["network.targets"], "environment");

  const fromCli = await composeRuntimeConfig({
    root: workspace,
    env: { NEXUS_NETWORK_TARGETS: "10.0.0.8:443" },
    args: ["--network-target=192.168.121.110:22", "--network-target=192.168.121.111:2222"],
  });
  assert.deepEqual(fromCli.network.targets, [
    { host: "192.168.121.110", port: 22 },
    { host: "192.168.121.111", port: 2222 },
  ]);
  assert.equal(fromCli.sources["network.targets"], "cli");

  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: { NEXUS_NETWORK_TARGETS: "example.com:22" } }),
    /只接受 IPv4 字面量/,
  );
  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: {}, args: ["--execution=local", "--network-target=192.168.121.110:22"] }),
    /只支持 execution\.type=native/,
  );
});

test("最终生效配置输出会脱敏 Key 并序列化无限步骤与 Token 预算", async () => {
  const config = await composeRuntimeConfig({
    root: "/tmp",
    env: {
      OPENAI_API_KEY: "secret-key",
      NEXUS_MAX_STEPS: "unlimited",
      NEXUS_MAX_TOKENS_PER_TURN: "unlimited",
    },
  });

  const inspected = inspectRuntimeConfig(config);

  assert.equal(inspected.provider.apiKey, "[REDACTED]");
  assert.equal(inspected.runtime.maxSteps, "不限制");
  assert.equal(inspected.runtime.maxTokensPerTurn, "不限制");
  assert.equal(JSON.stringify(inspected).includes("secret-key"), false);
  assert.equal(createConfiguredProvider(config).name, "openai-compatible/gpt-4.1-mini");
});
