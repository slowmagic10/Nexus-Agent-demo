// FOUNDATION — owns the new-task Project selection and managed Project creation flow.
export function createProjectPicker({
  dialog,
  form,
  projectSelect,
  createToggle,
  createFields,
  nameInput,
  cancelButton,
  submitButton,
  errorNode,
  loadProjects,
  createProject,
  createSession,
  createElement = (tag) => document.createElement(tag),
} = {}) {
  for (const [label, node] of Object.entries({
    dialog,
    form,
    projectSelect,
    createToggle,
    createFields,
    nameInput,
    cancelButton,
    submitButton,
    errorNode,
  })) assertNode(node, label);
  for (const [label, operation] of Object.entries({ loadProjects, createProject, createSession })) {
    if (typeof operation !== "function") throw new TypeError(`Project Picker ${label} 必须是函数`);
  }
  if (typeof createElement !== "function") throw new TypeError("Project Picker createElement 必须是函数");

  let catalog = { projects: [], defaultProjectId: null };
  let creating = false;
  let busy = false;
  let pending = null;
  let destroyed = false;
  let refreshVersion = 0;

  const onToggle = () => {
    if (busy) return;
    creating = !creating;
    renderMode();
    if (creating) nameInput.focus?.();
  };
  const onCancel = (event) => {
    event?.preventDefault?.();
    // Creating a Project or Session can already have crossed the HTTP commit
    // boundary. Keep the dialog open until that short operation settles so an
    // Escape key cannot appear to cancel work that still completes remotely.
    if (busy) return;
    settle(null);
  };
  const onSubmit = (event) => {
    event.preventDefault();
    void submit();
  };
  const onDialogCancel = (event) => onCancel(event);

  createToggle.addEventListener("click", onToggle);
  cancelButton.addEventListener("click", onCancel);
  form.addEventListener("submit", onSubmit);
  dialog.addEventListener("cancel", onDialogCancel);

  return Object.freeze({
    open({ preferredProjectId = null } = {}) {
      if (destroyed) throw new Error("Project Picker 已销毁");
      if (pending) return pending.promise;
      creating = false;
      busy = false;
      catalog = { projects: [], defaultProjectId: null };
      nameInput.value = "";
      errorNode.textContent = "";
      const promise = new Promise((resolve) => { pending = { resolve, promise: null }; });
      pending.promise = promise;
      const operation = pending;
      dialog.showModal?.();
      renderMode();
      void refresh(preferredProjectId, operation).catch((error) => {
        if (pending === operation && !destroyed) {
          errorNode.textContent = error.message || "无法加载项目";
          renderMode();
        }
      });
      return promise;
    },

    async refresh(preferredProjectId = null) {
      return refresh(preferredProjectId);
    },

    isOpen() {
      return Boolean(pending);
    },

    destroy() {
      if (destroyed) return;
      destroyed = true;
      createToggle.removeEventListener("click", onToggle);
      cancelButton.removeEventListener("click", onCancel);
      form.removeEventListener("submit", onSubmit);
      dialog.removeEventListener("cancel", onDialogCancel);
      refreshVersion += 1;
      settle(null);
    },
  });

  async function refresh(preferredProjectId = null, expectedOperation = pending) {
    const version = ++refreshVersion;
    const response = await loadProjects();
    if (destroyed || version !== refreshVersion || (expectedOperation && pending !== expectedOperation)) {
      return normalizeCatalog(response);
    }
    catalog = normalizeCatalog(response);
    projectSelect.replaceChildren(...catalog.projects.map((project) => {
      const option = createElement("option");
      option.value = project.id;
      option.textContent = project.isDefault
        ? project.name
        : `${project.name}${project.legacy ? " · 旧工作区" : ""}`;
      option.title = project.managed ? `Nexus Projects/${project.directory}` : "已注册的外部工作区";
      return option;
    }));
    const selected = catalog.projects.some((project) => project.id === preferredProjectId)
      ? preferredProjectId
      : catalog.defaultProjectId;
    projectSelect.value = selected || catalog.projects[0]?.id || "";
    renderMode();
    return catalog;
  }

  async function submit() {
    if (busy || !pending) return;
    const operation = pending;
    errorNode.textContent = "";
    busy = true;
    renderMode();
    try {
      let projectId = projectSelect.value;
      if (creating) {
        const name = String(nameInput.value || "").trim();
        if (!name) throw new Error("请输入新项目名称");
        const response = await createProject({ name });
        if (pending !== operation || destroyed) return;
        if (!response?.project?.id) throw new Error("Gateway 没有返回新项目");
        projectId = response.project.id;
        await refresh(projectId, operation);
        if (pending !== operation || destroyed) return;
      }
      if (!projectId) throw new Error("请选择项目");
      const result = await createSession({ projectId });
      if (pending !== operation || destroyed) return;
      settle(result);
    } catch (error) {
      if (pending !== operation || destroyed) return;
      busy = false;
      errorNode.textContent = error.message || "创建任务失败";
      renderMode();
    }
  }

  function renderMode() {
    createFields.classList.toggle("hidden", !creating);
    projectSelect.disabled = busy || creating || catalog.projects.length === 0;
    nameInput.disabled = busy || !creating;
    createToggle.disabled = busy;
    cancelButton.disabled = busy;
    createToggle.textContent = creating ? "选择已有项目" : "新建项目";
    submitButton.disabled = busy || (!creating && !projectSelect.value);
    submitButton.textContent = busy ? "正在创建…" : "创建任务";
  }

  function settle(value) {
    if (!pending) return;
    const current = pending;
    pending = null;
    busy = false;
    dialog.close?.();
    current.resolve(value);
  }
}

function normalizeCatalog(value) {
  if (!value || !Array.isArray(value.projects)) throw new Error("Project Catalog 响应无效");
  const projects = value.projects.filter((project) => (
    project && typeof project.id === "string" && typeof project.name === "string"
  ));
  return {
    projects,
    defaultProjectId: typeof value.defaultProjectId === "string" ? value.defaultProjectId : projects[0]?.id || null,
  };
}

function assertNode(node, label) {
  if (!node || typeof node.addEventListener !== "function") {
    throw new TypeError(`Project Picker 缺少 ${label}`);
  }
}
