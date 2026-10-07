import { showToast } from "./toast";
let notice: ReturnType<typeof showToast> | undefined;
export function playerNoticeText() {
  return notice?.element.isConnected
    ? (notice.element.querySelector("span")?.textContent ?? "")
    : "";
}
export function playerNotice(
  message: string,
  action?: { label: string; run: () => void },
) {
  notice?.element.remove();
  notice = message
    ? showToast(
        message,
        (document.fullscreenElement as HTMLElement) ?? document.body,
        !!action,
      )
    : undefined;
  if (notice && action) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = action.label;
    button.onclick = action.run;
    notice.element.querySelector(".toast-close")!.before(button);
  }
}
