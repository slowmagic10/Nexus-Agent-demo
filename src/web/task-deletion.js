// Owns one captured deletion target from confirmation through the HTTP result.
export function createTaskDeletion({
  dialog, form, titleNode, runningNode, errorNode, cancelButton, submitButton,
  deleteSession, onDeleted = () => {},
} = {}) {
  for (const [name, node] of Object.entries({ dialog, form, titleNode, runningNode, errorNode, cancelButton, submitButton })) {
    if (!node || typeof node.addEventListener !== "function") throw new TypeError(`Task Deletion 缺少 ${name}`);
  }
  if (typeof deleteSession !== "function" || typeof onDeleted !== "function") {
    throw new TypeError("Task Deletion 需要 deleteSession 和 onDeleted");
  }
  let pending = null;
  let busy = false;
  let destroyed = false;

  const cancel = (event) => {
    event?.preventDefault();
    // A committed DELETE cannot be cancelled by closing its confirmation UI.
    if (busy) return;
    settle(null);
  };
  const submit = (event) => {
    event.preventDefault();
    void confirm();
  };
  cancelButton.addEventListener("click", cancel);
  dialog.addEventListener("cancel", cancel);
  form.addEventListener("submit", submit);

  function render() {
    cancelButton.disabled = busy;
    submitButton.disabled = busy;
    submitButton.textContent = busy ? "正在删除…" : "删除任务";
    form.setAttribute("aria-busy", String(busy));
  }

  function settle(value) {
    if (!pending) return;
    const operation = pending;
    pending = null;
    busy = false;
    dialog.close();
    operation.resolve(value);
  }

  async function confirm() {
    if (busy || !pending || destroyed) return;
    const operation = pending;
    busy = true;
    errorNode.textContent = "";
    render();
    try {
      let result;
      try {
        result = await deleteSession({ sessionId: operation.sessionId });
      } catch (error) {
        if (error.status !== 404) throw error;
        result = { deleted: true, deletedSessionIds: [operation.sessionId], alreadyDeleted: true };
      }
      if (destroyed || pending !== operation) return;
      if (result?.deleted !== true) throw new Error("Gateway 未确认任务已删除，请重试。");
      const deletedSessionIds = [...new Set([
        operation.sessionId,
        ...(Array.isArray(result.deletedSessionIds) ? result.deletedSessionIds.filter((id) => typeof id === "string" && id) : []),
      ])];
      const value = { ...result, sessionId: operation.sessionId, deletedSessionIds };
      settle(value);
      onDeleted(value);
    } catch (error) {
      if (destroyed || pending !== operation) return;
      busy = false;
      errorNode.textContent = error.message || "删除任务失败，请重试。";
      render();
    }
  }

  return Object.freeze({
    open({ id, title = "新任务", phase = "idle" } = {}) {
      if (destroyed) throw new Error("Task Deletion 已销毁");
      if (pending) return pending.promise;
      if (typeof id !== "string" || !id.trim()) throw new TypeError("删除任务需要 Session ID");
      const promise = new Promise((resolve) => { pending = { sessionId: id, resolve }; });
      pending.promise = promise;
      titleNode.textContent = title || "新任务";
      runningNode.hidden = !["thinking", "executing", "awaiting_approval"].includes(phase);
      errorNode.textContent = "";
      busy = false;
      render();
      dialog.showModal();
      cancelButton.focus();
      return promise;
    },
    isOpen: () => Boolean(pending),
    destroy() {
      if (destroyed) return;
      destroyed = true;
      cancelButton.removeEventListener("click", cancel);
      dialog.removeEventListener("cancel", cancel);
      form.removeEventListener("submit", submit);
      settle(null);
    },
  });
}
