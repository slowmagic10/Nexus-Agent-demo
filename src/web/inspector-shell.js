export function createInspectorShell({
  root,
  toggle,
  backdrop,
  closeButton,
  tabs,
  views,
  defaultView = "overview",
  onViewSelected,
  onBeforeOpen,
  media,
}) {
  if (!root || !toggle || !backdrop || !closeButton) {
    throw new Error("Inspector Shell 缺少必要界面节点");
  }
  if (onViewSelected !== undefined && typeof onViewSelected !== "function") {
    throw new TypeError("Inspector Shell 的 onViewSelected 必须是函数");
  }
  if (onBeforeOpen !== undefined && typeof onBeforeOpen !== "function") {
    throw new TypeError("Inspector Shell 的 onBeforeOpen 必须是函数");
  }
  if (media !== undefined && (typeof media !== "object" || typeof media.matches !== "boolean")) {
    throw new TypeError("Inspector Shell 的 media 必须是 MediaQueryList");
  }

  const tabEntries = normalizeEntries(tabs, "tabs");
  const viewEntries = normalizeEntries(views, "views");
  assertMatchingViews(tabEntries, viewEntries);
  assertKnownView(defaultView, viewEntries);

  const eventRoot = root.ownerDocument || globalThis.document || root;
  let opened = false;
  let persistent = Boolean(media?.matches);
  let selectedView = defaultView;
  let returnFocus = null;

  const syncOpenState = () => {
    const visible = persistent || opened;
    root.classList.toggle("active", visible);
    root.classList.toggle("persistent", persistent);
    if (persistent) {
      root.removeAttribute("role");
      root.removeAttribute("aria-modal");
      root.removeAttribute("aria-hidden");
    } else if (visible) {
      root.setAttribute("role", "dialog");
      root.setAttribute("aria-modal", "true");
      root.setAttribute("aria-hidden", "false");
    } else {
      root.removeAttribute("role");
      root.removeAttribute("aria-modal");
      root.setAttribute("aria-hidden", "true");
    }
    root.inert = !visible;
    if (visible) root.removeAttribute("inert");
    else root.setAttribute("inert", "");
    backdrop.classList.toggle("hidden", persistent || !opened);
    if (persistent) {
      toggle.removeAttribute("aria-expanded");
      toggle.setAttribute("aria-label", "转到任务详情概览");
    } else {
      toggle.setAttribute("aria-expanded", String(visible));
      toggle.setAttribute("aria-label", visible ? "关闭任务详情" : "打开任务详情");
    }
    closeButton.hidden = persistent;
  };
  const syncSelectedView = () => {
    for (const [name, tab] of tabEntries) {
      const selected = name === selectedView;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.setAttribute("tabindex", selected ? "0" : "-1");
    }
    for (const [name, view] of viewEntries) {
      const selected = name === selectedView;
      view.classList.toggle("active", selected);
      view.classList.toggle("hidden", !selected);
    }
  };
  const selectView = (name) => {
    assertKnownView(name, viewEntries);
    if (name === selectedView) return selectedView;
    selectedView = name;
    syncSelectedView();
    onViewSelected?.(selectedView);
    return selectedView;
  };
  const openInspector = (view = selectedView) => {
    assertKnownView(view, viewEntries);
    onBeforeOpen?.(view);
    if (!opened) returnFocus = activeElementOf(eventRoot);
    if (view !== selectedView) selectView(view);
    opened = true;
    syncOpenState();
    tabEntries.find(([name]) => name === selectedView)?.[1]?.focus?.();
  };
  const closeInspector = () => {
    if (persistent || !opened) return;
    opened = false;
    syncOpenState();
    const target = returnFocus;
    returnFocus = null;
    if (target?.isConnected !== false && typeof target?.focus === "function") target.focus();
  };
  const toggleInspector = () => persistent
    ? openInspector(defaultView)
    : (opened ? closeInspector() : openInspector());
  const handleKeydown = (event) => {
    if (persistent || !opened) return;
    if (event.key === "Escape") {
      event.preventDefault?.();
      closeInspector();
      return;
    }
    if (event.key !== "Tab") return;
    const focusables = focusableElements(root, [closeButton, ...tabEntries.map(([, tab]) => tab)]);
    if (!focusables.length) {
      event.preventDefault?.();
      closeButton.focus?.();
      return;
    }
    const activeIndex = focusables.indexOf(activeElementOf(eventRoot));
    const target = event.shiftKey
      ? (activeIndex <= 0 ? focusables.at(-1) : null)
      : (activeIndex < 0 || activeIndex === focusables.length - 1 ? focusables[0] : null);
    if (!target) return;
    event.preventDefault?.();
    target.focus?.();
  };
  const tabListeners = tabEntries.map(([name, tab], index) => {
    const click = () => selectView(name);
    const keydown = (event) => {
      const last = tabEntries.length - 1;
      const targetIndex = ({
        ArrowLeft: index === 0 ? last : index - 1,
        ArrowRight: index === last ? 0 : index + 1,
        Home: 0,
        End: last,
      })[event.key];
      if (targetIndex === undefined) return;
      event.preventDefault?.();
      const [targetName, targetTab] = tabEntries[targetIndex];
      selectView(targetName);
      targetTab.focus?.();
    };
    tab.addEventListener("click", click);
    tab.addEventListener("keydown", keydown);
    return [tab, click, keydown];
  });
  const handleMediaChange = (event) => {
    const nextPersistent = Boolean(event?.matches);
    if (nextPersistent === persistent) return;
    const activeElement = activeElementOf(eventRoot);
    const shouldReturnFocus = persistent
      && !nextPersistent
      && typeof root.contains === "function"
      && root.contains(activeElement);
    persistent = nextPersistent;
    opened = false;
    returnFocus = null;
    syncOpenState();
    if (shouldReturnFocus) toggle.focus?.();
  };

  toggle.addEventListener("click", toggleInspector);
  backdrop.addEventListener("click", closeInspector);
  closeButton.addEventListener("click", closeInspector);
  eventRoot.addEventListener("keydown", handleKeydown);
  addMediaListener(media, handleMediaChange);
  syncSelectedView();
  syncOpenState();

  return Object.freeze({
    open: openInspector,
    close: closeInspector,
    select: selectView,
    isOpen: () => persistent || opened,
    isModalOpen: () => !persistent && opened,
    isPersistent: () => persistent,
    destroy() {
      toggle.removeEventListener("click", toggleInspector);
      backdrop.removeEventListener("click", closeInspector);
      closeButton.removeEventListener("click", closeInspector);
      eventRoot.removeEventListener("keydown", handleKeydown);
      removeMediaListener(media, handleMediaChange);
      for (const [tab, click, keydown] of tabListeners) {
        tab.removeEventListener("click", click);
        tab.removeEventListener("keydown", keydown);
      }
    },
  });
}

function addMediaListener(media, listener) {
  if (!media) return;
  if (typeof media.addEventListener === "function") media.addEventListener("change", listener);
  else if (typeof media.addListener === "function") media.addListener(listener);
}

function removeMediaListener(media, listener) {
  if (!media) return;
  if (typeof media.removeEventListener === "function") media.removeEventListener("change", listener);
  else if (typeof media.removeListener === "function") media.removeListener(listener);
}

function normalizeEntries(value, label) {
  let entries;
  if (value instanceof Map) entries = [...value.entries()];
  else if (value && !Array.isArray(value) && typeof value === "object" && typeof value[Symbol.iterator] !== "function") {
    entries = Object.entries(value);
  } else if (value && typeof value[Symbol.iterator] === "function") {
    entries = [...value].map((element) => [element?.dataset?.view || element?.dataset?.tab, element]);
  } else {
    throw new Error(`Inspector Shell 缺少 ${label}`);
  }

  if (!entries.length) throw new Error(`Inspector Shell 的 ${label} 不能为空`);
  const normalized = [];
  const names = new Set();
  for (const [rawName, element] of entries) {
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!name || !element) throw new Error(`Inspector Shell 的 ${label} 包含无效视图`);
    if (names.has(name)) throw new Error(`Inspector Shell 的 ${label} 包含重复视图：${name}`);
    names.add(name);
    normalized.push([name, element]);
  }
  return normalized;
}

function assertMatchingViews(tabs, views) {
  const tabNames = new Set(tabs.map(([name]) => name));
  const viewNames = new Set(views.map(([name]) => name));
  for (const name of tabNames) {
    if (!viewNames.has(name)) throw new Error(`Inspector Shell 缺少 ${name} 内容视图`);
  }
  for (const name of viewNames) {
    if (!tabNames.has(name)) throw new Error(`Inspector Shell 缺少 ${name} 标签`);
  }
}

function assertKnownView(name, views) {
  if (!views.some(([candidate]) => candidate === name)) {
    throw new Error(`Inspector Shell 未知视图：${String(name)}`);
  }
}

function activeElementOf(eventRoot) {
  return eventRoot?.activeElement || eventRoot?.ownerDocument?.activeElement || null;
}

function focusableElements(root, fallback) {
  const queried = typeof root.querySelectorAll === "function"
    ? [...root.querySelectorAll('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]:not([tabindex="-1"])')]
    : fallback;
  return [...new Set(queried)].filter((element) => {
    if (!element || typeof element.focus !== "function" || element.disabled || element.hidden) return false;
    if (element.getAttribute?.("tabindex") === "-1") return false;
    return !element.closest?.('.hidden, [aria-hidden="true"], [inert]');
  });
}
