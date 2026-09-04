import { createComposer } from "/composer.js";
import { createProjectPicker } from "/project-picker.js";
import { grantViewModel } from "/grants.js";
import { objectivePlanViewModel } from "/plan-view.js";
import { profileDriftViewModel, providerThinkingLabel } from "/profile-view.js";
import { contextObservabilityViewModel } from "/context-view.js";
import { createSessionProjection } from "/session-projection.js";
import { createTaskNavigation } from "/task-navigation.js";
import { createInspectorShell } from "/inspector-shell.js";
import { createReviewWorkspace } from "/review-workspace.js";
import { createTaskThread } from "/task-thread.js";

const $ = (selector) => document.querySelector(selector);
const state = {
  runtime: null,
  selectedAgentProfileId: "default",
  selectedPermissionProfile: "workspace-auto",
  inspectorTab: "overview",
  editingTitle: false,
  journalEvents: [],
  journalDirty: true,
  sessionProjects: new Map(),
  lastProjectId: null,
};
let runtimeLoadVersion = 0;
let sessionSelectionVersion = 0;

const elements = {
  sessionList: $("#session-list"),
  sessionCount: $("#session-count"),
  messages: $("#messages"),
  planPanel: $("#plan-panel"),
  events: $("#events"),
  journalSummary: $("#journal-summary"),
  contextPanel: $("#context-panel"),
  executionOverviewPanel: $("#execution-overview-panel"),
  fileChangesOverviewPanel: $("#file-changes-overview-panel"),
  evaluationPanel: $("#evaluation-panel"),
  title: $("#session-title"),
  titleForm: $("#title-form"),
  titleInput: $("#title-input"),
  renameSession: $("#rename-session"),
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
  reviewToggle: $("#review-toggle"),
  reviewCount: $("#review-count"),
  themeToggle: $("#theme-toggle"),
  permissionTrigger: $("#permission-trigger"),
  permissionLabel: $("#permission-label"),
  permissionMenu: $("#permission-menu"),
  dangerConfirm: $("#danger-confirm"),
  dangerConfirmBackdrop: $("#danger-confirm-backdrop"),
  dangerConfirmAccept: $("#danger-confirm-accept"),
  agentProfileSelect: $("#agent-profile-select"),
  inspectorTitle: $("#inspector-title"),
};

const taskNavigation = createTaskNavigation({
  sidebar: $("#task-sidebar"),
  toggle: $("#mobile-nav-toggle"),
  backdrop: $("#task-nav-backdrop"),
  media: window.matchMedia("(max-width: 760px)"),
});
const inspectorShell = createInspectorShell({
  root: elements.inspector,
  toggle: elements.debugToggle,
  backdrop: elements.backdrop,
  closeButton: $("#debug-close"),
  tabs: {
    overview: $("#overview-tab"),
    files: $("#files-tab"),
    context: $("#context-tab"),
    more: $("#more-tab"),
  },
  views: {
    overview: $("#overview-view"),
    files: $("#files-view"),
    context: $("#context-view"),
    more: $("#more-view"),
  },
  defaultView: "overview",
  media: window.matchMedia("(min-width: 1180px)"),
  onBeforeOpen: (view) => {
    taskNavigation.close();
    prepareInspectorView(view);
  },
  onViewSelected: handleInspectorViewSelected,
});
$("#mobile-nav-toggle").addEventListener("click", () => inspectorShell.close());

const sessionProjection = createSessionProjection({
  readSession: (id) => api(`/sessions/${encodeURIComponent(id)}`),
  eventSourceFactory: (url) => new EventSource(url),
  onChange: ({ session }) => renderSession(session),
  onEvent: handleSessionEvent,
  onDisconnect: (error) => toast(error.message),
});
const composer = createComposer({
  form: elements.form,
  input: elements.input,
  action: elements.composerAction,
  shortcut: elements.composerShortcut,
  provider: elements.provider,
  eventRoot: document,
  sendMessage: ({ sessionId, content }) => api(`/sessions/${encodeURIComponent(sessionId)}/messages`, {
    method: "POST",
    body: { content },
  }),
  cancelRun: ({ sessionId }) => api(`/sessions/${encodeURIComponent(sessionId)}/cancel`, {
    method: "POST",
    body: {},
  }),
  isOverlayOpen,
});
const projectPicker = createProjectPicker({
  dialog: $("#project-dialog"),
  form: $("#project-form"),
  projectSelect: $("#project-select"),
  createToggle: $("#project-create-toggle"),
  createFields: $("#project-create-fields"),
  nameInput: $("#project-name"),
  cancelButton: $("#project-cancel"),
  submitButton: $("#project-submit"),
  errorNode: $("#project-error"),
  loadProjects: () => api("/projects"),
  createProject: ({ name }) => api("/projects", { method: "POST", body: { name } }),
  createSession: ({ projectId }) => createProjectSession(projectId),
});
const reviewWorkspace = createReviewWorkspace({
  root: $("#review-workspace"),
  loadArtifact: async ({ sessionId, artifactId }) => {
    const response = await sessionProjection.query(`review-diff:${artifactId}`, (selectedSessionId, { signal }) => {
      if (selectedSessionId !== sessionId) throw new Error("Diff 不属于当前 Agent Session");
      return api(
        `/sessions/${encodeURIComponent(selectedSessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { signal },
        { silent: true },
      );
    });
    if (!response || response.sessionId !== sessionId) throw new Error("Diff 请求已过期");
    return response.value;
  },
});
const taskThread = createTaskThread({
  root: elements.messages,
  requestApproval: ({ sessionId, callId, approved, scope, signal }) => {
    if (sessionProjection.sessionId !== sessionId) throw new Error("审批所属任务已切换");
    return api(`/sessions/${encodeURIComponent(sessionId)}/approvals/${encodeURIComponent(callId)}`, {
      method: "POST",
      body: { approved, scope },
      signal,
    });
  },
  loadArtifact: async ({ sessionId, artifactId, signal }) => {
    const response = await sessionProjection.query(`thread-artifact:${artifactId}`, (selectedSessionId, { signal: querySignal }) => {
      if (selectedSessionId !== sessionId) throw new Error("Artifact 不属于当前 Agent Session");
      const requestSignal = typeof AbortSignal.any === "function"
        ? AbortSignal.any([signal, querySignal])
        : querySignal;
      return api(
        `/sessions/${encodeURIComponent(selectedSessionId)}/artifacts/${encodeURIComponent(artifactId)}`,
        { signal: requestSignal },
        { silent: true },
      );
    });
    if (!response || response.sessionId !== sessionId) throw new Error("Artifact 请求已过期");
    return response.value;
  },
  openReview: ({ sessionId, ...target }) => {
    if (sessionProjection.sessionId !== sessionId) return;
    openReview(target);
  },
  useStarter: async ({ sessionId, prompt }) => {
    if (sessionId === null) {
      if (sessionProjection.sessionId) return;
      const session = await createSession();
      if (!session) return;
    } else if (sessionProjection.sessionId !== sessionId) {
      return;
    }
    composer.setDraft(prompt, { focus: true });
  },
});
window.addEventListener("beforeunload", () => {
  composer.destroy();
  projectPicker.destroy();
  taskThread.destroy();
  sessionProjection.close();
  reviewWorkspace.destroy();
  taskNavigation.destroy();
  inspectorShell.destroy();
}, { once: true });

applyTheme(savedTheme());
$("#new-session").addEventListener("click", () => {
  void createSession().catch((error) => toast(error.message || "无法创建任务"));
});
let evaluationTimer = null;
elements.export.addEventListener("click", exportSession);
elements.themeToggle.addEventListener("click", toggleTheme);
elements.reviewToggle.addEventListener("click", () => openReview());
elements.permissionTrigger.addEventListener("click", togglePermissionMenu);
elements.permissionMenu.addEventListener("click", choosePermissionMode);
elements.agentProfileSelect.addEventListener("change", chooseAgentProfile);
elements.renameSession.addEventListener("click", openTitleEditor);
elements.titleForm.addEventListener("submit", saveDisplayTitle);
$("#title-cancel").addEventListener("click", closeTitleEditor);
elements.dangerConfirmAccept.addEventListener("click", confirmDangerFullAccess);
$("#danger-confirm-cancel").addEventListener("click", closeDangerConfirm);
elements.dangerConfirmBackdrop.addEventListener("click", closeDangerConfirm);
$("#memory-form").addEventListener("submit", addMemory);
$("#memory-section").addEventListener("toggle", handleInspectorSectionToggle);
$("#grants-section").addEventListener("toggle", handleInspectorSectionToggle);
$("#journal-section").addEventListener("toggle", handleInspectorSectionToggle);
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented) return;
  if (event.key === "Escape") {
    closeTitleEditor();
    inspectorShell.close();
    closePermissionMenu();
    closeDangerConfirm();
  }
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".permission-selector")) closePermissionMenu();
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

async function loadRuntime(projectId = null, { preserveSelection = false, selectionTicket = null } = {}) {
  const requestVersion = ++runtimeLoadVersion;
  const previousAgentProfileId = state.selectedAgentProfileId;
  const previousPermissionProfile = state.selectedPermissionProfile;
  const runtime = await api(projectId
    ? `/projects/${encodeURIComponent(projectId)}/runtime`
    : "/runtime");
  if (requestVersion !== runtimeLoadVersion
    || (selectionTicket !== null && selectionTicket !== sessionSelectionVersion)) return null;
  state.runtime = runtime;
  const profiles = runtime.agentProfiles?.profiles || [];
  state.selectedAgentProfileId = preserveSelection && profiles.some((profile) => profile.id === previousAgentProfileId)
    ? previousAgentProfileId
    : runtime.agentProfiles?.defaultProfile || runtime.agentProfile?.id || "default";
  const modes = runtime.permission?.modes || [];
  state.selectedPermissionProfile = preserveSelection && modes.some((mode) => mode.id === previousPermissionProfile && mode.available)
    ? previousPermissionProfile
    : profiles.find((profile) => profile.id === state.selectedAgentProfileId)?.permissionProfile
      || runtime.permission.defaultProfile;
  renderAgentProfileControl();
  renderPermissionControl();
  return runtime;
}

async function loadSessions() {
  const { sessions } = await api("/sessions");
  state.sessionProjects = new Map(sessions
    .filter((session) => session.project?.id)
    .map((session) => [session.id, session.project.id]));
  elements.sessionCount.textContent = sessions.length;
  elements.sessionList.replaceChildren(...sessions.map(sessionButton));
}

function sessionButton(session) {
  const button = document.createElement("button");
  button.className = `session-item${session.id === sessionProjection.sessionId ? " active" : ""}`;
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
  detail.textContent = `${session.project?.name || "本地项目"} · ${phaseLabel(session.phase)} · ${relativeTime(session.updatedAt)}`;
  button.append(row, detail);
  button.addEventListener("click", () => {
    void selectSession(session.id).catch((error) => toast(error.message || "无法打开任务"));
  });
  return button;
}

async function createSession() {
  taskNavigation.close();
  return projectPicker.open({ preferredProjectId: state.lastProjectId });
}

async function createProjectSession(projectId) {
  const runtime = await loadRuntime(projectId, { preserveSelection: true });
  if (!runtime) return null;
  const { session } = await api("/sessions", {
    method: "POST",
    body: {
      projectId,
      agentProfileId: state.selectedAgentProfileId,
      permissionProfile: state.selectedPermissionProfile,
      ...(state.selectedPermissionProfile === "danger-full-access" ? { permissionConfirmation: "danger-full-access" } : {}),
    },
  });
  await loadSessions();
  await selectSession(session.id);
  composer.focus();
  return session;
}

async function selectSession(id) {
  const selectionTicket = ++sessionSelectionVersion;
  const previousSessionId = sessionProjection.sessionId;
  // Invalidate an older baseline request immediately. Without this, a slow
  // Project runtime lookup for A can start select(A) after a later click on B.
  sessionProjection.close();
  taskNavigation.close();
  closeTitleEditor();
  const projectId = state.sessionProjects.get(id);
  try {
    if (projectId && state.runtime?.project?.id !== projectId) {
      const runtime = await loadRuntime(projectId, { selectionTicket });
      if (!runtime || selectionTicket !== sessionSelectionVersion) return null;
    }
    if (selectionTicket !== sessionSelectionVersion) return null;
    const selected = await sessionProjection.select(id);
    if (!selected || selectionTicket !== sessionSelectionVersion) return null;
    await Promise.allSettled([
      loadSessions(),
      loadGrants(),
      loadMemories(),
      loadCandidates(),
      ...(state.inspectorTab === "overview" && inspectorShell.isOpen() ? [loadEvaluation()] : []),
    ]);
    return selected;
  } catch (error) {
    if (selectionTicket !== sessionSelectionVersion) return null;
    if (selectionTicket === sessionSelectionVersion
      && previousSessionId
      && sessionProjection.sessionId === previousSessionId) {
      void sessionProjection.refresh().catch(() => {});
    }
    throw error;
  }
}

async function handleSessionEvent(event) {
  if (event.type === "SESSION_DISPLAY_TITLE_CHANGED") await loadSessions();
  if (["MEMORY_CANDIDATE_CREATED", "MEMORY_CANDIDATE_APPROVED", "MEMORY_CANDIDATE_REJECTED"].includes(event.type)) {
    await Promise.allSettled([loadCandidates(), loadMemories()]);
  }
  if (["TOOL_GRANT_ISSUED", "TOOL_GRANT_CONSUMED", "TOOL_GRANT_REVOKED", "TOOL_PROJECT_GRANT_ISSUED", "TOOL_PROJECT_GRANT_REVOKED"].includes(event.type)) {
    await Promise.allSettled([loadGrants()]);
  }
  if (state.inspectorTab === "overview" && inspectorShell.isOpen()) scheduleEvaluation();
}

function renderSession(session) {
  state.lastProjectId = session.project?.id || state.lastProjectId;
  state.selectedPermissionProfile = session.permissionProfile || state.runtime?.permission.defaultProfile || "workspace-auto";
  const title = session.displayTitle || "新任务";
  elements.title.textContent = title;
  document.title = `${title} · Nexus`;
  elements.phaseDot.className = `phase-dot ${phaseClass(session.phase)}`;
  elements.inspectorTitle.textContent = session.project?.name || "本地工作区";
  renderStatus(session);

  const busy = ["thinking", "executing", "awaiting_approval"].includes(session.phase);
  composer.update({
    sessionId: session.id,
    phase: session.phase,
    provider: session.provider || "本地模型",
    userTurnCount: (session.messages || []).reduce(
      (count, message) => count + Number(message.role === "user"),
      0,
    ),
  });
  elements.export.disabled = false;
  elements.renameSession.disabled = false;
  renderPermissionControl();
  setGrantActionAvailability(busy);

  const { executionProjection } = taskThread.update({
    session,
    cursor: sessionProjection.cursor,
  });
  const reviewState = reviewWorkspace.update({
    sessionId: session.id,
    cursor: sessionProjection.cursor,
    executionProjection,
  });
  renderReviewControl(reviewState);
  renderObjectivePlan(session.objective, session.plan, session.delegations);
  renderContextObservability(session);
  stageJournal(session.events);
  const latestExecution = executionProjection.turns.at(-1)?.execution || null;
  renderExecutionOverview(latestExecution, session);
  renderFileChangeOverview(latestExecution?.fileChanges || null, latestExecution?.turnKey || null);
  updateSelectedSession(session, title);
}

function renderStatus(session) {
  const parts = [
    [phaseLabel(session.phase), `status-chip phase ${phaseClass(session.phase)}`],
    [session.project?.name || "本地项目", "status-chip"],
    [agentProfileLabel(session.agentProfile?.id), "status-chip"],
    [session.provider || "本地模型", "status-chip"],
    [permissionLabel(session.permissionProfile), "status-chip"],
  ];
  elements.meta.replaceChildren(...parts.map(([text, className, titleText]) => {
    const chip = document.createElement("span");
    chip.className = className;
    chip.textContent = text;
    if (titleText) chip.title = titleText;
    if (text === session.provider) {
      const profile = session.agentProfile;
      chip.title = profile
        ? `${session.workspace}\nProfile ${profile.id}@${profile.version.slice(0, 12)}\n${providerThinkingLabel(profile.provider?.thinking)}`
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
    option.textContent = `${profile.label} · ${profile.provider?.model || "当前模型"} · ${providerThinkingLabel(profile.provider?.thinking)}`;
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
    if (sessionProjection.sessionId) {
      await api(`/sessions/${encodeURIComponent(sessionProjection.sessionId)}/permission-profile`, {
        method: "POST",
        body: {
          profile,
          ...(confirmed ? { confirmation: "danger-full-access" } : {}),
        },
      });
      await sessionProjection.refresh();
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
  const profile = sessionProjection.permissionProfile || state.selectedPermissionProfile;
  const busy = ["thinking", "executing", "awaiting_approval"].includes(sessionProjection.phase);
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

function openTitleEditor() {
  if (!sessionProjection.sessionId) return;
  state.editingTitle = true;
  elements.titleInput.value = elements.title.textContent === "新任务" ? "" : elements.title.textContent;
  elements.titleForm.classList.remove("hidden");
  elements.renameSession.classList.add("hidden");
  requestAnimationFrame(() => elements.titleInput.select());
}

function closeTitleEditor() {
  if (!state.editingTitle) return;
  state.editingTitle = false;
  elements.titleForm.classList.add("hidden");
  elements.renameSession.classList.remove("hidden");
}

async function saveDisplayTitle(event) {
  event.preventDefault();
  if (!sessionProjection.sessionId) return;
  const sessionId = sessionProjection.sessionId;
  const buttons = elements.titleForm.querySelectorAll("button");
  buttons.forEach((button) => { button.disabled = true; });
  try {
    const { session } = await api(`/sessions/${encodeURIComponent(sessionId)}/display-title`, {
      method: "POST",
      body: { title: elements.titleInput.value.trim() || null },
    });
    if (sessionProjection.sessionId === sessionId) renderSession(session);
    await loadSessions();
    closeTitleEditor();
    toast("任务名称已更新");
  } finally {
    buttons.forEach((button) => { button.disabled = false; });
  }
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

function renderContextObservability(session) {
  const view = contextObservabilityViewModel(session);
  if (!view) {
    const empty = document.createElement("div");
    empty.className = "drawer-empty";
    empty.textContent = "模型完成第一次请求后，这里会显示 Context 估算目标和压缩状态。";
    elements.contextPanel.replaceChildren(empty);
    return;
  }

  const overview = document.createElement("section");
  overview.className = "context-card context-overview";
  const head = contextCardHeading(
    "本次模型上下文",
    view.plan?.statusLabel || "等待规划",
    view.plan?.compacted || view.usage.overTarget ? "warning" : "normal",
  );
  const tokenLine = document.createElement("div");
  tokenLine.className = "context-token-line";
  const tokenValue = document.createElement("strong");
  tokenValue.textContent = `${formatTokens(view.usage.estimatedTokens)} / ${view.usage.maxTokens ? formatTokens(view.usage.maxTokens) : "未设置"}`;
  const tokenPercent = document.createElement("span");
  tokenPercent.textContent = view.usage.maxTokens ? `${view.usage.percent}%` : "无估算目标";
  tokenLine.append(tokenValue, tokenPercent);
  const meter = document.createElement("div");
  meter.className = `context-meter ${view.usage.level}`;
  const fill = document.createElement("i");
  fill.style.width = `${view.usage.meterPercent}%`;
  meter.append(fill);
  const tokenDetail = document.createElement("p");
  tokenDetail.className = "context-card-detail";
  tokenDetail.textContent = `固定 ${formatTokens(view.usage.fixedTokens)} · 消息 ${formatTokens(view.usage.messageTokens)} · ${view.plan?.strategyLabel || "尚无策略"}`;
  overview.append(head, tokenLine, meter, tokenDetail);

  const history = document.createElement("section");
  history.className = "context-card";
  const toolProjection = view.history.toolProjection;
  const activeToolProjection = view.history.activeToolProjection;
  history.append(
    contextCardHeading("历史窗口", view.history.omittedMessages ? `省略 ${view.history.omittedMessages} 条` : "未省略", view.history.omittedMessages ? "warning" : "normal"),
    contextMetrics([
      ["纳入消息", String(view.history.includedMessages), `${view.history.includedTurns} 个完整轮次`],
      ["省略消息", String(view.history.omittedMessages), `${view.history.omittedTurns} 个完整轮次`],
      [
        "工具历史",
        toolProjection.applied
          ? `${toolProjection.compactedToolCalls + toolProjection.compactedToolResults} 项精简`
          : "保持原样",
        toolProjection.applied
          ? `节省 ${formatTokens(toolProjection.savedTokens)} tokens`
          : `${toolProjection.eligibleTurns} 个历史轮次可投影`,
      ],
      [
        "本轮工具",
        activeToolProjection.applied
          ? `${activeToolProjection.compactedRounds} 轮精简`
          : "保持原样",
        activeToolProjection.applied
          ? `节省 ${formatTokens(activeToolProjection.savedTokens)} tokens · 最近 ${activeToolProjection.preservedRounds} 轮完整`
          : `最近 ${activeToolProjection.preservedRounds} 轮完整`,
      ],
    ]),
  );

  const memory = document.createElement("section");
  memory.className = "context-card";
  memory.append(
    contextCardHeading("长期记忆", `${view.memory.pinned.included + view.memory.relevant.included} 条命中`, "normal"),
    contextMemoryRow("固定记忆", view.memory.pinned),
    contextMemoryRow("相关记忆", view.memory.relevant),
  );

  const summary = document.createElement("section");
  summary.className = "context-card";
  summary.append(contextCardHeading("滚动摘要", view.summary.statusLabel, view.summary.degraded ? "danger" : view.summary.included ? "normal" : "muted"));
  const summaryDetail = document.createElement("p");
  summaryDetail.className = "context-card-detail";
  summaryDetail.textContent = view.summary.available
    ? `revision ${view.summary.revision} · 覆盖到消息 ${view.summary.throughMessage}${view.summary.sourceComplete === false ? " · 来源不完整" : ""}`
    : "仅在历史需要压缩时生成；摘要正文不会显示在此面板。";
  summary.append(summaryDetail);

  const cards = [overview, history, memory, summary];
  if (view.replan) {
    const replan = document.createElement("section");
    replan.className = `context-card context-replan ${view.replan.level}`;
    replan.append(contextCardHeading("Context 超限处理", view.replan.statusLabel, view.replan.level));
    const detail = document.createElement("p");
    detail.className = "context-card-detail";
    detail.textContent = view.replan.status === "replanned"
      ? `压缩目标 ${formatTokens(view.replan.fromMaxInputTokens)} → ${formatTokens(view.replan.toMaxInputTokens)}；新增省略 ${view.replan.omittedMessages} 条消息。`
      : view.replan.status === "exhausted"
        ? `当前压缩目标 ${formatTokens(view.replan.maxInputTokens)}${view.replan.contextLimit ? `；Provider 上限 ${formatTokens(view.replan.contextLimit)}` : ""}。`
        : `压缩目标 ${formatTokens(view.replan.fromMaxInputTokens)} → ${formatTokens(view.replan.toMaxInputTokens)}。`;
    replan.append(detail);
    cards.push(replan);
  }

  const identity = document.createElement("div");
  identity.className = "context-identity";
  identity.textContent = [
    view.identity.contextHashShort ? `Context ${view.identity.contextHashShort}` : null,
    view.identity.estimatorVersion,
    view.plan?.at ? new Date(view.plan.at).toLocaleTimeString() : null,
  ].filter(Boolean).join(" · ");
  cards.push(identity);
  elements.contextPanel.replaceChildren(...cards);
}

function renderExecutionOverview(execution, session) {
  if (!execution) {
    const empty = document.createElement("div");
    empty.className = "drawer-empty";
    empty.textContent = "任务开始后，这里会显示当前 Turn 的执行摘要。";
    elements.executionOverviewPanel.replaceChildren(empty);
    return;
  }
  const card = document.createElement("section");
  card.className = `context-card execution-overview-card ${execution.status}`;
  card.append(
    contextCardHeading("当前 Turn", executionStatusLabel(execution.status), executionStatusLevel(execution.status)),
    evaluationMetrics([
      ["工具", String(execution.counts.total), executionRunDetail(execution)],
      ["模型请求", String(execution.model.requests), execution.model.streaming ? "正在生成" : `${execution.model.completed} 次完成`],
      ["总耗时", execution.durationMs === null ? "—" : formatDuration(execution.durationMs), execution.durationMs === null ? "运行结束后记录" : "由 Journal 记录"],
      ["文件", String(execution.fileChanges.uniquePaths), execution.fileChanges.complete ? `${execution.fileChanges.operations} 次变化` : "变化采集不完整"],
    ]),
  );
  if (execution.recovery) {
    const recovery = document.createElement("p");
    recovery.className = "execution-recovery";
    recovery.textContent = execution.recovery.toolExecutionUnknown
      ? "Gateway 已恢复；中断前存在未闭合工具执行，结果已标记为未知。"
      : execution.recovery.interrupted
        ? `Gateway 已恢复；上次 Turn 在 ${execution.recovery.interruptedFromPhase || "运行中"} 阶段中断，未标记为完成。`
      : `Gateway 已从 ${execution.recovery.previousPhase || "上次状态"} 恢复。`;
    card.append(recovery);
  }
  const drift = profileDriftViewModel((session?.events || []).findLast((event) => event.type === "agent.profile_selected"));
  if (drift) {
    const notice = document.createElement("p");
    notice.className = `execution-drift${drift.highImpact ? " high" : ""}`;
    notice.textContent = `配置变化 ${drift.count} 项 · ${drift.summary}`;
    card.append(notice);
  }
  elements.executionOverviewPanel.replaceChildren(card);
}

function renderReviewControl(reviewState) {
  const summary = reviewState?.projection?.summary || { batches: 0, occurrences: 0 };
  const available = summary.batches > 0;
  elements.reviewToggle.disabled = !available;
  elements.reviewToggle.textContent = available ? `审查 ${summary.occurrences}` : "审查";
  elements.reviewToggle.title = available
    ? `打开文件审查，共 ${summary.occurrences} 项变化`
    : "当前任务还没有可审查的文件变化";
  elements.reviewToggle.setAttribute("aria-label", elements.reviewToggle.title);
  elements.reviewCount.textContent = String(summary.occurrences);
}

function openReview(target = null) {
  const snapshot = reviewWorkspace.snapshot();
  if (!snapshot.projection.batches.length) {
    toast("当前任务还没有可审查的文件变化");
    return;
  }
  try {
    if (target) reviewWorkspace.select(target);
    inspectorShell.open("files");
  } catch (error) {
    toast(error.message);
  }
}

function renderFileChangeOverview(fileChanges, turnKey) {
  const entries = fileChanges?.entries || [];
  if (!entries.length) {
    elements.fileChangesOverviewPanel.replaceChildren();
    return;
  }
  const section = document.createElement("section");
  section.className = "inspector-file-changes";
  const heading = document.createElement("header");
  const title = document.createElement("strong");
  title.textContent = "本轮文件变化";
  const count = document.createElement("span");
  count.textContent = `${fileChanges.uniquePaths} 个文件`;
  heading.append(title, count);
  section.append(
    heading,
    ...entries.map((entry) => fileChangePanel(entry.manifest, {
      turnKey,
      runKey: entry.runKey,
    })),
  );
  elements.fileChangesOverviewPanel.replaceChildren(section);
}

function executionRunDetail(execution) {
  return [
    execution.counts.succeeded ? `${execution.counts.succeeded} 成功` : null,
    execution.counts.failed ? `${execution.counts.failed} 失败` : null,
    execution.counts.blocked ? `${execution.counts.blocked} 阻止` : null,
    execution.counts.unknown ? `${execution.counts.unknown} 未知` : null,
    execution.counts.inherited ? `${execution.counts.inherited} 继承记录` : null,
    execution.counts.awaitingApproval ? `${execution.counts.awaitingApproval} 待批准` : null,
    execution.counts.running ? `${execution.counts.running} 运行中` : null,
  ].filter(Boolean).join(" · ") || "没有工具调用";
}

function executionStatusLabel(status) {
  return ({
    idle: "等待执行",
    running: "运行中",
    awaiting_approval: "等待批准",
    completed: "已完成",
    attention: "需要留意",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
    unknown: "结果未知",
    inherited: "继承记录",
  })[status] || status;
}

function executionStatusLevel(status) {
  if (["failed", "unknown"].includes(status)) return "danger";
  if (["attention", "awaiting_approval", "cancelled", "interrupted"].includes(status)) return "warning";
  if (["idle", "inherited"].includes(status)) return "muted";
  return "normal";
}

async function loadEvaluation() {
  if (!sessionProjection.sessionId) {
    const empty = document.createElement("div");
    empty.className = "drawer-empty";
    empty.textContent = "请先选择一个任务。";
    elements.evaluationPanel.replaceChildren(empty);
    return;
  }
  try {
    const current = await sessionProjection.query("evaluation", (sessionId, { signal }) => (
      api(`/sessions/${encodeURIComponent(sessionId)}/evaluation`, { signal }, { silent: true })
    ));
    if (!current) return;
    const { evaluation } = current.value;
    if (current.sessionId !== evaluation.sessionId) return;
    renderEvaluation(evaluation);
  } catch {
    const failed = document.createElement("div");
    failed.className = "drawer-empty";
    failed.textContent = "诊断报告暂时不可用。";
    elements.evaluationPanel.replaceChildren(failed);
  }
}

function scheduleEvaluation() {
  clearTimeout(evaluationTimer);
  evaluationTimer = setTimeout(() => void loadEvaluation(), 120);
}

function renderEvaluation(report) {
  const overview = document.createElement("section");
  overview.className = `evaluation-card evaluation-overview ${report.status}`;
  const head = contextCardHeading("任务健康报告", evaluationStatusLabel(report.status), evaluationStatusLevel(report.status));
  const summary = document.createElement("p");
  summary.className = "evaluation-summary";
  summary.textContent = `基于 ${report.cursor} 个 durable events · ${report.version}`;
  overview.append(head, summary);

  const metrics = document.createElement("section");
  metrics.className = "evaluation-card";
  metrics.append(
    contextCardHeading("运行概况", report.phase, "muted"),
    evaluationMetrics([
      ["Objective", report.objective.status || "无", report.objective.totalSteps ? `计划 ${report.objective.completedSteps}/${report.objective.totalSteps}` : "无计划步骤"],
      ["工具成功", report.tools.completed ? `${report.tools.successRate}%` : "—", `${report.tools.succeeded}/${report.tools.completed} 成功`],
      ["Context", String(report.context.plans), `压缩 ${report.context.compacted} · 历史节省 ${formatTokens(report.context.historySavedTokens)} tokens`],
      ["Token", formatTokens(report.metrics.totalTokens), `模型调用 ${report.metrics.modelCalls}`],
    ]),
  );

  const reliability = document.createElement("section");
  reliability.className = "evaluation-card";
  reliability.append(
    contextCardHeading("可靠性信号", report.tools.executionUnknown ? `${report.tools.executionUnknown} 个未知结果` : "执行结果明确", report.tools.executionUnknown ? "danger" : "normal"),
    evaluationRows([
      ["工具", `失败 ${report.tools.failed} · 参数无效 ${report.tools.validationFailed} · 能力不可用 ${report.tools.capabilityUnavailable}`],
      ["审批", `请求 ${report.approvals.requested} · 通过 ${report.approvals.granted} · 拒绝 ${report.approvals.denied}`],
      ["Context", `最高占用 ${report.context.maxUtilizationPercent}% · 重规划 ${report.context.replanned} · 耗尽 ${report.context.replanExhausted}`],
      ["委派", `完成 ${report.delegations.completed}/${report.delegations.total} · 异常 ${report.delegations.failed}`],
    ]),
  );

  const issues = document.createElement("section");
  issues.className = "evaluation-card";
  issues.append(contextCardHeading("需要关注", report.issues.length ? `${report.issues.length} 类` : "未发现问题", report.issues.some((issue) => issue.severity === "high") ? "danger" : report.issues.length ? "warning" : "normal"));
  if (report.issues.length) {
    const list = document.createElement("div");
    list.className = "evaluation-issues";
    for (const issue of report.issues) {
      const item = document.createElement("div");
      item.className = `evaluation-issue ${issue.severity}`;
      const marker = document.createElement("i");
      marker.textContent = ({ high: "!", medium: "·", low: "i" })[issue.severity] || "·";
      const copy = document.createElement("span");
      const title = document.createElement("strong");
      title.textContent = issue.label;
      const detail = document.createElement("small");
      detail.textContent = `${issue.code}${issue.count > 1 ? ` · ${issue.count} 次` : ""}${issue.eventSeq ? ` · event ${issue.eventSeq}` : ""}`;
      copy.append(title, detail);
      item.append(marker, copy);
      list.append(item);
    }
    issues.append(list);
  } else {
    summary.textContent += " · 未发现失败、未知副作用或未闭合状态";
  }

  const foot = document.createElement("p");
  foot.className = "evaluation-foot";
  foot.textContent = "报告由 Session Journal 派生，不调用模型，也不会修改原任务。";
  const details = document.createElement("details");
  details.className = "evaluation-details";
  const detailsSummary = document.createElement("summary");
  detailsSummary.textContent = "运行指标与可靠性";
  const detailsBody = document.createElement("div");
  detailsBody.className = "evaluation-details-body";
  detailsBody.append(metrics, reliability, foot);
  details.append(detailsSummary, detailsBody);
  elements.evaluationPanel.replaceChildren(overview, ...(report.issues.length ? [issues] : []), details);
}

function evaluationMetrics(items) {
  const grid = document.createElement("div");
  grid.className = "evaluation-metrics";
  for (const [label, value, detail] of items) {
    const metric = document.createElement("div");
    const caption = document.createElement("span");
    caption.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    const small = document.createElement("small");
    small.textContent = detail;
    metric.append(caption, strong, small);
    grid.append(metric);
  }
  return grid;
}

function evaluationRows(items) {
  const list = document.createElement("div");
  list.className = "evaluation-rows";
  for (const [label, value] of items) {
    const row = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = label;
    const detail = document.createElement("span");
    detail.textContent = value;
    row.append(title, detail);
    list.append(row);
  }
  return list;
}

function evaluationStatusLabel(status) {
  return ({ healthy: "健康", attention: "需要关注", failed: "失败", cancelled: "已取消", running: "运行中", idle: "尚未运行" })[status] || status;
}

function evaluationStatusLevel(status) {
  if (status === "failed") return "danger";
  if (["attention", "cancelled"].includes(status)) return "warning";
  if (["idle", "running"].includes(status)) return "muted";
  return "normal";
}

function contextCardHeading(titleText, statusText, level) {
  const head = document.createElement("header");
  head.className = "context-card-head";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const status = document.createElement("span");
  status.className = `context-state ${level}`;
  status.textContent = statusText;
  head.append(title, status);
  return head;
}

function contextMetrics(items) {
  const grid = document.createElement("div");
  grid.className = "context-metrics";
  for (const [label, value, detail] of items) {
    const metric = document.createElement("div");
    const caption = document.createElement("span");
    caption.textContent = label;
    const strong = document.createElement("strong");
    strong.textContent = value;
    const small = document.createElement("small");
    small.textContent = detail;
    metric.append(caption, strong, small);
    grid.append(metric);
  }
  return grid;
}

function contextMemoryRow(label, section) {
  const row = document.createElement("div");
  row.className = "context-memory-row";
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  title.textContent = label;
  const detail = document.createElement("small");
  detail.textContent = `${section.included} 条 · ${formatTokens(section.estimatedTokens)}${section.maxTokens ? ` / ${formatTokens(section.maxTokens)}` : ""}`;
  copy.append(title, detail);
  const status = document.createElement("span");
  status.className = section.truncated ? "context-truncated" : "context-complete";
  status.textContent = section.truncated ? `${section.truncated} 条截断` : "完整";
  row.append(copy, status);
  return row;
}

function fileChangePanel(manifest, reviewTarget = null) {
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
    const previewLimit = 8;
    for (const change of manifest.changes.slice(0, previewLimit)) {
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
    if (manifest.changes.length > previewLimit) {
      const remaining = document.createElement("span");
      remaining.className = "file-change-remaining";
      remaining.textContent = `还有 ${manifest.changes.length - previewLimit} 项，请在文件审查中查看`;
      panel.append(remaining);
    }
  }

  if (reviewTarget) {
    const open = document.createElement("button");
    open.type = "button";
    open.className = "artifact-button";
    open.textContent = manifest.diffArtifact?.id
      ? (manifest.diffTruncated ? "打开文件审查（Diff 已截断）" : "打开文件审查")
      : "查看文件变化";
    open.addEventListener("click", () => openReview({
      ...reviewTarget,
      path: manifest.changes?.[0]?.path || null,
    }));
    panel.append(open);
  }
  return panel;
}

function stageJournal(events) {
  state.journalEvents = Array.isArray(events) ? events : [];
  state.journalDirty = true;
  elements.journalSummary.textContent = state.journalEvents.length
    ? `最近 ${Math.min(100, state.journalEvents.length)} / 共 ${state.journalEvents.length} 条`
    : "任务开始后显示";
  if (state.inspectorTab === "more" && inspectorShell.isOpen() && $("#journal-section").open) {
    requestAnimationFrame(renderStagedJournal);
  }
}

function renderStagedJournal() {
  if (!state.journalDirty) return;
  state.journalDirty = false;
  renderEvents(state.journalEvents);
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

function isOverlayOpen() {
  return !elements.dangerConfirm.classList.contains("hidden")
    || projectPicker.isOpen()
    || state.editingTitle
    || inspectorShell.isModalOpen()
    || !elements.permissionMenu.classList.contains("hidden")
    || taskNavigation.isOpen();
}

async function exportSession() {
  const payload = await api(`/sessions/${encodeURIComponent(sessionProjection.sessionId)}/export`);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = `${sessionProjection.sessionId}.journal.json`;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function loadMemories() {
  if (!sessionProjection.sessionId) {
    const empty = document.createElement("div");
    empty.className = "drawer-empty";
    empty.textContent = "请先选择一个任务。";
    elements.memoryList.replaceChildren(empty);
    return;
  }
  const current = await sessionProjection.query("memories", (sessionId, { signal }) => (
    api(`/sessions/${encodeURIComponent(sessionId)}/memories`, { signal })
  ));
  if (!current) return;
  const { sessionId, value: { memories } } = current;
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
    const pin = document.createElement("button");
    pin.className = "memory-pin";
    pin.textContent = memory.pinned ? "取消固定" : "固定";
    pin.addEventListener("click", async () => {
      if (sessionProjection.sessionId !== sessionId) {
        toast("任务已经切换，请在当前任务中重新操作");
        return;
      }
      pin.disabled = true;
      try {
        await api(`/sessions/${encodeURIComponent(sessionId)}/memories/${encodeURIComponent(memory.id)}/pin`, {
          method: "POST",
          body: { pinned: !memory.pinned },
        });
        await loadMemories();
      } catch {
        pin.disabled = false;
      }
    });
    const remove = document.createElement("button");
    remove.textContent = "删除";
    remove.addEventListener("click", async () => {
      if (sessionProjection.sessionId !== sessionId) return;
      await api(`/sessions/${encodeURIComponent(sessionId)}/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" });
      await loadMemories();
    });
    box.append(text, pin, remove);
    return box;
  }));
}

async function loadCandidates() {
  if (!sessionProjection.sessionId) {
    const empty = document.createElement("div");
    empty.className = "candidate-empty";
    empty.textContent = "请先选择一个任务。";
    elements.candidateList.replaceChildren(empty);
    return;
  }
  const current = await sessionProjection.query("memory-candidates", (sessionId, { signal }) => (
    api(`/sessions/${encodeURIComponent(sessionId)}/memory-candidates`, { signal })
  ));
  if (!current) return;
  const { sessionId, value: { candidates } } = current;
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
      if (sessionProjection.sessionId !== sessionId) {
        toast("任务已经切换，请在当前任务中重新操作");
        return;
      }
      approve.disabled = true;
      reject.disabled = true;
      try {
        await api(`/sessions/${encodeURIComponent(sessionId)}/memory-candidates/${encodeURIComponent(candidate.id)}/${action}`, {
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
  if (!sessionProjection.sessionId) {
    toast("请先选择一个任务再新增长期记忆");
    return;
  }
  const input = $("#memory-input");
  const content = input.value.trim();
  if (!content) return;
  const sessionId = sessionProjection.sessionId;
  await api(`/sessions/${encodeURIComponent(sessionId)}/memories`, { method: "POST", body: { content, tags: [] } });
  input.value = "";
  if (sessionProjection.sessionId === sessionId) await loadMemories();
}

async function loadGrants() {
  if (!sessionProjection.sessionId) {
    elements.grantCount.textContent = "0";
    elements.grantSummary.textContent = "选择任务后查看";
    const empty = document.createElement("div");
    empty.className = "drawer-empty";
    empty.textContent = "请先选择一个任务。";
    elements.grantList.replaceChildren(empty);
    return;
  }
  const current = await sessionProjection.query("grants", (sessionId, { signal }) => (
    api(`/sessions/${encodeURIComponent(sessionId)}/grants`, { signal })
  ));
  if (!current) return;
  renderGrants(current.value.grants, current.sessionId);
}

function renderGrants(grants = {}, sessionId = sessionProjection.sessionId) {
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
  elements.grantList.replaceChildren(...views.map((grant) => grantCard(grant, sessionId)));
  setGrantActionAvailability(["thinking", "executing", "awaiting_approval"].includes(sessionProjection.phase));
}

function grantCard(grant, sessionId) {
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
    if (sessionProjection.sessionId !== sessionId) return;
    for (const button of [cancel, confirm]) button.disabled = true;
    try {
      const { grants } = await api(`/sessions/${encodeURIComponent(sessionId)}/grants/${encodeURIComponent(grant.id)}/revoke`, {
        method: "POST",
        body: { scope: grant.scope, reason: "用户在 Web UI 中撤销授权" },
      });
      if (sessionProjection.sessionId !== sessionId) return;
      renderGrants(grants, sessionId);
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

function handleInspectorViewSelected(name) {
  state.inspectorTab = name;
  elements.inspector.classList.toggle("review-mode", name === "files");
  prepareInspectorView(name);
}

function prepareInspectorView(name) {
  if (name === "overview") void loadEvaluation();
  if (name === "more") {
    if ($("#memory-section").open) void Promise.allSettled([loadMemories(), loadCandidates()]);
    if ($("#grants-section").open) void loadGrants();
    if ($("#journal-section").open) renderStagedJournal();
  }
}

function handleInspectorSectionToggle(event) {
  if (!event.currentTarget.open) return;
  if (event.currentTarget.id === "memory-section") void Promise.allSettled([loadMemories(), loadCandidates()]);
  if (event.currentTarget.id === "grants-section") void loadGrants();
  if (event.currentTarget.id === "journal-section") renderStagedJournal();
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
    "context.summary_requested": "生成会话摘要",
    "context.summary_completed": "更新会话摘要",
    "context.summary_degraded": "会话摘要降级",
    "context.replan_requested": "模型上下文超限",
    "context.replanned": "重新规划上下文",
    "context.replan_exhausted": "上下文重试仍超限",
    "memory.context_loaded": "加载相关记忆",
    "memory.added": "保存会话记忆",
    "memory.flush_requested": "提取记忆候选",
    "memory.flush_completed": "候选提取完成",
    "memory.flush_degraded": "候选提取降级",
    "memory.candidate_created": "创建记忆候选",
    "memory.candidate_approved": "保留记忆候选",
    "memory.candidate_rejected": "忽略记忆候选",
    "memory.pin_changed": "更新固定记忆",
    "tool.requested": "请求工具",
    "tool.validation_failed": "工具参数无效",
    "tool.authorization_decided": "工具策略决策",
    "tool.execution_started": "开始执行工具",
    "tool.output_updated": "更新工具实时输出",
    "tool.execution_unknown": "工具结果未知",
    "tool.recovery_cancelled": "恢复时取消未启动工具",
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
    "session.display_title_changed": "更新任务名称",
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
    if (!silent && error?.name !== "AbortError") toast("无法连接本地 Gateway");
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
