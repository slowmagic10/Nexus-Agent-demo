import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AgentSession } from "../src/core/session.js";
import { createSession, reduceSession } from "../src/core/state.js";
import { createExecutionSpec } from "../src/execution/interface.js";
import { DockerWorkspaceAdapter } from "../src/execution/docker-workspace-adapter.js";
import { createWorkspaceExecution } from "../src/execution/factory.js";
import { LocalWorkspaceAdapter, WorkspaceExecutionError } from "../src/execution/local-workspace-adapter.js";
import { NativeSandboxAdapter } from "../src/execution/native-sandbox-adapter.js";
import { WorkspacePolicy } from "../src/tools/authorization.js";
import { ToolHost } from "../src/tools/host.js";
import { createPermissionProfile } from "../src/tools/permission-profile.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("LocalWorkspaceAdapter 只向子进程暴露环境白名单", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-local-exec-env-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const adapter = new LocalWorkspaceAdapter({
    workspace,
    environment: { PATH: process.env.PATH, SAFE_VISIBLE: "visible", SECRET_TOKEN: "must-not-leak" },
    environmentAllowlist: ["PATH", "SAFE_VISIBLE"],
  });

  const result = await adapter.execute(createExecutionSpec({
    program: process.execPath,
    args: ["-e", "console.log(JSON.stringify({safe:process.env.SAFE_VISIBLE,secret:process.env.SECRET_TOKEN||null}))"],
  }));
  const childEnvironment = JSON.parse(result.stdout.trim());

  assert.equal(result.exitCode, 0);
  assert.deepEqual(childEnvironment, { safe: "visible", secret: null });
  assert.deepEqual(adapter.inspect().environmentAllowlist, ["PATH", "SAFE_VISIBLE"]);
  assert.equal(JSON.stringify(adapter.inspect()).includes("visible"), false);
  await assert.rejects(adapter.execute(createExecutionSpec({
    program: process.execPath,
    args: ["-e", ""],
    env: { SECRET_TOKEN: "still-forbidden" },
  })), /环境变量不在白名单/);

  const defaultAdapter = new LocalWorkspaceAdapter({
    workspace,
    environment: { PATH: process.env.PATH, HOME: "/private/home", OPENAI_API_KEY: "must-not-leak" },
  });
  const defaultResult = await defaultAdapter.execute(createExecutionSpec({
    program: process.execPath,
    args: ["-e", "console.log(JSON.stringify({home:process.env.HOME||null,key:process.env.OPENAI_API_KEY||null}))"],
  }));
  assert.deepEqual(JSON.parse(defaultResult.stdout.trim()), { home: null, key: null });
  await assert.rejects(defaultAdapter.execute(createExecutionSpec({
    program: process.execPath,
    args: ["-e", ""],
    filesystemMode: "read-only",
  })), (error) => error.code === "execution_isolation_unavailable" && /read-only/.test(error.message));
});

test("LocalWorkspaceAdapter 拒绝 workspace 外 cwd 和越界符号链接", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-local-exec-root-"));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-local-exec-outside-"));
  t.after(async () => {
    await fs.rm(workspace, { recursive: true, force: true });
    await fs.rm(outside, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(workspace, "nested"));
  await fs.symlink(outside, path.join(workspace, "escape"));
  const adapter = new LocalWorkspaceAdapter({ workspace, environment: {} });

  const result = await adapter.execute(createExecutionSpec({
    program: process.execPath,
    args: ["-e", "console.log(process.cwd())"],
    cwd: "nested",
  }));
  assert.equal(result.stdout.trim(), path.join(adapter.inspect().workspace, "nested"));
  await assert.rejects(adapter.execute(createExecutionSpec({
    program: process.execPath,
    args: ["-e", ""],
    cwd: "../",
  })), /路径越过了工作区边界/);
  await assert.rejects(adapter.execute(createExecutionSpec({
    program: process.execPath,
    args: ["-e", ""],
    cwd: "escape",
  })), /符号链接越过了工作区边界/);
});

test("LocalWorkspaceAdapter 支持独立超时和 AbortSignal 取消", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-local-exec-timeout-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const adapter = new LocalWorkspaceAdapter({ workspace, environment: {} });

  await assert.rejects(adapter.execute(createExecutionSpec({
    program: process.execPath,
    args: ["-e", "setInterval(()=>{},1000)"],
    timeoutMs: 30,
  })), (error) => error.code === "timeout" && /执行超时/.test(error.message));

  const controller = new AbortController();
  controller.abort(new Error("cancel-before-spawn"));
  await assert.rejects(adapter.execute(createExecutionSpec({
    program: process.execPath,
    args: ["-e", "console.log('must-not-run')"],
  }), { signal: controller.signal }), /cancel-before-spawn/);
});

test("LocalWorkspaceAdapter 超时会终止完整进程组", async (t) => {
  if (process.platform === "win32") return t.skip("Windows 使用不同的进程树终止机制");
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-local-exec-tree-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const marker = path.join(workspace, "grandchild-survived.txt");
  const adapter = new LocalWorkspaceAdapter({ workspace, environment: {}, killGraceMs: 20 });
  const grandchild = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived'),250)`;
  const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});setInterval(()=>{},1000)`;

  await assert.rejects(adapter.execute(createExecutionSpec({
    program: process.execPath,
    args: ["-e", parent],
    timeoutMs: 40,
  })), (error) => error.code === "timeout");
  await new Promise((resolve) => setTimeout(resolve, 350));
  await assert.rejects(fs.stat(marker), (error) => error.code === "ENOENT");
  assert.equal(adapter.inspect().processGroupTermination, true);
});

test("NativeSandboxAdapter 在 macOS 构造可审计 Seatbelt 策略", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-native-sandbox-"));
  const fakeHome = path.join(workspace, "fake-home");
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(fakeHome);
  const calls = [];
  const controlExecution = {
    id: "fake-native-control",
    inspect: () => ({ environmentAllowlist: ["PATH"] }),
    execute: async (spec, context) => {
      calls.push({ spec, context });
      return { executionId: "local-seatbelt", status: "completed", exitCode: 0, signal: null, stdout: "ok", stderr: "", output: "ok", durationMs: 1 };
    },
  };
  const adapter = new NativeSandboxAdapter({
    workspace,
    controlExecution,
    platform: "darwin",
    sandboxBinary: "/fake/sandbox-exec",
    temporaryDirectories: ["/private/tmp"],
    homeDirectory: fakeHome,
  });

  const result = await adapter.execute(createExecutionSpec({
    program: "/bin/zsh",
    args: ["-dfc", "pwd"],
    cwd: ".",
  }));

  assert.equal(calls.length, 1);
  assert.equal(calls[0].spec.program, "/fake/sandbox-exec");
  assert.equal(calls[0].spec.args[0], "-p");
  assert.match(calls[0].spec.args[1], /^\(version 1\)/);
  assert.match(calls[0].spec.args[1], /\(deny default\)/);
  assert.match(calls[0].spec.args[1], /\(allow file-read\*\)/);
  assert.match(calls[0].spec.args[1], /\(deny network\*\)/);
  assert.ok(calls[0].spec.args[1].includes(JSON.stringify(adapter.inspect().workspace)));
  assert.ok(calls[0].spec.args[1].includes(JSON.stringify(path.join(adapter.inspect().workspace, ".env.deepseek.local"))));
  assert.deepEqual(calls[0].spec.args.slice(-4), ["--", "/bin/zsh", "-dfc", "pwd"]);
  assert.equal(result.executionId, "native:local-seatbelt");
  assert.deepEqual(adapter.inspect().filesystem.write, [adapter.inspect().workspace, "/private/tmp"]);
  assert.equal(adapter.inspect().filesystem.read, "host-readable-minus-protected");
  assert.ok(adapter.inspect().filesystem.readDenied.includes(path.join(adapter.inspect().workspace, ".env.local")));
  assert.ok(adapter.inspect().filesystem.readDenied.includes(path.join(adapter.inspect().workspace, ".ssh")));
  assert.ok(adapter.inspect().filesystem.readDenied.includes(path.join(adapter.inspect().workspace, ".nexus", "config.local.json")));
  const canonicalFakeHome = path.join(adapter.inspect().workspace, "fake-home");
  assert.ok(adapter.inspect().filesystem.readDenied.includes(path.join(canonicalFakeHome, ".ssh")));
  assert.ok(calls[0].spec.args[1].includes(JSON.stringify(path.join(canonicalFakeHome, ".aws"))));
  assert.ok(calls[0].spec.args[1].includes(JSON.stringify(path.join(canonicalFakeHome, ".npmrc"))));
  assert.equal(adapter.inspect().filesystem.readDenied.includes(path.join(adapter.inspect().workspace, ".nexus")), false);
  assert.equal(adapter.inspect().filesystem.writeDenied.includes(path.join(adapter.inspect().workspace, ".git")), false);
  assert.equal(adapter.inspect().network, "deny");

  await adapter.execute(createExecutionSpec({
    program: "/bin/zsh",
    args: ["-dfc", "rg --files"],
    filesystemMode: "read-only",
  }));
  const readOnlyProfile = calls.at(-1).spec.args[1];
  assert.equal(readOnlyProfile.includes(`(allow file-write* (subpath ${JSON.stringify(adapter.inspect().workspace)})`), false);
  assert.ok(readOnlyProfile.includes(`(allow file-write* (subpath ${JSON.stringify("/private/tmp")})`));

  await adapter.execute(createExecutionSpec({
    program: "/bin/zsh",
    args: ["-dfc", "ssh root@192.168.121.110 uptime"],
    networkTargets: [{ host: "192.168.121.110", port: 22 }],
  }));
  const expandedProfile = calls.at(-1).spec.args[1];
  assert.match(expandedProfile, /\(allow network-outbound \(remote tcp "192\.168\.121\.110:22"\)\)/);
  assert.equal(expandedProfile.includes("(deny network*)"), false);
  assert.equal(adapter.inspect().networkExpansion, "exact-ip-tcp-per-execution");
});

test("NativeSandboxAdapter 不支持平台和策略应用失败都 fail closed", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-native-fail-closed-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  assert.throws(() => new NativeSandboxAdapter({
    workspace,
    platform: "linux",
    controlExecution: { id: "fake", execute: async () => ({ exitCode: 0 }) },
  }), (error) => error.code === "native_sandbox_unavailable" && /不会降级/.test(error.message));

  const adapter = new NativeSandboxAdapter({
    workspace,
    platform: "darwin",
    sandboxBinary: "/fake/sandbox-exec",
    controlExecution: {
      id: "fake",
      execute: async () => ({
        executionId: "failed-seatbelt",
        status: "failed",
        exitCode: 71,
        signal: null,
        stdout: "",
        stderr: "sandbox-exec: sandbox_apply: Operation not permitted",
        output: "sandbox-exec: sandbox_apply: Operation not permitted",
        durationMs: 1,
      }),
    },
  });
  await assert.rejects(adapter.execute(createExecutionSpec({ program: "/usr/bin/true" })), (error) => (
    error.code === "native_sandbox_unavailable" && /不会降级/.test(error.message)
  ));
});

test("DockerWorkspaceAdapter 构造固定隔离参数且只挂载 workspace", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-docker-exec-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "nested"));
  const calls = [];
  const controlExecution = {
    id: "fake-docker-control",
    inspect: () => ({ workspace }),
    execute: async (spec, context) => {
      calls.push({ spec, context });
      return { executionId: "local-docker", status: "completed", exitCode: 0, signal: null, stdout: "ok", stderr: "", output: "ok", durationMs: 1 };
    },
  };
  const adapter = new DockerWorkspaceAdapter({
    workspace,
    image: "node:22-alpine",
    controlExecution,
    cpus: 2,
    memory: "512m",
    pidsLimit: 64,
    containerEnvironmentAllowlist: ["NEXUS_TEST_MODE"],
  });

  const result = await adapter.execute(createExecutionSpec({
    program: "node",
    args: ["-e", "console.log('ok')"],
    cwd: "nested",
    env: { NEXUS_TEST_MODE: "safe" },
  }));

  assert.equal(calls.length, 1);
  const args = calls[0].spec.args;
  for (const expected of [
    "--context=default",
    "run",
    "--rm",
    "--pull=never",
    "--network=none",
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--cpus=2",
    "--memory=512m",
    "--pids-limit=64",
    `--mount=type=bind,src=${adapter.inspect().workspace},dst=/workspace`,
    "--workdir=/workspace/nested",
  ]) assert.ok(args.includes(expected), `缺少 Docker 参数 ${expected}`);
  assert.match(args.find((value) => value.startsWith("--user=")), /^--user=\d+:\d+$/);
  assert.ok(args.some((value) => value.startsWith("--name=nexus-")));
  assert.deepEqual(args.slice(-3), ["node", "-e", "console.log('ok')"]);
  assert.ok(args.indexOf("node:22-alpine") < args.indexOf("node"));
  assert.deepEqual(args.slice(args.indexOf("--env"), args.indexOf("node:22-alpine")), ["--env", "NEXUS_TEST_MODE=safe"]);
  assert.match(result.executionId, /^docker:nexus-/);
  assert.deepEqual(adapter.inspect().resources, { cpus: 2, memory: "512m", pidsLimit: 64 });
  assert.equal(JSON.stringify(adapter.inspect()).includes("safe"), false);

  await adapter.execute(createExecutionSpec({
    program: "rg",
    args: ["--files"],
    filesystemMode: "read-only",
  }));
  const readOnlyMount = calls.at(-1).spec.args.find((value) => value.startsWith("--mount=type=bind"));
  assert.equal(readOnlyMount, `--mount=type=bind,src=${adapter.inspect().workspace},dst=/workspace,readonly`);
});

test("ExecutionSpec 显式区分 workspace-write 与 read-only", () => {
  assert.equal(createExecutionSpec({ program: "/usr/bin/true" }).filesystemMode, "workspace-write");
  assert.equal(createExecutionSpec({ program: "/usr/bin/true", filesystemMode: "read-only" }).filesystemMode, "read-only");
  assert.throws(
    () => createExecutionSpec({ program: "/usr/bin/true", filesystemMode: "danger-full-access" }),
    /filesystemMode/,
  );
});

test("DockerWorkspaceAdapter 默认拒绝容器环境变量和非法镜像", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-docker-validate-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const controlExecution = {
    id: "fake-docker-control",
    inspect: () => ({ workspace }),
    execute: async () => { throw new Error("不应执行"); },
  };

  assert.throws(() => new DockerWorkspaceAdapter({ workspace, image: "--privileged", controlExecution }), /合法的非空镜像引用/);
  const adapter = new DockerWorkspaceAdapter({ workspace, image: "node:22-alpine", controlExecution });
  await assert.rejects(adapter.execute(createExecutionSpec({
    program: "node",
    env: { OPENAI_API_KEY: "must-not-leak" },
  })), /容器环境变量不在白名单/);
});

test("DockerWorkspaceAdapter 执行失败会独立清理且 CLI 缺失时不降级", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-docker-cleanup-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const calls = [];
  const controlExecution = {
    id: "fake-docker-control",
    inspect: () => ({ workspace }),
    execute: async (spec) => {
      calls.push(spec);
      if (calls.length === 1) throw new WorkspaceExecutionError("spawn docker ENOENT", { code: "spawn_failed" });
      return { executionId: "cleanup", status: "failed", exitCode: 1, signal: null, stdout: "", stderr: "not found", output: "not found", durationMs: 1 };
    },
  };
  const adapter = new DockerWorkspaceAdapter({ workspace, image: "node:22-alpine", controlExecution });

  await assert.rejects(adapter.execute(createExecutionSpec({ program: "node" })), (error) => (
    error.code === "docker_unavailable" && /不会降级到本机执行/.test(error.message)
  ));
  assert.equal(calls.length, 2);
  const name = calls[0].args.find((value) => value.startsWith("--name=")).slice("--name=".length);
  assert.deepEqual(calls[1].args, ["--context=default", "rm", "-f", name]);
});

test("WorkspaceExecution factory 支持 native 默认边界及显式 local/docker", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-execution-factory-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  assert.equal(createWorkspaceExecution({ workspace, execution: { type: "local", dockerImage: null } }, { environment: {} }).id, "local-workspace");
  assert.equal(createWorkspaceExecution({ workspace, execution: { type: "native", dockerImage: null } }, {
    environment: {},
    controlExecution: { id: "fake", execute: async () => ({ exitCode: 0 }) },
  }).id, "native-sandbox");
  assert.equal(createWorkspaceExecution({
    workspace,
    execution: { type: "docker", dockerImage: "node:22-alpine" },
  }, {
    environment: {},
    controlExecution: { id: "fake", inspect: () => ({ workspace }), execute: async () => ({ exitCode: 0 }) },
  }).id, "docker-workspace");
});

test("ExecutionSpec 校验网络扩展，Local 与 Docker 不伪装成精确目标沙箱", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-execution-network-target-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const spec = createExecutionSpec({
    program: "/usr/bin/true",
    networkTargets: [{ host: "192.168.121.110", port: 22 }],
  });
  assert.deepEqual(spec.networkTargets, [{ host: "192.168.121.110", port: 22 }]);
  assert.throws(
    () => createExecutionSpec({ program: "/usr/bin/true", networkTargets: [{ host: "example.com", port: 22 }] }),
    /只接受 IPv4 字面量/,
  );
  const local = new LocalWorkspaceAdapter({ workspace, environment: {} });
  await assert.rejects(local.execute(spec), (error) => error.code === "execution_isolation_unavailable" && /网络目标/.test(error.message));

  const docker = new DockerWorkspaceAdapter({
    workspace,
    image: "node:22-alpine",
    controlExecution: { id: "fake", execute: async () => ({ exitCode: 0 }) },
  });
  await assert.rejects(docker.execute(spec), (error) => error.code === "execution_isolation_unavailable" && /网络目标/.test(error.message));
});

test("run_shell 通过 WorkspaceExecution 接口执行并保留危险命令拒绝", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-execution-registry-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const calls = [];
  const execution = {
    id: "fake-workspace",
    inspect: () => ({ id: "fake-workspace" }),
    execute: async (spec, context) => {
      calls.push({ spec, context });
      return { exitCode: 0, stdout: "delegated", stderr: "", output: "delegated", durationMs: 1 };
    },
  };
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    workspaceExecution: execution,
  });
  const tool = registry.get("run_shell");
  const controller = new AbortController();

  assert.equal(await tool.execute({ command: "pwd" }, { signal: controller.signal }), "delegated");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].spec.program, "/bin/zsh");
  assert.deepEqual(calls[0].spec.args, ["-dfc", "pwd"]);
  assert.equal(calls[0].spec.cwd, ".");
  assert.equal(calls[0].context.signal, controller.signal);
  await assert.rejects(tool.execute({ command: "sudo reboot" }, {}), /拒绝宿主提权或系统级破坏命令/);
  assert.equal(calls.length, 1);
});

test("可信网络扩展只在 Tool Host 审批后进入 Native ExecutionSpec", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-network-expansion-approval-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const specs = [];
  const profile = createPermissionProfile({
    name: "workspace-auto",
    workspace,
    executionType: "native",
    networkTargets: [{ host: "192.168.121.110", port: 22 }],
  });
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    accessPolicy: profile,
    workspaceExecution: {
      id: "native-sandbox",
      execute: async (spec) => {
        specs.push(spec);
        return { exitCode: 0, output: "connected" };
      },
    },
  });
  const host = new ToolHost({ registry, policy: new WorkspacePolicy({}, { profile, allowElevation: false }) });
  const session = new AgentSession({
    state: createSession({ provider: "test", workspace, permissionProfile: "workspace-auto" }),
    reducer: reduceSession,
  });
  const call = { name: "run_shell", arguments: { command: "ssh root@192.168.121.110 uptime" } };

  const sessionApproved = await host.execute({ id: "network-session-approved", ...call }, {
    session,
    requestApproval: async () => ({ approved: true, scope: "session" }),
  });
  assert.equal(sessionApproved.status, "completed");
  assert.equal(specs.length, 1);

  const reused = await host.execute({ id: "network-session-reused", ...call }, {
    session,
    requestApproval: async () => false,
  });
  assert.equal(reused.status, "completed");
  assert.equal(specs.length, 2);

  const denied = await host.execute({ id: "network-denied", name: call.name, arguments: { command: "ssh root@192.168.121.110 hostname" } }, {
    session,
    requestApproval: async () => false,
  });
  assert.equal(denied.status, "denied");
  assert.equal(specs.length, 2);
  assert.deepEqual(specs[0].networkTargets, [{ host: "192.168.121.110", port: 22 }]);
  const authorization = session.state.events.find((event) => (
    event.type === "tool.authorization_decided" && event.callId === "network-session-approved"
  ));
  assert.deepEqual(authorization.explanation.networkTargets, [{ host: "192.168.121.110", port: 22 }]);
  assert.deepEqual(session.state.events.find((event) => (
    event.type === "approval.requested" && event.callId === "network-session-approved"
  )).approvalScopes, ["once", "session"]);
  const grant = session.state.toolGrants.find((item) => item.scope === "session");
  assert.equal(grant.consumedAt, null);
});

test("run_shell 经 WorkspaceExecution 超时后保持 execution_unknown 语义", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-execution-timeout-chain-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  let executions = 0;
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    shellTimeoutMs: 5,
    workspaceExecution: {
      id: "ignores-abort",
      execute: async () => { executions += 1; return await new Promise(() => {}); },
    },
  });
  const session = new AgentSession({
    state: createSession({ provider: "test", workspace }),
    reducer: reduceSession,
  });
  const host = new ToolHost({
    registry,
    policy: new WorkspacePolicy({ rules: [{ id: "allow-shell-test", tools: ["run_shell"], decision: "allow" }] }),
  });

  const result = await host.execute({ id: "shell-timeout", name: "run_shell", arguments: { command: "sleep forever" } }, { session });

  assert.equal(result.status, "execution_unknown");
  assert.equal(executions, 1);
  assert.ok(session.state.events.some((event) => event.type === "tool.execution_unknown"));
});
