// FOUNDATION — shared top-level projection protocol for durable session events.
export function createStatePatch(previous, next) {
  const patch = { set: {}, append: {}, remove: [] };
  const keys = new Set([...Object.keys(previous), ...Object.keys(next)]);

  for (const key of keys) {
    if (!(key in next)) {
      patch.remove.push(key);
      continue;
    }
    if (sameValue(previous[key], next[key])) continue;
    if (Array.isArray(previous[key]) && Array.isArray(next[key]) && isPrefix(previous[key], next[key])) {
      patch.append[key] = structuredClone(next[key].slice(previous[key].length));
      continue;
    }
    patch.set[key] = structuredClone(next[key]);
  }

  if (!Object.keys(patch.set).length) delete patch.set;
  if (!Object.keys(patch.append).length) delete patch.append;
  if (!patch.remove.length) delete patch.remove;
  return patch;
}

export function applyStatePatch(state, patch) {
  const next = structuredClone(state);
  for (const key of patch.remove || []) delete next[key];
  for (const [key, value] of Object.entries(patch.set || {})) next[key] = structuredClone(value);
  for (const [key, values] of Object.entries(patch.append || {})) {
    if (!Array.isArray(next[key])) throw new Error(`无法向非数组状态字段追加内容：${key}`);
    next[key].push(...structuredClone(values));
  }
  return next;
}

function isPrefix(previous, next) {
  if (previous.length > next.length) return false;
  return previous.every((value, index) => sameValue(value, next[index]));
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}
