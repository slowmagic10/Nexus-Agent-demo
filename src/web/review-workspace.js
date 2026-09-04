export const REVIEW_WORKSPACE_VERSION = "review-workspace-v1";

const OPERATIONS = new Set(["created", "modified", "deleted"]);

// UI-only projection. Durable File Change Manifests and Artifact references stay authoritative.
export function projectReviewWorkspace(executionProjection = {}, { sessionId = null } = {}) {
  const groups = [];
  const batches = [];
  const usedBatchKeys = new Map();

  const inheritedEntries = Array.isArray(executionProjection?.inheritedFileChanges)
    ? executionProjection.inheritedFileChanges
    : [];
  if (inheritedEntries.length) {
    const group = {
      groupKey: "inherited",
      kind: "inherited",
      label: "分支继承",
      batches: inheritedEntries.map((entry, index) => projectBatch(entry, {
        source: "inherited",
        groupKey: "inherited",
        turnKey: null,
        turnOrdinal: null,
        entryOrdinal: index + 1,
        sessionId,
        usedBatchKeys,
      })),
    };
    groups.push(group);
    batches.push(...group.batches);
  }

  const turns = Array.isArray(executionProjection?.turns) ? executionProjection.turns : [];
  for (const [turnIndex, turn] of turns.entries()) {
    const execution = turn?.execution || {};
    const entries = Array.isArray(execution?.fileChanges?.entries)
      ? execution.fileChanges.entries
      : [];
    if (!entries.length) continue;
    const turnKey = textOrNull(execution.turnKey) || `turn:${turnIndex + 1}`;
    const group = {
      groupKey: `turn:${encodeKey(turnKey)}`,
      kind: "turn",
      label: `Turn ${turnIndex + 1}`,
      turnKey,
      turnOrdinal: turnIndex + 1,
      batches: entries.map((entry, index) => projectBatch(entry, {
        source: "turn",
        groupKey: `turn:${encodeKey(turnKey)}`,
        turnKey,
        turnOrdinal: turnIndex + 1,
        entryOrdinal: index + 1,
        sessionId,
        usedBatchKeys,
      })),
    };
    groups.push(group);
    batches.push(...group.batches);
  }

  const allPaths = new Set();
  let occurrences = 0;
  for (const batch of batches) {
    occurrences += batch.changes.length;
    for (const change of batch.changes) {
      if (change.valid) allPaths.add(change.path);
    }
  }

  return {
    version: REVIEW_WORKSPACE_VERSION,
    groups,
    batches,
    summary: {
      batches: batches.length,
      occurrences,
      uniquePaths: allPaths.size,
    },
  };
}

export function createReviewWorkspace({ root, loadArtifact }) {
  if (!root || typeof root.replaceChildren !== "function") {
    throw new Error("Review Workspace 需要可渲染的 root");
  }
  if (typeof loadArtifact !== "function") {
    throw new TypeError("Review Workspace 的 loadArtifact 必须是函数");
  }
  const document = root.ownerDocument || globalThis.document;
  if (!document || typeof document.createElement !== "function") {
    throw new Error("Review Workspace 缺少 Document");
  }

  let destroyed = false;
  let epoch = 0;
  let sessionId = null;
  let cursor = null;
  let projection = projectReviewWorkspace();
  let projectionSignatureValue = projectionSignature(projection);
  let selectedBatchKey = null;
  let selectedPath = null;
  const cache = new Map();
  const errors = new Map();
  const inflight = new Map();

  const selectedBatch = () => projection.batches.find((batch) => batch.batchKey === selectedBatchKey) || null;

  const render = () => {
    if (destroyed) return;
    const shell = element(document, "section", "review-workspace");
    shell.setAttribute("data-version", REVIEW_WORKSPACE_VERSION);
    const navigation = element(document, "nav", "review-workspace-navigation");
    navigation.setAttribute("aria-label", "文件变更批次");
    const detail = element(document, "section", "review-workspace-detail");

    if (!projection.batches.length) {
      const empty = element(document, "p", "review-workspace-empty", "当前任务还没有可审查的文件变化。");
      shell.append(empty);
      root.replaceChildren(shell);
      return;
    }

    for (const group of projection.groups) {
      const groupNode = element(document, "section", "review-workspace-group");
      groupNode.setAttribute("data-group-key", group.groupKey);
      groupNode.append(element(document, "h3", "review-workspace-group-title", group.label));
      const list = element(document, "div", "review-workspace-batches");
      for (const batch of group.batches) {
        const button = element(document, "button", "review-workspace-batch");
        button.type = "button";
        button.setAttribute("data-batch-key", batch.batchKey);
        button.setAttribute("aria-pressed", String(batch.batchKey === selectedBatchKey));
        if (batch.batchKey === selectedBatchKey) button.setAttribute("aria-current", "true");
        if (batch.batchKey === selectedBatchKey) button.classList.add("active");
        button.append(
          element(document, "strong", "review-workspace-batch-tool", batch.tool || "未知工具"),
          element(document, "span", "review-workspace-batch-count", `${batch.changes.length} 项变化`),
        );
        button.addEventListener("click", () => select({ batchKey: batch.batchKey }));
        list.append(button);
      }
      groupNode.append(list);
      navigation.append(groupNode);
    }

    const batch = selectedBatch();
    if (batch) renderBatch(document, detail, batch, {
      selectedPath,
      artifactState: artifactStateFor(batch, { cache, errors, inflight }),
      onSelectPath: (path) => select({ batchKey: batch.batchKey, path }),
      onLoadArtifact: () => startArtifactLoad(batch),
    });
    shell.append(navigation, detail);
    root.replaceChildren(shell);
  };

  const update = ({ sessionId: nextSessionId, cursor: nextCursor = null, executionProjection } = {}) => {
    assertAlive(destroyed);
    if (typeof nextSessionId !== "string" || !nextSessionId.trim()) {
      throw new Error("Review Workspace sessionId 无效");
    }
    if (nextCursor !== null && (!Number.isSafeInteger(nextCursor) || nextCursor < 0)) {
      throw new Error("Review Workspace cursor 无效");
    }
    const nextProjection = projectReviewWorkspace(executionProjection, { sessionId: nextSessionId });
    const nextProjectionSignature = projectionSignature(nextProjection);
    const sameSession = sessionId === nextSessionId;
    const projectionChanged = nextProjectionSignature !== projectionSignatureValue;
    if (!sameSession) {
      epoch += 1;
      cache.clear();
      errors.clear();
      inflight.clear();
    }
    const previousBatchKey = sameSession ? selectedBatchKey : null;
    const previousPath = sameSession ? selectedPath : null;
    sessionId = nextSessionId;
    cursor = nextCursor;
    projection = nextProjection;
    projectionSignatureValue = nextProjectionSignature;
    selectedBatchKey = projection.batches.some((batch) => batch.batchKey === previousBatchKey)
      ? previousBatchKey
      : projection.batches.at(-1)?.batchKey || null;
    const nextBatch = selectedBatch();
    selectedPath = previousPath && nextBatch?.changes.some((change) => change.path === previousPath)
      ? previousPath
      : null;
    if (!sameSession || projectionChanged) render();
    return snapshot();
  };

  const select = ({ batchKey = null, turnKey = null, runKey = null, path = null } = {}) => {
    assertAlive(destroyed);
    let batch = null;
    if (batchKey !== null) {
      batch = projection.batches.find((candidate) => candidate.batchKey === batchKey) || null;
    } else if (turnKey !== null || runKey !== null) {
      batch = projection.batches.find((candidate) => (
        candidate.source === "turn"
        && (turnKey === null || candidate.turnKey === turnKey)
        && (runKey === null || candidate.runKey === runKey)
      )) || null;
    } else {
      batch = selectedBatch() || projection.batches.at(-1) || null;
    }
    if (!batch) throw new Error("Review Workspace 找不到指定批次");
    if (path !== null && !batch.changes.some((change) => change.path === path)) {
      throw new Error("Review Workspace 找不到指定文件变化");
    }
    selectedBatchKey = batch.batchKey;
    selectedPath = path;
    render();
    return snapshot();
  };

  const startArtifactLoad = (batch) => {
    const ref = batch?.artifactRef;
    if (!ref) return Promise.resolve(null);
    const key = artifactCacheKey(ref);
    if (cache.has(key)) return Promise.resolve(cache.get(key));
    if (inflight.has(key)) return inflight.get(key);
    errors.delete(key);
    const requestedEpoch = epoch;
    const promise = Promise.resolve()
      .then(() => loadArtifact({ sessionId: ref.sessionId, artifactId: ref.id }))
      .then((value) => validateLoadedArtifact(value, ref))
      .then((artifact) => {
        if (destroyed || requestedEpoch !== epoch) return artifact;
        cache.set(key, artifact);
        errors.delete(key);
        return artifact;
      })
      .catch((error) => {
        if (!destroyed && requestedEpoch === epoch) {
          errors.set(key, error instanceof Error ? error : new Error(String(error)));
        }
        return null;
      })
      .finally(() => {
        if (inflight.get(key) === promise) inflight.delete(key);
        const current = selectedBatch();
        if (!destroyed && current?.artifactRef && artifactCacheKey(current.artifactRef) === key) render();
      });
    inflight.set(key, promise);
    render();
    return promise;
  };

  const reset = () => {
    assertAlive(destroyed);
    epoch += 1;
    sessionId = null;
    cursor = null;
    projection = projectReviewWorkspace();
    projectionSignatureValue = projectionSignature(projection);
    selectedBatchKey = null;
    selectedPath = null;
    cache.clear();
    errors.clear();
    inflight.clear();
    render();
  };

  const snapshot = () => {
    const batch = selectedBatch();
    return {
      version: REVIEW_WORKSPACE_VERSION,
      sessionId,
      cursor,
      selectedBatchKey,
      selectedPath,
      projection,
      selectedBatch: batch,
      artifact: artifactStateFor(batch, { cache, errors, inflight }),
      cacheKeys: [...cache.keys()],
    };
  };

  render();
  return Object.freeze({
    update,
    select,
    reset,
    destroy() {
      if (destroyed) return;
      destroyed = true;
      epoch += 1;
      cache.clear();
      errors.clear();
      inflight.clear();
      root.replaceChildren();
    },
    snapshot,
  });
}

function projectBatch(entry, context) {
  const entryRecord = isRecord(entry) ? entry : {};
  const entryKey = textOrNull(entryRecord.entryKey) || textOrNull(entryRecord.runKey) || `entry:${context.entryOrdinal}`;
  const baseKey = context.source === "turn"
    ? `turn:${encodeKey(context.turnKey)}:entry:${encodeKey(entryKey)}`
    : `inherited:entry:${encodeKey(entryKey)}`;
  const occurrence = (context.usedBatchKeys.get(baseKey) || 0) + 1;
  context.usedBatchKeys.set(baseKey, occurrence);
  const batchKey = occurrence === 1 ? baseKey : `${baseKey}:occurrence:${occurrence}`;
  const manifest = isRecord(entryRecord.manifest) ? entryRecord.manifest : null;
  let invalid = !isRecord(entry) || !manifest || !Array.isArray(manifest.changes);
  const rawChanges = Array.isArray(manifest?.changes) ? manifest.changes : [];
  const changes = rawChanges.map((change, index) => {
    const valid = isRecord(change)
      && typeof change.path === "string"
      && change.path.length > 0
      && OPERATIONS.has(change.operation);
    if (!valid) invalid = true;
    return {
      occurrenceKey: `${batchKey}:change:${index + 1}`,
      path: typeof change?.path === "string" ? change.path : "（无效路径）",
      operation: OPERATIONS.has(change?.operation) ? change.operation : "invalid",
      before: isRecord(change?.before) ? change.before : null,
      after: isRecord(change?.after) ? change.after : null,
      valid,
    };
  });
  const artifact = normalizeArtifactRef(manifest?.diffArtifact, context.sessionId);
  if (manifest?.diffArtifact && !artifact.valid) invalid = true;
  const captureUnavailable = manifest?.captureUnavailable === true;
  const diffUnavailable = manifest?.diffUnavailable === true;
  const diffTruncated = manifest?.diffTruncated === true;
  const incomplete = manifest?.complete === false;
  const metadataOnly = Boolean(
    manifest
    && !invalid
    && changes.length
    && !manifest.diffArtifact
    && !diffUnavailable
    && !captureUnavailable
  );
  const statusTags = [
    ...(incomplete ? ["complete=false"] : []),
    ...(captureUnavailable ? ["captureUnavailable"] : []),
    ...(diffUnavailable ? ["diffUnavailable"] : []),
    ...(diffTruncated ? ["diffTruncated"] : []),
    ...(metadataOnly ? ["metadata_only"] : []),
    ...(invalid ? ["invalid"] : []),
  ];

  return {
    batchKey,
    groupKey: context.groupKey,
    source: context.source,
    turnKey: context.turnKey,
    turnOrdinal: context.turnOrdinal,
    entryKey,
    runKey: textOrNull(entryRecord.runKey),
    callId: textOrNull(entryRecord.callId),
    tool: textOrNull(entryRecord.tool),
    executionStatus: textOrNull(entryRecord.status),
    parentSessionId: textOrNull(entryRecord.parentSessionId),
    parentCursor: Number.isSafeInteger(entryRecord.parentCursor) ? entryRecord.parentCursor : null,
    manifest,
    changes,
    artifactRef: artifact.valid ? artifact.value : null,
    statusTags,
    flags: {
      incomplete,
      captureUnavailable,
      diffUnavailable,
      diffTruncated,
      metadataOnly,
      invalid,
    },
  };
}

function renderBatch(document, detail, batch, { selectedPath, artifactState, onSelectPath, onLoadArtifact }) {
  const header = element(document, "header", "review-workspace-header");
  header.append(
    element(document, "h2", "review-workspace-title", batch.tool || "未知工具"),
    element(document, "p", "review-workspace-origin", batch.source === "inherited"
      ? "从父任务继承的文件变化"
      : `Turn ${batch.turnOrdinal} · ${executionStatusLabel(batch.executionStatus)}`),
  );
  detail.append(header);

  if (batch.statusTags.length) {
    const statuses = element(document, "div", "review-workspace-statuses");
    for (const status of batch.statusTags) {
      statuses.append(element(
        document,
        "span",
        `review-workspace-status status-${status.replace(/[^a-zA-Z0-9_-]/g, "-")}`,
        statusLabel(status),
      ));
    }
    detail.append(statuses);
  }

  const counts = countOperations(batch.changes);
  detail.append(element(
    document,
    "p",
    "review-workspace-summary",
    `新增 ${counts.created} · 修改 ${counts.modified} · 删除 ${counts.deleted} · 共 ${batch.changes.length} 项`,
  ));

  const files = element(document, "div", "review-workspace-files");
  for (const change of batch.changes) {
    const row = element(document, "button", `review-workspace-file operation-${change.operation}`);
    row.type = "button";
    row.setAttribute("data-occurrence-key", change.occurrenceKey);
    row.setAttribute("aria-pressed", String(change.path === selectedPath));
    if (change.path === selectedPath) row.setAttribute("aria-current", "true");
    if (change.path === selectedPath) row.classList.add("active");
    row.append(
      element(document, "span", "review-workspace-operation", operationLabel(change.operation)),
      element(document, "code", "review-workspace-path", change.path),
    );
    row.addEventListener("click", () => onSelectPath(change.path));
    files.append(row);
  }
  if (!batch.changes.length) files.append(element(document, "p", "review-workspace-no-files", "没有可确认的文件变化。"));
  detail.append(files);

  const diff = element(document, "section", "review-workspace-diff-section");
  diff.setAttribute("aria-live", "polite");
  diff.setAttribute("aria-busy", String(artifactState.status === "loading"));
  diff.append(element(document, "h3", "review-workspace-diff-title", "整批 Diff"));
  if (!batch.artifactRef) {
    const reason = batch.flags.invalid
      ? "Diff 引用无效，已阻止加载。"
      : batch.flags.captureUnavailable
        ? "文件变化采集不可用。"
        : batch.flags.diffUnavailable
          ? "Diff Artifact 保存失败。"
          : batch.flags.metadataOnly
            ? "本批次只有文件元数据，没有可展示的文本 Diff。"
            : "本批次没有 Diff Artifact。";
    diff.append(element(document, "p", "review-workspace-diff-unavailable", reason));
  } else if (artifactState.status === "loaded") {
    if (batch.flags.diffTruncated) {
      diff.append(element(document, "p", "review-workspace-diff-warning", "Diff 在采集时达到上限，以下内容并不完整。"));
    }
    const pre = element(document, "pre", "review-workspace-diff");
    pre.textContent = artifactState.artifact.content;
    diff.append(pre);
    if (batch.flags.diffTruncated) {
      diff.append(element(document, "p", "review-workspace-diff-warning", "已显示全部可用内容；Diff 末尾可能缺失。"));
    }
  } else {
    const button = element(document, "button", "review-workspace-load-diff");
    button.type = "button";
    button.disabled = artifactState.status === "loading";
    button.setAttribute("aria-busy", String(artifactState.status === "loading"));
    button.textContent = artifactState.status === "loading"
      ? "正在加载整批 Diff…"
      : artifactState.status === "error"
        ? "重试加载整批 Diff"
        : batch.flags.diffTruncated
          ? "加载整批 Diff（采集时已截断）"
          : "加载整批 Diff";
    button.addEventListener("click", onLoadArtifact);
    diff.append(button);
    if (artifactState.status === "error") {
      const error = element(document, "p", "review-workspace-diff-error", `加载失败：${artifactState.error}`);
      error.setAttribute("role", "alert");
      diff.append(error);
    }
  }
  detail.append(diff);
}

function artifactStateFor(batch, { cache, errors, inflight }) {
  if (!batch) return { status: "unavailable", artifact: null, error: null };
  if (!batch.artifactRef) {
    return { status: batch.flags.invalid ? "invalid" : "unavailable", artifact: null, error: null };
  }
  const key = artifactCacheKey(batch.artifactRef);
  if (cache.has(key)) return { status: "loaded", artifact: cache.get(key), error: null, cacheKey: key };
  if (inflight.has(key)) return { status: "loading", artifact: null, error: null, cacheKey: key };
  if (errors.has(key)) return { status: "error", artifact: null, error: errors.get(key).message, cacheKey: key };
  return { status: "idle", artifact: null, error: null, cacheKey: key };
}

function normalizeArtifactRef(value, expectedSessionId) {
  if (!isRecord(value)) return { valid: false, value: null };
  const normalized = {
    id: textOrNull(value.id),
    sessionId: textOrNull(value.sessionId),
    kind: textOrNull(value.kind),
    sha256: textOrNull(value.sha256),
    byteSize: value.byteSize,
  };
  const valid = Boolean(
    normalized.id
    && normalized.sessionId
    && normalized.kind === "file_diff"
    && /^[a-f0-9]{64}$/.test(normalized.sha256 || "")
    && Number.isSafeInteger(normalized.byteSize)
    && normalized.byteSize >= 0
    && (!expectedSessionId || normalized.sessionId === expectedSessionId)
  );
  return { valid, value: valid ? Object.freeze(normalized) : null };
}

function validateLoadedArtifact(value, ref) {
  const artifact = isRecord(value?.artifact) ? value.artifact : value;
  if (!isRecord(artifact) || typeof artifact.content !== "string") {
    throw new Error("Artifact 响应无效");
  }
  for (const field of ["id", "sessionId", "kind", "sha256", "byteSize"]) {
    if (artifact[field] !== ref[field]) throw new Error(`Artifact ${field} 与 durable 引用不一致`);
  }
  const contentBytes = new TextEncoder().encode(artifact.content).byteLength;
  if (contentBytes !== ref.byteSize) throw new Error("Artifact content byteSize 与 durable 引用不一致");
  return {
    id: artifact.id,
    sessionId: artifact.sessionId,
    kind: artifact.kind,
    sha256: artifact.sha256,
    byteSize: artifact.byteSize,
    content: artifact.content,
  };
}

function artifactCacheKey(ref) {
  return JSON.stringify([ref.sessionId, ref.id, ref.sha256]);
}

function projectionSignature(projection) {
  return JSON.stringify({
    groups: projection.groups.map((group) => ({
      groupKey: group.groupKey,
      kind: group.kind,
      label: group.label,
      turnKey: group.turnKey || null,
      batches: group.batches.map((batch) => batch.batchKey),
    })),
    batches: projection.batches.map((batch) => ({
      batchKey: batch.batchKey,
      source: batch.source,
      turnKey: batch.turnKey,
      turnOrdinal: batch.turnOrdinal,
      entryKey: batch.entryKey,
      runKey: batch.runKey,
      tool: batch.tool,
      executionStatus: batch.executionStatus,
      parentSessionId: batch.parentSessionId,
      parentCursor: batch.parentCursor,
      statusTags: batch.statusTags,
      artifactRef: batch.artifactRef,
      changes: batch.changes.map((change) => ({
        path: change.path,
        operation: change.operation,
        valid: change.valid,
        before: change.before,
        after: change.after,
      })),
    })),
  });
}

function countOperations(changes) {
  const counts = { created: 0, modified: 0, deleted: 0 };
  for (const change of changes) {
    if (Object.hasOwn(counts, change.operation)) counts[change.operation] += 1;
  }
  return counts;
}

function operationLabel(operation) {
  return ({ created: "新增", modified: "修改", deleted: "删除", invalid: "无效" })[operation] || "未知";
}

function executionStatusLabel(status) {
  return ({
    succeeded: "执行成功",
    failed: "执行失败",
    blocked: "已阻止",
    cancelled: "已取消",
    unknown: "结果未知",
    running: "正在执行",
    pending: "准备执行",
    awaiting_approval: "等待批准",
  })[status] || "状态未知";
}

function statusLabel(status) {
  return ({
    "complete=false": "变化列表可能不完整",
    captureUnavailable: "变化采集不可用",
    diffUnavailable: "Diff 保存失败",
    diffTruncated: "Diff 已截断",
    metadata_only: "仅有文件元数据",
    invalid: "记录无效",
  })[status] || status;
}

function element(document, tagName, className, text = null) {
  const node = document.createElement(tagName);
  node.className = className;
  if (text !== null) node.textContent = text;
  return node;
}

function encodeKey(value) {
  return encodeURIComponent(String(value));
}

function textOrNull(value) {
  return typeof value === "string" && value.length ? value : null;
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertAlive(destroyed) {
  if (destroyed) throw new Error("Review Workspace 已销毁");
}
