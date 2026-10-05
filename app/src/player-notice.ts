import { showToast } from "./toast";
let notice: ReturnType<typeof showToast> | undefined;
export function playerNoticeText() {
  return notice?.element.isConnected
    ? (notice.element.querySelector("span")?.textContent ?? "")
    : "";
}
export function playerNotice(message: string) {
  notice?.element.remove();
  notice = message
    ? showToast(
        message,
        (document.fullscreenElement as HTMLElement) ?? document.body,
      )
    : undefined;
}
