let timer: ReturnType<typeof setTimeout> | undefined;
export function playerNotice(message: string) {
  const box = document.querySelector<HTMLElement>("#player-error");
  if (!box) return;
  clearTimeout(timer);
  box.textContent = message;
  box.hidden = false;
  if (message) timer = setTimeout(() => { box.textContent = ""; }, 5000);
}
