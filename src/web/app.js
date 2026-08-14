const $ = (selector) => document.querySelector(selector);
const state = { sessionId: null, session: null, source: null };

const elements = {
  sessionList: $("#session-list"), messages: $("#messages"), events: $("#events"),
  title: $("#session-title"), meta: $("#session-meta"), approval: $("#approval"),
  input: $("#message-input"), form: $("#message-form"), export: $("#export-session"),
  cancel: $("#cancel-run"), metrics: $("#metrics"), memoryList: $("#memory-list"),
};

$("#new-session").addEventListener("click", createSession);
elements.form.addEventListener("submit", sendMessage);
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); elements.form.requestSubmit(); }
});
elements.cancel.addEventListener("click", cancelRun);
elements.export.addEventListener("click", exportSession);
$("#memory-form").addEventListener("submit", addMemory);
document.querySelectorAll(".tab").forEach((tab) => tab.addEventListener("click", () => selectTab(tab.dataset.tab)));

await Promise.all([checkHealth(), loadSessions(), loadMemories()]);

async function checkHealth() {
  try {
    await api("/health");
    $("#health-dot").classList.add("online"); $("#health-text").textContent = "Gateway 在线";
  } catch { $("#health-text").textContent = "Gateway 离线"; }
}

async function loadSessions() {
  const { sessions } = await api("/sessions");
  elements.sessionList.replaceChildren(...sessions.map(sessionButton));
}

function sessionButton(session) {
  const button = document.createElement("button");
  button.className = `session-item${session.id === state.sessionId ? " active" : ""}`;
  button.dataset.sessionId = session.id;
  const name = document.createElement("strong"); name.textContent = session.id;
  const detail = document.createElement("span"); detail.textContent = `${session.phase} · ${session.messageCount} 条消息`;
  button.append(name, detail); button.addEventListener("click", () => selectSession(session.id));
  return button;
}

async function createSession() {
  const { session } = await api("/sessions", { method: "POST", body: {} });
  await loadSessions(); await selectSession(session.id);
}

async function selectSession(id) {
  state.sessionId = id;
  const { session } = await api(`/sessions/${encodeURIComponent(id)}`);
  renderSession(session); connectEvents(); await loadSessions();
}

function connectEvents() {
  state.source?.close();
  state.source = new EventSource(`/sessions/${encodeURIComponent(state.sessionId)}/events`);
  state.source.addEventListener("state", (event) => renderSession(JSON.parse(event.data)));
  state.source.onerror = () => toast("事件流暂时断开，浏览器将自动重连");
}

function renderSession(session) {
  state.session = session;
  elements.title.textContent = session.id;
  elements.meta.textContent = `${session.provider} · ${session.workspace}`;
  const busy = ["thinking", "executing", "awaiting_approval"].includes(session.phase);
  elements.input.disabled = busy; elements.form.querySelector("button").disabled = busy;
  elements.cancel.disabled = !busy; elements.export.disabled = false;
  elements.metrics.replaceChildren(...[
    ["阶段", session.phase], ["模型调用", session.metrics.modelCalls], ["工具调用", session.metrics.toolCalls],
    ["Token", session.metrics.totalTokens || 0], ["本轮耗时", `${session.metrics.lastTurnDurationMs || 0}ms`],
  ].map(metric));
  renderMessages(session.messages); renderEvents(session.events); renderApproval(session.pendingApproval);
  const sidebarItem = elements.sessionList.querySelector(`[data-session-id="${CSS.escape(session.id)}"] span`);
  if (sidebarItem) sidebarItem.textContent = `${session.phase} · ${session.messages.length} 条消息`;
}

function metric([label, value]) {
  const box = document.createElement("div"), span = document.createElement("span"), strong = document.createElement("strong");
  span.textContent = label; strong.textContent = value; box.append(span, strong); return box;
}

function renderMessages(messages) {
  if (!messages.length) { elements.messages.innerHTML = '<div class="empty">发送第一条消息开始任务。</div>'; return; }
  elements.messages.replaceChildren(...messages.map((message) => {
    const box = document.createElement("div"); box.className = `message ${message.role}`;
    const role = document.createElement("span"); role.className = "role"; role.textContent = message.role;
    const content = document.createElement("div");
    content.textContent = message.content || message.tool_calls?.map((call) => `调用 ${call.function.name}\n${call.function.arguments}`).join("\n") || "";
    box.append(role, content); return box;
  }));
  elements.messages.scrollTop = elements.messages.scrollHeight;
}

function renderEvents(events) {
  elements.events.replaceChildren(...events.slice(-80).reverse().map((event) => {
    const box = document.createElement("div"); box.className = "event";
    const title = document.createElement("strong"); title.textContent = `${event.seq}. ${event.type}`;
    const detail = document.createElement("span"); detail.textContent = `${event.tool || ""} ${new Date(event.at).toLocaleTimeString()}`;
    box.append(title, detail); return box;
  }));
}

function renderApproval(call) {
  if (!call) { elements.approval.classList.add("hidden"); elements.approval.replaceChildren(); return; }
  elements.approval.classList.remove("hidden");
  const title = document.createElement("strong"); title.textContent = `需要审批：${call.name}`;
  const code = document.createElement("code"); code.textContent = JSON.stringify(call.arguments, null, 2);
  const row = document.createElement("div"); row.className = "row";
  const approve = document.createElement("button"); approve.className = "primary"; approve.textContent = "批准一次";
  const deny = document.createElement("button"); deny.textContent = "拒绝";
  approve.onclick = () => decide(call.id, true); deny.onclick = () => decide(call.id, false);
  row.append(approve, deny); elements.approval.replaceChildren(title, code, row);
}

async function sendMessage(event) {
  event.preventDefault(); const content = elements.input.value.trim(); if (!content || !state.sessionId) return;
  elements.input.value = "";
  await api(`/sessions/${encodeURIComponent(state.sessionId)}/messages`, { method: "POST", body: { content } });
}

async function decide(callId, approved) {
  await api(`/sessions/${encodeURIComponent(state.sessionId)}/approvals/${encodeURIComponent(callId)}`, { method: "POST", body: { approved } });
}

async function cancelRun() {
  await api(`/sessions/${encodeURIComponent(state.sessionId)}/cancel`, { method: "POST", body: {} });
}

async function exportSession() {
  const payload = await api(`/sessions/${encodeURIComponent(state.sessionId)}/export`);
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
  const link = document.createElement("a"); link.href = URL.createObjectURL(blob); link.download = `${state.sessionId}.json`; link.click();
  URL.revokeObjectURL(link.href);
}

async function loadMemories() {
  const { memories } = await api("/memories");
  elements.memoryList.replaceChildren(...memories.map((memory) => {
    const box = document.createElement("div"); box.className = "memory";
    const text = document.createElement("p"); text.textContent = memory.content;
    const remove = document.createElement("button"); remove.textContent = "删除";
    remove.onclick = async () => { await api(`/memories/${encodeURIComponent(memory.id)}`, { method: "DELETE" }); await loadMemories(); };
    box.append(text, remove); return box;
  }));
}

async function addMemory(event) {
  event.preventDefault(); const input = $("#memory-input"); const content = input.value.trim(); if (!content) return;
  await api("/memories", { method: "POST", body: { content, tags: [] } }); input.value = ""; await loadMemories();
}

function selectTab(name) {
  document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab.dataset.tab === name));
  $("#events-view").classList.toggle("hidden", name !== "events"); $("#memory-view").classList.toggle("hidden", name !== "memory");
}

async function api(url, options = {}) {
  const init = { ...options, headers: { ...(options.headers || {}) } };
  if (options.body !== undefined) { init.headers["content-type"] = "application/json"; init.body = JSON.stringify(options.body); }
  const response = await fetch(url, init); const payload = await response.json();
  if (!response.ok) { toast(payload.error || `请求失败 ${response.status}`); throw new Error(payload.error); }
  return payload;
}

let toastTimer;
function toast(message) {
  const box = $("#toast"); box.textContent = message; box.classList.remove("hidden"); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => box.classList.add("hidden"), 3000);
}
