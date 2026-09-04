const BUSY_PHASES = new Set(["thinking", "executing", "awaiting_approval"]);

export function createComposer({
  form,
  input,
  action,
  shortcut,
  provider: providerNode,
  eventRoot,
  sendMessage,
  cancelRun,
  isOverlayOpen = () => false,
} = {}) {
  assertEventTarget(form, "form");
  assertEventTarget(input, "input");
  assertEventTarget(action, "action");
  assertEventTarget(eventRoot, "eventRoot");
  assertTextNode(shortcut, "shortcut");
  assertTextNode(providerNode, "provider");
  if (typeof form.requestSubmit !== "function") throw new TypeError("form.requestSubmit 必须是函数");
  if (typeof sendMessage !== "function") throw new TypeError("sendMessage 必须是函数");
  if (typeof cancelRun !== "function") throw new TypeError("cancelRun 必须是函数");
  if (typeof isOverlayOpen !== "function") throw new TypeError("isOverlayOpen 必须是函数");

  let currentSessionId = null;
  let currentPhase = "idle";
  let currentUserTurnCount = 0;
  let composing = false;
  let destroyed = false;
  let operationSequence = 0;
  const pendingSends = new Map();
  const cancellingSessions = new Map();

  const onCompositionStart = () => {
    composing = true;
  };
  const onCompositionEnd = () => {
    composing = false;
  };
  const onInputKeydown = (event) => {
    if (!shouldSubmit(event, composing)) return;
    event.preventDefault();
    form.requestSubmit();
  };
  const onSubmit = (event) => {
    event.preventDefault();
    void submitCurrentDraft();
  };
  const onActionClick = () => {
    const state = actionState();
    if (state.disabled) return;
    if (state.mode === "stop") {
      void cancelCurrentRun();
      return;
    }
    form.requestSubmit();
  };
  const onRootKeydown = (event) => {
    if (!shouldCancel(event)) return;
    event.preventDefault();
    void cancelCurrentRun();
  };

  input.addEventListener("compositionstart", onCompositionStart);
  input.addEventListener("compositionend", onCompositionEnd);
  input.addEventListener("keydown", onInputKeydown);
  form.addEventListener("submit", onSubmit);
  action.addEventListener("click", onActionClick);
  eventRoot.addEventListener("keydown", onRootKeydown, true);
  render();

  return Object.freeze({
    update({ sessionId = null, phase = "idle", provider = "本地模型", userTurnCount = 0 } = {}) {
      if (destroyed) return;
      currentSessionId = typeof sessionId === "string" && sessionId ? sessionId : null;
      currentPhase = typeof phase === "string" && phase ? phase : "idle";
      currentUserTurnCount = Number.isSafeInteger(userTurnCount) && userTurnCount >= 0
        ? userTurnCount
        : 0;
      const pendingSend = currentSessionId ? pendingSends.get(currentSessionId) : null;
      if (pendingSend && (
        currentPhase !== pendingSend.phaseAtSubmit
        || currentUserTurnCount > pendingSend.userTurnCountAtSubmit
      )) {
        pendingSends.delete(currentSessionId);
      }
      if (currentSessionId && !BUSY_PHASES.has(currentPhase)) {
        cancellingSessions.delete(currentSessionId);
      }
      providerNode.textContent = typeof provider === "string" && provider ? provider : "本地模型";
      render();
    },

    setDraft(value, { focus = false } = {}) {
      if (destroyed) return;
      input.value = String(value ?? "");
      if (focus) focusInput();
    },

    focus() {
      if (!destroyed) focusInput();
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      operationSequence += 1;
      input.removeEventListener("compositionstart", onCompositionStart);
      input.removeEventListener("compositionend", onCompositionEnd);
      input.removeEventListener("keydown", onInputKeydown);
      form.removeEventListener("submit", onSubmit);
      action.removeEventListener("click", onActionClick);
      eventRoot.removeEventListener("keydown", onRootKeydown, true);
      pendingSends.clear();
      cancellingSessions.clear();
    },
  });

  async function submitCurrentDraft() {
    const sessionId = currentSessionId;
    const content = String(input.value ?? "").trim();
    const state = actionState();
    if (!sessionId || !content || state.mode !== "send" || state.disabled) return;

    const operationId = ++operationSequence;
    pendingSends.set(sessionId, {
      operationId,
      phaseAtSubmit: currentPhase,
      userTurnCountAtSubmit: currentUserTurnCount,
    });
    input.value = "";
    render();
    try {
      await sendMessage({ sessionId, content });
    } catch {
      if (destroyed || pendingSends.get(sessionId)?.operationId !== operationId) return;
      pendingSends.delete(sessionId);
      if (currentSessionId === sessionId && !String(input.value ?? "")) input.value = content;
      render();
      return;
    }
    // 成功响应只代表请求已被 Gateway 接受。保持 Session-scoped lock，
    // 直到 durable Session phase 推进，避免 HTTP 202 与 SSE 之间重复提交。
  }

  async function cancelCurrentRun() {
    const sessionId = currentSessionId;
    const state = actionState();
    if (!sessionId || state.mode !== "stop" || state.disabled) return;

    const operationId = ++operationSequence;
    cancellingSessions.set(sessionId, operationId);
    render();
    try {
      await cancelRun({ sessionId });
    } catch {
      if (destroyed || cancellingSessions.get(sessionId) !== operationId) return;
      cancellingSessions.delete(sessionId);
      if (currentSessionId === sessionId) render();
    }
  }

  function shouldCancel(event) {
    return event?.defaultPrevented !== true
      && event?.key === "Escape"
      && event.repeat !== true
      && !isOverlayOpen()
      && actionState().mode === "stop"
      && !actionState().disabled;
  }

  function actionState() {
    const busy = BUSY_PHASES.has(currentPhase);
    if (busy) {
      const cancelling = Boolean(currentSessionId && cancellingSessions.has(currentSessionId));
      return {
        mode: "stop",
        disabled: cancelling,
        label: cancelling ? "正在停止任务" : "停止任务",
        shortcut: cancelling ? "正在停止…" : "Esc 停止",
        symbol: "■",
      };
    }
    const sending = Boolean(currentSessionId && pendingSends.has(currentSessionId));
    return {
      mode: "send",
      disabled: sending,
      label: sending ? "正在发送消息" : "发送消息",
      shortcut: sending ? "正在发送…" : "Enter 发送",
      symbol: "↑",
    };
  }

  function render() {
    if (destroyed) return;
    const state = actionState();
    input.disabled = !currentSessionId || BUSY_PHASES.has(currentPhase) || pendingSends.has(currentSessionId);
    action.textContent = state.symbol;
    action.disabled = !currentSessionId || state.disabled;
    action.setAttribute("aria-label", state.label);
    action.title = state.mode === "stop" ? "停止当前任务（Esc）" : "发送消息（Enter）";
    action.classList.toggle("stop-button", state.mode === "stop");
    shortcut.textContent = state.shortcut;
  }

  function focusInput() {
    if (typeof input.focus === "function") input.focus();
  }
}

function shouldSubmit(event, composing) {
  if (!event || event.key !== "Enter" || event.shiftKey) return false;
  return !composing
    && event.isComposing !== true
    && event.keyCode !== 229
    && event.which !== 229;
}

function assertEventTarget(value, name) {
  if (!value
    || typeof value.addEventListener !== "function"
    || typeof value.removeEventListener !== "function") {
    throw new TypeError(`${name} 必须是 EventTarget`);
  }
}

function assertTextNode(value, name) {
  if (!value || !("textContent" in value)) throw new TypeError(`${name} 必须支持 textContent`);
}
