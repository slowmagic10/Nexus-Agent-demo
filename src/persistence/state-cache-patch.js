// Compile the shared top-level state patch into an optional SQLite cache update.
// The caller supplies an already-redacted patch and owns the full-save fallback.
const MAX_OPERATIONS = 128;
const MAX_FUNCTION_ITEMS = 30;
const MAX_JSON_DEPTH = 100;
const MAX_JSON_NODES = 100_000;
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function compileStateCachePatch(patch) {
  try {
    if (!isRecord(patch)) return null;
    const fields = dataEntries(patch);
    if (!fields || fields.some(([key]) => !["set", "append", "remove"].includes(key))) return null;
    const values = Object.fromEntries(fields);
    const set = "set" in values ? dataEntries(values.set) : [];
    const append = "append" in values ? dataEntries(values.append) : [];
    const remove = "remove" in values ? values.remove : [];
    if (!set || !append || !isDenseArray(remove)) return null;
    if (remove.some((key) => !isSafeKey(key))) return null;
    if ([...set, ...append].some(([key]) => !isSafeKey(key))) return null;
    if (append.some(([, items]) => !isDenseArray(items))) return null;
    const operationCount = remove.length + set.length + append.reduce((count, [, items]) => count + 1 + items.length, 0);
    if (operationCount > MAX_OPERATIONS) return null;
    const budget = { nodes: 0 };
    if (set.some(([, value]) => !isJsonValue(value, budget))) return null;
    if (append.some(([, items]) => !isJsonValue(items, budget))) return null;

    let base = "state_json";
    const baseParams = [];
    for (const keys of groups(remove)) {
      base = `json_remove(${base}, ${keys.map((key) => jsonPathLiteral(key)).join(", ")})`;
    }
    for (const entries of groups(set)) {
      const pairs = entries.map(([key, value]) => {
        baseParams.push(JSON.stringify(value));
        return `${jsonPathLiteral(key)}, json(?)`;
      });
      base = `json_set(${base}, ${pairs.join(", ")})`;
    }
    if (!append.length) return { expression: base, params: baseParams };

    // Checking even empty appends is required: applyStatePatch rejects a missing
    // or non-array target rather than silently skipping it. A scalar subquery
    // gives every guard and insertion the same post-remove/set document.
    const checks = append.map(([key]) => `json_type(patch_base, ${jsonPathLiteral(key)}) = 'array'`);
    let result = "patch_base";
    const appendParams = [];
    const insertions = append.flatMap(([key, items]) => items.map((value) => [key, value]));
    for (const entries of groups(insertions)) {
      const pairs = entries.map(([key, value]) => {
        appendParams.push(JSON.stringify(value));
        return `${jsonPathLiteral(key, true)}, json(?)`;
      });
      result = `json_insert(${result}, ${pairs.join(", ")})`;
    }
    const expression = `(SELECT CASE WHEN ${checks.join(" AND ")} THEN ${result} ELSE NULL END FROM (SELECT ${base} AS patch_base))`;
    // Anonymous parameters appear in the outer SELECT before its FROM subquery.
    return { expression, params: [...appendParams, ...baseParams] };
  } catch {
    // Unsupported JS values (including cyclic/proxied inputs) take the caller's
    // full-save path; a partial translation is never returned.
    return null;
  }
}

function isSafeKey(key) {
  // __proto__ is an assignment operator on ordinary JS objects, not a field.
  return typeof key === "string" && key !== "__proto__" && SAFE_KEY.test(key);
}

function jsonPathLiteral(key, append = false) {
  return `'$.${key}${append ? "[#]" : ""}'`;
}

function* groups(items) {
  for (let index = 0; index < items.length; index += MAX_FUNCTION_ITEMS) {
    yield items.slice(index, index + MAX_FUNCTION_ITEMS);
  }
}

function isRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function dataEntries(value) {
  if (!isRecord(value)) return null;
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (typeof key !== "string" || !descriptor?.enumerable || !("value" in descriptor)) return null;
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  if (Reflect.ownKeys(value).length !== value.length + 1) return false;
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (!descriptor?.enumerable || !("value" in descriptor)) return false;
  }
  return true;
}

function isJsonValue(value, budget, ancestors = new Set(), depth = 0) {
  budget.nodes += 1;
  if (budget.nodes > MAX_JSON_NODES || depth > MAX_JSON_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  // JSON.stringify normalizes -0, so use the full-save path for that JS value.
  if (typeof value === "number") return Number.isFinite(value) && !Object.is(value, -0);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  let children;
  if (Array.isArray(value)) {
    if (!isDenseArray(value)) return false;
    children = value;
  } else {
    const entries = dataEntries(value);
    if (!entries) return false;
    children = entries.map(([, child]) => child);
  }
  ancestors.add(value);
  const valid = children.every((child) => isJsonValue(child, budget, ancestors, depth + 1));
  ancestors.delete(value);
  return valid;
}
