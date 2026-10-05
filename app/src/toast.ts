export let dismissToast = () => {};
export function showToast(
  message: string,
  parent: HTMLElement = document.body,
  persistent = false,
) {
  dismissToast();
  const toast = document.createElement("div");
  toast.className = "update-toast";
  toast.setAttribute("popover", "manual");
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  const label = document.createElement("span");
  const close = document.createElement("button");
  close.type = "button";
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss notification");
  close.innerHTML =
    '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>';
  toast.append(label, close);
  // A toast outside a modal dialog is inert, even when its popover is visible.
  const modal = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (modal && !modal.contains(parent)) parent = modal;
  parent.append(toast);
  toast.showPopover();
  toast.classList.add("visible");
  let fade: ReturnType<typeof setTimeout> | undefined;
  let remove: ReturnType<typeof setTimeout> | undefined;
  const update = (text: string, keepVisible = false) => {
    clearTimeout(fade);
    clearTimeout(remove);
    label.textContent = text;
    toast.classList.add("visible");
    if (!keepVisible)
      fade = setTimeout(() => {
        toast.classList.remove("visible");
        remove = setTimeout(() => toast.remove(), 250);
      }, 3000);
  };
  dismissToast = () => {
    clearTimeout(fade);
    clearTimeout(remove);
    toast.remove();
  };
  close.onclick = dismissToast;
  update(message, persistent);
  return { element: toast, update };
}
