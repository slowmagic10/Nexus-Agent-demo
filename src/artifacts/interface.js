// FOUNDATION — durable, session-scoped Artifact persistence contract.

export const DEFAULT_ARTIFACT_MEDIA_TYPE = "text/plain; charset=utf-8";
export const MAX_ARTIFACT_BYTES = 4_000_000;

export function assertArtifactStore(store) {
  if (!store || typeof store.put !== "function" || typeof store.get !== "function" || typeof store.list !== "function") {
    throw new Error("Artifact Store 必须提供 put/get/list");
  }
  return store;
}

export function artifactMetadata(record) {
  if (!record || typeof record !== "object") throw new Error("Artifact record 无效");
  const metadata = {
    id: requiredText(record.id, "id"),
    sessionId: requiredText(record.sessionId, "sessionId"),
    callId: optionalText(record.callId, "callId"),
    kind: requiredText(record.kind || "tool_output", "kind"),
    mediaType: requiredText(record.mediaType || DEFAULT_ARTIFACT_MEDIA_TYPE, "mediaType"),
    byteSize: record.byteSize,
    sha256: requiredText(record.sha256, "sha256"),
    createdAt: requiredText(record.createdAt, "createdAt"),
  };
  if (!Number.isSafeInteger(metadata.byteSize) || metadata.byteSize < 0) throw new Error("Artifact byteSize 无效");
  if (!/^[a-f0-9]{64}$/.test(metadata.sha256)) throw new Error("Artifact sha256 无效");
  if (!Number.isFinite(new Date(metadata.createdAt).getTime())) throw new Error("Artifact createdAt 无效");
  return Object.freeze(metadata);
}

function requiredText(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`Artifact ${label} 无效`);
  return value;
}

function optionalText(value, label) {
  if (value === null || value === undefined) return null;
  return requiredText(value, label);
}
