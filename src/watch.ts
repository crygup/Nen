import { mountTogether } from "./together";
import type { Playback, SegmentType } from "./shared";
const api = window.nen;
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const time = (n: number) =>
  `${Math.floor(n / 3600) ? `${Math.floor(n / 3600)}:` : ""}${String(Math.floor(n / 60) % 60).padStart(2, "0")}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
const icon = (name: string) =>
  `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6">${({ back: '<path d="m14 5-7 7 7 7"/>', play: '<path d="m8 4 12 8-12 8z" fill="currentColor" stroke="none"/>', pause: '<path d="M8 4v16M16 4v16" stroke-width="4"/>', next: '<path d="m5 5 11 7-11 7z"/><path d="M19 5v14"/>', volume: '<path d="M3 9h4l5-4v14l-5-4H3zM16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14"/>', full: '<path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6"/>', tracks: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6 11h5M14 11h4M6 15h3M12 15h6"/>', source: '<path d="M4 5h16v5H4zM4 14h16v5H4zM7 7v1M7 16v1"/>', speed: '<path d="M4 18a9 9 0 1 1 16 0M12 13l5-6"/><circle cx="12" cy="13" r="2"/>', more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>' } as Record<string, string>)[name]}</svg>`;
export function mountPlayer(actions: {
  sources: (p: Playback) => void;
  next: (p: Playback) => void;
  edit: () => void;
  error: (e: unknown) => void;
}) {
  const root = document.querySelector("#app")!;
  document.documentElement.classList.add("player-mode");
  document.documentElement.dataset.theme = "dark";
  root.innerHTML = `<section class="player-stage" aria-label="Video player"><canvas id="video-surface"></canvas><header class="watch-header"><button id="stop" class="icon-button" aria-label="Back to browsing" title="Back">${icon("back")}</button><div><strong id="watch-title"></strong><span id="watch-episode"></span></div><button id="fullscreen-top" class="icon-button" aria-label="Toggle fullscreen">${icon("full")}</button></header><div id="buffering" class="buffering" role="status">Opening video…</div><div id="skip-popup" class="skip-popup" hidden><button id="skip-current">Skip intro</button><button id="dismiss-skip" aria-label="Dismiss skip suggestion"><svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div><div id="next-popup" class="skip-popup next-popup" hidden><button id="play-next">Play next episode</button></div><footer class="watch-footer"><div class="seek-row"><span id="position">00:00</span><input id="seek" type="range" min="0" max="1" step="0.1" value="0" aria-label="Playback position"><span id="duration">00:00</span></div><div class="watch-buttons"><button id="pause" class="icon-button" aria-label="Pause">${icon("pause")}</button><button id="next-episode" class="icon-button" aria-label="Next episode" title="Next episode">${icon("next")}</button><button id="mute" class="icon-button" aria-label="Mute" title="Mute">${icon("volume")}</button><input id="volume" type="range" min="0" max="100" value="100" aria-label="Volume"><div class="watch-spacer"></div><button id="change-source" class="icon-button" aria-label="Change source" title="Change source">${icon("source")}</button><button id="speed" class="icon-button" aria-label="Playback speed" title="Playback speed">${icon("speed")}</button><button id="tracks" class="icon-button" aria-label="Audio and subtitles" title="Audio and subtitles">${icon("tracks")}</button><button id="player-more" class="icon-button" aria-label="More playback controls" title="More">${icon("more")}</button><button id="fullscreen" class="icon-button" aria-label="Fullscreen" title="Fullscreen">${icon("full")}</button></div><div id="speed-panel" class="watch-panel" hidden><strong>Playback speed</strong><output id="speed-value">1×</output><input id="speed-slider" type="range" min="0.25" max="4" step="0.05" value="1" aria-label="Playback speed"><div class="speed-presets">${[0.5, 1, 1.25, 1.5, 2, 3, 4].map((n) => `<button data-speed="${n}">${n}×</button>`).join("")}</div></div><div id="track-panel" class="watch-panel" hidden></div><div id="more-panel" class="watch-panel" hidden><button id="undo">Undo skip</button><button id="edit-marker">Edit skip times</button></div><p id="player-error" role="alert"></p></footer></section><dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;
  const el = <T extends HTMLElement = HTMLElement>(id: string) =>
    document.getElementById(id) as T;
  const togetherPanel = document.createElement("aside");
  togetherPanel.className = "watch-together";
  togetherPanel.hidden = true;
  root.append(togetherPanel);
  let removeTogether: (() => void) | undefined;
  const roomUpdate = (room: import("./shared").TogetherState) => {
    togetherPanel.hidden = !room.connected;
    root.classList.toggle("with-together", room.connected);
    if (room.connected && !removeTogether) removeTogether = mountTogether(togetherPanel, () => {}, true);
    el<HTMLButtonElement>("pause").disabled = room.connected && !room.host && !room.allowPause;
    el<HTMLInputElement>("seek").disabled = room.connected && !room.host;
    el<HTMLButtonElement>("speed").disabled = room.connected;
    el<HTMLButtonElement>("play-next").disabled = el<HTMLButtonElement>("next-episode").disabled = room.connected && !room.host;
  };
  const removeRoomListener = api.onTogether(roomUpdate);
  void api.togetherState().then(roomUpdate);
  window.addEventListener("pagehide", () => { removeRoomListener(); removeTogether?.(); }, { once: true });
  let captureError = "";
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
  void api.startVideo().catch(actions.error);
  window.addEventListener(
    "pagehide",
    () => {
      unsubscribe();
      if (decoder.state !== "closed") decoder.close();
    },
    { once: true },
  );
  let latest: Playback;
  let dragging = false;
  let timer: ReturnType<typeof setTimeout>;
  let trackKey = "";
  let activeMarker: SegmentType | undefined;
  let markerKey = "";
  let priorVolume = 100;
  const dismissed = new Set<string>();
  const run = (p: Promise<unknown>) => void p.catch(actions.error);
  const wake = () => {
    el("app").classList.remove("controls-hidden");
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (
        latest?.active &&
        !latest.paused &&
        !document.querySelector("dialog[open]") &&
        !dragging &&
        el("track-panel").hidden &&
        el("more-panel").hidden &&
        el("speed-panel").hidden
      )
        el("app").classList.add("controls-hidden");
    }, 3000);
  };
  document.addEventListener("pointermove", wake);
  document.addEventListener("pointerdown", wake);
  document.addEventListener("keydown", wake);
  el("stop").onclick = () => run(api.control("stop"));
  el("pause").onclick = () => run(api.control("pause"));
  el("fullscreen").onclick = el("fullscreen-top").onclick = () =>
    run(api.control("fullscreen"));
  el("play-next").onclick = el("next-episode").onclick = () => actions.next(latest);
  el("change-source").onclick = () => actions.sources(latest);
  el("tracks").onclick = () => {
    el("speed-panel").hidden = true;
    el("track-panel").hidden = !el("track-panel").hidden;
    el("more-panel").hidden = true;
    wake();
  };
  el("player-more").onclick = () => {
    el("speed-panel").hidden = true;
    el("more-panel").hidden = !el("more-panel").hidden;
    el("track-panel").hidden = true;
    wake();
  };
  el("speed").onclick = () => {
    el("speed-panel").hidden = !el("speed-panel").hidden;
    el("track-panel").hidden = el("more-panel").hidden = true;
    wake();
  };
  const speedSlider = el<HTMLInputElement>("speed-slider");
  let speedDragging = false;
  speedSlider.onpointerdown = (e) => {
    speedDragging = true;
    speedSlider.setPointerCapture(e.pointerId);
  };
  speedSlider.onlostpointercapture = speedSlider.onblur = () => {
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
  seek.onpointerdown = () => {
    dragging = true;
  };
  seek.oninput = () => {
    el("position").textContent = time(Number(seek.value));
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
    run(api.control("volume", Number((e.target as HTMLInputElement).value)));
  el("mute").onclick = () => {
    if ((latest?.volume ?? 100) > 0) {
      priorVolume = latest.volume ?? 100;
      run(api.control("volume", 0));
    } else run(api.control("volume", priorVolume || 100));
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
    if ((e.target as HTMLElement).closest("input,textarea,.watch-together")) return;
    if (e.code === "Space") {
      e.preventDefault();
      if (!e.repeat) run(api.control("pause"));
    }
    if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
      e.preventDefault();
      run(api.control("seekRelative", e.key === "ArrowRight" ? 5 : -5));
    }
    if (e.key.toLowerCase() === "f") run(api.control("fullscreen"));
    if (e.key === "Escape") run(api.control("stop"));
  });
  document.querySelector(".player-stage")!.addEventListener("click", (e) => {
    if (
      (e.target as HTMLElement).closest(
        "button,input,select,textarea,.watch-panel,.watch-header,.watch-footer,.skip-popup",
      )
    )
      return;
    if ((e as MouseEvent).detail === 1) run(api.control("pause"));
  });
  document.querySelector(".player-stage")!.addEventListener("dblclick", (e) => {
    if ((e.target as HTMLElement).closest("button,input,select")) return;
    run(api.control("fullscreen"));
  });
  wake();
  return (p: Playback) => {
    latest = p;
    el("buffering").hidden = !!p.error || (!!p.ready && !p.seeking && !p.buffering);
    el("buffering").textContent =
      p.loadingNotice ?? (p.seeking || p.buffering ? "Buffering video…" : p.duration > 0
        ? "Opening video…"
        : p.peers === 0
          ? "Waiting for peers. You can choose another source below."
          : p.speed > 0
            ? `Loading video · ${Math.round(p.speed / 1024)} KB/s`
            : "Waiting for video data. You can choose another source below.");
    el("watch-title").textContent = p.title ?? "Nen";
    el("watch-episode").textContent =
      p.episodeTitle && p.episodeTitle !== `Episode ${p.episode}`
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
    el("next-popup").hidden = !p.nextEpisode || !p.ready || p.duration <= 0 || p.duration - p.position > 15 || !!p.error;
    el<HTMLInputElement>("volume").value = String(p.volume ?? 100);
    el("player-error").textContent = p.error ?? captureError;
    const key = JSON.stringify(p.tracks);
    if (key !== trackKey) {
      trackKey = key;
      el("track-panel").innerHTML = (["audio", "sub"] as const)
        .map(
          (type) =>
            `<label>${type === "audio" ? "Audio" : "Subtitles"}<select data-track="${type}">${type === "sub" ? `<option value="0" ${!p.tracks.some((t) => t.type === "sub" && t.selected) ? "selected" : ""}>Off</option>` : ""}${p.tracks
              .filter((t) => t.type === type)
              .map(
                (t) =>
                  `<option value="${t.id}" ${t.selected ? "selected" : ""}>${esc(t.title || t.lang || `Track ${t.id}`)}</option>`,
              )
              .join("")}</select></label>`,
        )
        .join("");
      el("track-panel")
        .querySelectorAll<HTMLSelectElement>("select")
        .forEach(
          (select) =>
            (select.onchange = () =>
              run(
                api.control(
                  select.dataset.track as "audio" | "sub",
                  Number(select.value),
                ),
              )),
        );
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
    el("skip-popup").hidden =
      !marker || dismissed.has(markerKey);
    el("skip-current").textContent =
      marker?.type === "op" || marker?.type === "mixed-op"
        ? "Skip intro"
        : marker?.type === "recap"
          ? "Skip recap"
          : "Skip outro";
    if (p.paused) el("app").classList.remove("controls-hidden");
  };
}
