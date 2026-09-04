import { artifactIdFromToolResult } from "./artifact-view.js";
import { projectExecutionTurns } from "./execution-summary.js";

export const TASK_THREAD_VERSION = "task-thread-v1";

const BUSY_PHASES = new Set(["thinking", "executing"]);
const OPEN_EXECUTION_STATUSES = new Set(["unknown", "failed", "awaiting_approval", "interrupted"]);
const FOLLOW_TAIL_THRESHOLD = 96;

// Deep UI Module: owns projection, keyed DOM reconciliation and all asynchronous
// interactions inside the visible Task Thread. Durable Session state remains the
// source of truth; this Module only retains ephemeral interaction intent.
export function createTaskThread({
  root,
  requestApproval,
  loadArtifact,
  openReview,
  useStarter,
  scheduleFrame = (callback) => requestAnimationFrame(callback),
  cancelFrame = (handle) => cancelAnimationFrame(handle),
} = {}) {
  assertRoot(root);
  for (const [name, callback] of Object.entries({ requestApproval, loadArtifact, openReview, useStarter })) {
    if (typeof callback !== "function") throw new TypeError(`Task Thread ${name} 必须是函数`);
  }
  if (typeof scheduleFrame !== "function" || typeof cancelFrame !== "function") {
    throw new TypeError("Task Thread frame scheduler 无效");
  }

  const document = root.ownerDocument || globalThis.document;
  if (!document || typeof document.createElement !== "function") {
    throw new Error("Task Thread 缺少 Document");
  }

  let destroyed = false;
  let epoch = 0;
  let sessionId = null;
  let cursor = null;
  let turnCount = 0;
  let frameHandle = null;
  let scrollRevision = 0;
  let lastExecutionProjection = projectExecutionTurns();
  const turnNodes = new Map();
  const disclosures = new Map();
  const approvalStates = new Map();
  const artifactStates = new Map();
  const operations = new Set();

  const onScroll = () => { scrollRevision += 1; };
  root.addEventListener?.("scroll", onScroll, { passive: true });

  const update = ({ session, cursor: nextCursor = null } = {}) => {
    assertAlive(destroyed);
    assertSession(session);
    if (nextCursor !== null && (!Number.isSafeInteger(nextCursor) || nextCursor < 0)) {
      throw new Error("Task Thread cursor 必须是非负安全整数");
    }

    const nextSessionId = session.id.trim();
    const switchedSession = sessionId !== nextSessionId;
    const firstRender = sessionId === null;
    const wasNearBottom = isNearBottom(root);
    const previousScrollTop = finiteNumber(root.scrollTop);
    const focusedKey = focusKeyInside(root, document.activeElement);
    if (switchedSession) resetEphemeralState({ clearRoot: true });
    sessionId = nextSessionId;
    cursor = nextCursor;

    const executionProjection = projectExecutionTurns(session);
    lastExecutionProjection = executionProjection;
    reconcileApprovalStates(executionProjection, session.pendingApproval);
    const nextTurnCount = executionProjection.turns.length;
    const newUserTurn = !switchedSession && nextTurnCount > turnCount;
    const nodes = renderThread(session, executionProjection);
    reconcileChildren(root, nodes);
    restoreFocus(root, document, focusedKey);

    const shouldFollowTail = firstRender || switchedSession || newUserTurn || wasNearBottom;
    if (!shouldFollowTail) root.scrollTop = previousScrollTop;
    scheduleTailFollow(shouldFollowTail);
    turnCount = nextTurnCount;
    return { executionProjection };
  };

  const renderThread = (session, executionProjection) => {
    const messages = Array.isArray(session.messages) ? session.messages : [];
    const pendingApproval = session.pendingApproval || null;
    const modelStream = session.modelStream || null;
    const streamedText = Array.isArray(session.modelStreamChunks)
      ? session.modelStreamChunks.join("")
      : "";
    const busy = BUSY_PHASES.has(session.phase);
    const turns = executionProjection.turns;
    const empty = !messages.length && !pendingApproval && !session.lastError && !streamedText && !busy;
    if (empty) return [welcomeNode(session.id)];

    const rendered = [];
    let approvalRendered = false;
    for (const [index, turn] of turns.entries()) {
      const active = index === turns.length - 1;
      const key = turn.execution?.turnKey || `turn:${index + 1}`;
      const historical = !active;
      const cached = turnNodes.get(key);
      let signature = cached?.signature || null;
      let node = null;

      // Once a Turn is historical, durable append-only semantics make it immutable.
      // This keeps streaming updates proportional to the active Turn, not history size.
      if (historical && cached?.historical) {
        node = cached.node;
      } else {
        signature = turnSignature(turn, active ? {
          phase: session.phase,
          pendingApproval,
          modelStream,
          streamedText,
          lastError: session.lastError,
        } : null);
        if (cached?.signature === signature) node = cached.node;
      }
      if (!node) {
        node = renderTurn(document, turn, {
          active,
          session,
          pendingApproval,
          modelStream,
          streamedText,
          busy,
          turnKey: key,
        });
      }
      turnNodes.set(key, { node, signature, historical });
      approvalRendered ||= node.getAttribute?.("data-approval-rendered") === "true";
      rendered.push(node);
    }

    if (pendingApproval && !approvalRendered) {
      const orphanKey = `orphan:${pendingApproval.id || "pending"}`;
      const signature = JSON.stringify(pendingApproval);
      const cached = turnNodes.get(orphanKey);
      const node = cached?.signature === signature
        ? cached.node
        : renderOrphanApproval(document, session.id, pendingApproval, orphanKey);
      turnNodes.set(orphanKey, { node, signature, historical: false });
      rendered.push(node);
    }

    if (!turns.length && session.lastError) {
      rendered.push(renderOutcome(document, {
        status: session.phase === "cancelled" ? "cancelled" : "failed",
        reason: session.lastError,
      }, "session-outcome"));
    }

    const liveKeys = new Set([
      ...turns.map((turn, index) => turn.execution?.turnKey || `turn:${index + 1}`),
      ...(pendingApproval && !approvalRendered ? [`orphan:${pendingApproval.id || "pending"}`] : []),
    ]);
    for (const key of turnNodes.keys()) {
      if (!liveKeys.has(key)) turnNodes.delete(key);
    }
    return rendered;
  };

  const renderTurn = (doc, turn, context) => {
    const container = element(doc, "section", "conversation-turn");
    container.setAttribute("data-turn-key", context.turnKey);
    let approvalRendered = false;

    if (turn.user) {
      const row = element(doc, "article", "message-row user");
      const bubble = element(doc, "div", "user-bubble", turn.user.content || "");
      row.append(bubble);
      container.append(row);
    }

    const hasActiveProjection = context.active
      && (Boolean(context.streamedText) || context.busy || Boolean(context.pendingApproval));
    const outcome = turnOutcome(turn.execution, context);
    if (turn.activityMessages.length || turn.finalMessage || hasActiveProjection || outcome) {
      const { row, body } = createAssistantTurnRow(doc);
      if (turn.activityMessages.length || turn.execution.runs.length) {
        const activity = renderTurnActivity(doc, turn, {
          expanded: hasActiveProjection,
          sessionId: context.session.id,
          turnKey: context.turnKey,
        });
        approvalRendered ||= activity.approvalRendered;
        body.append(activity.node);
      }
      if (turn.finalMessage?.content) {
        const final = renderMarkdown(doc, turn.finalMessage.content);
        final.classList.add("turn-final");
        body.append(final);
      } else if (context.active && context.modelStream && context.streamedText) {
        // Durable final content always wins over the transient stream projection.
        body.append(renderModelStream(doc, context.modelStream, context.streamedText));
      }
      if (context.active && context.busy && !context.streamedText) body.append(thinkingDots(doc));
      if (outcome) body.append(renderOutcome(doc, outcome, `${context.turnKey}:outcome`));
      container.append(row);
    }
    container.setAttribute("data-approval-rendered", String(approvalRendered));
    return container;
  };

  const renderTurnActivity = (doc, turn, { expanded, sessionId: capturedSessionId, turnKey }) => {
    const disclosureKey = `${turnKey}:activity`;
    const details = disclosure(doc, `turn-activity ${turn.execution.status}`, disclosureKey,
      expanded || OPEN_EXECUTION_STATUSES.has(turn.execution.status));
    const summary = element(doc, "summary");
    summary.setAttribute("data-thread-focus-key", `${disclosureKey}:summary`);
    const title = element(doc, "strong", null, "执行摘要");
    const meta = element(doc, "span", null, executionSummaryMeta(turn.execution));
    const chevron = element(doc, "span", "chevron", "⌄");
    summary.append(title, meta, chevron);

    const content = element(doc, "div", "turn-activity-content");
    let approvalRendered = false;
    let runIndex = 0;
    for (const message of turn.activityMessages) {
      const step = element(doc, "section", "turn-activity-step");
      if (message.content) step.append(renderMarkdown(doc, message.content));
      for (const call of message.tool_calls || []) {
        const run = turn.execution.runs[runIndex++] || null;
        step.append(renderToolCard(doc, {
          call: normalizeToolCall(run?.call || call),
          run,
          sessionId: capturedSessionId,
          turnKey,
        }));
        approvalRendered ||= Boolean(run?.pendingApproval);
      }
      if (step.childElementCount) content.append(step);
    }
    for (const run of turn.execution.runs.slice(runIndex)) {
      const step = element(doc, "section", "turn-activity-step");
      step.append(renderToolCard(doc, {
        call: normalizeToolCall(run.call),
        run,
        sessionId: capturedSessionId,
        turnKey,
      }));
      content.append(step);
      approvalRendered ||= Boolean(run.pendingApproval);
    }
    details.append(summary, content);
    return { node: details, approvalRendered };
  };

  const renderToolCard = (doc, { call, run = null, sessionId: capturedSessionId, turnKey }) => {
    const result = run?.result || null;
    const pending = run?.pendingApproval || null;
    const outputStream = run?.liveOutput || null;
    const statusName = run?.status || null;
    const durationMs = run?.durationMs || 0;
    const runKey = run?.runKey || `approval:${call.id || "unknown"}`;
    const disclosureKey = `${turnKey}:${runKey}:tool`;
    const view = toolExecutionView({
      executionStatus: statusName,
      pending,
      result,
      outputStream,
      durationMs,
      effectiveTimeoutMs: run?.effectiveTimeoutMs,
      terminationReason: run?.terminationReason,
    });
    const details = disclosure(doc, `tool-card ${view.className}`, disclosureKey,
      Boolean(pending || outputStream?.preview));
    details.setAttribute("data-run-key", runKey);
    if (call.id) details.setAttribute("data-call-id", call.id);

    const summary = element(doc, "summary");
    summary.setAttribute("data-thread-focus-key", `${disclosureKey}:summary`);
    summary.append(
      element(doc, "span", "tool-icon", view.icon),
      element(doc, "span", "tool-name", toolLabel(call.name)),
      element(doc, "span", "tool-status", view.label),
      element(doc, "span", "chevron", "⌄"),
    );

    const content = element(doc, "div", "tool-content");
    content.append(element(doc, "pre", null, formatToolArguments(call.arguments)));
    if (!result && outputStream?.preview) {
      content.append(
        element(doc, "span", "tool-output-label", outputStream.truncated ? "实时输出 · 预览已满" : "实时输出"),
        element(doc, "pre", "tool-live-output", outputStream.preview),
      );
    }
    if (result) renderToolResult(doc, content, result, capturedSessionId, runKey);
    if (run?.fileChanges) {
      content.append(fileChangePanel(doc, run.fileChanges, {
        sessionId: capturedSessionId,
        turnKey,
        runKey,
      }));
    }
    if (pending) content.append(approvalActions(doc, pending, {
      sessionId: capturedSessionId,
      runKey,
    }));
    details.append(summary, content);
    return details;
  };

  const renderToolResult = (doc, content, result, capturedSessionId, runKey) => {
    content.append(element(doc, "span", "tool-output-label", "输出"));
    const artifactId = artifactIdFromToolResult(result.content);
    const key = artifactId ? artifactKey(capturedSessionId, artifactId) : null;
    const artifactState = key ? artifactStates.get(key) : null;
    const output = element(doc, "pre", null,
      artifactState?.status === "loaded" ? artifactState.content : (result.content || "工具没有返回内容"));
    content.append(output);
    if (!artifactId) return;

    const load = element(doc, "button", "artifact-button");
    load.type = "button";
    load.setAttribute("data-thread-focus-key", `${runKey}:artifact:${artifactId}`);
    applyArtifactButtonState(load, artifactState);
    load.addEventListener("click", () => startArtifactLoad({
      sessionId: capturedSessionId,
      artifactId,
      output,
      button: load,
    }));
    content.append(load);
    const nextArtifactState = artifactState || { status: "idle", views: new Map() };
    if (!(nextArtifactState.views instanceof Map)) nextArtifactState.views = new Map();
    nextArtifactState.views.set(runKey, { output, button: load });
    artifactStates.set(key, nextArtifactState);
  };

  const startArtifactLoad = ({ sessionId: capturedSessionId, artifactId, output, button }) => {
    if (!isCurrent(capturedSessionId) || button.disabled) return;
    const key = artifactKey(capturedSessionId, artifactId);
    const current = artifactStates.get(key) || { status: "idle", views: new Map() };
    if (current?.status === "loaded") return;
    const controller = operationController();
    const capturedEpoch = epoch;
    current.status = "loading";
    current.error = null;
    if (!(current.views instanceof Map)) current.views = new Map();
    artifactStates.set(key, current);
    applyArtifactViews(current);
    Promise.resolve()
      .then(() => {
        if (!isCurrent(capturedSessionId, capturedEpoch) || controller.signal.aborted) return null;
        return loadArtifact({ sessionId: capturedSessionId, artifactId, signal: controller.signal });
      })
      .then((payload) => {
        if (payload === null) return null;
        return normalizeLoadedArtifact(payload, { sessionId: capturedSessionId, artifactId });
      })
      .then((artifact) => {
        if (artifact === null) return;
        if (!isCurrent(capturedSessionId, capturedEpoch) || controller.signal.aborted) return;
        const state = artifactStates.get(key);
        if (!state) return;
        state.status = "loaded";
        state.content = artifact.content;
        state.byteSize = artifact.byteSize;
        applyArtifactViews(state);
      })
      .catch((error) => {
        if (!isCurrent(capturedSessionId, capturedEpoch) || controller.signal.aborted) return;
        const state = artifactStates.get(key);
        if (!state) return;
        state.status = "error";
        state.error = error instanceof Error ? error.message : String(error);
        applyArtifactViews(state);
      })
      .finally(() => releaseController(controller));
  };

  const approvalActions = (doc, call, { sessionId: capturedSessionId, runKey }) => {
    const key = approvalKey(capturedSessionId, runKey, call.id);
    const panel = element(doc, "div", "approval-panel");
    panel.append(
      element(doc, "p", "approval-copy", call.reason || "此操作需要你的确认后才会在本地执行。"),
      element(doc, "p", "approval-copy",
        `权限档位：${call.profile || "未指定"} · 风险：${call.risk || "未分类"} · 规则：${call.ruleId || "未命中"}`),
    );
    const row = element(doc, "div", "approval-actions");
    const scopes = call.approvalScopes || ["once"];
    const approvals = [
      ["once", "仅本次", "只允许当前工具调用，使用后立即失效"],
      ["session", "本会话允许", "相同工具和资源在当前会话中可复用，最长 8 小时"],
      ["project", "本项目允许", "相同工具和资源可跨本项目会话复用，最长 30 天"],
    ].filter(([scope]) => scopes.includes(scope)).map(([scope, label, title]) => {
      const button = element(doc, "button", `approve-button approve-${scope}`, label);
      button.type = "button";
      button.title = title;
      button.setAttribute("data-thread-focus-key", `${key}:${scope}`);
      return { button, scope };
    });
    const deny = element(doc, "button", "deny-button", "拒绝");
    deny.type = "button";
    deny.setAttribute("data-thread-focus-key", `${key}:deny`);
    const buttons = [...approvals.map(({ button }) => button), deny];
    const approvalState = approvalStates.get(key) || { pending: false };
    approvalState.buttons = new Set(buttons);
    approvalStates.set(key, approvalState);
    const pending = approvalState.pending === true;
    for (const button of buttons) button.disabled = pending;
    approvals.forEach(({ button, scope }) => {
      button.addEventListener("click", () => submitApproval({
        key, callId: call.id, approved: true, scope, buttons, sessionId: capturedSessionId,
      }));
    });
    deny.addEventListener("click", () => submitApproval({
      key, callId: call.id, approved: false, scope: "once", buttons, sessionId: capturedSessionId,
    }));
    row.append(...buttons);
    panel.append(row);
    return panel;
  };

  const submitApproval = ({ key, callId, approved, scope, buttons, sessionId: capturedSessionId }) => {
    if (!isCurrent(capturedSessionId) || approvalStates.get(key)?.pending) return;
    const controller = operationController();
    const capturedEpoch = epoch;
    const state = approvalStates.get(key) || {};
    approvalStates.set(key, { ...state, pending: true, controller });
    for (const button of buttons) button.disabled = true;
    Promise.resolve()
      .then(() => {
        if (!isCurrent(capturedSessionId, capturedEpoch) || controller.signal.aborted) return;
        return requestApproval({
          sessionId: capturedSessionId,
          callId,
          approved,
          scope,
          signal: controller.signal,
        });
      })
      .catch(() => {
        if (!isCurrent(capturedSessionId, capturedEpoch) || controller.signal.aborted) return;
        const current = approvalStates.get(key) || {};
        approvalStates.set(key, { ...current, pending: false, controller: null });
        for (const button of current.buttons || buttons) button.disabled = false;
      })
      .finally(() => releaseController(controller));
  };

  const fileChangePanel = (doc, manifest, target) => {
    const panel = element(doc, "section", "file-change-panel");
    const summary = manifest.summary || summarizeChanges(manifest.changes);
    panel.append(
      element(doc, "strong", null, `文件变更 · ${summary.total} 项`),
      element(doc, "span", null,
        `新增 ${summary.created} · 修改 ${summary.modified} · 删除 ${summary.deleted}${manifest.complete ? "" : " · 采集不完整"}`),
    );
    if (manifest.changes?.length) {
      const list = element(doc, "ul");
      for (const change of manifest.changes.slice(0, 8)) {
        const item = element(doc, "li", change.operation);
        item.append(
          element(doc, "i", null, ({ created: "+", modified: "~", deleted: "−" })[change.operation] || "·"),
          element(doc, "code", null, change.path),
        );
        list.append(item);
      }
      panel.append(list);
      if (manifest.changes.length > 8) {
        panel.append(element(doc, "span", "file-change-remaining",
          `还有 ${manifest.changes.length - 8} 项，请在文件审查中查看`));
      }
    }
    const button = element(doc, "button", "artifact-button",
      manifest.diffArtifact?.id
        ? (manifest.diffTruncated ? "打开文件审查（Diff 已截断）" : "打开文件审查")
        : "查看文件变化");
    button.type = "button";
    button.addEventListener("click", () => {
      if (!isCurrent(target.sessionId)) return;
      openReview({
        sessionId: target.sessionId,
        turnKey: target.turnKey,
        runKey: target.runKey,
        path: manifest.changes?.[0]?.path || null,
      });
    });
    panel.append(button);
    return panel;
  };

  const renderOrphanApproval = (doc, capturedSessionId, pendingApproval, key) => {
    const container = element(doc, "section", "conversation-turn");
    container.setAttribute("data-turn-key", key);
    container.setAttribute("data-approval-rendered", "true");
    const { row, body } = createAssistantTurnRow(doc);
    body.append(renderToolCard(doc, {
      call: normalizeToolCall(pendingApproval),
      run: {
        runKey: key,
        status: "awaiting_approval",
        pendingApproval,
      },
      sessionId: capturedSessionId,
      turnKey: key,
    }));
    container.append(row);
    return container;
  };

  const welcomeNode = (capturedSessionId) => {
    const cached = turnNodes.get("welcome");
    if (cached) return cached.node;
    const box = element(document, "div", "welcome");
    box.setAttribute("data-turn-key", "welcome");
    box.append(
      element(document, "div", "welcome-mark", "N"),
      element(document, "h2", null, "开始一个新任务"),
      element(document, "p", null, "Nexus 会在本地工作区中读取文件、运行命令并请求必要审批。"),
    );
    const starters = element(document, "div", "starters");
    for (const [label, description, prompt] of [
      ["理解项目", "梳理架构与关键模块", "分析这个项目的结构，并告诉我应该从哪里开始。"],
      ["检查问题", "定位错误与风险", "检查当前项目，找出最值得修复的问题。"],
      ["继续开发", "推进优先级最高的功能", "根据当前项目目标，实现下一个优先级最高的功能。"],
    ]) {
      const button = element(document, "button");
      button.type = "button";
      button.dataset.prompt = prompt;
      button.append(element(document, "strong", null, label), element(document, "span", null, description));
      button.addEventListener("click", async (event) => {
        if (!isCurrent(capturedSessionId)) return;
        button.disabled = true;
        try {
          await useStarter({ sessionId: capturedSessionId, prompt, event });
        } catch {
          // App Adapter owns user-facing error reporting.
        } finally {
          if (isCurrent(capturedSessionId) && button.isConnected !== false) button.disabled = false;
        }
      });
      starters.append(button);
    }
    box.append(starters);
    turnNodes.set("welcome", { node: box, signature: "welcome", historical: false });
    return box;
  };

  const disclosure = (doc, className, key, defaultOpen) => {
    const details = element(doc, "details", className);
    details.setAttribute("data-disclosure-key", key);
    details.open = disclosures.has(key) ? disclosures.get(key) : defaultOpen;
    details.addEventListener("toggle", () => {
      if (!destroyed) disclosures.set(key, Boolean(details.open));
    });
    return details;
  };

  const reconcileApprovalStates = (projection, orphanApproval) => {
    const live = new Set();
    for (const turn of projection.turns) {
      for (const run of turn.execution?.runs || []) {
        if (run.pendingApproval) live.add(approvalKey(sessionId, run.runKey, run.pendingApproval.id));
      }
    }
    if (orphanApproval && !live.size) {
      live.add(approvalKey(sessionId, `orphan:${orphanApproval.id || "pending"}`, orphanApproval.id));
    }
    for (const [key, state] of approvalStates) {
      if (live.has(key)) continue;
      state.controller?.abort();
      approvalStates.delete(key);
    }
  };

  const operationController = () => {
    const controller = new AbortController();
    operations.add(controller);
    return controller;
  };
  const releaseController = (controller) => operations.delete(controller);

  const scheduleTailFollow = (enabled) => {
    if (frameHandle !== null) cancelFrame(frameHandle);
    frameHandle = null;
    if (!enabled) return;
    const capturedEpoch = epoch;
    const capturedScrollRevision = scrollRevision;
    frameHandle = scheduleFrame(() => {
      frameHandle = null;
      if (destroyed || capturedEpoch !== epoch || capturedScrollRevision !== scrollRevision) return;
      root.scrollTop = root.scrollHeight;
    });
  };

  const resetEphemeralState = ({ clearRoot = true } = {}) => {
    epoch += 1;
    if (frameHandle !== null) cancelFrame(frameHandle);
    frameHandle = null;
    for (const controller of operations) controller.abort();
    operations.clear();
    turnNodes.clear();
    disclosures.clear();
    approvalStates.clear();
    artifactStates.clear();
    turnCount = 0;
    if (clearRoot) root.replaceChildren();
  };

  const reset = () => {
    assertAlive(destroyed);
    resetEphemeralState();
    sessionId = null;
    cursor = null;
    lastExecutionProjection = projectExecutionTurns();
  };

  const showWelcome = () => {
    reset();
    const node = welcomeNode(null);
    root.replaceChildren(node);
    scheduleTailFollow(true);
    return node;
  };

  const destroy = () => {
    if (destroyed) return;
    resetEphemeralState();
    root.removeEventListener?.("scroll", onScroll);
    sessionId = null;
    cursor = null;
    destroyed = true;
  };

  const snapshot = () => ({
    version: TASK_THREAD_VERSION,
    destroyed,
    sessionId,
    cursor,
    turnCount,
    renderedTurnKeys: [...turnNodes.keys()],
    disclosureCount: disclosures.size,
    pendingApprovals: [...approvalStates.entries()].filter(([, state]) => state.pending).map(([key]) => key),
    artifactKeys: [...artifactStates.keys()],
    executionProjection: lastExecutionProjection,
  });

  const isCurrent = (capturedSessionId, capturedEpoch = epoch) => (
    !destroyed && sessionId === capturedSessionId && epoch === capturedEpoch
  );

  showWelcome();
  return { update, showWelcome, reset, destroy, snapshot };
}

function createAssistantTurnRow(document) {
  const row = element(document, "article", "message-row assistant agent-turn");
  const avatar = element(document, "div", "avatar", "N");
  const body = element(document, "div", "message-body");
  row.append(avatar, body);
  return { row, body };
}

function renderModelStream(document, modelStream, text) {
  const output = renderMarkdown(document, text);
  output.classList.add("turn-final", "model-stream", modelStream.status);
  const labels = {
    streaming: "正在生成",
    cancelled: "已中途停止",
    failed: "生成失败，保留部分输出",
    interrupted: "进程中断，保留部分输出",
  };
  output.append(element(document, "span", "model-stream-state", labels[modelStream.status] || "部分输出"));
  return output;
}

function thinkingDots(document) {
  const dots = element(document, "div", "thinking-dots turn-thinking");
  dots.append(element(document, "i"), element(document, "i"), element(document, "i"));
  return dots;
}

function turnOutcome(execution, { active, session }) {
  const explicit = execution?.outcome || null;
  const status = explicit?.requiresManualInspection
    ? "unknown"
    : (explicit?.status || execution?.status);
  if (!["failed", "cancelled", "interrupted", "unknown"].includes(status)) return null;
  return {
    status,
    reason: explicit?.reason || (active && status === "failed" ? session.lastError : null),
    sideEffectCertainty: explicit?.sideEffectCertainty || (status === "unknown" ? "unknown" : null),
    recovery: explicit?.recovery || execution?.recovery || null,
    requiresManualInspection: explicit?.requiresManualInspection === true,
  };
}

function renderOutcome(document, outcome, key) {
  const box = element(document, "div", `runtime-error turn-outcome ${outcome.status}`);
  box.setAttribute("data-outcome-key", key);
  const labels = {
    failed: "本轮失败",
    cancelled: "本轮已取消",
    interrupted: "本轮在恢复后中断",
    unknown: "工具结果未知",
  };
  box.append(element(document, "strong", null, labels[outcome.status] || "本轮未完成"));
  if (outcome.reason) box.append(element(document, "span", null, outcome.reason));
  if (outcome.requiresManualInspection || outcome.sideEffectCertainty === "unknown" || outcome.recovery?.toolExecutionUnknown) {
    box.append(element(document, "span", null, "结果未知，先检查工作区或外部状态；Nexus 不会自动重试。"));
  } else if (outcome.status === "interrupted") {
    box.append(element(document, "span", null, "Gateway 恢复了会话，但不会猜测或重复尚未确认的操作。"));
  }
  return box;
}

function renderMarkdown(document, source) {
  const root = element(document, "div", "markdown");
  const lines = String(source || "").replace(/\r\n/g, "\n").split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) { index += 1; continue; }
    if (/^```/.test(line.trim())) {
      const language = line.trim().slice(3).trim();
      const codeLines = [];
      index += 1;
      while (index < lines.length && !/^```/.test(lines[index].trim())) codeLines.push(lines[index++]);
      if (index < lines.length) index += 1;
      const pre = element(document, "pre");
      const code = element(document, "code", null, codeLines.join("\n"));
      if (language) code.dataset.language = language;
      pre.append(code);
      root.append(pre);
      continue;
    }
    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const node = element(document, `h${heading[1].length + 1}`);
      appendInline(document, node, heading[2]);
      root.append(node);
      index += 1;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = element(document, ordered ? "ol" : "ul");
      const matcher = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const match = lines[index].match(matcher);
        if (!match) break;
        const item = element(document, "li");
        appendInline(document, item, match[1]);
        list.append(item);
        index += 1;
      }
      root.append(list);
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = element(document, "blockquote");
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quoteLines.push(lines[index++].replace(/^>\s?/, ""));
      appendInline(document, quote, quoteLines.join(" "));
      root.append(quote);
      continue;
    }
    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) paragraph.push(lines[index++].trim());
    if (!paragraph.length) paragraph.push(lines[index++]);
    const node = element(document, "p");
    appendInline(document, node, paragraph.join(" "));
    root.append(node);
  }
  return root;
}

function appendInline(document, parent, source) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_([^_]+)_|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) parent.append(element(document, "code", null, token.slice(1, -1)));
    else if (token.startsWith("**") || token.startsWith("__")) parent.append(element(document, "strong", null, token.slice(2, -2)));
    else if (token.startsWith("*") || token.startsWith("_")) parent.append(element(document, "em", null, token.slice(1, -1)));
    else {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const link = element(document, "a", null, parts[1]);
      if (safeLink(parts[2], document)) {
        link.href = parts[2];
        link.target = "_blank";
        link.rel = "noreferrer";
      }
      parent.append(link);
    }
    cursor = match.index + token.length;
  }
  if (cursor < source.length) parent.append(document.createTextNode(source.slice(cursor)));
}

function isBlockStart(line) {
  const value = line.trim();
  return /^```/.test(value) || /^#{1,4}\s+/.test(value) || /^>\s?/.test(value)
    || /^[-*+]\s+/.test(value) || /^\d+[.)]\s+/.test(value);
}

function safeLink(value, document) {
  try {
    const base = document.defaultView?.location?.href || globalThis.location?.href || "http://localhost/";
    return ["http:", "https:"].includes(new URL(value, base).protocol);
  } catch {
    return false;
  }
}

function normalizeToolCall(call = {}) {
  return {
    id: call.id,
    name: call.name || call.function?.name || "unknown",
    arguments: call.arguments ?? call.function?.arguments ?? {},
  };
}

function normalizeLoadedArtifact(payload, expected) {
  const artifact = payload?.artifact || payload;
  if (!artifact || typeof artifact !== "object") throw new Error("Artifact 响应无效");
  if (artifact.sessionId && artifact.sessionId !== expected.sessionId) throw new Error("Artifact Session 不匹配");
  if (artifact.id && artifact.id !== expected.artifactId) throw new Error("Artifact ID 不匹配");
  if (typeof artifact.content !== "string") throw new Error("Artifact 缺少文本内容");
  return {
    content: artifact.content,
    byteSize: Number.isSafeInteger(artifact.byteSize) && artifact.byteSize >= 0
      ? artifact.byteSize
      : new TextEncoder().encode(artifact.content).byteLength,
  };
}

function applyArtifactButtonState(button, state) {
  button.disabled = state?.status === "loading" || state?.status === "loaded";
  if (state?.status === "loading") button.textContent = "加载中…";
  else if (state?.status === "loaded") button.textContent = `已加载完整输出 · ${state.byteSize} 字节`;
  else if (state?.status === "error") button.textContent = `加载失败：${state.error}`;
  else button.textContent = "加载完整输出";
}

function applyArtifactViews(state) {
  for (const { output, button } of state.views?.values?.() || []) {
    if (state.status === "loaded") output.textContent = state.content;
    applyArtifactButtonState(button, state);
  }
}

function toolExecutionView({
  executionStatus,
  pending,
  result,
  outputStream,
  durationMs,
  effectiveTimeoutMs,
  terminationReason,
}) {
  if (pending || executionStatus === "awaiting_approval") {
    return { className: "approval-needed", icon: "!", label: "等待批准" };
  }
  const duration = durationMs ? ` · ${formatDuration(durationMs)}` : "";
  const runningMeta = [
    executionLimitLabel(effectiveTimeoutMs),
    outputStream?.capturedChars ? `${outputStream.capturedChars} 字符` : null,
  ].filter(Boolean).join(" · ");
  const runningLabel = `运行中${runningMeta ? ` · ${runningMeta}` : ""}`;
  const failedLabel = terminationReason === "timeout"
    ? `已超时${duration}`
    : terminationReason === "cancelled"
      ? `用户取消${duration}`
      : terminationReason === "external_failed"
        ? `执行失败${duration}`
        : `失败${duration}`;
  const cancelledLabel = terminationReason === "cancelled"
    ? `用户取消${duration}`
    : `已取消${duration}`;
  const unknownReason = ({
    timeout: "超时后",
    cancelled: "用户取消后",
    external_failed: "执行失败后",
  })[terminationReason];
  const states = {
    inherited: ["inherited", "↳", "继承记录"],
    succeeded: ["completed", "✓", `已完成${duration}`],
    failed: ["failed", "×", failedLabel],
    blocked: ["failed", "×", "已阻止"],
    cancelled: ["failed", "×", cancelledLabel],
    unknown: ["failed", "?", `结果未知${unknownReason ? ` · ${unknownReason}` : ""}${duration}`],
    running: ["running", "·", runningLabel],
    pending: ["running", "·", "准备执行"],
  };
  const selected = states[executionStatus];
  if (selected) return { className: selected[0], icon: selected[1], label: selected[2] };
  if (result) return { className: "completed", icon: "✓", label: `已完成${duration}` };
  return { className: "running", icon: "·", label: "运行中" };
}

function executionLimitLabel(value) {
  if (value === null) return "不限时";
  if (!Number.isSafeInteger(value) || value < 1) return null;
  return `最长 ${formatTimeout(value)}`;
}

function formatTimeout(value) {
  if (value < 1_000) return `${value}ms`;
  if (value < 60_000) {
    const seconds = value / 1_000;
    return `${Number.isInteger(seconds) ? seconds : seconds.toFixed(1)}s`;
  }
  if (value < 3_600_000) {
    const minutes = Math.floor(value / 60_000);
    const seconds = Math.floor((value % 60_000) / 1_000);
    return `${minutes}m${seconds ? ` ${seconds}s` : ""}`;
  }
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  return `${hours}h${minutes ? ` ${minutes}m` : ""}`;
}

function executionSummaryMeta(execution) {
  return [
    execution.counts.total ? `${execution.counts.total} 个工具` : `${execution.model.requests} 次模型请求`,
    execution.durationMs !== null ? formatDuration(execution.durationMs) : null,
    execution.fileChanges.uniquePaths ? `${execution.fileChanges.uniquePaths} 个文件` : null,
    execution.counts.failed ? `${execution.counts.failed} 个失败` : null,
    execution.counts.blocked ? `${execution.counts.blocked} 个已阻止` : null,
    execution.counts.unknown ? `${execution.counts.unknown} 个结果未知` : null,
    execution.counts.inherited ? `${execution.counts.inherited} 个继承记录` : null,
    execution.counts.awaitingApproval ? `${execution.counts.awaitingApproval} 个待批准` : null,
    execution.counts.running ? `${execution.counts.running} 个运行中` : null,
    execution.status === "interrupted" ? "Turn 已中断" : null,
  ].filter(Boolean).join(" · ");
}

function formatToolArguments(value) {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value ?? {}, null, 2);
}

function toolLabel(name) {
  const labels = {
    run_shell: "运行终端命令",
    read_file: "读取文件",
    write_file: "修改文件",
    edit_file: "精确编辑文件",
    apply_patch: "应用多文件 Patch",
    list_files: "查看文件",
    search_files: "搜索文件",
    memory_save: "保存长期记忆",
    memory_search: "搜索长期记忆",
    remember: "保存会话记忆",
    update_plan: "更新任务计划",
    delegate_task: "委派 Child Agent",
  };
  return labels[name] || name || "工具调用";
}

function summarizeChanges(changes = []) {
  const summary = { created: 0, modified: 0, deleted: 0, total: changes.length };
  for (const change of changes) {
    if (Object.hasOwn(summary, change?.operation)) summary[change.operation] += 1;
  }
  return summary;
}

function formatDuration(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

function turnSignature(turn, live) {
  return JSON.stringify(live ? { turn, live } : turn);
}

function artifactKey(sessionId, artifactId) {
  return `${sessionId}:${artifactId}`;
}

function approvalKey(sessionId, runKey, callId) {
  return `${sessionId}:${runKey}:${callId || "unknown"}`;
}

function element(document, tagName, className = null, text = null) {
  const node = document.createElement(tagName);
  if (className) node.className = className;
  if (text !== null && text !== undefined) node.textContent = String(text);
  return node;
}

function reconcileChildren(root, desired) {
  if (typeof root.insertBefore !== "function" || typeof root.removeChild !== "function") {
    root.replaceChildren(...desired);
    return;
  }
  const wanted = new Set(desired);
  for (const [index, node] of desired.entries()) {
    if (root.children[index] !== node) root.insertBefore(node, root.children[index] || null);
  }
  for (const child of [...root.children]) {
    if (!wanted.has(child)) root.removeChild(child);
  }
}

function focusKeyInside(root, activeElement) {
  if (!activeElement || !contains(root, activeElement)) return null;
  return activeElement.getAttribute?.("data-thread-focus-key") || null;
}

function restoreFocus(root, document, key) {
  if (!key || (document.activeElement && contains(root, document.activeElement))) return;
  const target = findByAttribute(root, "data-thread-focus-key", key);
  target?.focus?.({ preventScroll: true });
}

function findByAttribute(root, name, value) {
  const stack = [...(root.children || [])];
  while (stack.length) {
    const node = stack.shift();
    if (node.getAttribute?.(name) === value) return node;
    stack.unshift(...(node.children || []));
  }
  return null;
}

function contains(root, target) {
  if (typeof root.contains === "function") return root.contains(target);
  if (root === target) return true;
  return [...(root.children || [])].some((child) => contains(child, target));
}

function isNearBottom(root) {
  const remaining = finiteNumber(root.scrollHeight) - finiteNumber(root.scrollTop) - finiteNumber(root.clientHeight);
  return remaining <= FOLLOW_TAIL_THRESHOLD;
}

function finiteNumber(value) {
  return Number.isFinite(value) ? value : 0;
}

function assertRoot(root) {
  if (!root || typeof root.replaceChildren !== "function" || typeof root.addEventListener !== "function") {
    throw new Error("Task Thread 需要可渲染的 root");
  }
}

function assertSession(session) {
  if (!session || typeof session !== "object" || typeof session.id !== "string" || !session.id.trim()) {
    throw new Error("Task Thread Session 无效");
  }
}

function assertAlive(destroyed) {
  if (destroyed) throw new Error("Task Thread 已销毁");
}
