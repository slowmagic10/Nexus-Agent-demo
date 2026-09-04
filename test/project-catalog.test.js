import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ensureManagedProjectWorkspace,
  ensureWorkspaceStateDirectory,
  ProjectCatalog,
} from "../src/projects/catalog.js";
import { projectIdentity } from "../src/tools/project-grant-store.js";

test("Project Catalog 创建独立默认 Workspace 并保留显式旧项目", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-catalog-"));
  const root = path.join(fixture, "Nexus Projects");
  const legacy = path.join(fixture, "Nexus Agent");
  await fs.mkdir(legacy);
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));

  const catalog = await new ProjectCatalog({
    root,
    defaultWorkspace: path.join(root, "Default"),
    legacyProjects: [{ workspace: legacy, name: "Nexus Agent（旧工作区）" }],
  }).initialize();
  const listed = await catalog.list();

  assert.equal(listed.length, 2);
  assert.equal(listed[0].name, "默认工作区");
  assert.equal(listed[0].workspace, await fs.realpath(path.join(root, "Default")));
  assert.equal(listed[0].id, projectIdentity(listed[0].workspace));
  assert.equal(listed[0].isDefault, true);
  assert.equal(listed[1].name, "Nexus Agent（旧工作区）");
  assert.equal(listed[1].managed, false);
  assert.equal(listed[1].legacy, true);
  assert.notEqual(listed[0].workspace, legacy);

  const ignore = await fs.readFile(path.join(root, "Default", ".gitignore"), "utf8");
  assert.match(ignore, /^\.nexus\/nexus\.db\*/m);
  assert.match(ignore, /^\.nexus\/config\.local\.json$/m);
});

test("Project Catalog 只在受管 Root 创建单层真实目录", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-create-"));
  const root = path.join(fixture, "projects");
  const catalog = await new ProjectCatalog({ root, defaultWorkspace: path.join(root, "Default") }).initialize();
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));

  const created = await catalog.create({ name: "数据分析实验" });
  assert.equal(created.name, "数据分析实验");
  assert.equal(created.directory, "数据分析实验");
  assert.equal(created.managed, true);
  assert.equal((await fs.lstat(created.workspace)).isDirectory(), true);
  assert.equal((await catalog.get(created.id)).workspace, created.workspace);
  await assert.rejects(catalog.create({ name: "数据分析实验" }), (error) => error.status === 409);

  for (const name of ["../escape", "nested/path", ".hidden", "..", "bad\\path", "bad\0name"]) {
    await assert.rejects(catalog.create({ name }), (error) => error.status === 400);
  }
  await assert.rejects(catalog.get("not-a-project-id"), (error) => error.status === 404);
  await assert.rejects(fs.access(path.join(fixture, "escape")));
});

test("Project Catalog 不跟随 Projects Root 下的符号链接项目", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-symlink-"));
  const root = path.join(fixture, "projects");
  const outside = path.join(fixture, "outside");
  await fs.mkdir(outside);
  const catalog = await new ProjectCatalog({ root, defaultWorkspace: path.join(root, "Default") }).initialize();
  await fs.symlink(outside, path.join(root, "linked-outside"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));

  assert.equal((await catalog.list()).some((project) => project.directory === "linked-outside"), false);
  await assert.rejects(catalog.create({ name: "linked-outside" }), (error) => error.status === 409);
});

test("显式默认 Workspace 位于 Projects Root 深层时作为外部项目稳定列出", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-nested-default-"));
  const root = path.join(fixture, "projects");
  const workspace = path.join(root, "group", "repo");
  await fs.mkdir(workspace, { recursive: true });
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));

  const catalog = await new ProjectCatalog({ root, defaultWorkspace: workspace }).initialize();
  const listed = await catalog.list();

  assert.equal(listed.length, 1);
  assert.equal(listed[0].workspace, await fs.realpath(workspace));
  assert.equal(listed[0].managed, false);
  assert.equal(listed[0].isDefault, true);
  assert.deepEqual(await catalog.get(listed[0].id), listed[0]);
});

test("受管项目不会通过 .gitignore 或 .nexus 符号链接写出 Workspace", async (t) => {
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "nexus-project-internal-link-"));
  const root = path.join(fixture, "projects");
  const workspace = path.join(root, "Unsafe");
  const outsideIgnore = path.join(fixture, "outside.gitignore");
  const outsideState = path.join(fixture, "outside-state");
  await fs.mkdir(workspace, { recursive: true });
  await fs.mkdir(outsideState);
  await fs.writeFile(outsideIgnore, "outside\n", "utf8");
  await fs.symlink(outsideIgnore, path.join(workspace, ".gitignore"));
  t.after(() => fs.rm(fixture, { recursive: true, force: true }));

  await assert.rejects(
    ensureManagedProjectWorkspace(workspace, { root }),
    /\.gitignore 不能是符号链接/,
  );
  assert.equal(await fs.readFile(outsideIgnore, "utf8"), "outside\n");

  await fs.unlink(path.join(workspace, ".gitignore"));
  await fs.symlink(outsideState, path.join(workspace, ".nexus"));
  await assert.rejects(ensureWorkspaceStateDirectory(workspace), /\.nexus 必须是真实目录/);
  await assert.rejects(fs.access(path.join(outsideState, "nexus.db")));

  await fs.unlink(path.join(workspace, ".nexus"));
  await fs.mkdir(path.join(workspace, ".nexus"));
  const outsideWal = path.join(fixture, "outside-wal");
  await fs.writeFile(outsideWal, "unchanged", "utf8");
  await fs.symlink(outsideWal, path.join(workspace, ".nexus", "nexus.db-wal"));
  await assert.rejects(ensureWorkspaceStateDirectory(workspace), /nexus\.db-wal 必须是普通文件/);
  assert.equal(await fs.readFile(outsideWal, "utf8"), "unchanged");
});
