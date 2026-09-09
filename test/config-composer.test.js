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
  assert.equal(config.provider.contextWindowTokens, 32_000);
  assert.equal(config.runtime.maxSteps, Infinity);
  assert.equal(config.runtime.maxTokensPerTurn, Infinity);
  assert.deepEqual(config.execution, { type: "native", dockerImage: null });
  assert.deepEqual(config.network, { targets: [] });
  assert.deepEqual(config.permission, { profile: "workspace-auto" });
  assert.equal(config.gateway.port, 4317);
  assert.equal(config.sources["provider.type"], "derived:default");
  assert.equal(createConfiguredProvider(config).name, "offline-demo");
});

test("Provider Context Window 支持 JSON、环境变量与 CLI 的确定优先级", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-context-window-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({
    provider: { contextWindowTokens: 131_072 },
  }), "utf8");
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    provider: { contextWindowTokens: 262_144 },
  }), "utf8");

  const fromEnvironment = await composeRuntimeConfig({
    root: workspace,
    env: { NEXUS_CONTEXT_WINDOW_TOKENS: "1000000" },
  });
  assert.equal(fromEnvironment.provider.contextWindowTokens, 1_000_000);
  assert.equal(fromEnvironment.sources["provider.contextWindowTokens"], "environment");
  assert.ok(fromEnvironment.agents.profiles.every((profile) => profile.provider.contextWindowTokens === 1_000_000));
  assert.equal(inspectRuntimeConfig(fromEnvironment).provider.contextWindowTokens, 1_000_000);

  const fromCli = await composeRuntimeConfig({
    root: workspace,
    env: { NEXUS_CONTEXT_WINDOW_TOKENS: "1000000" },
    args: ["--context-window-tokens=900000"],
  });
  assert.equal(fromCli.provider.contextWindowTokens, 900_000);
  assert.equal(fromCli.sources["provider.contextWindowTokens"], "cli");

  const fromLocalJson = await composeRuntimeConfig({ root: workspace, env: {} });
  assert.equal(fromLocalJson.provider.contextWindowTokens, 262_144);
  assert.equal(fromLocalJson.sources["provider.contextWindowTokens"], "local_private");

  await fs.rm(path.join(workspace, ".nexus", "config.local.json"));
  const fromWorkspaceJson = await composeRuntimeConfig({ root: workspace, env: {} });
  assert.equal(fromWorkspaceJson.provider.contextWindowTokens, 131_072);
  assert.equal(fromWorkspaceJson.sources["provider.contextWindowTokens"], "workspace_profile");
});

test("Provider Context Window 非法配置会在启动前失败", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-context-window-invalid-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({
    provider: { contextWindowTokens: 0 },
  }), "utf8");

  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: {} }),
    /contextWindowTokens.*正整数/,
  );
  await fs.writeFile(path.join(workspace, "nexus.config.json"), "{}", "utf8");
  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: { NEXUS_CONTEXT_WINDOW_TOKENS: "-1" } }),
    /contextWindowTokens.*正整数/,
  );
  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: {}, args: ["--context-window-tokens=1.5"] }),
    /contextWindowTokens.*正整数/,
  );
});

test("CLI/Gateway 可启用独立 Projects Root 作为默认 Workspace", async () => {
  const config = await composeRuntimeConfig({
    root: "/tmp/nexus-source",
    env: { NEXUS_PROJECTS_ROOT: "/tmp/nexus-user-projects" },
    useProjectsDefault: true,
  });

  assert.equal(config.workspace, "/tmp/nexus-user-projects/Default");
  assert.deepEqual(config.projects, {
    root: "/tmp/nexus-user-projects",
    defaultWorkspace: "/tmp/nexus-user-projects/Default",
  });
  assert.equal(config.sources.projectsRoot, "environment");
  assert.equal(config.sources.workspace, "default");
});

test("--demo 清除 Thinking 并强制所有具名 Profile 保持离线", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-demo-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    agents: {
      profiles: {
        review: { provider: { thinking: "enabled" } },
        remote: {
          provider: {
            type: "openai-compatible",
            apiKey: "remote-secret",
            baseUrl: "https://example.com/v1",
            model: "remote-model",
          },
        },
      },
    },
  }), "utf8");

  const config = await composeRuntimeConfig({
    root: workspace,
    env: { NEXUS_PROVIDER_THINKING: "disabled" },
    args: ["--demo"],
  });

  assert.equal(config.provider.type, "demo");
  assert.equal(config.provider.thinking, "provider-default");
  assert.equal(config.sources["provider.type"], "cli");
  assert.equal(config.sources["provider.thinking"], "cli");
  assert.ok(config.agents.profiles.every((profile) => profile.provider.type === "demo"));
  assert.ok(config.agents.profiles.every((profile) => profile.provider.thinking === "provider-default"));
  assert.doesNotMatch(JSON.stringify(inspectRuntimeConfig(config)), /remote-secret|remote-model|example\.com/);

  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: {}, args: ["--demo", "--provider-thinking=enabled"] }),
    /不能与 --provider-thinking/,
  );
});

test("配置按 profile、local、environment、CLI 的确定顺序覆盖", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-compose-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({
    provider: {
      model: "profile-model",
      thinking: "enabled",
    },
    runtime: { maxSteps: 10 },
    gateway: { port: 4100 },
  }), "utf8");
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    provider: {
      type: "openai-compatible",
      apiKey: "local-secret",
      baseUrl: "https://local.example/v1",
      model: "local-model",
      thinking: "disabled",
    },
    runtime: { maxSteps: 20 },
  }), "utf8");
  const env = {
    OPENAI_MODEL: "environment-model",
    NEXUS_PROVIDER_THINKING: "enabled",
    NEXUS_MAX_STEPS: "30",
    NEXUS_GATEWAY_PORT: "4200",
  };
  const args = [
    `--workspace=${workspace}`,
    "--model=cli-model",
    "--provider-thinking=disabled",
    "--max-steps=unlimited",
    "--mcp=cli-mcp.json",
    "--port=4300",
  ];

  const config = await composeRuntimeConfig({
    root: workspace,
    args,
    env,
    localEnvironment: { file: "/private/.env.local", appliedKeys: ["NEXUS_GATEWAY_PORT"] },
  });

  assert.equal(config.provider.type, "openai-compatible");
  assert.equal(config.provider.apiKey, "local-secret");
  assert.equal(config.provider.model, "cli-model");
  assert.equal(config.provider.baseUrl, "https://local.example/v1");
  assert.equal(config.provider.thinking, "disabled");
  assert.equal(config.runtime.maxSteps, Infinity);
  assert.equal(config.mcp.file, "cli-mcp.json");
  assert.equal(config.gateway.port, 4300);
  assert.equal(config.sources["provider.apiKey"], "local_private");
  assert.equal(config.sources["provider.model"], "cli");
  assert.equal(config.sources["provider.baseUrl"], "local_private");
  assert.equal(config.sources["provider.thinking"], "cli");
  assert.equal(config.sources["gateway.port"], "cli");
});

test("共享 Workspace 配置不能把受信 API Key 重定向到项目端点", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-endpoint-boundary-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({
    provider: {
      type: "openai-compatible",
      baseUrl: "https://attacker.invalid/v1",
      model: "attacker-model",
    },
  }), "utf8");

  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: { OPENAI_API_KEY: "trusted-secret" } }),
    /不允许选择 provider\.type\/baseUrl/,
  );
});

test("项目内同名 local config 不属于可信配置来源", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-project-local-boundary-"));
  const trustedRoot = path.join(fixture, "nexus-app");
  const workspace = path.join(fixture, "project");
  await fs.mkdir(path.join(trustedRoot, ".nexus"), { recursive: true });
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    provider: {
      type: "openai-compatible",
      apiKey: "project-secret",
      baseUrl: "https://attacker.invalid/v1",
      model: "attacker-model",
    },
  }), "utf8");
  await fs.writeFile(path.join(trustedRoot, ".nexus", "config.local.json"), JSON.stringify({
    provider: { model: "trusted-model" },
  }), "utf8");

  const config = await composeRuntimeConfig({
    root: trustedRoot,
    args: [`--workspace=${workspace}`],
    env: {
      OPENAI_API_KEY: "environment-secret",
      OPENAI_BASE_URL: "http://127.0.0.1:18001/v1",
    },
  });
  assert.equal(config.provider.apiKey, "environment-secret");
  assert.equal(config.provider.baseUrl, "http://127.0.0.1:18001/v1");
  assert.equal(config.provider.model, "trusted-model");
  assert.equal(config.files.local, path.join(trustedRoot, ".nexus", "config.local.json"));
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
      model: "base-model",
      thinking: "disabled"
    },
    agents: {
      default: "fast",
      profiles: {
        fast: { provider: { model: "fast-model" } },
        deep: { provider: { model: "deep-model", apiKey: "deep-router-secret", thinking: "enabled" } }
      }
    }
  }), "utf8");

  const config = await composeRuntimeConfig({ root: workspace, env: {} });
  const providers = createConfiguredAgentProviders(config);
  assert.equal(providers.get("fast").provider.name, "openai-compatible/fast-model");
  assert.equal(providers.get("deep").provider.name, "openai-compatible/deep-model");
  assert.equal(providers.get("deep").provider.apiKey, "deep-router-secret");
  assert.equal(providers.get("fast").provider.thinking, "disabled");
  assert.equal(providers.get("deep").provider.thinking, "enabled");
  const inspected = JSON.stringify(inspectRuntimeConfig(config));
  assert.doesNotMatch(inspected, /shared-router-secret|deep-router-secret/);
  assert.match(inspected, /fast-model|deep-model/);
});

test("本机配置可显式选择原生 OpenAI Responses Adapter", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-openai-responses-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    provider: {
      type: "openai-responses",
      apiKey: "responses-secret",
      baseUrl: "https://api.openai.com/v1",
      model: "gpt-test",
    },
    agents: {
      profiles: {
        responses: { provider: { type: "openai-responses", model: "gpt-responses" } },
      },
    },
  }), "utf8");

  const config = await composeRuntimeConfig({ root: workspace, env: {}, args: ["--agent-profile=responses"] });
  const provider = createConfiguredProvider(config);
  const profiles = createConfiguredAgentProviders(config);
  const inspected = JSON.stringify(inspectRuntimeConfig(config));

  assert.equal(provider.name, "openai-responses/gpt-test");
  assert.equal(profiles.get("responses").provider.name, "openai-responses/gpt-responses");
  assert.equal(profiles.get("responses").descriptor.adapter, "openai-responses");
  assert.doesNotMatch(inspected, /responses-secret/);
  assert.match(inspected, /openai-responses/);
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
  await assert.rejects(
    composeRuntimeConfig({ root: workspace, env: {}, args: ["--provider-thinking=sometimes"] }),
    /provider\.thinking/,
  );
  await assert.rejects(
    composeRuntimeConfig({
      root: workspace,
      env: { OPENAI_API_KEY: "test", NEXUS_PROVIDER: "openai-responses" },
      args: ["--provider-thinking=disabled"],
    }),
    /只支持 openai-compatible/,
  );
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

test("Provider 请求契约按配置层覆盖，真实容量与有效输入预算分别保留", async (t) => {
  const workspace = await requestPolicyWorkspace(t);
  await fs.writeFile(path.join(workspace, "nexus.config.json"), JSON.stringify({ provider: {
    contextWindowTokens: 100_000, contextTargetTokens: 20_000,
    maxOutputTokens: 2_000, outputTokenParameter: "max_tokens", streamUsage: true,
  } }));
  const localFile = path.join(workspace, ".nexus", "config.local.json");
  await fs.writeFile(localFile, JSON.stringify({ provider: {
    type: "openai-compatible", apiKey: "request-policy-secret", contextTargetTokens: 30_000,
    maxOutputTokens: 3_000, outputTokenParameter: "max_completion_tokens", streamUsage: false,
  } }));
  const local = await composeRuntimeConfig({ root: workspace, env: {} });
  assert.equal(local.provider.contextTargetTokens, 30_000);
  assert.equal(local.provider.maxOutputTokens, 3_000);
  assert.equal(local.provider.outputTokenParameter, "max_completion_tokens");
  assert.equal(local.provider.streamUsage, false);
  assert.equal(local.sources["provider.contextTargetTokens"], "local_private");
  const env = { NEXUS_CONTEXT_TARGET_TOKENS: "40000", NEXUS_MAX_OUTPUT_TOKENS: "4000",
    NEXUS_OUTPUT_TOKEN_PARAMETER: "max_tokens", NEXUS_STREAM_USAGE: "true" };
  const environmental = await composeRuntimeConfig({ root: workspace, env });
  assert.equal(environmental.provider.contextTargetTokens, 40_000);
  assert.equal(environmental.provider.maxOutputTokens, 4_000);
  assert.equal(environmental.provider.outputTokenParameter, "max_tokens");
  assert.equal(environmental.provider.streamUsage, true);
  assert.equal(environmental.sources["provider.streamUsage"], "environment");
  const cli = await composeRuntimeConfig({ root: workspace, env, args: [
    "--context-target-tokens=95000", "--max-output-tokens=10000",
    "--output-token-parameter=max_completion_tokens", "--stream-usage=false",
  ] });
  assert.equal(cli.provider.contextWindowTokens, 100_000);
  assert.equal(cli.provider.contextTargetTokens, 95_000);
  assert.equal(cli.runtime.maxInputTokens, 90_000);
  assert.equal(cli.sources["provider.maxOutputTokens"], "cli");
  const binding = createConfiguredAgentProviders(cli).get("default");
  assert.equal(binding.descriptor.contextWindowTokens, 100_000);
  assert.equal(binding.descriptor.contextTargetTokens, 95_000);
  assert.equal(binding.descriptor.maxOutputTokens, 10_000);
  assert.equal(binding.descriptor.outputTokenParameter, "max_completion_tokens");
  assert.equal("streamUsage" in binding.descriptor, false);
  const inspected = inspectRuntimeConfig(cli);
  assert.equal(inspected.runtime.maxInputTokens, 90_000);
  assert.equal(inspected.provider.contextTargetTokens, 95_000);
  assert.doesNotMatch(JSON.stringify(inspected), /request-policy-secret/);
  await fs.rm(localFile);
  const shared = await composeRuntimeConfig({ root: workspace, env: { OPENAI_API_KEY: "test" } });
  assert.equal(shared.provider.contextTargetTokens, 20_000);
  assert.equal(shared.sources["provider.contextTargetTokens"], "workspace_profile");
});

test("Provider 请求契约允许显式 reset，默认 inspection 与 descriptor 不新增字段", async (t) => {
  const workspace = await requestPolicyWorkspace(t);
  const file = path.join(workspace, ".nexus", "config.local.json");
  await fs.writeFile(file, JSON.stringify({ provider: {
    type: "openai-compatible", apiKey: "test", contextTargetTokens: 10_000,
    maxOutputTokens: 1_000, outputTokenParameter: "max_tokens", streamUsage: true,
  } }));
  const reset = await composeRuntimeConfig({ root: workspace, env: {
    NEXUS_CONTEXT_TARGET_TOKENS: "provider-default", NEXUS_MAX_OUTPUT_TOKENS: "provider-default",
    NEXUS_OUTPUT_TOKEN_PARAMETER: "provider-default", NEXUS_STREAM_USAGE: "false",
  } });
  for (const field of ["contextTargetTokens", "maxOutputTokens", "outputTokenParameter"]) {
    assert.equal(reset.provider[field], null);
    assert.equal(field in inspectRuntimeConfig(reset).provider, false);
    assert.equal(field in createConfiguredAgentProviders(reset).get("default").descriptor, false);
  }
  assert.equal(reset.provider.streamUsage, false);
  assert.equal("streamUsage" in inspectRuntimeConfig(reset).provider, false);
  assert.equal(reset.runtime.maxInputTokens, 32_000);
  const resetCli = await composeRuntimeConfig({ root: workspace, env: {}, args: [
    "--context-target-tokens=provider-default", "--max-output-tokens=provider-default",
    "--output-token-parameter=provider-default", "--stream-usage=false",
  ] });
  assert.deepEqual(resetCli.provider, reset.provider);
  await fs.writeFile(file, JSON.stringify({ provider: {
    type: "openai-compatible", apiKey: "test", contextTargetTokens: null,
    maxOutputTokens: null, outputTokenParameter: null, streamUsage: false,
  } }));
  assert.deepEqual((await composeRuntimeConfig({ root: workspace, env: {} })).provider, reset.provider);
});

test("请求契约拒绝错误类型、不完整兼容契约和跨 Adapter 功能", async (t) => {
  const workspace = await requestPolicyWorkspace(t);
  const env = { OPENAI_API_KEY: "test" };
  for (const args of [
    ["--context-target-tokens=0"], ["--max-output-tokens=1.5"],
    ["--context-target-tokens=9007199254740992"], ["--stream-usage=1"], ["--stream-usage=TRUE"],
    ["--output-token-parameter=max_output_tokens"], ["--max-output-tokens=1000"],
    ["--context-target-tokens=32001"], ["--max-output-tokens=32000", "--output-token-parameter=max_tokens"],
    ["--provider=openai-responses", "--output-token-parameter=max_tokens"],
    ["--provider=openai-responses", "--stream-usage=true"],
  ]) await assert.rejects(composeRuntimeConfig({ root: workspace, env, args }));
  const file = path.join(workspace, ".nexus", "config.local.json");
  for (const provider of [
    { contextTargetTokens: "1000" }, { maxOutputTokens: "1000", outputTokenParameter: "max_tokens" },
    { streamUsage: "false" }, { streamUsage: null },
  ]) {
    await fs.writeFile(file, JSON.stringify({ provider }));
    await assert.rejects(composeRuntimeConfig({ root: workspace, env }));
  }
  await fs.writeFile(file, "{}");
  const parameterOnly = await composeRuntimeConfig({ root: workspace, env, args: ["--output-token-parameter=max_tokens"] });
  assert.equal(parameterOnly.provider.maxOutputTokens, null);
  assert.equal(parameterOnly.provider.outputTokenParameter, "max_tokens");
  const responses = await composeRuntimeConfig({ root: workspace, env, args: [
    "--provider=openai-responses", "--max-output-tokens=1000",
  ] });
  assert.equal(responses.provider.maxOutputTokens, 1_000);
  assert.equal(responses.runtime.maxInputTokens, 31_000);
});

test("--demo 清除输出 wire 契约并保留默认和具名 Profile 的规划目标", async (t) => {
  const workspace = await requestPolicyWorkspace(t);
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), JSON.stringify({
    provider: { type: "openai-compatible", apiKey: "test", contextTargetTokens: 8_000,
      maxOutputTokens: 1_000, outputTokenParameter: "max_tokens", streamUsage: true },
    agents: { profiles: { review: { provider: { contextWindowTokens: 80_000,
      contextTargetTokens: 12_000, maxOutputTokens: 2_000, outputTokenParameter: "max_completion_tokens", streamUsage: true } } } },
  }));
  const config = await composeRuntimeConfig({ root: workspace, env: {}, args: ["--demo"] });
  assert.equal(config.provider.contextTargetTokens, 8_000);
  assert.equal(config.runtime.maxInputTokens, 8_000);
  assert.equal(config.provider.maxOutputTokens, null);
  assert.equal(config.provider.outputTokenParameter, null);
  assert.equal(config.provider.streamUsage, false);
  const review = config.agents.profiles.find((profile) => profile.id === "review");
  assert.equal(review.provider.type, "demo");
  assert.equal(review.provider.contextWindowTokens, 80_000);
  assert.equal(review.provider.contextTargetTokens, 12_000);
  assert.equal(review.provider.maxOutputTokens, null);
  assert.equal(review.provider.outputTokenParameter, null);
  assert.equal(review.provider.streamUsage, false);
});

async function requestPolicyWorkspace(t) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-config-request-policy-"));
  await fs.mkdir(path.join(workspace, ".nexus"), { recursive: true });
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  return workspace;
}
