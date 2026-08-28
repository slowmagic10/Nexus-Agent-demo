import { applyStatePatch } from "/state-patch.js";
import {
  composerActionState,
  shouldCancelRun,
  shouldSubmitMessage,
} from "/keyboard.js";
import { grantViewModel } from "/grants.js";
import { objectivePlanViewModel } from "/plan-view.js";
import { profileDriftViewModel } from "/profile-view.js";
import { artifactIdFromToolResult } from "/artifact-view.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  sessionId: null,
  session: null,
  cursor: 0,
  source: null,
  runtime: null,
  selectedAgentProfileId: "default",
  selectedPermissionProfile: "workspace-auto",
  inspectorTab: "events",
  cancelling: false,
};

const elements = {
  sessionList: $("#session-list"),
  sessionCount: $("#session-count"),
  messages: $("#messages"),
  planPanel: $("#plan-panel"),
  events: $("#events"),
  title: $("#session-title"),
  meta: $("#session-meta"),
  phaseDot: $("#phase-dot"),
  input: $("#message-input"),
  form: $("#message-form"),
  export: $("#export-session"),
  composerAction: $("#composer-action"),
  composerShortcut: $("#composer-shortcut"),
  provider: $("#composer-provider"),
  memoryList: $("#memory-list"),
  candidateList: $("#candidate-list"),
  grantList: $("#grant-list"),
  grantCount: $("#grant-count"),
  grantSummary: $("#grant-summary"),
  inspector: $("#inspector"),
  backdrop: $("#drawer-backdrop"),
  debugToggle: $("#debug-toggle"),
  themeToggle: $("#theme-toggle"),
  permissionTrigger: $("#permission-trigger"),
  permissionLabel: $("#permission-label"),
  permissionMenu: $("#permission-menu"),
  dangerConfirm: $("#danger-confirm"),
  dangerConfirmBackdrop: $("#danger-confirm-backdrop"),
  dangerConfirmAccept: $("#danger-confirm-accept"),
  agentProfileSelect: $("#agent-profile-select"),
};

applyTheme(savedTheme());
$("#new-session").addEventListener("click", createSession);
elements.form.addEventListener("submit", sendMessage);
let inputIsComposing = false;
elements.input.addEventListener("compositionstart", () => {
  inputIsComposing = true;
});
elements.input.addEventListener("compositionend", () => {
  inputIsComposing = false;
});
elements.input.addEventListener("keydown", (event) => {
  if (shouldSubmitMessage(event, { composing: inputIsComposing })) {
    event.preventDefault();
    elements.form.requestSubmit();
  }
});
elements.messages.addEventListener("click", useStarter);
elements.composerAction.addEventListener("click", handleComposerAction);
elements.export.addEventListener("click", exportSession);
elements.themeToggle.addEventListener("click", toggleTheme);
elements.permissionTrigger.addEventListener("click", togglePermissionMenu);
elements.permissionMenu.addEventListener("click", choosePermissionMode);
elements.agentProfileSelect.addEventListener("change", chooseAgentProfile);
elements.dangerConfirmAccept.addEventListener("click", confirmDangerFullAccess);
$("#danger-confirm-cancel").addEventListener("click", closeDangerConfirm);
elements.dangerConfirmBackdrop.addEventListener("click", closeDangerConfirm);
elements.debugToggle.addEventListener("click", openInspector);
$("#debug-close").addEventListener("click", closeInspector);
elements.backdrop.addEventListener("click", closeInspector);
$("#memory-form").addEventListener("submit", addMemory);
document.addEventListener("keydown", (event) => {
  if (shouldCancelRun(event, {
    phase: state.session?.phase,
    cancelling: state.cancelling,
    overlayOpen: isOverlayOpen(),
  })) {
    event.preventDefault();
    void cancelRun();
    return;
  }
  if (event.key === "Escape") {
    closeInspector();
    closePermissionMenu();
    closeDangerConfirm();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".permission-selector")) closePermissionMenu();
});
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => selectTab(tab.dataset.tab));
});

await Promise.allSettled([checkHealth(), loadRuntime(), loadSessions(), loadMemories(), loadCandidates()]);

function savedTheme() {
  try {
    const saved = localStorage.getItem("nexus-theme");
    if (["dark", "light"].includes(saved)) return saved;
  } catch {}
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

function toggleTheme() {
  const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
  applyTheme(next);
  try { localStorage.setItem("nexus-theme", next); } catch {}
}

function applyTheme(theme) {
  const light = theme === "light";
  document.documentElement.dataset.theme = light ? "light" : "dark";
  elements.themeToggle.textContent = light ? "深色" : "浅色";
  elements.themeToggle.setAttribute("aria-label", light ? "切换到深色主题" : "切换到浅色主题");
  elements.themeToggle.setAttribute("aria-pressed", String(light));
}

async function checkHealth() {
  try {
    await api("/health", {}, { silent: true });
    $("#health-dot").classList.add("online");
    $("#health-text").textContent = "Gateway 在线";
  } catch {
    $("#health-text").textContent = "Gateway 离线";
  }
}

async function loadRuntime() {
  state.runtime = await api("/runtime");
  state.selectedPermissionProfile = state.runtime.permission.defaultProfile;
  state.selectedAgentProfileId = state.runtime.agentProfiles?.defaultProfile || state.runtime.agentProfile?.id || "default";
  renderAgentProfileControl();
  renderPermissionControl();
}

async function loadSessions() {
  const { sessions } = await api("/sessions");
  elements.sessionCount.textContent = sessions.length;
  elements.sessionList.replaceChildren(...sessions.map(sessionButton));
}

function sessionButton(session) {
  const button = document.createElement("button");
  button.className = `session-item${session.id === state.sessionId ? " active" : ""}`;
  button.dataset.sessionId = session.id;

  const row = document.createElement("span");
  row.className = "session-name-row";
  const phase = document.createElement("i");
  phase.className = `session-phase ${phaseClass(session.phase)}`;
  const name = document.createElement("strong");
  name.textContent = session.title || "新任务";
  row.append(phase, name);

  const detail = document.createElement("span");
  detail.className = "session-detail";
  detail.textContent = `${phaseLabel(session.phase)} · ${relativeTime(session.updatedAt)}`;
  button.append(row, detail);
  button.addEventListener("click", () => selectSession(session.id));
  return button;
}

async function createSession() {
  const { session } = await api("/sessions", {
    method: "POST",
    body: {
      agentProfileId: state.selectedAgentProfileId,
      permissionProfile: state.selectedPermissionProfile,
      ...(state.selectedPermissionProfile === "danger-full-access" ? { permissionConfirmation: "danger-full-access" } : {}),
    },
  });
  await loadSessions();
  await selectSession(session.id);
  elements.input.focus();
  return session;
}

async function selectSession(id) {
  state.sessionId = id;
  const { session, cursor } = await api(`/sessions/${encodeURIComponent(id)}`);
  state.cursor = cursor;
  renderSession(session);
  connectEvents();
  await Promise.all([loadSessions(), loadGrants()]);
}

function connectEvents() {
  state.source?.close();
  state.source = new EventSource(`/sessions/${encodeURIComponent(state.sessionId)}/events?after=${state.cursor}`);
  state.source.addEventListener("session_event", handleSessionEvent);
  state.source.onerror = () => toast("事件流暂时断开，浏览器将自动重连");
}

async function handleSessionEvent(message) {
  const event = JSON.parse(message.data);
  if (event.cursor <= state.cursor) return;
  if (event.baseline) {
    state.session = event.baseline;
  } else if (event.patch) {
    state.session = applyStatePatch(state.session, event.patch);
  } else {
    const current = await api(`/sessions/${encodeURIComponent(state.sessionId)}`);
    state.session = current.session;
    state.cursor = current.cursor;
    renderSession(state.session);
    return;
  }
  state.cursor = event.cursor;
  renderSession(state.session);
  if (["MEMORY_CANDIDATE_CREATED", "MEMORY_CANDIDATE_APPROVED", "MEMORY_CANDIDATE_REJECTED"].includes(event.type)) {
    await Promise.allSettled([loadCandidates(), loadMemories()]);
  }
  if (["TOOL_GRANT_ISSUED", "TOOL_GRANT_CONSUMED", "TOOL_GRANT_REVOKED", "TOOL_PROJECT_GRANT_ISSUED", "TOOL_PROJECT_GRANT_REVOKED"].includes(event.type)) {
    await loadGrants();
  }
}

function renderSession(session) {
  state.session = session;
  state.selectedPermissionProfile = session.permissionProfile || state.runtime?.permission.defaultProfile || "workspace-auto";
  const title = sessionTitle(session);
  elements.title.textContent = title;
  document.title = `${title} · Nexus`;
  elements.phaseDot.className = `phase-dot ${phaseClass(session.phase)}`;
  renderStatus(session);

  const busy = ["thinking", "executing", "awaiting_approval"].includes(session.phase);
  if (!busy) state.cancelling = false;
  elements.input.disabled = busy;
  renderComposerAction();
  elements.export.disabled = false;
  elements.provider.textContent = session.provider || "本地模型";
  renderPermissionControl();
  setGrantActionAvailability(busy);

  renderMessages(session.messages, session.pendingApproval, session.phase === "failed" ? session.lastError : null, session.events);
  renderObjectivePlan(session.objective, session.plan, session.delegations);
  renderEvents(session.events);
  updateSelectedSession(session, title);
}

function renderStatus(session) {
  const metrics = session.metrics || {};
  const drift = profileDriftViewModel((session.events || []).findLast((event) => event.type === "agent.profile_selected"));
  const parts = [
    [phaseLabel(session.phase), `status-chip phase ${phaseClass(session.phase)}`],
    [agentProfileLabel(session.agentProfile?.id), "status-chip"],
    [session.provider || "本地模型", "status-chip"],
    [permissionLabel(session.permissionProfile), "status-chip"],
    [formatTokens(metrics.totalTokens || 0), "status-chip"],
  ];
  if (drift) parts.push([`配置变化 ${drift.count}`, `status-chip profile-drift${drift.highImpact ? " high" : ""}`, drift.summary]);
  if (metrics.lastTurnDurationMs) parts.push([formatDuration(metrics.lastTurnDurationMs), "status-chip"]);
  elements.meta.replaceChildren(...parts.map(([text, className, titleText]) => {
    const chip = document.createElement("span");
    chip.className = className;
    chip.textContent = text;
    if (titleText) chip.title = titleText;
    if (text === session.provider) {
      const profile = session.agentProfile;
      chip.title = profile
        ? `${session.workspace}\nProfile ${profile.id}@${profile.version.slice(0, 12)}`
        : session.workspace;
    }
    return chip;
  }));
}

function renderAgentProfileControl() {
  const profiles = state.runtime?.agentProfiles?.profiles || [];
  elements.agentProfileSelect.replaceChildren(...profiles.map((profile) => {
    const option = document.createElement("option");
    option.value = profile.id;
    option.textContent = `${profile.label} · ${profile.provider?.model || "当前模型"}`;
    option.title = [profile.description, profile.id, permissionLabel(profile.permissionProfile)].filter(Boolean).join(" · ");
    return option;
  }));
  elements.agentProfileSelect.value = state.selectedAgentProfileId;
  elements.agentProfileSelect.disabled = profiles.length < 2;
}

function chooseAgentProfile() {
  const profile = state.runtime?.agentProfiles?.profiles.find((item) => item.id === elements.agentProfileSelect.value);
  if (!profile) return;
  state.selectedAgentProfileId = profile.id;
  state.selectedPermissionProfile = profile.permissionProfile;
  renderPermissionControl();
  toast(`新任务将使用 ${profile.label}`);
}

function agentProfileLabel(id) {
  return state.runtime?.agentProfiles?.profiles.find((profile) => profile.id === id)?.label || id || "Default";
}

function togglePermissionMenu(event) {
  event.stopPropagation();
  if (!state.runtime || elements.permissionTrigger.disabled) return;
  const opening = elements.permissionMenu.classList.contains("hidden");
  elements.permissionMenu.classList.toggle("hidden", !opening);
  elements.permissionTrigger.setAttribute("aria-expanded", String(opening));
}

function closePermissionMenu() {
  elements.permissionMenu.classList.add("hidden");
  elements.permissionTrigger.setAttribute("aria-expanded", "false");
}

async function choosePermissionMode(event) {
  const option = event.target.closest("[data-profile]");
  if (!option) return;
  const profile = option.dataset.profile;
  const mode = permissionMode(profile);
  if (!mode?.available) {
    toast(mode?.unavailableReason || "该权限档位当前不可用");
    return;
  }
  if (profile === state.selectedPermissionProfile) {
    closePermissionMenu();
    return;
  }
  if (profile === "danger-full-access") {
    openDangerConfirm();
    return;
  }
  await applyPermissionMode(profile);
}

async function applyPermissionMode(profile, { confirmed = false } = {}) {
  const option = elements.permissionMenu.querySelector(`[data-profile="${CSS.escape(profile)}"]`);
  if (!option) return;
  option.disabled = true;
  try {
    if (state.sessionId) {
      const { session } = await api(`/sessions/${encodeURIComponent(state.sessionId)}/permission-profile`, {
        method: "POST",
        body: {
          profile,
          ...(confirmed ? { confirmation: "danger-full-access" } : {}),
        },
      });
      renderSession(session);
    } else {
      state.selectedPermissionProfile = profile;
      renderPermissionControl();
    }
    closePermissionMenu();
    return true;
  } catch {
    // api() 已向用户显示错误；保持原权限档位。
    return false;
  } finally {
    option.disabled = false;
  }
}

function openDangerConfirm() {
  closePermissionMenu();
  elements.dangerConfirm.classList.remove("hidden");
  elements.dangerConfirmBackdrop.classList.remove("hidden");
  requestAnimationFrame(() => elements.dangerConfirmAccept.focus());
}

function closeDangerConfirm() {
  elements.dangerConfirm.classList.add("hidden");
  elements.dangerConfirmBackdrop.classList.add("hidden");
}

async function confirmDangerFullAccess() {
  elements.dangerConfirmAccept.disabled = true;
  try {
    if (await applyPermissionMode("danger-full-access", { confirmed: true })) closeDangerConfirm();
  } finally {
    elements.dangerConfirmAccept.disabled = false;
  }
}

function renderPermissionControl() {
  const profile = state.session?.permissionProfile || state.selectedPermissionProfile;
  const busy = ["thinking", "executing", "awaiting_approval"].includes(state.session?.phase);
  elements.permissionLabel.textContent = permissionLabel(profile);
  elements.permissionTrigger.classList.toggle("dangerous", profile === "danger-full-access");
  elements.permissionTrigger.disabled = !state.runtime || busy;
  elements.permissionMenu.querySelectorAll("[data-profile]").forEach((option) => {
    const mode = permissionMode(option.dataset.profile);
    const selected = option.dataset.profile === profile;
    option.classList.toggle("selected", selected);
    option.classList.toggle("unavailable", !mode?.available);
    option.setAttribute("aria-selected", String(selected));
    option.title = mode?.available ? "" : (mode?.unavailableReason || "当前不可用");
    option.querySelector(".permission-lock")?.classList.toggle("hidden", Boolean(mode?.available));
  });
  if (busy) closePermissionMenu();
}

function permissionMode(profile) {
  return state.runtime?.permission.modes.find((mode) => mode.id === profile) || null;
}

function permissionLabel(profile) {
  return permissionMode(profile)?.label || ({
    "read-only": "只读模式",
    "approval-required": "请求批准",
    "workspace-confirm": "每次确认",
    "workspace-untrusted": "谨慎工作区",
    "workspace-auto": "帮我批准",
    "danger-full-access": "完全访问",
  })[profile] || "权限设置";
}

function updateSelectedSession(session, title) {
  const item = elements.sessionList.querySelector(`[data-session-id="${CSS.escape(session.id)}"]`);
  if (!item) return;
  item.querySelector("strong").textContent = title;
  item.querySelector(".session-phase").className = `session-phase ${phaseClass(session.phase)}`;
  item.querySelector(".session-detail").textContent = `${phaseLabel(session.phase)} · 刚刚`;
}

function renderMessages(messages, pendingApproval, terminalError, events = []) {
  if (!messages.length) {
    elements.messages.replaceChildren(createWelcome());
    return;
  }

  const toolResults = new Map(
    messages
      .filter((message) => message.role === "tool" && message.tool_call_id)
      .map((message) => [message.tool_call_id, message]),
  );
  const fileChanges = new Map(events
    .filter((event) => event.callId && event.fileChanges)
    .map((event) => [event.callId, event.fileChanges]));
  const rendered = [];
  let approvalRendered = false;

  for (const message of messages) {
    if (message.role === "tool") continue;
    const row = document.createElement("article");
    row.className = `message-row ${message.role}`;

    if (message.role === "assistant") {
      const avatar = document.createElement("div");
      avatar.className = "avatar";
      avatar.textContent = "N";
      const body = document.createElement("div");
      body.className = "message-body";
      if (message.content) body.append(renderMarkdown(message.content));
      for (const call of message.tool_calls || []) {
        const normalized = normalizeToolCall(call);
        const pending = pendingApproval?.id === normalized.id ? pendingApproval : null;
        body.append(toolCard(normalized, toolResults.get(normalized.id), pending, fileChanges.get(normalized.id)));
        approvalRendered ||= Boolean(pending);
      }
      row.append(avatar, body);
    } else {
      const bubble = document.createElement("div");
      bubble.className = "user-bubble";
      bubble.textContent = message.content || "";
      row.append(bubble);
    }
    rendered.push(row);
  }

  if (pendingApproval && !approvalRendered) {
    const row = document.createElement("article");
    row.className = "message-row assistant";
    const avatar = document.createElement("div");
    avatar.className = "avatar";
    avatar.textContent = "N";
    const body = document.createElement("div");
    body.className = "message-body";
    body.append(toolCard(pendingApproval, null, pendingApproval));
    row.append(avatar, body);
    rendered.push(row);
  }

  if (terminalError) {
    const alert = document.createElement("div");
    alert.className = "runtime-error";
    const title = document.createElement("strong");
    title.textContent = "任务已停止";
    const detail = document.createElement("span");
    detail.textContent = terminalError;
    alert.append(title, detail);
    rendered.push(alert);
  }

  if (["thinking", "executing"].includes(state.session?.phase)) rendered.push(thinkingIndicator());
  elements.messages.replaceChildren(...rendered);
  requestAnimationFrame(() => { elements.messages.scrollTop = elements.messages.scrollHeight; });
}

function renderObjectivePlan(objective, plan, delegations) {
  const view = objectivePlanViewModel(objective, plan, delegations);
  elements.planPanel.classList.toggle("hidden", !view);
  if (!view) {
    elements.planPanel.replaceChildren();
    return;
  }

  const header = document.createElement("header");
  const heading = document.createElement("div");
  heading.className = "plan-heading";
  const eyebrow = document.createElement("span");
  eyebrow.textContent = "当前目标";
  const title = document.createElement("strong");
  title.textContent = view.objective;
  heading.append(eyebrow, title);

  const status = document.createElement("span");
  status.className = `plan-status ${view.status}`;
  status.textContent = view.statusLabel;
  header.append(heading, status);

  const body = document.createElement("div");
  body.className = "plan-body";
  if (view.explanation) {
    const explanation = document.createElement("p");
    explanation.className = "plan-explanation";
    explanation.textContent = view.explanation;
    body.append(explanation);
  }
  if (view.steps.length) {
    const list = document.createElement("ol");
    list.className = "plan-steps";
    for (const step of view.steps) {
      const item = document.createElement("li");
      item.className = step.status;
      const marker = document.createElement("i");
      marker.textContent = step.marker;
      const text = document.createElement("span");
      text.textContent = step.step;
      item.append(marker, text);
      list.append(item);
    }
    body.append(list);
  }
  if (view.delegations.length) {
    const heading = document.createElement("span");
    heading.className = "delegation-heading";
    heading.textContent = "Child 委派";
    const list = document.createElement("div");
    list.className = "delegation-list";
    for (const delegation of view.delegations) {
      const item = document.createElement("div");
      item.className = `delegation-item ${delegation.status}`;
      const marker = document.createElement("i");
      marker.textContent = delegation.marker;
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = delegation.objective;
      const detail = document.createElement("small");
      detail.textContent = `${delegation.statusLabel} · ${delegation.childSessionId}`;
      copy.append(title, detail);
      item.append(marker, copy);
      list.append(item);
    }
    body.append(heading, list);
  }
  if (view.revision) {
    const revision = document.createElement("span");
    revision.className = "plan-revision";
    revision.textContent = `计划版本 ${view.revision}`;
    body.append(revision);
  }
  const hasPlanDetails = Boolean(view.explanation || view.steps.length || view.delegations.length || view.revision);
  elements.planPanel.replaceChildren(header, ...(hasPlanDetails ? [body] : []));
}

function toolCard(call, result, pending, fileChanges = null) {
  const details = document.createElement("details");
  details.className = `tool-card ${pending ? "approval-needed" : result ? toolResultClass(result.content) : "running"}`;
  details.open = Boolean(pending);

  const summary = document.createElement("summary");
  const icon = document.createElement("span");
  icon.className = "tool-icon";
  icon.textContent = pending ? "!" : result ? (toolResultClass(result.content) === "failed" ? "×" : "✓") : "·";
  const name = document.createElement("span");
  name.className = "tool-name";
  name.textContent = toolLabel(call.name);
  const status = document.createElement("span");
  status.className = "tool-status";
  status.textContent = pending ? "等待批准" : result ? (toolResultClass(result.content) === "failed" ? "未完成" : "已完成") : "运行中";
  const chevron = document.createElement("span");
  chevron.className = "chevron";
  chevron.textContent = "⌄";
  summary.append(icon, name, status, chevron);

  const content = document.createElement("div");
  content.className = "tool-content";
  const args = document.createElement("pre");
  args.textContent = formatToolArguments(call.arguments);
  content.append(args);
  if (result) {
    const outputLabel = document.createElement("span");
    outputLabel.className = "tool-output-label";
    outputLabel.textContent = "输出";
    const output = document.createElement("pre");
    output.textContent = result.content || "工具没有返回内容";
    content.append(outputLabel, output);
    const artifactId = artifactIdFromToolResult(result.content);
    if (artifactId && state.sessionId) {
      const load = document.createElement("button");
      load.type = "button";
      load.className = "artifact-button";
      load.textContent = "加载完整输出";
      load.addEventListener("click", async () => {
        load.disabled = true;
        load.textContent = "加载中…";
        try {
          const payload = await api(`/sessions/${encodeURIComponent(state.sessionId)}/artifacts/${encodeURIComponent(artifactId)}`);
          output.textContent = payload.artifact.content;
          load.textContent = `已加载完整输出 · ${payload.artifact.byteSize} 字节`;
        } catch (error) {
          load.disabled = false;
          load.textContent = `加载失败：${error.message}`;
        }
      });
      content.append(load);
    }
    if (fileChanges) content.append(fileChangePanel(fileChanges));
  }
  if (pending) content.append(approvalActions(pending));
  details.append(summary, content);
  return details;
}

function fileChangePanel(manifest) {
  const panel = document.createElement("section");
  panel.className = "file-change-panel";
  const heading = document.createElement("strong");
  const summary = manifest.summary || { created: 0, modified: 0, deleted: 0, total: 0 };
  heading.textContent = `文件变更 · ${summary.total} 项`;
  const detail = document.createElement("span");
  detail.textContent = `新增 ${summary.created} · 修改 ${summary.modified} · 删除 ${summary.deleted}${manifest.complete ? "" : " · 采集不完整"}`;
  panel.append(heading, detail);

  if (manifest.changes?.length) {
    const list = document.createElement("ul");
    for (const change of manifest.changes.slice(0, 24)) {
      const item = document.createElement("li");
      item.className = change.operation;
      const marker = document.createElement("i");
      marker.textContent = ({ created: "+", modified: "~", deleted: "−" })[change.operation] || "·";
      const path = document.createElement("code");
      path.textContent = change.path;
      item.append(marker, path);
      list.append(item);
    }
    panel.append(list);
  }

  if (manifest.diffArtifact?.id && state.sessionId) {
    const load = document.createElement("button");
    load.type = "button";
    load.className = "artifact-button";
    load.textContent = manifest.diffTruncated ? "加载 Diff（已截断）" : "加载 Diff";
    load.addEventListener("click", async () => {
      load.disabled = true;
      load.textContent = "加载中…";
      try {
        const payload = await api(`/sessions/${encodeURIComponent(state.sessionId)}/artifacts/${encodeURIComponent(manifest.diffArtifact.id)}`);
        const diff = document.createElement("pre");
        diff.className = "file-diff";
        diff.textContent = payload.artifact.content;
        panel.append(diff);
        load.textContent = `已加载 Diff · ${payload.artifact.byteSize} 字节`;
      } catch (error) {
        load.disabled = false;
        load.textContent = `加载失败：${error.message}`;
      }
    });
    panel.append(load);
  }
  return panel;
}

function approvalActions(call) {
  const notice = document.createElement("p");
  notice.className = "approval-copy";
  notice.textContent = call.reason || "此操作需要你的确认后才会在本地执行。";
  const context = document.createElement("p");
  context.className = "approval-copy";
  context.textContent = `权限档位：${call.profile || "未指定"} · 风险：${call.risk || "未分类"} · 规则：${call.ruleId || "未命中"}`;
  const row = document.createElement("div");
  row.className = "approval-actions";
  const scopes = call.approvalScopes || ["once"];
  const approvals = [
    ["once", "仅本次", "只允许当前工具调用，使用后立即失效"],
    ["session", "本会话允许", "相同工具和资源在当前会话中可复用，最长 8 小时"],
    ["project", "本项目允许", "相同工具和资源可跨本项目会话复用，最长 30 天"],
  ].filter(([scope]) => scopes.includes(scope)).map(([scope, label, title]) => {
    const button = document.createElement("button");
    button.className = `approve-button approve-${scope}`;
    button.textContent = label;
    button.title = title;
    return { button, scope };
  });
  const deny = document.createElement("button");
  deny.className = "deny-button";
  deny.textContent = "拒绝";
  const buttons = [...approvals.map(({ button }) => button), deny];
  approvals.forEach(({ button, scope }) => {
    button.addEventListener("click", () => decide(call.id, true, scope, buttons));
  });
  deny.addEventListener("click", () => decide(call.id, false, "once", buttons));
  row.append(...buttons);
  const fragment = document.createDocumentFragment();
  fragment.append(notice, context, row);
  return fragment;
}

function thinkingIndicator() {
  const row = document.createElement("div");
  row.className = "message-row assistant thinking-row";
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = "N";
  const dots = document.createElement("div");
  dots.className = "thinking-dots";
  dots.innerHTML = "<i></i><i></i><i></i>";
  row.append(avatar, dots);
  return row;
}

function renderEvents(events) {
  if (!events.length) {
    const empty = document.createElement("div");
    empty.className = "drawer-empty";
    empty.textContent = "任务开始后，运行事件会显示在这里。";
    elements.events.replaceChildren(empty);
    return;
  }
  elements.events.replaceChildren(...events.slice(-100).reverse().map((event) => {
    const box = document.createElement("div");
    box.className = "event";
    const dot = document.createElement("i");
    const body = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = eventLabel(event.type);
    const detail = document.createElement("span");
    const drift = profileDriftViewModel(event);
    detail.textContent = [drift?.summary || event.tool, new Date(event.at).toLocaleTimeString()].filter(Boolean).join(" · ");
    const raw = document.createElement("code");
    raw.textContent = event.type;
    body.append(title, detail, raw);
    box.append(dot, body);
    return box;
  }));
}

async function useStarter(event) {
  const button = event.target.closest("[data-prompt]");
  if (!button) return;
  if (!state.sessionId) await createSession();
  elements.input.value = button.dataset.prompt;
  elements.input.focus();
}

async function sendMessage(event) {
  event.preventDefault();
  const content = elements.input.value.trim();
  if (!content || !state.sessionId) return;
  elements.input.value = "";
  elements.input.disabled = true;
  elements.composerAction.disabled = true;
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/messages`, {
      method: "POST",
      body: { content },
    });
  } catch {
    elements.input.value = content;
    elements.input.disabled = false;
    renderComposerAction();
  }
}

function handleComposerAction() {
  const action = composerActionState(state.session?.phase, { cancelling: state.cancelling });
  if (action.mode === "stop") {
    void cancelRun();
    return;
  }
  elements.form.requestSubmit();
}

async function decide(callId, approved, scope, buttons) {
  buttons.forEach((button) => { button.disabled = true; });
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/approvals/${encodeURIComponent(callId)}`, {
      method: "POST",
      body: { approved, scope },
    });
  } catch {
    buttons.forEach((button) => { button.disabled = false; });
  }
}

async function cancelRun() {
  const action = composerActionState(state.session?.phase, { cancelling: state.cancelling });
  if (!state.sessionId || action.mode !== "stop" || state.cancelling) return;
  state.cancelling = true;
  renderComposerAction();
  try {
    await api(`/sessions/${encodeURIComponent(state.sessionId)}/cancel`, { method: "POST", body: {} });
  } catch {
    state.cancelling = false;
    renderComposerAction();
  }
}

function renderComposerAction() {
  const action = composerActionState(state.session?.phase, { cancelling: state.cancelling });
  elements.composerAction.textContent = action.symbol;
  elements.composerAction.disabled = !state.sessionId || action.disabled;
  elements.composerAction.setAttribute("aria-label", action.label);
  elements.composerAction.title = action.mode === "stop" ? "停止当前任务（Esc）" : "发送消息（Enter）";
  elements.composerAction.classList.toggle("stop-button", action.mode === "stop");
  elements.composerShortcut.textContent = action.shortcut;
}

function isOverlayOpen() {
  return !elements.dangerConfirm.classList.contains("hidden")
    || elements.inspector.getAttribute("aria-hidden") === "false"
    || !elements.permissionMenu.classList.contains("hidden");
}

async function exportSession() {
  const payload = await api(`/sessions/${encodeURIComponent(state.sessionId)}/export`);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${state.sessionId}.journal.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function loadMemories() {
  const { memories } = await api("/memories");
  if (!memories.length) {
    const empty = document.createElement("div");
    empty.className = "drawer-empty";
    empty.textContent = "还没有长期记忆。";
    elements.memoryList.replaceChildren(empty);
    return;
  }
  elements.memoryList.replaceChildren(...memories.map((memory) => {
    const box = document.createElement("div");
    box.className = "memory";
    const text = document.createElement("p");
    text.textContent = memory.content;
    const remove = document.createElement("button");
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      await api(`/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
      await loadMemories();
    });
    box.append(text, remove);
    return box;
  }));
}

async function loadCandidates() {
  const { candidates } = await api("/memory-candidates");
  if (!candidates.length) {
    const empty = document.createElement("div");
    empty.className = "candidate-empty";
    empty.textContent = "暂无待确认候选。";
    elements.candidateList.replaceChildren(empty);
    return;
  }
  elements.candidateList.replaceChildren(...candidates.map((candidate) => {
    const box = document.createElement("div");
    box.className = "memory candidate";
    const text = document.createElement("p");
    text.textContent = candidate.content;
    const meta = document.createElement("span");
    meta.className = "candidate-meta";
    meta.textContent = `${candidate.kind} · 置信度 ${Math.round((candidate.confidence ?? 0) * 100)}%`;
    const actions = document.createElement("div");
    actions.className = "candidate-actions";
    const approve = document.createElement("button");
    approve.className = "candidate-approve";
    approve.textContent = "保留";
    const reject = document.createElement("button");
    reject.textContent = "忽略";
    const decideCandidate = async (action) => {
      if (!state.sessionId) {
        toast("请先选择一个任务再处理候选记忆");
        return;
      }
      approve.disabled = true;
      reject.disabled = true;
      try {
        await api(`/sessions/${encodeURIComponent(state.sessionId)}/memory-candidates/${encodeURIComponent(candidate.id)}/${action}`, {
          method: "POST",
          body: action === "reject" ? { reason: "用户在 Web UI 中忽略候选" } : {},
        });
        await Promise.all([loadCandidates(), loadMemories()]);
      } catch {
        approve.disabled = false;
        reject.disabled = false;
      }
    };
    approve.addEventListener("click", () => decideCandidate("approve"));
    reject.addEventListener("click", () => decideCandidate("reject"));
    actions.append(approve, reject);
    box.append(text, meta, actions);
    return box;
  }));
}

async function addMemory(event) {
  event.preventDefault();
  const input = $("#memory-input");
  const content = input.value.trim();
  if (!content) return;
  await api("/memories", { method: "POST", body: { content, tags: [] } });
  input.value = "";
  await loadMemories();
}

async function loadGrants() {
  if (!state.sessionId) {
    elements.grantCount.textContent = "0";
    elements.grantSummary.textContent = "选择任务后查看";
    const empty = document.createElement("div");
    empty.className = "drawer-empty";
    empty.textContent = "请先选择一个任务。";
    elements.grantList.replaceChildren(empty);
    return;
  }
  const { grants } = await api(`/sessions/${encodeURIComponent(state.sessionId)}/grants`);
  renderGrants(grants);
}

function renderGrants(grants = {}) {
  const views = [
    ...(grants.session || []).map((grant) => grantViewModel(grant, { scope: grant.scope || (grant.callId || grant.argsHash ? "once" : "session") })),
    ...(grants.project || []).map((grant) => grantViewModel(grant, { scope: "project" })),
  ];
  elements.grantCount.textContent = String(views.length);
  elements.grantSummary.textContent = views.length ? `${views.length} 个有效授权` : "当前没有有效授权";
  if (!views.length) {
    const empty = document.createElement("div");
    empty.className = "drawer-empty grant-empty";
    empty.textContent = "需要审批时可以选择仅本次、本会话或本项目；仅本次授权使用后会立即消失。";
    elements.grantList.replaceChildren(empty);
    return;
  }
  elements.grantList.replaceChildren(...views.map(grantCard));
  setGrantActionAvailability(["thinking", "executing", "awaiting_approval"].includes(state.session?.phase));
}

function grantCard(grant) {
  const box = document.createElement("section");
  box.className = "grant-card";
  const head = document.createElement("div");
  head.className = "grant-head";
  const title = document.createElement("strong");
  title.textContent = toolLabel(grant.tool);
  const scope = document.createElement("span");
  scope.className = `grant-scope scope-${grant.scope}`;
  scope.textContent = grant.scopeLabel;
  head.append(title, scope);

  const resources = document.createElement("ul");
  resources.className = "grant-resources";
  (grant.resources.length ? grant.resources : ["未声明资源"]).forEach((label) => {
    const item = document.createElement("li");
    item.textContent = label;
    resources.append(item);
  });

  const foot = document.createElement("div");
  foot.className = "grant-foot";
  const expiry = document.createElement("span");
  expiry.textContent = grant.expiryLabel;
  if (grant.expiresAt) expiry.title = new Date(grant.expiresAt).toLocaleString();
  const revoke = document.createElement("button");
  revoke.type = "button";
  revoke.dataset.grantAction = "revoke";
  revoke.textContent = "撤销";

  const confirmation = document.createElement("div");
  confirmation.className = "grant-revoke-confirm hidden";
  const copy = document.createElement("span");
  copy.textContent = "撤销后，下次匹配操作会重新请求批准。";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = "取消";
  const confirm = document.createElement("button");
  confirm.type = "button";
  confirm.className = "grant-revoke-danger";
  confirm.dataset.grantAction = "confirm-revoke";
  confirm.textContent = "确认撤销";
  confirmation.append(copy, cancel, confirm);

  revoke.addEventListener("click", () => {
    revoke.classList.add("hidden");
    confirmation.classList.remove("hidden");
    confirm.focus();
  });
  cancel.addEventListener("click", () => {
    confirmation.classList.add("hidden");
    revoke.classList.remove("hidden");
    revoke.focus();
  });
  confirm.addEventListener("click", async () => {
    for (const button of [cancel, confirm]) button.disabled = true;
    try {
      const { grants } = await api(`/sessions/${encodeURIComponent(state.sessionId)}/grants/${encodeURIComponent(grant.id)}/revoke`, {
        method: "POST",
        body: { scope: grant.scope, reason: "用户在 Web UI 中撤销授权" },
      });
      renderGrants(grants);
      toast("授权已撤销；下次匹配操作将重新请求批准");
    } catch {
      for (const button of [cancel, confirm]) button.disabled = false;
    }
  });

  foot.append(expiry, revoke);
  box.append(head, resources, foot, confirmation);
  return box;
}

function setGrantActionAvailability(busy) {
  elements.grantList.querySelectorAll("[data-grant-action]").forEach((button) => {
    button.disabled = busy;
    button.title = busy ? "任务运行期间不能撤销授权" : "";
  });
}

function openInspector() {
  elements.inspector.classList.add("open");
  elements.inspector.setAttribute("aria-hidden", "false");
  elements.debugToggle.setAttribute("aria-expanded", "true");
  elements.backdrop.classList.remove("hidden");
}

function closeInspector() {
  elements.inspector.classList.remove("open");
  elements.inspector.setAttribute("aria-hidden", "true");
  elements.debugToggle.setAttribute("aria-expanded", "false");
  elements.backdrop.classList.add("hidden");
}

function selectTab(name) {
  state.inspectorTab = name;
  document.querySelectorAll(".tab").forEach((tab) => {
    const active = tab.dataset.tab === name;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  $("#events-view").classList.toggle("hidden", name !== "events");
  $("#memory-view").classList.toggle("hidden", name !== "memory");
  $("#grants-view").classList.toggle("hidden", name !== "grants");
  if (name === "grants") void loadGrants();
}

function renderMarkdown(source) {
  const root = document.createElement("div");
  root.className = "markdown";
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
      const pre = document.createElement("pre");
      const code = document.createElement("code");
      if (language) code.dataset.language = language;
      code.textContent = codeLines.join("\n");
      pre.append(code);
      root.append(pre);
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      const node = document.createElement(`h${heading[1].length + 1}`);
      appendInline(node, heading[2]);
      root.append(node);
      index += 1;
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line) || /^\s*\d+[.)]\s+/.test(line)) {
      const ordered = /^\s*\d+[.)]\s+/.test(line);
      const list = document.createElement(ordered ? "ol" : "ul");
      const matcher = ordered ? /^\s*\d+[.)]\s+(.+)$/ : /^\s*[-*+]\s+(.+)$/;
      while (index < lines.length) {
        const match = lines[index].match(matcher);
        if (!match) break;
        const item = document.createElement("li");
        appendInline(item, match[1]);
        list.append(item);
        index += 1;
      }
      root.append(list);
      continue;
    }

    if (/^>\s?/.test(line)) {
      const quote = document.createElement("blockquote");
      const quoteLines = [];
      while (index < lines.length && /^>\s?/.test(lines[index])) quoteLines.push(lines[index++].replace(/^>\s?/, ""));
      appendInline(quote, quoteLines.join(" "));
      root.append(quote);
      continue;
    }

    const paragraph = [];
    while (index < lines.length && lines[index].trim() && !isBlockStart(lines[index])) paragraph.push(lines[index++].trim());
    if (!paragraph.length) paragraph.push(lines[index++]);
    const node = document.createElement("p");
    appendInline(node, paragraph.join(" "));
    root.append(node);
  }
  return root;
}

function appendInline(parent, source) {
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*\n]+\*|_([^_]+)_|\[[^\]]+\]\([^)]+\))/g;
  let cursor = 0;
  for (const match of source.matchAll(pattern)) {
    if (match.index > cursor) parent.append(document.createTextNode(source.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) {
      const code = document.createElement("code");
      code.textContent = token.slice(1, -1);
      parent.append(code);
    } else if (token.startsWith("**") || token.startsWith("__")) {
      const strong = document.createElement("strong");
      strong.textContent = token.slice(2, -2);
      parent.append(strong);
    } else if (token.startsWith("*") || token.startsWith("_")) {
      const em = document.createElement("em");
      em.textContent = token.slice(1, -1);
      parent.append(em);
    } else {
      const parts = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      const link = document.createElement("a");
      link.textContent = parts[1];
      if (safeLink(parts[2])) {
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

function safeLink(value) {
  try {
    return ["http:", "https:"].includes(new URL(value, location.href).protocol);
  } catch {
    return false;
  }
}

function createWelcome() {
  const box = document.createElement("div");
  box.className = "welcome";
  const mark = document.createElement("div");
  mark.className = "welcome-mark";
  mark.textContent = "N";
  const title = document.createElement("h2");
  title.textContent = "开始一个新任务";
  const copy = document.createElement("p");
  copy.textContent = "Nexus 会在本地工作区中读取文件、运行命令并请求必要审批。";
  const starters = document.createElement("div");
  starters.className = "starters";
  [
    ["理解项目", "梳理架构与关键模块", "分析这个项目的结构，并告诉我应该从哪里开始。"],
    ["检查问题", "定位错误与风险", "检查当前项目，找出最值得修复的问题。"],
    ["继续开发", "推进优先级最高的功能", "根据当前项目目标，实现下一个优先级最高的功能。"],
  ].forEach(([label, description, prompt]) => {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.prompt = prompt;
    const strong = document.createElement("strong");
    strong.textContent = label;
    const span = document.createElement("span");
    span.textContent = description;
    button.append(strong, span);
    starters.append(button);
  });
  box.append(mark, title, copy, starters);
  return box;
}

function normalizeToolCall(call) {
  return {
    id: call.id,
    name: call.name || call.function?.name || "unknown",
    arguments: call.arguments ?? call.function?.arguments ?? {},
  };
}

function formatToolArguments(value) {
  if (typeof value === "string") {
    try { return JSON.stringify(JSON.parse(value), null, 2); } catch { return value; }
  }
  return JSON.stringify(value ?? {}, null, 2);
}

function toolResultClass(content) {
  return /失败|拒绝|未知工具|取消|error/i.test(content || "") ? "failed" : "completed";
}

function toolLabel(name) {
  const labels = {
    run_shell: "运行终端命令",
    read_file: "读取文件",
    write_file: "修改文件",
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

function sessionTitle(session) {
  const content = session.messages?.find((message) => message.role === "user")?.content?.trim();
  if (!content) return "新任务";
  const compact = content.replace(/\s+/g, " ");
  return compact.length > 42 ? `${compact.slice(0, 42).trimEnd()}…` : compact;
}

function phaseLabel(phase) {
  return ({ idle: "就绪", thinking: "思考中", executing: "执行中", awaiting_approval: "等待批准", completed: "已完成", failed: "失败", cancelled: "已取消" })[phase] || phase;
}

function phaseClass(phase) {
  if (["thinking", "executing"].includes(phase)) return "running";
  if (phase === "awaiting_approval") return "attention";
  if (phase === "completed") return "completed";
  if (["failed", "cancelled"].includes(phase)) return "failed";
  return "idle";
}

function eventLabel(type) {
  return ({
    "message.user": "收到任务",
    "objective.created": "建立当前目标",
    "objective.completed": "目标完成",
    "objective.failed": "目标失败",
    "objective.cancelled": "目标取消",
    "objective.paused": "暂停旧目标",
    "plan.updated": "更新任务计划",
    "agent.transfer_requested": "创建 Child 委派",
    "agent.transfer_completed": "Child 委派完成",
    "agent.transfer_failed": "Child 委派失败",
    "agent.transfer_cancelled": "Child 委派取消",
    "agent.transfer_interrupted": "Child 委派中断",
    "agent.transfer_approval_requested": "Child 请求 Parent 审批",
    "agent.transfer_approval_granted": "Parent 批准 Child 操作",
    "agent.transfer_approval_denied": "Parent 拒绝 Child 操作",
    "session.delegated": "创建 Child Session",
    "agent.profile_selected": "选择 Agent Profile",
    "message.assistant": "Agent 回复",
    "model.requested": "请求模型",
    "model.completed": "模型返回",
    "model.context_prepared": "准备上下文",
    "model.context_compacted": "压缩上下文",
    "memory.context_loaded": "加载相关记忆",
    "memory.added": "保存会话记忆",
    "memory.flush_requested": "提取记忆候选",
    "memory.flush_completed": "候选提取完成",
    "memory.flush_degraded": "候选提取降级",
    "memory.candidate_created": "创建记忆候选",
    "memory.candidate_approved": "保留记忆候选",
    "memory.candidate_rejected": "忽略记忆候选",
    "tool.requested": "请求工具",
    "tool.validation_failed": "工具参数无效",
    "tool.authorization_decided": "工具策略决策",
    "tool.execution_started": "开始执行工具",
    "tool.execution_unknown": "工具结果未知",
    "tool.completed": "工具完成",
    "tool.file_changes_inherited": "继承文件变更",
    "approval.requested": "等待审批",
    "approval.granted": "审批通过",
    "approval.denied": "审批拒绝",
    "approval.stale": "审批已失效",
    "tool.grant_issued": "签发会话授权",
    "tool.grant_consumed": "消费单次授权",
    "tool.grant_revoked": "撤销会话授权",
    "tool.project_grant_issued": "签发项目授权",
    "tool.project_grant_revoked": "撤销项目授权",
    "permission.profile_changed": "切换权限档位",
    "permission.profile_downgraded": "安全降级权限档位",
    "session.turn_completed": "任务完成",
    "session.failed": "任务失败",
    "session.cancelled": "任务取消",
    "session.resumed": "恢复任务",
  })[type] || type;
}

function relativeTime(value) {
  const elapsed = Math.max(0, Date.now() - new Date(value).getTime());
  if (elapsed < 60_000) return "刚刚";
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)} 分钟前`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)} 小时前`;
  return new Date(value).toLocaleDateString();
}

function formatTokens(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(value >= 10_000 ? 0 : 1)}k tokens` : `${value} tokens`;
}

function formatDuration(value) {
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`;
}

async function api(url, options = {}, { silent = false } = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (options.body !== undefined) {
    init.headers["content-type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  let response;
  try {
    response = await fetch(url, init);
  } catch (error) {
    if (!silent) toast("无法连接本地 Gateway");
    throw error;
  }
  const payload = await response.json();
  if (!response.ok) {
    if (!silent) toast(payload.error || `请求失败 ${response.status}`);
    throw new Error(payload.error);
  }
  return payload;
}

let toastTimer;
function toast(message) {
  const box = $("#toast");
  box.textContent = message;
  box.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add("hidden"), 3000);
}
