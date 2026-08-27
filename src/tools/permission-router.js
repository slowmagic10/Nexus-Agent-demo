// FOUNDATION — routes the Tool Host interface by the durable Session permission profile.
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

  schemas({ session } = {}) {
    return this.#resolve(session?.state?.permissionProfile).schemas();
  }

  execute(call, context = {}) {
    return this.#resolve(context.session?.state?.permissionProfile).execute(call, context);
  }

  #resolve(profile) {
    const selected = profile || this.defaultProfile;
    const host = this.hosts.get(selected);
    if (!host) throw new Error(`会话权限档位不可用：${selected}`);
    return host;
  }
}
