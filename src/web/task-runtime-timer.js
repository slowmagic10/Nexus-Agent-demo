const ACTIVE_PHASES = new Set(["thinking", "executing", "awaiting_approval"]);
const TERMINAL_EVENTS = new Set(["session.turn_completed", "session.failed", "session.cancelled"]);

// Read-only presentation of the latest user turn. Wall-clock ticks never enter
// the durable journal, and later memory/metadata events cannot extend a turn.
export function projectTurnTiming(session) {
  if (!session?.id) return null;
  const events = Array.isArray(session.events) ? session.events : [];
  const userIndex = events.findLastIndex((event) => event?.type === "message.user" && event.inherited !== true);
  const user = events[userIndex];
  const turnEvents = userIndex < 0 ? [] : events.slice(userIndex + 1).filter((event) => event && event.inherited !== true);
  const terminal = turnEvents.findLast((event) => TERMINAL_EVENTS.has(event.type));
  const activeStart = timestamp(session.turnStartedAt);
  const userStart = timestamp(user?.at);
  const startedAt = activeStart ?? userStart;
  const key = `${session.id}:${userIndex}:${user?.seq ?? ""}:${startedAt ?? user?.at ?? ""}`;

  if (terminal) {
    const endedAt = timestamp(terminal.at);
    const durationMs = duration(terminal.durationMs)
      ?? (userStart !== null && endedAt !== null ? Math.max(0, endedAt - userStart) : null);
    if (durationMs === null) return null;
    return { key, running: false, startedAt: userStart, durationMs };
  }
  // Recovery records when the process returned, not when its previous run
  // stopped. An already terminal turn stays frozen; an interrupted one has no
  // reliable end timestamp, and must not include time spent offline.
  if (turnEvents.some((event) => event.type === "session.resumed")) return null;
  if (!ACTIVE_PHASES.has(session.phase) || startedAt === null) return null;
  return { key, running: true, startedAt, durationMs: null };
}

export function formatRuntimeDuration(durationMs) {
  const seconds = Math.floor((duration(durationMs) ?? 0) / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remaining = seconds % 60;
  const short = `${String(minutes).padStart(2, "0")}:${String(remaining).padStart(2, "0")}`;
  return hours ? `${hours}:${short}` : short;
}

export function createTaskRuntimeTimer({
  root,
  now = Date.now,
  scheduleTick = setInterval,
  cancelTick = clearInterval,
} = {}) {
  if (!root || typeof root.setAttribute !== "function") throw new TypeError("Task Runtime Timer 需要 root 元素");
  if ([now, scheduleTick, cancelTick].some((callback) => typeof callback !== "function")) {
    throw new TypeError("Task Runtime Timer 需要有效的时钟和调度函数");
  }
  root.setAttribute("role", "timer");
  root.setAttribute("aria-live", "off");
  root.setAttribute("aria-atomic", "true");
  let timing = null;
  let interval = null;
  let generation = 0;
  let destroyed = false;

  function render() {
    root.hidden = timing === null;
    root.setAttribute("data-running", String(timing?.running === true));
    if (!timing) {
      root.textContent = "";
      return;
    }
    const clock = now();
    const elapsedMs = timing.running
      ? Math.max(0, (Number.isFinite(clock) ? clock : timing.startedAt) - timing.startedAt)
      : timing.durationMs;
    root.textContent = `${timing.running ? "本轮已运行" : "本轮耗时"} ${formatRuntimeDuration(elapsedMs)}`;
  }

  function stop() {
    generation += 1;
    if (interval !== null) cancelTick(interval);
    interval = null;
  }

  render();
  return Object.freeze({
    update(session) {
      if (destroyed) return;
      const next = projectTurnTiming(session);
      if (next?.key !== timing?.key || next?.running !== timing?.running) stop();
      timing = next;
      render();
      if (timing?.running && interval === null) {
        const ticket = generation;
        interval = scheduleTick(() => {
          if (!destroyed && ticket === generation && timing?.running) render();
        }, 1000);
      }
    },
    destroy() {
      if (destroyed) return;
      destroyed = true;
      stop();
      timing = null;
      render();
    },
  });
}

function timestamp(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function duration(value) {
  return Number.isFinite(value) && value >= 0 ? value : null;
}
