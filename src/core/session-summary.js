import { types } from "node:util";
import { AgentSession } from "./session.js";
import { prepareContextSummarySource } from "./context-summary.js";
import { readSessionState } from "./session-state-view.js";

const nativePrepare = AgentSession.prototype.prepareContextSummary;
const nativeReadState = AgentSession.prototype.readState;
const nativeCursor = Object.getOwnPropertyDescriptor(AgentSession.prototype, "cursor").get;

// Preserve old source readers and Proxy adapters instead of bypassing their
// hooks through inherited native methods. New adapters can explicitly supply
// their own preparation API and own the detached-source contract.
export function prepareSessionContextSummary(session, options) {
  if (!types.isProxy(session)) {
    const prepare = session?.prepareContextSummary;
    if (typeof prepare === "function" && (prepare !== nativePrepare
      || (session instanceof AgentSession && hasNativeSourceReaders(session)))) {
      return prepare.call(session, options);
    }
  }
  const source = readSessionState(session, ["messages", "contextSummary"]);
  const sourceCursor = session.cursor;
  return prepareContextSummarySource(source, sourceCursor, options);
}

function hasNativeSourceReaders(session) {
  const expected = new Map([["readState", { value: nativeReadState }], ["cursor", { get: nativeCursor }]]);
  for (let owner = session; owner !== null && expected.size; owner = Object.getPrototypeOf(owner)) {
    if (types.isProxy(owner)) return false;
    for (const [key, native] of expected) {
      const descriptor = Object.getOwnPropertyDescriptor(owner, key);
      if (!descriptor) continue;
      if ("value" in native ? descriptor.value !== native.value : descriptor.get !== native.get) return false;
      expected.delete(key);
    }
  }
  return expected.size === 0;
}
