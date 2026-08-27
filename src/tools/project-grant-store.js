// FOUNDATION — user-private, workspace-bound project grants.
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export class ProjectGrantStore {
  constructor(file) {
    if (typeof file !== "string" || !file.trim()) throw new Error("Project Grant Store 文件路径无效");
    this.file = path.resolve(file);
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(this.file);
    chmodSync(this.file, 0o600);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_grants (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        workspace TEXT NOT NULL,
        tool TEXT NOT NULL,
        capability_hash TEXT NOT NULL,
        policy_version TEXT NOT NULL,
        resources_json TEXT NOT NULL,
        issued_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        revoked_at TEXT,
        revoked_reason TEXT
      );
      CREATE INDEX IF NOT EXISTS project_grants_project_active
        ON project_grants(project_id, revoked_at, expires_at);
      CREATE TABLE IF NOT EXISTS project_grant_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        grant_id TEXT NOT NULL,
        at TEXT NOT NULL,
        type TEXT NOT NULL,
        detail_json TEXT NOT NULL
      );
    `);
  }

  issue(grant) {
    validateProjectGrant(grant);
    const expectedProjectId = projectIdentity(grant.workspace);
    if (grant.projectId !== expectedProjectId) throw new Error("Project Grant 与 workspace 身份不匹配");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare(`
        INSERT INTO project_grants (
          id, project_id, workspace, tool, capability_hash, policy_version,
          resources_json, issued_at, expires_at, revoked_at, revoked_reason
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
      `).run(
        grant.id,
        grant.projectId,
        canonicalWorkspace(grant.workspace),
        grant.tool,
        grant.capabilityHash,
        grant.policyVersion,
        JSON.stringify(grant.resources),
        grant.issuedAt,
        grant.expiresAt,
      );
      this.#event(grant.id, grant.issuedAt, "project_grant.issued", {
        projectId: grant.projectId,
        tool: grant.tool,
        policyVersion: grant.policyVersion,
        resources: grant.resources,
        expiresAt: grant.expiresAt,
      });
      this.db.exec("COMMIT");
      return grant;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  list({ workspace, now = new Date().toISOString(), includeInactive = false } = {}) {
    const projectId = projectIdentity(workspace);
    const rows = this.db.prepare(`
      SELECT * FROM project_grants
      WHERE project_id = ?
      ORDER BY issued_at DESC
    `).all(projectId);
    const nowMs = new Date(now).getTime();
    if (!Number.isFinite(nowMs)) throw new Error("Project Grant 查询时间无效");
    return rows.map(rowToGrant).filter((grant) => (
      includeInactive || (!grant.revokedAt && new Date(grant.expiresAt).getTime() > nowMs)
    ));
  }

  revoke(id, reason = "用户撤销项目授权", at = new Date().toISOString()) {
    if (typeof id !== "string" || !id) throw new Error("Project Grant ID 无效");
    if (!Number.isFinite(new Date(at).getTime())) throw new Error("Project Grant 撤销时间无效");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = this.db.prepare(`
        UPDATE project_grants
        SET revoked_at = ?, revoked_reason = ?
        WHERE id = ? AND revoked_at IS NULL
      `).run(at, String(reason || "用户撤销项目授权"), id);
      if (result.changes !== 1) throw new Error(`未找到可撤销的 Project Grant：${id}`);
      this.#event(id, at, "project_grant.revoked", { reason: String(reason || "用户撤销项目授权") });
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  #event(grantId, at, type, detail) {
    this.db.prepare(`
      INSERT INTO project_grant_events (grant_id, at, type, detail_json)
      VALUES (?, ?, ?, ?)
    `).run(grantId, at, type, JSON.stringify(detail));
  }
}

export function projectIdentity(workspace) {
  const canonical = canonicalWorkspace(workspace);
  return createHash("sha256").update(`nexus-project-v1\0${canonical}`).digest("hex");
}

export function defaultProjectGrantStoreFile(environment = process.env) {
  const override = environment.NEXUS_USER_DATA_DIR;
  if (typeof override === "string" && override.trim()) return path.join(path.resolve(override), "project-grants.db");
  if (process.platform === "darwin") return path.join(os.homedir(), "Library", "Application Support", "Nexus Agent", "project-grants.db");
  if (process.platform === "win32") return path.join(environment.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Nexus Agent", "project-grants.db");
  return path.join(environment.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "nexus-agent", "project-grants.db");
}

function canonicalWorkspace(workspace) {
  if (typeof workspace !== "string" || !workspace.trim()) throw new Error("Project Grant workspace 无效");
  try {
    return realpathSync(path.resolve(workspace));
  } catch {
    return path.resolve(workspace);
  }
}

function validateProjectGrant(grant) {
  if (!grant || grant.scope !== "project" || grant.usage !== "project") throw new Error("Project Grant 类型无效");
  for (const key of ["id", "projectId", "workspace", "tool", "capabilityHash", "policyVersion", "issuedAt", "expiresAt"]) {
    if (typeof grant[key] !== "string" || !grant[key]) throw new Error(`Project Grant ${key} 无效`);
  }
  if (!Array.isArray(grant.resources)) throw new Error("Project Grant resources 必须是数组");
  if (!Number.isFinite(new Date(grant.issuedAt).getTime()) || !Number.isFinite(new Date(grant.expiresAt).getTime())) {
    throw new Error("Project Grant 时间无效");
  }
}

function rowToGrant(row) {
  return {
    id: row.id,
    scope: "project",
    usage: "project",
    projectId: row.project_id,
    workspace: row.workspace,
    tool: row.tool,
    capabilityHash: row.capability_hash,
    policyVersion: row.policy_version,
    resources: JSON.parse(row.resources_json),
    issuedAt: row.issued_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}
