export function createTaskNavigation({ sidebar, toggle, backdrop, media, root = document }) {
  if (!sidebar || !toggle || !backdrop || !media) throw new Error("Task Navigation 缺少必要界面节点");
  let open = false;

  const sync = () => {
    const visible = Boolean(media.matches && open);
    sidebar.classList.toggle("mobile-open", visible);
    backdrop.classList.toggle("hidden", !visible);
    toggle.setAttribute("aria-expanded", String(visible));
    if (media.matches) sidebar.setAttribute("aria-hidden", String(!visible));
    else sidebar.removeAttribute("aria-hidden");
  };
  const openNavigation = () => {
    open = true;
    sync();
  };
  const closeNavigation = () => {
    open = false;
    sync();
  };
  const toggleNavigation = () => open ? closeNavigation() : openNavigation();
  const handleKeydown = (event) => {
    if (event.key !== "Escape" || !media.matches || !open) return;
    event.preventDefault?.();
    closeNavigation();
  };
  const handleMediaChange = () => {
    if (!media.matches) open = false;
    sync();
  };

  toggle.addEventListener("click", toggleNavigation);
  backdrop.addEventListener("click", closeNavigation);
  root.addEventListener("keydown", handleKeydown);
  media.addEventListener?.("change", handleMediaChange);
  sync();

  return Object.freeze({
    open: openNavigation,
    close: closeNavigation,
    isOpen: () => Boolean(media.matches && open),
    destroy() {
      toggle.removeEventListener("click", toggleNavigation);
      backdrop.removeEventListener("click", closeNavigation);
      root.removeEventListener("keydown", handleKeydown);
      media.removeEventListener?.("change", handleMediaChange);
    },
  });
}
