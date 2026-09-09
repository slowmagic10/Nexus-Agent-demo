// Equality for stable JSON data without serializing unchanged string contents.
// Unknown JS shapes use the original serializer, including its error behavior.
const UNKNOWN = Symbol("unknown JSON shape");
const ABSENT = Symbol("absent child");
const MAX_DEPTH = 128;
const MAX_NODES = 100_000;
const isProxy = nativeProxyCheck();
const isRawJson = typeof JSON.isRawJSON === "function" ? JSON.isRawJSON : null;

export function sameJsonValue(left, right) {
  if (isProxy) {
    try {
      const result = comparePlainJson(left, right, new Set(), new Set(), { remaining: MAX_NODES }, 0);
      if (result !== UNKNOWN) return result;
    } catch {
      // Inspection is only an optimization. JSON.stringify remains the
      // compatibility authority for values outside the plain-data fast path.
    }
  }
  return JSON.stringify(left) === JSON.stringify(right);
}

function comparePlainJson(left, right, leftAncestors, rightAncestors, budget, depth) {
  if (depth > MAX_DEPTH || (budget.remaining -= 2) < 0) return UNKNOWN;
  const a = describe(left);
  const b = describe(right);
  if (a === UNKNOWN || b === UNKNOWN) return UNKNOWN;
  if ((a.object && leftAncestors.has(left)) || (b.object && rightAncestors.has(right))) return UNKNOWN;
  let equal = a.kind === b.kind && a.length === b.length;
  if (!a.object && !b.object) return equal && left === right;
  if (a.object) leftAncestors.add(left);
  if (b.object) rightAncestors.add(right);
  try {
    // Even after a mismatch, inspect the rest: a later BigInt, cycle or getter
    // must still take the serializer path rather than hiding its error/effect.
    for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
      if (a.keys && b.keys && a.keys[index] !== b.keys[index]) equal = false;
      const av = child(a, index);
      const bv = child(b, index);
      if (av === UNKNOWN || bv === UNKNOWN) return UNKNOWN;
      const result = comparePlainJson(av, bv, leftAncestors, rightAncestors, budget, depth + 1);
      if (result === UNKNOWN) return UNKNOWN;
      if (!result) equal = false;
    }
    return equal;
  } finally {
    if (a.object) leftAncestors.delete(left);
    if (b.object) rightAncestors.delete(right);
  }
}

function describe(value) {
  if (value === ABSENT) return { kind: "absent", length: 0 };
  if (value === null || typeof value === "string" || typeof value === "boolean"
      || (typeof value === "number" && Number.isFinite(value))) {
    return { kind: value === null ? "null" : typeof value, length: 0 };
  }
  if (!value || typeof value !== "object" || isProxy(value) || isRawJson?.(value)) return UNKNOWN;
  const prototype = Object.getPrototypeOf(value);
  const array = Array.isArray(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) return UNKNOWN;
  // Getters and callable toJSON (own or inherited) belong to the serializer.
  // Inspect descriptors without invoking them; a non-callable value shadows
  // an inherited toJSON exactly as JSON.stringify's property lookup does.
  for (let owner = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    if (isProxy(owner)) return UNKNOWN;
    const descriptor = Object.getOwnPropertyDescriptor(owner, "toJSON");
    if (!descriptor) continue;
    if (!("value" in descriptor) || typeof descriptor.value === "function") return UNKNOWN;
    break;
  }
  const keys = array ? null : Object.keys(value);
  return { kind: array ? "array" : "object", object: value, keys, length: array ? value.length : keys.length };
}

function child(view, index) {
  if (index >= view.length) return ABSENT;
  const descriptor = Object.getOwnPropertyDescriptor(view.object, view.keys ? view.keys[index] : String(index));
  // Array holes/undefined and object undefined members have distinct JSON
  // omission rules. Leave them, accessors and exotic objects to the fallback.
  return descriptor && "value" in descriptor ? descriptor.value : UNKNOWN;
}

function nativeProxyCheck() {
  try {
    // The same patch module is served to browsers. Without a native Proxy
    // detector, retain the original JSON path instead of misreading a Proxy's
    // data descriptors as the values returned by its get traps.
    return globalThis.process?.getBuiltinModule?.("node:util")?.types?.isProxy || null;
  } catch {
    return null;
  }
}
