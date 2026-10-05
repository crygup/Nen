export async function toggleFullscreen(
  video: HTMLVideoElement,
  doc = document,
) {
  const page = doc as Document & {
    webkitFullscreenElement?: Element;
    webkitExitFullscreen?: () => void;
  };
  const root = doc.documentElement as HTMLElement & {
    webkitRequestFullscreen?: () => void;
  };
  const media = video as HTMLVideoElement & {
    webkitDisplayingFullscreen?: boolean;
    webkitEnterFullscreen?: () => void;
    webkitExitFullscreen?: () => void;
  };
  if (doc.fullscreenElement) return doc.exitFullscreen();
  if (page.webkitFullscreenElement && page.webkitExitFullscreen)
    return page.webkitExitFullscreen();
  if (media.webkitDisplayingFullscreen && media.webkitExitFullscreen)
    return media.webkitExitFullscreen();
  if (root.requestFullscreen && doc.fullscreenEnabled !== false) {
    await root.requestFullscreen();
    const orientation = doc.defaultView?.screen.orientation as
      | (ScreenOrientation & { lock?: (value: string) => Promise<void> })
      | undefined;
    if (doc.defaultView?.matchMedia("(pointer: coarse)").matches) {
      try {
        await orientation?.lock?.("landscape");
      } catch {
        /* The browser can refuse orientation locking. */
      }
    }
    return;
  }
  if (root.webkitRequestFullscreen) return root.webkitRequestFullscreen();
  if (media.webkitEnterFullscreen) return media.webkitEnterFullscreen();
  throw Error("Fullscreen is not available in this browser.");
}
