// FOUNDATION — routes the Tool Host interface by the durable Session permission profile.
import { refreshVerification } from "../core/verification.js";
import { runToolBatch } from "./batch.js";
import { readSessionState } from "../core/session-state-view.js";
export class PermissionToolHostRouter {
  constructor({ hosts, defaultProfile = "workspace-auto" } = {}) {
    const entries = hosts instanceof Map ? [...hosts.entries()] : Object.entries(hosts || {});
    if (!entries.length || entries.some(([name, host]) => (
      typeof name !== "string" || !name || typeof host?.schemas !== "function" || typeof host?.execute !== "function"
    ))) {
      throw new Error("Permission Tool Host Router 需要具名 Tool Host");
    }
    this.hosts = new Map(entries);
    if (!this.hosts.has(defaultProfile)) throw new Error(`默认权限档位不可用：${defaultProfile}`);
    this.defaultProfile = defaultProfile;
  }

  profiles() {
    return [...this.hosts.keys()];
  }

  has(profile) {
    return this.hosts.has(profile);
  }

  inspect() {
    return {
      defaultProfile: this.defaultProfile,
      profiles: [...this.hosts.entries()].map(([name, host]) => ({
        name,
        policyVersion: host.policy?.version || null,
      })),
    };
  }

  schemas({ session } = {}) {
    return this.#resolve(readSessionState(session, ["permissionProfile"])?.permissionProfile).schemas({ session });
  }

  execute(call, context = {}) {
    return this.#resolve(readSessionState(context.session, ["permissionProfile"])?.permissionProfile).execute(call, context);
  }

  executeBatch(calls, context = {}) {
    return runToolBatch(calls, context, {
      prepareRead: (call) => this.#resolve(readSessionState(context.session, ["permissionProfile"])?.permissionProfile).prepareParallelRead?.(call, context) || null,
      executeSerial: (call) => this.execute(call, context),
    });
  }

  refreshVerification(context = {}) {
    const host = this.#resolve(readSessionState(context.session, ["permissionProfile"])?.permissionProfile);
    return typeof host.refreshVerification === "function" ? host.refreshVerification(context) : refreshVerification(context);
  }

  #resolve(profile) {
    const selected = profile || this.defaultProfile;
    const host = this.hosts.get(selected);
    if (!host) throw new Error(`会话权限档位不可用：${selected}`);
    return host;
  }
}
