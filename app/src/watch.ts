import { playerNotice, playerNoticeText } from "./player-notice";
import { mountTogether } from "./together";
import {
  escapeHtml as esc,
  audioTrackName,
  subtitleTrackName,
  type Playback,
  type SegmentType,
} from "./shared";
const api = window.nen;
const time = (n: number) =>
  `${Math.floor(n / 3600) ? `${Math.floor(n / 3600)}:` : ""}${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
const downloadedGradient = (ranges: [number, number][], position: number) => {
  let end = position;
  for (const [start, stop] of [...ranges].sort((a, b) => a[0] - b[0])) {
    if (
      Number.isFinite(start) &&
      Number.isFinite(stop) &&
      start <= end &&
      stop > end
    )
      end = Math.min(1, stop);
  }
  return `linear-gradient(to right, transparent 0 ${position * 100}%, rgb(255 255 255 / 48%) ${position * 100}% ${end * 100}%, transparent ${end * 100}% 100%)`;
};
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">${({ back: '<path d="m14 5-7 7 7 7"/>', play: '<path d="m8 4 12 8-12 8z" fill="currentColor" stroke="none"/>', pause: '<path d="M8 4v16M16 4v16" stroke-width="4"/>', next: '<path d="m5 5 11 7-11 7z"/><path d="M19 5v14"/>', volume: '<path d="M3 9h4l5-4v14l-5-4H3zM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/>', mini: '<rect x="3" y="4" width="18" height="16" rx="2"/><rect x="12" y="12" width="7" height="6"/>', pin: '<path d="M9 3h6l-1 6 4 4v2H6v-2l4-4zM12 15v6"/>', full: '<path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"/>', audio: '<path d="M4 10v4M8 6v12M12 3v18M16 7v10M20 10v4"/>', tracks: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6 11h5M14 11h4M6 15h3M12 15h6"/>', source: '<path d="M4 5h16v5H4zM4 14h16v5H4zM7 7v1M7 16v1"/>', speed: '<path d="M4 18a9 9 0 1 1 16 0M12 13l5-6"/><circle cx="12" cy="13" r="2"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>' } as Record<string, string>)[name]}</svg>`;
export function mountPlayer(actions: {
  menu: (
    event: MouseEvent,
    actions: [string, () => Promise<unknown>][],
  ) => void;
  sources: (p: Playback) => void;
  next: (p: Playback) => void;
  edit: () => void;
  error: (e: unknown) => void;
}) {
  const root = document.querySelector("#app")!;
  document.documentElement.classList.add("player-mode");
  root.innerHTML = `<section class="player-stage" aria-label="Video player"><canvas id="video-surface"></canvas><header class="watch-header"><button id="stop" class="icon-button" aria-label="Back to browsing" title="Back">${icon("back")}</button><div><strong id="watch-title"></strong><span id="watch-episode"></span></div><span id="private-player" class="private-indicator" hidden aria-label="Private session" title="Private session"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg></span><button id="mini-pin" class="icon-button" aria-label="Pin on top" aria-pressed="false" hidden>${icon("pin")}</button><button id="mini-player" class="icon-button" aria-label="Mini player" title="Mini player" hidden>${icon("mini")}</button><button id="fullscreen-top" class="icon-button" aria-label="Toggle fullscreen">${icon("full")}</button></header><div id="buffering" class="buffering" role="status">Loading</div><div id="skip-popup" class="skip-popup" hidden><button id="skip-current">Skip intro</button><button id="dismiss-skip" aria-label="Dismiss skip suggestion"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div id="next-popup" class="skip-popup next-popup" hidden><button id="play-next">Play next episode</button></div><footer class="watch-footer"><div class="seek-row"><span id="position">00:00</span><div class="seek-track"><div id="seek-preview" class="seek-preview" hidden><img alt="Seek preview" hidden><span></span></div><input id="seek" type="range" min="0" max="1" step="0.1" value="0" aria-label="Playback position"></div><span id="duration">00:00</span></div><div class="watch-buttons"><button id="pause" class="icon-button" aria-label="Pause">${icon("pause")}</button><button id="next-episode" class="icon-button" aria-label="Next episode" title="Next episode">${icon("next")}</button><button id="mute" class="icon-button" aria-label="Mute" title="Mute">${icon("volume")}</button><input id="volume" type="range" min="0" max="100" value="100" aria-label="Volume"><div class="watch-spacer"></div><button id="change-source" class="icon-button" aria-label="Change source" title="Change source">${icon("source")}</button><button id="speed" class="icon-button" aria-label="Playback speed" title="Playback speed">${icon("speed")}</button><button id="audio-tracks" class="icon-button" aria-label="Audio tracks" title="Audio tracks">${icon("audio")}</button><button id="tracks" class="icon-button" aria-label="Subtitles" title="Subtitles">${icon("tracks")}</button><button id="player-more" class="icon-button" aria-label="More playback controls" title="More">${icon("more")}</button><button id="fullscreen" class="icon-button" aria-label="Fullscreen" title="Fullscreen">${icon("full")}</button></div><div id="speed-panel" class="watch-panel" hidden><strong>Playback speed</strong><output id="speed-value">1×</output><input id="speed-slider" type="range" min="0.25" max="4" step="0.05" value="1" aria-label="Playback speed"><div class="speed-presets">${[0.5, 1, 1.25, 1.5, 2, 3, 4].map((n) => `<button data-speed="${n}">${n}×</button>`).join("")}</div></div><div id="audio-panel" class="watch-panel track-options" hidden></div><div id="track-panel" class="watch-panel track-options" hidden></div><div id="more-panel" class="watch-panel" hidden><section class="player-statistics"><strong>Statistics</strong><dl><dt>Peers</dt><dd id="stats-peers"></dd><dt>Speed</dt><dd id="stats-speed"></dd><dt>Source</dt><dd id="stats-source"></dd><dt>Downloaded</dt><dd id="stats-downloaded"></dd></dl></section><section class="player-skips"><strong id="more-heading">Skips</strong><button id="local-subtitle" hidden>Load subtitle file</button><button id="undo">Undo skip</button><button id="edit-marker">Edit skip times</button><div id="player-downloads" hidden><hr><strong>Downloads</strong><button id="download-video">Download</button><button id="copy-magnet">Copy magnet link</button></div></section></div></footer></section><dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const volumeToast = document.createElement("div");
  volumeToast.className = "volume-toast";
  volumeToast.setAttribute("role", "status");
  volumeToast.setAttribute("aria-live", "polite");
  volumeToast.innerHTML =
    '<span>Volume</span><strong>100%</strong><span class="volume-meter" aria-hidden="true"><span></span></span>';
  document.querySelector(".player-stage")!.append(volumeToast);
  const volumePercent = volumeToast.querySelector("strong")!;
  let volumeToastTimer: ReturnType<typeof setTimeout>;
  const showVolumeToast = (value: number) => {
    volumePercent.textContent = `${value}%`;
    volumeToast.style.setProperty("--volume-level", `${value}%`);
    volumeToast.classList.add("visible");
    clearTimeout(volumeToastTimer);
    volumeToastTimer = setTimeout(
      () => volumeToast.classList.remove("visible"),
      1500,
    );
  };
  const sliderVolume = document.createElement("output");
  sliderVolume.className = "volume-value";
  sliderVolume.setAttribute("for", "volume");
  sliderVolume.setAttribute("aria-hidden", "true");
  el("volume").after(sliderVolume);
  let sliderVolumeTimer: ReturnType<typeof setTimeout>;
  const showSliderVolume = (value: number) => {
    sliderVolume.textContent = `${value}%`;
    sliderVolume.classList.add("visible");
    clearTimeout(sliderVolumeTimer);
    sliderVolumeTimer = setTimeout(
      () => sliderVolume.classList.remove("visible"),
      850,
    );
  };
  const togetherPanel = document.createElement("aside");
  togetherPanel.className = "watch-together";
  togetherPanel.hidden = true;
  root.append(togetherPanel);
  let removeTogether: (() => void) | undefined;
  const roomUpdate = (room: import("./shared").TogetherState) => {
    togetherPanel.hidden = !room.connected;
    el("change-source").hidden =
      !!latest?.local ||
      (room.connected && !room.members.find((m) => m.id === room.self)?.error);
    root.classList.toggle("with-together", room.connected);
    if (room.connected && !removeTogether)
      removeTogether = mountTogether(togetherPanel, true);
    el<HTMLButtonElement>("pause").disabled =
      room.connected && !room.host && !room.allowPause;
    el<HTMLInputElement>("seek").disabled = room.connected && !room.host;
    el<HTMLButtonElement>("speed").disabled = room.connected && !room.host;
    el<HTMLButtonElement>("play-next").disabled = el<HTMLButtonElement>(
      "next-episode",
    ).disabled = room.connected && !room.host;
  };
  const removeRoomListener = api.onTogether(roomUpdate);
  void api.togetherState().then(roomUpdate);
  window.addEventListener(
    "pagehide",
    () => {
      removeRoomListener();
      removeTogether?.();
    },
    { once: true },
  );
  let captureError = "",
    lastPlaybackError = "";
  if (api.onVideo) {
    const surface = el<HTMLCanvasElement>("video-surface");
    const context = surface.getContext("2d", { alpha: false })!;
    let waitingForKey = true,
      timestamp = 0;
    const config: VideoDecoderConfig = {
      codec: "avc1.640033",
      optimizeForLatency: true,
      hardwareAcceleration: "prefer-hardware",
    };
    const decoder = new VideoDecoder({
      output: (frame) => {
        if (
          surface.width !== frame.displayWidth ||
          surface.height !== frame.displayHeight
        ) {
          surface.width = frame.displayWidth;
          surface.height = frame.displayHeight;
        }
        context.drawImage(frame, 0, 0);
        if (captureError) {
          if (playerNoticeText() === captureError) playerNotice("");
          captureError = "";
        }
        frame.close();
        surface.dataset.ready = "true";
      },
      error: (e) => {
        captureError = e.message;
        actions.error(e);
      },
    });
    decoder.configure(config);
    const unsubscribe = api.onVideo(
      (data, key) => {
        if (decoder.state === "closed") return;
        if (decoder.decodeQueueSize > 3) {
          decoder.reset();
          decoder.configure(config);
          waitingForKey = true;
        }
        if (waitingForKey && !key) return;
        waitingForKey = false;
        decoder.decode(
          new EncodedVideoChunk({
            type: key ? "key" : "delta",
            timestamp: (timestamp += 16667),
            data,
          }),
        );
      },
      (message) => {
        captureError = message;
        actions.error(message);
      },
    );
    window.addEventListener(
      "pagehide",
      () => {
        unsubscribe();
        if (decoder.state !== "closed") decoder.close();
      },
      { once: true },
    );
  }
  void api.startVideo().catch(actions.error);
  let latest: Playback;
  let dragging = false;
  let timer: ReturnType<typeof setTimeout>;
  let trackKey = "";
  let displayedDownloadRanges = "";
  let displayedMarkers = "";
  let activeMarker: SegmentType | undefined;
  let markerKey = "";
  let priorVolume = 100;
  let volumeTarget = 100;
  let pendingVolume: number | undefined;
  let volumeSending = false;
  const dismissed = new Set<string>();
  const run = (p: Promise<unknown>) => void p.catch(actions.error);
  const sendVolume = async () => {
    if (volumeSending) return;
    volumeSending = true;
    try {
      while (pendingVolume !== undefined) {
        const value = pendingVolume;
        await api.control("volume", value);
        if (pendingVolume === value) break;
      }
    } catch (error) {
      pendingVolume = undefined;
      volumeTarget = latest?.volume ?? 100;
      el<HTMLInputElement>("volume").value = String(volumeTarget);
      actions.error(error);
    } finally {
      volumeSending = false;
      if (pendingVolume !== undefined && latest?.volume === pendingVolume)
        pendingVolume = undefined;
    }
  };
  const setVolume = (
    value: number,
    feedback: "toast" | "slider" | "none" = "none",
  ) => {
    const next = Math.max(0, Math.min(100, Math.round(value)));
    if (feedback === "toast") showVolumeToast(next);
    if (feedback !== "none") showSliderVolume(next);
    if (next === volumeTarget) return;
    if (volumeTarget > 0) priorVolume = volumeTarget;
    volumeTarget = pendingVolume = next;
    el<HTMLInputElement>("volume").value = String(next);
    void sendVolume();
  };
  const wake = () => {
    el("app").classList.remove("controls-hidden");
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (
        latest?.active &&
        latest.ready &&
        !latest.loadingNotice &&
        !latest.buffering &&
        !latest.error &&
        !latest.paused &&
        !document.querySelector("dialog[open]") &&
        !dragging &&
        el("track-panel").hidden &&
        el("audio-panel").hidden &&
        el("more-panel").hidden &&
        el("speed-panel").hidden
      )
        el("app").classList.add("controls-hidden");
    }, 3000);
  };
  const touchPlayer = () => matchMedia("(pointer: coarse)").matches;
  document.addEventListener("pointermove", (event) => {
    if (event.pointerType === "mouse") wake();
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      !touchPlayer() ||
      (event.target as Element).closest("button,input,select,.watch-panel")
    )
      wake();
  });
  document.addEventListener("pointerdown", (event) => {
    if (
      (event.target as HTMLElement).closest(
        ".watch-panel, #speed, #audio-tracks, #tracks, #player-more",
      )
    )
      return;
    for (const panel of document.querySelectorAll<HTMLElement>(".watch-panel"))
      panel.hidden = true;
  });
  document.addEventListener("keydown", wake);
  document.addEventListener("focusin", wake);
  document.addEventListener("pointerup", () => {
    dragging = false;
    if (!touchPlayer()) wake();
  });
  document.addEventListener("pointercancel", () => {
    dragging = false;
    wake();
  });
  const updateMini = (value: { active: boolean; pinned: boolean }) => {
    document.documentElement.classList.toggle("mini-player", value.active);
    el("mini-pin").hidden = !value.active;
    el("mini-pin").setAttribute("aria-pressed", String(value.pinned));
    el("mini-pin").setAttribute(
      "aria-label",
      value.pinned ? "Unpin from top" : "Pin on top",
    );
    el("mini-player").setAttribute(
      "aria-label",
      value.active ? "Exit mini player" : "Mini player",
    );
    el("mini-player").title = value.active ? "Exit mini player" : "Mini player";
  };
  if (api.miniPlayer) {
    el("mini-player").hidden = false;
    el("mini-player").onclick = () =>
      run(api.miniPlayer!("toggle").then(updateMini));
    el("mini-pin").onclick = () => run(api.miniPlayer!("pin").then(updateMini));
    run(api.miniPlayer("state").then(updateMini));
  }
  const fullscreen = () =>
    run(
      api.control("fullscreen").then(async () => {
        if (api.miniPlayer) updateMini(await api.miniPlayer("state"));
      }),
    );
  void api
    .state()
    .then((state) => {
      el("private-player").hidden = !state.settings.privateSession;
    })
    .catch(actions.error);
  document.querySelector<HTMLElement>(".player-stage")!.oncontextmenu = (
    event,
  ) => {
    const items: [string, () => Promise<unknown>][] = [];
    if (api.saveScreenshot)
      items.push([
        "Save Screenshot",
        async () => {
          const path = await api.saveScreenshot!();
          if (path)
            playerNotice(
              "Saved to " + path,
              api.revealScreenshot
                ? {
                    label: "Open folder",
                    run: () => run(api.revealScreenshot!()),
                  }
                : undefined,
            );
        },
      ]);
    if (api.downloads && !el("player-downloads").hidden)
      items.push([
        "Download video",
        async () => {
          el("download-video").click();
        },
      ]);
    if (items.length) {
      event.preventDefault();
      actions.menu(event, items);
    }
  };
  el("stop").onclick = () => run(api.control("stop"));
  el("pause").onclick = () => run(api.control("pause"));
  el("fullscreen").onclick = el("fullscreen-top").onclick = () => fullscreen();
  el("download-video").onclick = () => {
    if (!api.downloads) return;
    const button = el<HTMLButtonElement>("download-video");
    button.disabled = true;
    button.textContent = "Downloading…";
    void api.downloads
      .save()
      .then((saved) => {
        if (saved) playerNotice("Episode saved.");
      })
      .catch(actions.error)
      .finally(() => {
        button.disabled = false;
        button.textContent = "Download";
      });
  };
  el("copy-magnet").onclick = () => {
    if (api.downloads)
      void api.downloads
        .copyMagnet()
        .then(() => playerNotice("Magnet link copied."))
        .catch(actions.error);
  };
  el("local-subtitle").onclick = () => {
    if (api.local) run(api.local.subtitle());
  };
  el("play-next").onclick = el("next-episode").onclick = () =>
    actions.next(latest);
  el("change-source").onclick = () => actions.sources(latest);
  for (const [button, panel] of [
    ["audio-tracks", "audio-panel"],
    ["tracks", "track-panel"],
    ["player-more", "more-panel"],
    ["speed", "speed-panel"],
  ]) {
    el(button).onclick = () => {
      const opening = el(panel).hidden;
      for (const item of document.querySelectorAll<HTMLElement>(".watch-panel"))
        item.hidden = item.id !== panel || !opening;
      wake();
    };
  }
  const speedSlider = el<HTMLInputElement>("speed-slider");
  let speedDragging = false;
  speedSlider.onpointerdown = () => {
    speedDragging = true;
  };
  speedSlider.onchange =
    speedSlider.onpointerup =
    speedSlider.onpointercancel =
    speedSlider.onblur =
      () => {
        speedDragging = false;
      };
  speedSlider.oninput = () => {
    el("speed-value").textContent = speedSlider.value + "×";
    run(api.control("speed", Number(speedSlider.value)));
  };
  document
    .querySelectorAll<HTMLButtonElement>("[data-speed]")
    .forEach(
      (b) =>
        (b.onclick = () => run(api.control("speed", Number(b.dataset.speed)))),
    );
  el("undo").onclick = () => run(api.undo());
  el("edit-marker").onclick = actions.edit;
  const seek = el<HTMLInputElement>("seek");
  const preview = el<HTMLElement>("seek-preview");
  let previewTimer: ReturnType<typeof setTimeout>;
  let previewBucket = -1;
  let pendingPreview = false;
  let previewSource = "";
  const frames = new Map<number, string>();
  const hidePreview = () => {
    clearTimeout(previewTimer);
    previewBucket = -1;
    preview.hidden = true;
  };
  const loadPreview = async () => {
    if (pendingPreview || preview.hidden || previewBucket < 0) return;
    const bucket = previewBucket,
      source = previewSource;
    const image = preview.querySelector("img")!;
    if (frames.has(bucket)) {
      image.src = frames.get(bucket)!;
      image.hidden = false;
      return;
    }
    pendingPreview = true;
    preview.classList.add("loading-frame");
    try {
      const src = await api.seekPreview(bucket * 5);
      if (src && source === previewSource) {
        frames.set(bucket, src);
        if (frames.size > 120) frames.delete(frames.keys().next().value!);
        if (bucket === previewBucket && !preview.hidden) {
          image.src = src;
          image.hidden = false;
        }
      }
      if (!src && bucket === previewBucket)
        preview.dataset.notice = "Frame unavailable";
    } catch {
      if (bucket === previewBucket)
        preview.dataset.notice = "Frame unavailable";
    } finally {
      pendingPreview = false;
      preview.classList.remove("loading-frame");
      if (
        (bucket !== previewBucket || source !== previewSource) &&
        !preview.hidden
      )
        void loadPreview();
    }
  };
  seek.onpointermove = (event) => {
    const source = `${latest?.mediaId}:${latest?.episode}:${latest?.local?.folder}:${latest?.local?.name}:${latest?.release?.hash}`;
    if (source !== previewSource) {
      previewSource = source;
      frames.clear();
      previewBucket = -1;
    }
    const bounds = seek.getBoundingClientRect();
    const fraction = Math.max(
      0,
      Math.min(1, (event.clientX - bounds.left) / bounds.width),
    );
    const seconds = Math.min(
      Math.max(0, (latest?.duration ?? 0) - 0.1),
      fraction * (latest?.duration ?? 0),
    );
    if (!latest?.duration) return;
    preview.hidden = false;
    preview.style.left = `${Math.max(Math.min(104, bounds.width / 2), Math.min(bounds.width - 104, fraction * bounds.width))}px`;
    preview.querySelector("span")!.textContent = time(seconds);
    const bucket = Math.floor(seconds / 5);
    if (bucket === previewBucket) return;
    previewBucket = bucket;
    delete preview.dataset.notice;
    const image = preview.querySelector("img")!;
    image.hidden = !frames.has(bucket);
    if (frames.has(bucket)) image.src = frames.get(bucket)!;
    clearTimeout(previewTimer);
    previewTimer = setTimeout(() => void loadPreview(), 80);
  };
  seek.addEventListener("pointerleave", hidePreview);
  seek.addEventListener("blur", hidePreview);
  window.addEventListener("pagehide", hidePreview, { once: true });

  seek.onpointerdown = () => {
    dragging = true;
  };
  seek.oninput = () => {
    el("position").textContent = time(Number(seek.value));
    seek.style.setProperty(
      "--downloaded",
      downloadedGradient(
        latest?.download?.ranges ?? [],
        Number(seek.value) / Number(seek.max),
      ),
    );
    seek.style.setProperty(
      "--played",
      `${(Number(seek.value) / Number(seek.max)) * 100}%`,
    );
  };
  seek.onchange = () => {
    run(api.control("seek", Number(seek.value)));
    dragging = false;
    wake();
  };
  seek.onpointercancel = () => {
    dragging = false;
  };
  seek.onblur = () => {
    dragging = false;
  };
  el<HTMLInputElement>("volume").oninput = (e) =>
    setVolume(Number((e.target as HTMLInputElement).value), "slider");
  el("mute").onclick = () => {
    setVolume(volumeTarget > 0 ? 0 : priorVolume || 100);
  };
  el("skip-current").onclick = () => {
    dismissed.add(markerKey);
    el("skip-popup").hidden = true;
    if (activeMarker) run(api.skip(activeMarker));
  };
  el("dismiss-skip").onclick = () => {
    dismissed.add(markerKey);
    el("skip-popup").hidden = true;
  };
  document.addEventListener("keydown", (e) => {
    if (
      document.querySelector("dialog[open]") ||
      (e.target instanceof HTMLInputElement && e.target.type !== "range") ||
      e.target instanceof HTMLSelectElement
    )
      return;
    if ((e.target as HTMLElement).closest("input,textarea,.watch-together"))
      return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!e.repeat) run(api.control("pause"));
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      run(api.control("seekRelative", e.key === "ArrowRight" ? 5 : -5));
    }
    if (
      (e.key === "ArrowUp" || e.key === "ArrowDown") &&
      !e.altKey &&
      !e.ctrlKey &&
      !e.metaKey
    ) {
      e.preventDefault();
      setVolume(volumeTarget + (e.key === "ArrowUp" ? 5 : -5), "toast");
    }
    if (e.key.toLowerCase() === "f") fullscreen();
    if (e.key === "Escape" && !e.repeat) {
      e.preventDefault();
      run(api.control("stop"));
    }
  });
  const stage = document.querySelector<HTMLElement>(".player-stage")!;
  const interactive = (event: Event) =>
    (event.target as Element).closest(
      "button,input,select,textarea,.watch-panel,.watch-header,.watch-footer,.skip-popup,dialog",
    );
  let tapTimer: ReturnType<typeof setTimeout> | undefined;
  let tapSide = 0;
  stage.style.touchAction = "manipulation";
  stage.addEventListener("click", (event) => {
    if (interactive(event)) {
      clearTimeout(tapTimer);
      tapTimer = undefined;
      return;
    }
    if (!touchPlayer()) {
      if (event.detail === 1) run(api.control("pause"));
      return;
    }
    const bounds = stage.getBoundingClientRect();
    const side = event.clientX < bounds.left + bounds.width / 2 ? -1 : 1;
    if (tapTimer !== undefined) {
      clearTimeout(tapTimer);
      tapTimer = undefined;
      if (side === tapSide) run(api.control("seekRelative", side * 5));
      return;
    }
    tapSide = side;
    tapTimer = setTimeout(() => {
      tapTimer = undefined;
      if (el("app").classList.contains("controls-hidden")) wake();
      else {
        clearTimeout(timer);
        el("app").classList.add("controls-hidden");
      }
    }, 280);
  });
  stage.addEventListener("dblclick", (event) => {
    if (touchPlayer() || interactive(event)) return;
    fullscreen();
  });
  wake();
  return (p: Playback) => {
    el("player-downloads").hidden = !api.downloads || !p.release || !!p.local;
    if (p.local) el("change-source").hidden = true;
    el("local-subtitle").hidden = !p.local;
    el("undo").hidden = el("edit-marker").hidden = !!p.local;
    el("more-heading").textContent = p.local ? "Subtitles" : "Skips";
    for (const id of ["stats-peers", "stats-speed", "stats-downloaded"]) {
      el(id).hidden = !!p.local;
      (el(id).previousElementSibling as HTMLElement).hidden = !!p.local;
    }
    const ranges = p.download?.ranges;
    el("stats-peers").textContent = ranges ? String(p.peers) : "Not available";
    el("stats-speed").textContent = ranges
      ? (p.speed / 1000000).toFixed(2) + " MB/s"
      : "Not available";
    el("stats-source").textContent = p.local
      ? p.local.name
      : p.sourceName || "Not available";
    el("stats-downloaded").textContent = ranges
      ? (
          Math.min(
            1,
            Math.max(
              0,
              ranges.reduce((sum, [start, end]) => sum + end - start, 0),
            ),
          ) * 100
        ).toFixed(2) + "%"
      : "Not available";
    const wasBlocked =
      !latest?.ready ||
      latest.paused ||
      latest.buffering ||
      latest.loadingNotice ||
      latest.error;
    latest = p;
    if (
      wasBlocked &&
      p.ready &&
      !p.paused &&
      !p.buffering &&
      !p.loadingNotice &&
      !p.error
    )
      wake();
    el("buffering").hidden =
      !p.error && !p.loadingNotice && !!p.ready && !p.seeking && !p.buffering;
    el("buffering").classList.toggle("failed", !!p.error);
    el("buffering").textContent =
      p.error ??
      (p.loadingNotice === "Press Play to start." ||
      p.loadingNotice === "Choose a source to continue."
        ? p.loadingNotice
        : "Loading");
    el("watch-title").textContent = p.title ?? "Nen";
    el("watch-episode").textContent = p.local
      ? p.local.name
      : p.episodeTitle && p.episodeTitle !== `Episode ${p.episode}`
        ? `${p.episodeTitle} · Episode ${p.episode}`
        : p.episode
          ? `Episode ${p.episode}`
          : "";
    const rate = p.playbackRate ?? 1;
    if (!speedDragging) {
      el("speed-value").textContent = rate + "×";
      if (Number(speedSlider.value) !== rate) speedSlider.value = String(rate);
    }
    document
      .querySelectorAll<HTMLElement>("[data-speed]")
      .forEach((b) =>
        b.setAttribute(
          "aria-pressed",
          String(Number(b.dataset.speed) === rate),
        ),
      );
    el("position").textContent = time(p.position);
    el("duration").textContent = time(p.duration);
    seek.max = String(p.duration || 1);
    if (!dragging) {
      seek.value = String(p.position);
      seek.style.setProperty(
        "--played",
        `${(p.position / (p.duration || 1)) * 100}%`,
      );
    }
    const download = p.active ? p.download : undefined;
    const position = Math.max(
      0,
      Math.min(1, Number(seek.value) / (p.duration || 1)),
    );
    const downloadKey = JSON.stringify([download?.ranges ?? [], position]);
    if (downloadKey !== displayedDownloadRanges) {
      displayedDownloadRanges = downloadKey;
      seek.style.setProperty(
        "--downloaded",
        downloadedGradient(download?.ranges ?? [], position),
      );
    }
    const timelineKey = JSON.stringify([p.active, p.duration, p.markers]);
    if (timelineKey !== displayedMarkers) {
      displayedMarkers = timelineKey;
      const segments = p.active && p.duration > 0 ? p.markers : [];
      const kinds = {
        op: "intro",
        "mixed-op": "intro",
        ed: "outro",
        "mixed-ed": "outro",
        recap: "recap",
      } as const;
      const gradients: string[] = [];
      for (const marker of segments) {
        const kind = kinds[marker.type];
        const start = Math.max(0, marker.start),
          end = Math.min(p.duration, marker.end);
        if (
          !kind ||
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end <= start
        )
          continue;
        gradients.push(
          `linear-gradient(to right, transparent 0 ${(start / p.duration) * 100}%, ${{ intro: "#70b8ef", outro: "#c69ae8", recap: "#e8b65e" }[kind]} ${(start / p.duration) * 100}% ${(end / p.duration) * 100}%, transparent ${(end / p.duration) * 100}% 100%)`,
        );
      }
      seek.style.setProperty(
        "--segments",
        gradients.join(",") || "linear-gradient(transparent, transparent)",
      );
    }
    const pauseLabel = p.paused ? "Play" : "Pause";
    if (el("pause").getAttribute("aria-label") !== pauseLabel) {
      el("pause").innerHTML = icon(p.paused ? "play" : "pause");
      el("pause").setAttribute("aria-label", pauseLabel);
    }
    el("next-episode").hidden = !p.nextEpisode;
    const nextLabel = p.nextMediaId ? "Start next season" : "Play next episode";
    el("play-next").textContent = nextLabel;
    el("next-episode").setAttribute("aria-label", nextLabel);
    el("next-episode").title = nextLabel;
    el("next-popup").hidden =
      !p.nextEpisode ||
      !p.ready ||
      p.duration <= 0 ||
      p.duration - p.position > 15 ||
      !!p.error;
    const actualVolume = p.volume ?? 100;
    if (
      pendingVolume === undefined ||
      (!volumeSending && actualVolume === pendingVolume)
    ) {
      pendingVolume = undefined;
      volumeTarget = actualVolume;
      el<HTMLInputElement>("volume").value = String(actualVolume);
      if (actualVolume > 0) priorVolume = actualVolume;
    }
    const playbackError = p.error || "";
    if (playbackError !== lastPlaybackError) {
      if (playbackError || playerNoticeText() === lastPlaybackError)
        playerNotice(playbackError);
      lastPlaybackError = playbackError;
    }
    const key = JSON.stringify(p.tracks);
    if (key !== trackKey) {
      trackKey = key;
      for (const type of ["audio", "sub"] as const) {
        const panel = el(type === "audio" ? "audio-panel" : "track-panel");
        const tracks = p.tracks.filter((t) => t.type === type);
        panel.innerHTML =
          "<strong>" +
          (type === "audio" ? "Audio tracks" : "Subtitles") +
          '</strong><div class="track-list">' +
          (type === "sub"
            ? '<button data-track-id="0" aria-pressed="' +
              !tracks.some((t) => t.selected) +
              '">Off</button>'
            : "") +
          tracks
            .map(
              (t) =>
                '<button data-track-id="' +
                t.id +
                '" aria-pressed="' +
                !!t.selected +
                '">' +
                esc(
                  type === "audio" ? audioTrackName(t) : subtitleTrackName(t),
                ) +
                "</button>",
            )
            .join("") +
          (!tracks.length
            ? "<p>No " +
              (type === "audio" ? "audio tracks" : "subtitles") +
              " available.</p>"
            : "") +
          "</div>";
        if (type === "sub") {
          const controls = document.createElement("div");
          controls.className = "subtitle-adjustments";
          panel.prepend(controls);
          void api.state().then((state) => {
            for (const [key, label, min, max, step, fallback] of [
              ["subtitleDelay", "Delay", -30, 30, 0.1, 0],
              ["subtitleSize", "Size", 50, 250, 5, 100],
              ["subtitlePosition", "Vertical position", 0, 100, 1, 5],
            ] as const) {
              let value = state.settings[key] ?? fallback;
              const row = document.createElement("div");
              row.innerHTML = `<span>${label}</span><div class="subtitle-stepper"><button aria-label="Decrease ${label.toLowerCase()}">−</button><output aria-live="polite"></output><button aria-label="Increase ${label.toLowerCase()}">+</button></div>`;
              const buttons = row.querySelectorAll("button");
              const update = () => {
                row.querySelector("output")!.textContent =
                  key === "subtitleDelay"
                    ? value === 0
                      ? "0 s"
                      : `${value > 0 ? "+" : ""}${value.toFixed(1)} s`
                    : `${value}%`;
                buttons[0].disabled = value <= min;
                buttons[1].disabled = value >= max;
              };
              buttons.forEach(
                (button, i) =>
                  (button.onclick = () => {
                    value = Math.max(
                      min,
                      Math.min(
                        max,
                        Math.round((value + (i ? step : -step)) * 10) / 10,
                      ),
                    );
                    update();
                    run(api.control(key, value));
                  }),
              );
              update();
              controls.append(row);
            }
          });
        }
        panel
          .querySelectorAll<HTMLButtonElement>("[data-track-id]")
          .forEach((button) => {
            button.onclick = () =>
              run(api.control(type, Number(button.dataset.trackId)));
          });
      }
    }
    const marker = p.markers.find(
      (m) => p.position >= m.start && p.position < m.end,
    );
    const nextKey = marker
      ? JSON.stringify([
          p.mediaId,
          p.episode,
          p.release?.hash,
          marker.type,
          marker.start,
          marker.end,
        ])
      : "";
    if (nextKey !== markerKey) {
      markerKey = nextKey;
    }
    activeMarker = marker?.type;
    el("skip-popup").hidden = !marker || dismissed.has(markerKey);
    el("skip-current").textContent =
      marker?.type === "op" || marker?.type === "mixed-op"
        ? "Skip intro"
        : marker?.type === "recap"
          ? "Skip recap"
          : "Skip outro";
    if (
      (!touchPlayer() && p.paused) ||
      p.error ||
      p.loadingNotice ||
      !p.ready ||
      p.buffering
    )
      el("app").classList.remove("controls-hidden");
  };
}
