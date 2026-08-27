// FOUNDATION — owner-scoped, revocable lifecycle for runtime capabilities.
const DEFAULT_EVENT_LIMIT = 500;

export class CapabilityRuntime {
  #active = new Map();
  #registrations = new Map();
  #owners = new Map();
  #events = [];
  #subscribers = new Set();
  #sequence = 0;
  #revision = 0;
  #clock;
  #eventLimit;

  constructor({ clock = () => new Date(), eventLimit = DEFAULT_EVENT_LIMIT } = {}) {
    if (typeof clock !== "function") throw new Error("Capability Runtime clock 必须是函数");
    if (!Number.isInteger(eventLimit) || eventLimit < 1) throw new Error("Capability Runtime eventLimit 必须是正整数");
    this.#clock = clock;
    this.#eventLimit = eventLimit;
  }

  register({ kind, name, owner, value, dispose = null }) {
    validateIdentity("kind", kind);
    validateIdentity("name", name);
    validateIdentity("owner", owner);
    if (value === undefined) throw new Error("Capability registration 必须包含 value");
    if (dispose !== null && typeof dispose !== "function") throw new Error("Capability dispose 必须是函数或 null");
    const key = capabilityKey(kind, name);
    const existing = this.#active.get(key);
    if (existing) throw new Error(`能力名称冲突：${kind}/${name} 已由 ${existing.owner} 注册`);

    const registration = {
      registrationId: `capability-${++this.#sequence}`,
      kind,
      name,
      owner,
      value,
      dispose,
      registeredAt: this.#now(),
      active: true,
      leases: 0,
      drainWaiters: new Set(),
    };
    this.#active.set(key, registration);
    this.#registrations.set(registration.registrationId, registration);
    const ownerRegistrations = this.#owners.get(owner) || new Set();
    ownerRegistrations.add(registration.registrationId);
    this.#owners.set(owner, ownerRegistrations);
    this.#emit("capability.registered", registration);

    return Object.freeze({
      registrationId: registration.registrationId,
      kind,
      name,
      owner,
      revoke: (reason) => this.revoke(registration.registrationId, reason),
    });
  }

  get(kind, name) {
    return this.#active.get(capabilityKey(kind, name))?.value ?? null;
  }

  resolve(kind, name) {
    const registration = this.#active.get(capabilityKey(kind, name));
    return registration ? publicRegistration(registration) : null;
  }

  list(kind = null) {
    if (kind !== null) validateIdentity("kind", kind);
    return [...this.#active.values()]
      .filter((registration) => kind === null || registration.kind === kind)
      .map(publicRegistration);
  }

  acquire(kind, name, registrationId = null) {
    const registration = this.#active.get(capabilityKey(kind, name));
    if (!registration || (registrationId && registration.registrationId !== registrationId)) return null;
    registration.leases += 1;
    let released = false;
    return Object.freeze({
      ...publicRegistration(registration),
      release: () => {
        if (released) return false;
        released = true;
        registration.leases -= 1;
        if (registration.leases === 0) {
          for (const resolve of registration.drainWaiters) resolve();
          registration.drainWaiters.clear();
        }
        return true;
      },
    });
  }

  async revoke(registrationId, reason = "revoked") {
    const registration = this.#registrations.get(registrationId);
    if (!registration?.active) return false;
    this.#deactivate(registration, reason);
    await this.#waitForDrain(registration);
    await this.#dispose(registration);
    return true;
  }

  async revokeOwner(owner, reason = "owner_revoked") {
    validateIdentity("owner", owner);
    const registrations = [...(this.#owners.get(owner) || [])]
      .map((registrationId) => this.#registrations.get(registrationId))
      .filter((registration) => registration?.active);
    for (const registration of registrations) this.#deactivate(registration, reason);
    await Promise.all(registrations.map((registration) => this.#waitForDrain(registration)));
    const settled = await Promise.allSettled(registrations.map((registration) => this.#dispose(registration)));
    return {
      revoked: registrations.map((registration) => registration.registrationId),
      failures: settled.flatMap((result, index) => result.status === "rejected"
        ? [{ registrationId: registrations[index].registrationId, error: result.reason?.message || String(result.reason) }]
        : []),
    };
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new Error("Capability Runtime subscriber 必须是函数");
    this.#subscribers.add(listener);
    return () => this.#subscribers.delete(listener);
  }

  events({ afterRevision = 0 } = {}) {
    if (!Number.isInteger(afterRevision) || afterRevision < 0) throw new Error("afterRevision 必须是非负整数");
    return this.#events.filter((event) => event.revision > afterRevision).map((event) => structuredClone(event));
  }

  inspect() {
    return {
      revision: this.#revision,
      active: this.list().map(({ value, ...registration }) => registration),
      events: this.events(),
    };
  }

  #deactivate(registration, reason) {
    registration.active = false;
    this.#active.delete(capabilityKey(registration.kind, registration.name));
    const ownerRegistrations = this.#owners.get(registration.owner);
    ownerRegistrations?.delete(registration.registrationId);
    if (ownerRegistrations?.size === 0) this.#owners.delete(registration.owner);
    this.#emit("capability.revoked", registration, { reason });
  }

  async #waitForDrain(registration) {
    if (registration.leases > 0) {
      await new Promise((resolve) => registration.drainWaiters.add(resolve));
    }
  }

  async #dispose(registration) {
    if (!registration.dispose) return;
    try {
      await registration.dispose();
    } catch (error) {
      this.#emit("capability.dispose_failed", registration, { error: error?.message || String(error) });
      throw error;
    }
  }

  #emit(type, registration, detail = {}) {
    const event = Object.freeze({
      revision: ++this.#revision,
      at: this.#now(),
      type,
      registrationId: registration.registrationId,
      kind: registration.kind,
      name: registration.name,
      owner: registration.owner,
      ...detail,
    });
    this.#events.push(event);
    if (this.#events.length > this.#eventLimit) this.#events.splice(0, this.#events.length - this.#eventLimit);
    for (const subscriber of this.#subscribers) {
      try {
        subscriber(structuredClone(event));
      } catch {}
    }
  }

  #now() {
    const value = this.#clock();
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error("Capability Runtime clock 返回了无效时间");
    return date.toISOString();
  }
}

function publicRegistration(registration) {
  return Object.freeze({
    registrationId: registration.registrationId,
    kind: registration.kind,
    name: registration.name,
    owner: registration.owner,
    registeredAt: registration.registeredAt,
    value: registration.value,
  });
}

function capabilityKey(kind, name) {
  return `${kind}\u0000${name}`;
}

function validateIdentity(label, value) {
  if (typeof value !== "string" || !value.trim() || value.length > 160 || /[\u0000-\u001f]/.test(value)) {
    throw new Error(`Capability ${label} 必须是 1 到 160 字符的非控制字符字符串`);
  }
}
