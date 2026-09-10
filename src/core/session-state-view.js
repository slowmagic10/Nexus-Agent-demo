// Narrow, detached snapshots for internal decisions. This is an allocation
// boundary, not an authorization boundary or a cache across durable commits.
export function readSessionState(session, fields) {
  const keys = stateViewFields(fields);
  const readState = session?.readState;
  if (typeof readState === "function") return readState.call(session, keys);
  const state = session?.state;
  return state == null ? undefined : selectSessionStateFields(state, keys);
}

export function selectSessionStateFields(state, fields) {
  const keys = stateViewFields(fields);
  // Clone the selected object once to preserve aliases between selected values
  // while exposing no mutable references to the Session's private state.
  return structuredClone(Object.fromEntries(keys.map((key) => [
    key, Object.hasOwn(state, key) ? state[key] : undefined,
  ])));
}

function stateViewFields(fields) {
  if (!Array.isArray(fields) || fields.length > 64) throw new TypeError("状态字段必须是最多64项的数组");
  for (const field of fields) {
    if (typeof field !== "string" || !field || field.length > 128) {
      throw new TypeError("状态字段名称必须是1到128字符的字符串");
    }
  }
  return [...new Set(fields)];
}
