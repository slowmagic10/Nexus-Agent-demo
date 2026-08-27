export function shouldSubmitMessage(event, { composing = false } = {}) {
  if (!event || event.key !== "Enter" || event.shiftKey) return false;
  return !composing
    && event.isComposing !== true
    && event.keyCode !== 229
    && event.which !== 229;
}

const BUSY_PHASES = new Set(["thinking", "executing", "awaiting_approval"]);

export function composerActionState(phase, { cancelling = false } = {}) {
  const busy = BUSY_PHASES.has(phase);
  if (!busy) {
    return {
      busy: false,
      mode: "send",
      disabled: false,
      label: "发送消息",
      shortcut: "Enter 发送",
      symbol: "↑",
    };
  }
  return {
    busy: true,
    mode: "stop",
    disabled: cancelling,
    label: cancelling ? "正在停止任务" : "停止任务",
    shortcut: cancelling ? "正在停止…" : "Esc 停止",
    symbol: "■",
  };
}

export function shouldCancelRun(event, { phase, overlayOpen = false, cancelling = false } = {}) {
  return event?.key === "Escape"
    && event.repeat !== true
    && !overlayOpen
    && !cancelling
    && BUSY_PHASES.has(phase);
}
