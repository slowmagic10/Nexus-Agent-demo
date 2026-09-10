// FOUNDATION — ordered live notifications with backpressure on their readable sources.
// Sources must honor synchronous pause(): this is not a dropping queue for arbitrary producers.
export function createOutputNotifier(callback, { sources = [] } = {}) {
  if (callback !== undefined && typeof callback !== "function") throw new Error("Output Notifier callback 必须是函数");
  if (!Array.isArray(sources) || sources.some((source) => (
    typeof source?.pause !== "function" || typeof source?.resume !== "function"
  ))) throw new Error("Output Notifier sources 必须支持 pause/resume");
  if (callback && !sources.length) throw new Error("Output Notifier 需要可背压的输出来源");

  let tail = Promise.resolve();
  let pending = 0;
  let stopped = false;
  const resumeSources = () => {
    for (const source of sources) {
      // A source may synchronously emit again from resume(); leave the others paused in that case.
      if (!stopped && pending) break;
      source.resume();
    }
  };
  return {
    emit(event) {
      if (!callback || stopped) return;
      pending += 1;
      if (pending === 1) for (const source of sources) source.pause();
      tail = tail.then(async () => {
        try {
          await callback(event);
        } catch {
          // Preview persistence is observational; its failure must not change the process result.
        } finally {
          pending -= 1;
          if (!pending && !stopped) resumeSources();
        }
      });
      return tail;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      // Cancellation must drain both pipes even while an accepted notification is still pending.
      if (callback) resumeSources();
    },
    async drain() {
      while (true) {
        const current = tail;
        await current;
        if (current === tail) return;
      }
    },
  };
}
