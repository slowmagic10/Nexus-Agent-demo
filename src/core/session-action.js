import { AgentSession } from "./session.js";
import { types } from "node:util";

const nativeDispatch = AgentSession.prototype.dispatch;
const nativeReceipt = AgentSession.prototype.dispatchWithReceipt;

// Internal callers only await completion; they must not consume the return
// value. Keep dispatch overrides/adapters on their original path so hooks,
// failures and queue timing remain observable exactly once.
export function dispatchSessionAction(session, action) {
  const dispatch = session?.dispatch;
  if (typeof dispatch !== "function") throw new TypeError("Session 缺少 dispatch 接口");
  if (!types.isProxy(session) && session instanceof AgentSession && dispatch === nativeDispatch) {
    if (hasNativeReceipt(session)) {
      // Match native dispatch's single receipt.then(...) continuation, without
      // requesting the detached state that this caller would discard.
      return nativeReceipt.call(session, action, { includeState: false }).then(() => undefined);
    }
  }
  return dispatch.call(session, action);
}

function hasNativeReceipt(session) {
  // Do not probe an accessor just to choose a route: native dispatch must remain
  // the only caller of a custom receipt getter, even if it changes per lookup.
  for (let owner = session; owner !== null; owner = Object.getPrototypeOf(owner)) {
    if (types.isProxy(owner)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(owner, "dispatchWithReceipt");
    if (descriptor) return descriptor.value === nativeReceipt;
  }
  return false;
}
