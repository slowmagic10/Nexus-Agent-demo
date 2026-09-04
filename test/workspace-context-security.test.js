import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createToolRegistry } from "../src/tools/registry.js";
import { loadWorkspaceContext } from "../src/workspace.js";

test("Workspace Context 不跟随 AGENTS.md 或 SOUL.md 符号链接越界", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-context-link-"));
  const workspace = path.join(fixture, "workspace");
  const secret = path.join(fixture, "host-secret");
  await fs.mkdir(workspace);
  await fs.writeFile(secret, "HOST_CREDENTIAL_SHOULD_NOT_LEAK", "utf8");
  await fs.symlink(secret, path.join(workspace, "AGENTS.md"));
  await fs.symlink(secret, path.join(workspace, "SOUL.md"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));

  const context = await loadWorkspaceContext(workspace);
  assert.equal(context.includes("HOST_CREDENTIAL_SHOULD_NOT_LEAK"), false);
  assert.equal(context, "工作区没有 AGENTS.md 或 SOUL.md。");
});

test("Workspace Context 仍读取边界内普通文件并保持长度上限", async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-context-safe-"));
  await fs.writeFile(path.join(workspace, "AGENTS.md"), `安全说明\n${"甲".repeat(20_000)}`, "utf8");
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));

  const context = await loadWorkspaceContext(workspace);
  assert.match(context, /^## AGENTS\.md\n安全说明/u);
  assert.ok(context.length <= 12_020);
});

test("Workspace Skill 的发现与加载不会跟随 SKILL.md 符号链接", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-skill-link-"));
  const workspace = path.join(fixture, "workspace");
  const bundledSkills = path.join(fixture, "bundled-skills");
  const skillDirectory = path.join(workspace, ".nexus", "skills", "evil");
  const safeSkillDirectory = path.join(workspace, ".nexus", "skills", "safe");
  const secret = path.join(fixture, "host-skill-secret");
  await fs.mkdir(skillDirectory, { recursive: true });
  await fs.mkdir(safeSkillDirectory);
  await fs.mkdir(bundledSkills);
  await fs.writeFile(secret, "description: HOST_SKILL_SECRET", "utf8");
  await fs.symlink(secret, path.join(skillDirectory, "SKILL.md"));
  await fs.writeFile(path.join(safeSkillDirectory, "SKILL.md"), "description: 边界内技能\n请安全执行。", "utf8");
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));

  const registry = createToolRegistry({ workspace, bundledSkills });
  const listed = await registry.get("list_skills").execute({});
  assert.equal(listed.includes("HOST_SKILL_SECRET"), false);
  assert.match(listed, /safe\t边界内技能/u);
  await assert.rejects(registry.get("load_skill").execute({ name: "evil" }, {
    dispatch: async () => assert.fail("越界 Skill 不应写入 durable Session"),
  }), /未找到 Skill/);
  let durableSkill = null;
  const loaded = await registry.get("load_skill").execute({ name: "safe" }, {
    dispatch: async (action) => { durableSkill = action.skill; },
  });
  assert.match(loaded, /请安全执行/u);
  assert.equal(durableSkill?.name, "safe");
});
