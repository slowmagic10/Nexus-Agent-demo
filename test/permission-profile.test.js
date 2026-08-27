import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createPermissionProfile } from "../src/tools/permission-profile.js";
import { createToolRegistry } from "../src/tools/registry.js";

test("PermissionProfile 独立判断路径风险、沙箱和审批", () => {
  const native = createPermissionProfile({ name: "workspace-auto", workspace: "/tmp/workspace", executionType: "native" });
  assert.equal(native.pathDecision("src/app.js", "write").decision, "allow");
  assert.equal(native.pathDecision("nested/.env.production", "read").decision, "deny");
  assert.equal(native.pathDecision(".nexus/nexus.db", "read").decision, "allow");
  assert.equal(native.pathDecision(".nexus/nexus.db", "write").decision, "approval_required");
  assert.equal(native.pathDecision(".git/config", "write").decision, "approval_required");
  assert.equal(native.pathDecision(".agents/skill.md", "read").decision, "allow");
  assert.equal(native.classifyShell("npm test").decision, "allow");
  assert.equal(native.classifyShell("git status --short").decision, "allow");
  assert.equal(native.classifyShell("npm install").decision, "approval_required");
  assert.equal(native.classifyShell("cat ../secret.txt").decision, "deny");
  assert.equal(native.classifyShell("sudo reboot").decision, "deny");
  assert.equal(native.classifyShell("cat .env.local").decision, "deny");

  const local = createPermissionProfile({ name: "workspace-auto", workspace: "/tmp/workspace", executionType: "local" });
  assert.equal(local.classifyShell("npm test").decision, "approval_required");
  assert.equal(local.classifyShell("npm test").explanation.category, "unsandboxed_shell");
});

test("workspace-auto 拒绝 Shell 通过 home shorthand 读取宿主凭据", () => {
  const profile = createPermissionProfile({ name: "workspace-auto", workspace: "/tmp/workspace", executionType: "native" });
  for (const command of [
    "cat ~/.ssh/id_rsa",
    "cat ~/.aws/credentials",
    "cat $HOME/.npmrc",
    "cat ${HOME}/.npmrc",
    "cd ~",
  ]) {
    assert.equal(profile.classifyShell(command).decision, "deny", command);
  }
  assert.equal(profile.classifyShell("npm test").decision, "allow");
});

test("可信网络目标绑定 Profile、命令分类和 Sandbox 扩展", () => {
  const profile = createPermissionProfile({
    name: "workspace-auto",
    workspace: "/tmp/workspace",
    executionType: "native",
    networkTargets: [{ host: "192.168.121.110", port: 22 }],
  });
  const ssh = profile.classifyShell("ssh -o StrictHostKeyChecking=no root@192.168.121.110 uptime");
  assert.equal(ssh.decision, "approval_required");
  assert.equal(ssh.explanation.category, "trusted_network_target");
  assert.deepEqual(ssh.approvalScopes, ["once", "session"]);
  assert.deepEqual(ssh.explanation.networkTargets, [{ host: "192.168.121.110", port: 22 }]);
  assert.deepEqual(profile.networkTargetsForShell("ssh root@192.168.121.110 uptime"), [{ host: "192.168.121.110", port: 22 }]);

  const expect = profile.classifyShell("expect /tmp/ssh.exp 192.168.121.110 root uptime");
  assert.equal(expect.decision, "approval_required");
  assert.equal(expect.explanation.category, "trusted_network_target");
  assert.equal(profile.classifyShell("ssh root@192.168.121.111 uptime").decision, "deny");
  assert.equal(profile.classifyShell("curl http://192.168.121.110:8080").decision, "deny");
  assert.equal(profile.classifyShell("npm install").decision, "approval_required");
  assert.equal(profile.classifyShell("echo 192.168.121.110").decision, "allow");
  assert.deepEqual(profile.networkTargetsForShell("echo 192.168.121.110"), []);

  const withoutTargets = createPermissionProfile({ name: "workspace-auto", workspace: "/tmp/workspace", executionType: "native" });
  assert.equal(withoutTargets.classifyShell("ssh root@192.168.121.111 uptime").decision, "approval_required");
  assert.notEqual(profile.version, withoutTargets.version);
});

test("danger-full-access 只允许 trusted-local 并跳过工具审批与保护分类", () => {
  assert.throws(
    () => createPermissionProfile({ name: "danger-full-access", workspace: "/tmp/workspace", executionType: "native" }),
    /只能与显式 trusted-local/,
  );
  const profile = createPermissionProfile({ name: "danger-full-access", workspace: "/tmp/workspace", executionType: "local" });
  assert.equal(profile.classifyShell("rm -rf src && cat ~/.ssh/id_rsa && curl https://example.com").decision, "allow");
  assert.equal(profile.pathDecision(".env.local", "read").decision, "allow");
  assert.equal(profile.authorize({
    definition: { name: "credential_tool", capability: { risk: "R3", effects: ["credential"], readOnly: false } },
    call: { arguments: {} },
    resources: [],
  }).decision, "allow");
  assert.equal(profile.canExpose({ capability: { risk: "R3", effects: ["credential"] } }), true);
});

test("workspace-auto 对沙箱内破坏性操作请求可复用到 Session 的审批", () => {
  const profile = createPermissionProfile({ name: "workspace-auto", workspace: "/tmp/workspace", executionType: "native" });
  for (const command of [
    "rm -r -f src",
    "rm --recursive --force src",
    "find . -delete",
    "find src -type f -exec rm -f {} +",
    "find src -type f -print0 | xargs -0 rm -f",
  ]) {
    const decision = profile.classifyShell(command);
    assert.equal(decision.decision, "approval_required", command);
    assert.equal(decision.explanation.category, "workspace_destructive", command);
    assert.deepEqual(decision.approvalScopes, ["once", "session"], command);
  }
  assert.equal(profile.classifyShell("find src -name '*.js' -print").decision, "allow");
  for (const command of ["sudo reboot", "shutdown -h now", "mkfs /dev/disk9", "rm -rf ../outside", "cat /etc/passwd"]) {
    assert.equal(profile.classifyShell(command).decision, "deny", command);
  }
});

test("workspace-auto 不会自动允许动态解释器绕过破坏性命令分类", () => {
  const profile = createPermissionProfile({ name: "workspace-auto", workspace: "/tmp/workspace", executionType: "native" });
  for (const command of [
    "python3 -c \"import shutil; shutil.rmtree('src')\"",
    "node --eval \"require('fs').rmSync('src', { recursive: true, force: true })\"",
    "ruby -e \"FileUtils.rm_rf('src')\"",
    "perl -e \"use File::Path qw(remove_tree); remove_tree('src')\"",
    "php -r \"array_map('unlink', glob('src/*'));\"",
    "bash -c \"printf safe\"",
  ]) {
    const decision = profile.classifyShell(command);
    assert.equal(decision.decision, "approval_required", command);
    assert.equal(decision.explanation.category, "dynamic_interpreter", command);
    assert.deepEqual(decision.approvalScopes, ["once", "session"], command);
  }
  assert.equal(profile.classifyShell("echo `git status --short`").decision, "approval_required");
  assert.equal(profile.classifyShell("echo $(git status --short)").decision, "approval_required");
  assert.equal(profile.classifyShell("python3 -m pytest").decision, "allow");
  assert.equal(profile.classifyShell("node --test").decision, "allow");
});

test("workspace-untrusted 只自动允许沙箱内明确的只读检查命令", () => {
  const profile = createPermissionProfile({ name: "workspace-untrusted", workspace: "/tmp/workspace", executionType: "native" });
  assert.equal(profile.pathDecision("src/app.js", "write").decision, "allow");
  for (const command of [
    "pwd",
    "ls -la src",
    "rg --files src",
    "rg TODO src",
    "git status --short",
    "git diff --check",
    "git rev-parse --show-toplevel",
    "git ls-files src",
  ]) {
    const decision = profile.classifyShell(command);
    assert.equal(decision.decision, "allow", command);
    assert.equal(decision.explanation.category, "untrusted_safe_read", command);
  }
  for (const command of [
    "npm test",
    "npm run build",
    "node --test",
    "python3 -m pytest",
    "bash scripts/check.sh",
    "echo changed > output.txt",
    "git checkout main",
    "rg --follow secret .",
    "./git status --short",
  ]) {
    const decision = profile.classifyShell(command);
    assert.equal(decision.decision, "approval_required", command);
  }
  assert.equal(profile.classifyShell("rm -rf src").decision, "approval_required");

  const local = createPermissionProfile({ name: "workspace-untrusted", workspace: "/tmp/workspace", executionType: "local" });
  assert.equal(local.classifyShell("git status --short").decision, "approval_required");
});

test("workspace-confirm 对普通写入和所有 Shell 请求确认，但保留真正硬拒绝", () => {
  const profile = createPermissionProfile({ name: "workspace-confirm", workspace: "/tmp/workspace", executionType: "native" });
  const read = { name: "read_file", capability: { risk: "R0", effects: ["read"], readOnly: true } };
  const write = { name: "write_file", capability: { risk: "R1", effects: ["write"], readOnly: false } };
  assert.equal(profile.authorize({ definition: read, call: { arguments: {} }, resources: [] }).decision, "allow");
  const writeDecision = profile.authorize({
    definition: write,
    call: { arguments: { path: "src/app.js" } },
    resources: [{ kind: "workspace_path", value: "src/app.js", access: "write" }],
  });
  assert.equal(writeDecision.decision, "approval_required");
  assert.deepEqual(writeDecision.approvalScopes, ["once", "session"]);
  assert.equal(profile.classifyShell("npm test").decision, "approval_required");
  assert.equal(profile.pathDecision(".nexus/config.json", "read").decision, "allow");
  assert.equal(profile.pathDecision(".nexus/config.local.json", "read").decision, "deny");
  assert.equal(profile.pathDecision(".agents/skill.md", "write").decision, "approval_required");
  assert.equal(profile.pathDecision(".env.local", "read").decision, "deny");
  assert.equal(profile.pathDecision(".ssh/id_rsa", "read").decision, "deny");
  assert.equal(profile.pathDecision(".aws/credentials", "read").decision, "deny");
  assert.equal(profile.classifyShell("cat ~/.ssh/id_rsa").decision, "deny");
  assert.equal(profile.classifyShell("cat .ssh/id_rsa").decision, "deny");
});

test("workspace-untrusted 的自动 Shell 使用固定工具路径", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-untrusted-path-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const calls = [];
  const profile = createPermissionProfile({ name: "workspace-untrusted", workspace, executionType: "native" });
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    accessPolicy: profile,
    workspaceExecution: {
      id: "native-sandbox",
      execute: async (spec) => {
        calls.push(spec);
        return { exitCode: 0, output: "clean" };
      },
    },
  });

  assert.equal(await registry.get("run_shell").execute(
    { command: "git status --short" },
    { state: { permissionProfile: "workspace-untrusted" }, signal: null },
  ), "clean");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
});

test("read-only 只允许工作区读取和最小只读 Shell，所有提权路径硬拒绝", () => {
  const profile = createPermissionProfile({ name: "read-only", workspace: "/tmp/workspace", executionType: "native" });
  assert.equal(profile.pathDecision("src/app.js", "read").decision, "allow");
  assert.equal(profile.pathDecision("src/app.js", "write").decision, "deny");
  for (const command of ["pwd", "ls -la", "rg TODO", "rg --files"]) {
    assert.equal(profile.classifyShell(command).decision, "allow", command);
  }
  for (const command of [
    "git status --short",
    "ls src",
    "rg TODO src",
    "rg --files /tmp",
    "npm test",
    "curl https://example.com",
    "echo changed > output.txt",
    "python3 -c 'print(1)'",
    "rm -rf src",
  ]) {
    assert.equal(profile.classifyShell(command).decision, "deny", command);
  }
  const read = { name: "read_file", capability: { risk: "R0", effects: ["read"], readOnly: true } };
  const write = { name: "write_file", capability: { risk: "R1", effects: ["write"], readOnly: false } };
  const shell = { name: "run_shell", capability: { risk: "R2", effects: ["execute"], readOnly: false } };
  const networkRead = { name: "remote_read", capability: { risk: "R2", effects: ["read", "network"], readOnly: true } };
  assert.equal(profile.canExpose(read), true);
  assert.equal(profile.canExpose(write), false);
  assert.equal(profile.canExpose(shell), true);
  assert.equal(profile.canExpose(networkRead), false);

  const local = createPermissionProfile({ name: "read-only", workspace: "/tmp/workspace", executionType: "local" });
  assert.equal(local.classifyShell("pwd").decision, "deny");
});

test("read-only 的自动 Shell 使用固定工具路径", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-read-only-path-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const calls = [];
  const profile = createPermissionProfile({ name: "read-only", workspace, executionType: "native" });
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    accessPolicy: profile,
    workspaceExecution: {
      id: "native-sandbox",
      execute: async (spec) => {
        calls.push(spec);
        return { exitCode: 0, output: "read-only" };
      },
    },
  });

  assert.equal(await registry.get("run_shell").execute(
    { command: "rg --files" },
    { state: { permissionProfile: "read-only" }, signal: null },
  ), "read-only");
  assert.equal(calls[0].env.PATH, "/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin:/usr/local/bin");
  assert.equal(calls[0].filesystemMode, "read-only");
});

test("文件工具统一隐藏所有 .env* 变体", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-env-variants-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, "visible.txt"), "variant-needle visible", "utf8");
  for (const filename of [".envrc", ".env-secret", ".environment"]) {
    await fs.writeFile(path.join(workspace, filename), `variant-needle ${filename}`, "utf8");
  }
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    workspaceExecution: { id: "native-sandbox", execute: async () => ({ exitCode: 0, output: "ok" }) },
  });

  for (const filename of [".envrc", ".env-secret", ".environment"]) {
    await assert.rejects(registry.get("read_file").execute({ path: filename }), /拒绝读取受保护路径/);
  }
  const search = await registry.get("search_files").execute({ query: "variant-needle", path: "." });
  assert.match(search, /visible\.txt/);
  assert.equal(search.includes(".env"), false);
  const listing = await registry.get("list_files").execute({ path: "." });
  for (const filename of [".envrc", ".env-secret", ".environment"]) {
    assert.equal(listing.includes(filename), false, filename);
  }
});

test("Tool Registry 执行层按 Session profile 选择 Shell 防线", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-profile-registry-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.writeFile(path.join(workspace, ".env.local"), "TEST_ONLY=value", "utf8");
  const calls = [];
  const profiles = Object.fromEntries(["workspace-auto", "danger-full-access"].map((name) => [name, createPermissionProfile({
    name,
    workspace,
    executionType: "local",
  })]));
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    accessPolicy: profiles["workspace-auto"],
    accessPolicies: profiles,
    workspaceExecution: {
      id: "local-workspace",
      inspect: () => ({ id: "local-workspace" }),
      execute: async (spec) => {
        calls.push(spec);
        return { exitCode: 0, output: "ok" };
      },
    },
  });
  const shell = registry.get("run_shell");

  assert.equal(await shell.execute(
    { command: "rm -rf src" },
    { state: { permissionProfile: "workspace-auto" }, signal: null },
  ), "ok");
  assert.equal(calls.length, 1);
  assert.equal(await shell.execute(
    { command: "rm -rf src" },
    { state: { permissionProfile: "danger-full-access" }, signal: null },
  ), "ok");
  assert.equal(calls.length, 2);
  const readFile = registry.get("read_file");
  await assert.rejects(
    readFile.execute({ path: ".env.local" }, { state: { permissionProfile: "workspace-auto" } }),
    /拒绝读取受保护路径/,
  );
  assert.equal(await readFile.execute(
    { path: ".env.local" },
    { state: { permissionProfile: "danger-full-access" } },
  ), "TEST_ONLY=value");
});

test("Tool Registry 只把审批命令命中的可信网络目标交给 WorkspaceExecution", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-network-target-registry-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const calls = [];
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
        calls.push(spec);
        return { exitCode: 0, output: "ok" };
      },
    },
  });
  const shell = registry.get("run_shell");

  assert.equal(await shell.execute({ command: "ssh root@192.168.121.110 uptime" }, {}), "ok");
  assert.deepEqual(calls[0].networkTargets, [{ host: "192.168.121.110", port: 22 }]);
  await assert.rejects(shell.execute({ command: "ssh root@192.168.121.111 uptime" }, {}), /不在可信网络目标白名单/);
  assert.equal(calls.length, 1);
});

test("文件工具与 Shell 共享敏感路径策略", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-access-policy-"));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  await fs.mkdir(path.join(workspace, "src"));
  await fs.mkdir(path.join(workspace, ".nexus"));
  await fs.mkdir(path.join(workspace, ".git"));
  await fs.writeFile(path.join(workspace, "src", "visible.txt"), "shared-needle visible", "utf8");
  await fs.writeFile(path.join(workspace, ".env.production"), "shared-needle secret", "utf8");
  await fs.writeFile(path.join(workspace, ".nexus", "notes.md"), "shared-needle visible-metadata", "utf8");
  await fs.writeFile(path.join(workspace, ".nexus", "config.local.json"), "shared-needle private", "utf8");
  const registry = createToolRegistry({
    workspace,
    bundledSkills: path.join(workspace, "skills"),
    workspaceExecution: { id: "native-sandbox", execute: async () => ({ exitCode: 0, output: "ok" }) },
  });

  await assert.rejects(registry.get("read_file").execute({ path: ".env.production" }), /拒绝读取受保护路径/);
  assert.equal(await registry.get("read_file").execute({ path: ".nexus/notes.md" }), "shared-needle visible-metadata");
  await assert.rejects(registry.get("read_file").execute({ path: ".nexus/config.local.json" }), /拒绝读取受保护路径/);
  const search = await registry.get("search_files").execute({ query: "shared-needle", path: "." });
  assert.match(search, /src\/visible\.txt/);
  assert.equal(search.includes(".env.production"), false);
  assert.match(search, /\.nexus\/notes\.md/);
  assert.equal(search.includes("config.local.json"), false);
  const listing = await registry.get("list_files").execute({ path: "." });
  assert.equal(listing.includes(".env.production"), false);
  assert.equal(listing.includes(".nexus"), true);
  assert.match(listing, /src/);
});
