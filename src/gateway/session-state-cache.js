import { types } from "node:util";
import { AgentSession } from "../core/session.js";
import { reduceSession } from "../core/state.js";
import { SessionStore } from "../persistence/session-store.js";

const nativeSubscribe = AgentSession.prototype.subscribe;
const nativeReader = AgentSession.prototype.subscribeStateReader;
const nativeCommit = SessionStore.prototype.commitSessionEvent;

// Only Gateway's native reducer + native Journal own their committed states.
// Extension subscriptions and stores retain the original eager snapshot path.
export function attachSessionStateCache(entry, manager, nativeUpdate) {
  const { session } = entry;
  const { store } = manager;
  if (!hasNativeMethod(session, AgentSession, "subscribe", nativeSubscribe)
    || !hasNativeMethod(session, AgentSession, "subscribeStateReader", nativeReader)
    || !ownsCommittedState(store)) {
    session.subscribe((next) => manager.update(entry, next));
    return;
  }

  let snapshot = entry.state;
  let pendingRead = null;
  Object.defineProperty(entry, "state", {
    enumerable: true,
    configurable: true,
    get() {
      if (pendingRead) {
        snapshot = pendingRead();
        pendingRead = null;
      }
      return snapshot;
    },
    set(value) {
      snapshot = value;
      pendingRead = null;
    },
  });

  nativeReader.call(session, (read) => {
    const update = manager.update;
    if (update !== nativeUpdate || entry.subscribers.size || !ownsCommittedState(store)) {
      update.call(manager, entry, read());
    } else {
      // Retain one committed version, never a queue of patches/readers. A read
      // from an event observer still sees the preceding state notification.
      pendingRead = read;
      snapshot = undefined;
    }
  }, { immutableReducer: reduceSession, immutableJournalCommit: nativeCommit });
}

function ownsCommittedState(store) {
  return hasNativeMethod(store, SessionStore, "commitSessionEvent", nativeCommit);
}

function hasNativeMethod(value, Type, key, method) {
  if (!value || types.isProxy(value) || !(value instanceof Type)) return false;
  for (let owner = value; owner !== null; owner = Object.getPrototypeOf(owner)) {
    if (types.isProxy(owner)) return false;
    const descriptor = Object.getOwnPropertyDescriptor(owner, key);
    if (descriptor) return descriptor.value === method;
  }
  return false;
}
