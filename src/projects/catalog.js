// FOUNDATION — managed local Project catalog; Project identity is the canonical Workspace identity.
import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { projectIdentity } from "../tools/project-grant-store.js";

export class ProjectCatalog {
  #root;
  #defaultWorkspace;
  #legacyProjects;
  #canonicalRoot = null;
  #defaultProjectId = null;
  #defaultManaged = false;

  constructor({ root, defaultWorkspace, legacyProjects = [] } = {}) {
    this.#root = requiredPath(root, "Projects Root");
    this.#defaultWorkspace = requiredPath(defaultWorkspace, "默认 Workspace");
    if (!Array.isArray(legacyProjects)) throw new TypeError("legacyProjects 必须是数组");
    this.#legacyProjects = legacyProjects.map((project) => ({
      workspace: requiredPath(project?.workspace, "Legacy Project Workspace"),
      name: normalizeDisplayName(project?.name || path.basename(project?.workspace || "")),
    }));
  }

  get root() {
    return this.#canonicalRoot || this.#root;
  }

  get defaultProjectId() {
    if (!this.#defaultProjectId) throw new Error("Project Catalog 尚未初始化");
    return this.#defaultProjectId;
  }

  async initialize() {
    await fs.mkdir(this.#root, { recursive: true, mode: 0o700 });
    this.#canonicalRoot = await fs.realpath(this.#root);
    const managedDefault = await isCanonicalDirectChild(this.#canonicalRoot, this.#defaultWorkspace);
    this.#defaultManaged = managedDefault;
    if (managedDefault) {
      await ensureManagedProjectWorkspace(this.#defaultWorkspace, { root: this.#canonicalRoot });
    }
    const defaultProject = await this.#projectFromWorkspace(this.#defaultWorkspace, {
      name: "默认工作区",
      isDefault: true,
      managed: managedDefault,
    });
    this.#defaultProjectId = defaultProject.id;
    return this;
  }

  async list() {
    await this.#ensureInitialized();
    const projects = new Map();
    const add = (project) => projects.set(project.workspace, project);

    const defaultProject = await this.#projectFromWorkspace(this.#defaultWorkspace, {
      name: "默认工作区",
      isDefault: true,
      managed: this.#defaultManaged,
    });
    add(defaultProject);

    const entries = await fs.readdir(this.#canonicalRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith(".")) continue;
      const workspace = path.join(this.#canonicalRoot, entry.name);
      const canonical = await fs.realpath(workspace);
      // An explicitly selected nested Workspace is registered as an external
      // Project. Do not also expose its parent directory as a managed Project,
      // which would create overlapping permission and Session boundaries.
      if (!defaultProject.managed && isWithin(canonical, defaultProject.workspace)) continue;
      const isDefault = canonical === defaultProject.workspace;
      const project = await this.#projectFromWorkspace(workspace, {
        name: isDefault ? "默认工作区" : entry.name,
        isDefault,
      });
      add(project);
    }

    for (const legacy of this.#legacyProjects) {
      if (path.resolve(legacy.workspace) === path.resolve(this.#defaultWorkspace)) continue;
      try {
        add(await this.#projectFromWorkspace(legacy.workspace, {
          name: legacy.name,
          managed: false,
          legacy: true,
        }));
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }

    return [...projects.values()].sort((left, right) => {
      if (left.isDefault !== right.isDefault) return left.isDefault ? -1 : 1;
      if (left.managed !== right.managed) return left.managed ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN");
    });
  }

  async get(id) {
    if (typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)) {
      throw new ProjectCatalogError(404, "项目不存在");
    }
    const project = (await this.list()).find((item) => item.id === id);
    if (!project) throw new ProjectCatalogError(404, "项目不存在");
    return project;
  }

  async create({ name } = {}) {
    await this.#ensureInitialized();
    const projectName = normalizeProjectDirectoryName(name);
    const workspace = path.join(this.#canonicalRoot, projectName);
    if (!isDirectChild(this.#canonicalRoot, workspace)) {
      throw new ProjectCatalogError(400, "项目目录必须位于受管 Projects Root 下");
    }
    try {
      await fs.mkdir(workspace, { mode: 0o700 });
    } catch (error) {
      if (error?.code === "EEXIST") throw new ProjectCatalogError(409, `项目“${projectName}”已经存在`);
      throw error;
    }
    await ensurePrivateGitIgnore(workspace);
    return this.#projectFromWorkspace(workspace, { name: projectName });
  }

  async #projectFromWorkspace(workspace, { name, isDefault = false, managed, legacy = false } = {}) {
    const canonical = await fs.realpath(workspace);
    const stat = await fs.lstat(canonical);
    if (!stat.isDirectory()) throw new ProjectCatalogError(400, `项目 Workspace 不是目录：${workspace}`);
    const isManaged = managed ?? isWithin(this.#canonicalRoot, canonical);
    if (isManaged && !isDirectChildOrSame(this.#canonicalRoot, canonical)) {
      throw new ProjectCatalogError(400, "受管项目必须是 Projects Root 的直接子目录");
    }
    return Object.freeze({
      id: projectIdentity(canonical),
      name: normalizeDisplayName(name || path.basename(canonical)),
      workspace: canonical,
      directory: path.basename(canonical),
      managed: isManaged,
      isDefault,
      legacy,
    });
  }

  async #ensureInitialized() {
    if (!this.#canonicalRoot) await this.initialize();
  }
}

export class ProjectCatalogError extends Error {
  constructor(status, message) {
    super(message);
    this.name = "ProjectCatalogError";
    this.status = status;
  }
}

export function publicProject(project) {
  return Object.freeze({
    id: project.id,
    name: project.name,
    directory: project.directory,
    managed: project.managed,
    isDefault: project.isDefault,
    legacy: project.legacy,
  });
}

export async function ensureManagedProjectWorkspace(workspace, { root = path.dirname(workspace) } = {}) {
  const target = requiredPath(workspace, "Managed Project Workspace");
  const projectsRoot = requiredPath(root, "Projects Root");
  await fs.mkdir(projectsRoot, { recursive: true, mode: 0o700 });
  const canonicalRoot = await fs.realpath(projectsRoot);
  const canonicalParent = await fs.realpath(path.dirname(target));
  if (canonicalParent !== canonicalRoot || !path.basename(target)) {
    throw new ProjectCatalogError(400, "受管项目必须是 Projects Root 的直接子目录");
  }
  const managedTarget = path.join(canonicalRoot, path.basename(target));
  await fs.mkdir(managedTarget, { recursive: true, mode: 0o700 });
  const targetStat = await fs.lstat(managedTarget);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new ProjectCatalogError(400, "受管项目 Workspace 必须是真实目录，不能是符号链接");
  }
  const canonicalTarget = await fs.realpath(managedTarget);
  if (!isDirectChild(canonicalRoot, canonicalTarget)) {
    throw new ProjectCatalogError(400, "受管项目不能通过符号链接越出 Projects Root");
  }
  await ensurePrivateGitIgnore(canonicalTarget);
  return canonicalTarget;
}

export async function ensureWorkspaceStateDirectory(workspace) {
  const canonicalWorkspace = await fs.realpath(requiredPath(workspace, "Workspace"));
  const stateDirectory = path.join(canonicalWorkspace, ".nexus");
  try {
    const current = await fs.lstat(stateDirectory);
    if (current.isSymbolicLink() || !current.isDirectory()) {
      throw new ProjectCatalogError(400, "Workspace 的 .nexus 必须是真实目录，不能是符号链接");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    await fs.mkdir(stateDirectory, { mode: 0o700 });
  }
  const canonicalState = await fs.realpath(stateDirectory);
  if (path.dirname(canonicalState) !== canonicalWorkspace) {
    throw new ProjectCatalogError(400, "Workspace 的 .nexus 不能越出项目目录");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await assertOptionalRegularFile(path.join(canonicalState, `nexus.db${suffix}`));
  }
  const database = path.join(canonicalState, "nexus.db");
  let databaseHandle;
  try {
    databaseHandle = await fs.open(database, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error?.code)) {
      throw new ProjectCatalogError(400, "Workspace 的 nexus.db 不能是符号链接");
    }
    throw error;
  }
  try {
    if (!(await databaseHandle.stat()).isFile()) {
      throw new ProjectCatalogError(400, "Workspace 的 nexus.db 必须是普通文件");
    }
  } finally {
    await databaseHandle.close();
  }
  return canonicalState;
}

export async function existingWorkspaceStateDatabase(workspace) {
  const canonicalWorkspace = await fs.realpath(requiredPath(workspace, "Workspace"));
  const stateDirectory = path.join(canonicalWorkspace, ".nexus");
  let stateStat;
  try {
    stateStat = await fs.lstat(stateDirectory);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (stateStat.isSymbolicLink() || !stateStat.isDirectory()) {
    throw new ProjectCatalogError(400, "Workspace 的 .nexus 必须是真实目录，不能是符号链接");
  }
  const canonicalState = await fs.realpath(stateDirectory);
  if (path.dirname(canonicalState) !== canonicalWorkspace) {
    throw new ProjectCatalogError(400, "Workspace 的 .nexus 不能越出项目目录");
  }
  const database = path.join(canonicalState, "nexus.db");
  let databaseStat;
  try {
    databaseStat = await fs.lstat(database);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) {
    throw new ProjectCatalogError(400, "Workspace 的 nexus.db 必须是普通文件，不能是符号链接");
  }
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    await assertOptionalRegularFile(path.join(canonicalState, `nexus.db${suffix}`));
  }
  return database;
}

async function assertOptionalRegularFile(file) {
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new ProjectCatalogError(400, `${path.basename(file)} 必须是普通文件，不能是符号链接`);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

function requiredPath(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} 必须是非空路径`);
  return path.resolve(value);
}

function normalizeDisplayName(value) {
  const name = String(value || "").normalize("NFC").trim();
  if (!name || name.length > 80) throw new ProjectCatalogError(400, "项目名称必须是 1 到 80 个字符");
  return name;
}

function normalizeProjectDirectoryName(value) {
  const name = normalizeDisplayName(value);
  if (name === "." || name === ".." || name.startsWith(".") || /[\\/\0-\x1f]/u.test(name) || /[. ]$/u.test(name)) {
    throw new ProjectCatalogError(400, "项目名称不能包含路径、隐藏目录或控制字符");
  }
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu.test(name)) {
    throw new ProjectCatalogError(400, "项目名称是系统保留名称");
  }
  return name;
}

function isWithin(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function isDirectChild(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return Boolean(relative) && !relative.includes(path.sep) && relative !== "..";
}

async function isCanonicalDirectChild(root, target) {
  try {
    return await fs.realpath(path.dirname(path.resolve(target))) === path.resolve(root)
      && Boolean(path.basename(path.resolve(target)));
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function isDirectChildOrSame(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || isDirectChild(root, target);
}

async function ensurePrivateGitIgnore(workspace) {
  const file = path.join(workspace, ".gitignore");
  const required = [
    ".nexus/nexus.db*",
    ".nexus/config.local.json",
    ".nexus/mcp.json",
    ".nexus/exports/",
  ];
  let handle;
  try {
    handle = await fs.open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    if (["ELOOP", "EMLINK"].includes(error?.code)) {
      throw new ProjectCatalogError(400, "项目 .gitignore 不能是符号链接");
    }
    throw error;
  }
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new ProjectCatalogError(400, "项目 .gitignore 必须是普通文件");
    const existing = await handle.readFile("utf8");
    const present = new Set(existing.split(/\r?\n/u).map((line) => line.trim()));
    const missing = required.filter((line) => !present.has(line));
    if (!missing.length) return;
    const separator = existing && !existing.endsWith("\n") ? "\n" : "";
    const heading = present.has("# Nexus local state") ? "" : "# Nexus local state\n";
    const next = Buffer.from(`${existing}${separator}${heading}${missing.join("\n")}\n`, "utf8");
    await handle.write(next, 0, next.length, 0);
    await handle.truncate(next.length);
    await handle.sync();
  } finally {
    await handle.close();
  }
}
