import { validateLibrary } from "../app/src/shared";
import { toggleFullscreen } from "./fullscreen";
declare const NEN_BROWSER_VERSION: string;
import { browserRoom } from "./room";
import {
  episodeAvailability,
  matchSubtitle,
  type SubtitleSelection,
} from "../app/src/shared";
import { connectAccount } from "./account";
import Hls from "hls.js";
import {
  migrateWatchLater,
  newEntry,
  activeRun,
  markEpisode,
  validateTransfer,
  mergeWatch,
} from "../app/electron/watch-data";
import type {
  API,
  State,
  Media,
  Playback,
  WatchEntry,
  Marker,
} from "../app/src/shared";
import "./browser.css";

if (window.parent !== window) {
  const parentApi = (window.parent as Window & { nen: API }).nen;
  window.nen = {
    ...parentApi,
    onPlayback: (fn) => {
      const remove = parentApi.onPlayback(fn);
      window.addEventListener("pagehide", remove, { once: true });
      return remove;
    },
    onTogether: (fn) => {
      const remove = parentApi.onTogether(fn);
      window.addEventListener("pagehide", remove, { once: true });
      return remove;
    },
  };
  await import("../app/src/main");
} else {
  const key = "nen-browser-state-v2";
  const defaults: State = {
    version: NEN_BROWSER_VERSION,
    settings: {
      theme: "dark",
      autoSkip: false,
      autoNext: false,
      audio: "",
      subtitles: "eng",
      subtitlePosition: 15,
      source: "all",
      sourceMode: "auto",
      qualities: [1080, 720, 480, 360],
    },
    progress: {},
    watch: {},
    favorites: {},
    favoriteChanges: {},
    anilist: { connected: false, baseline: {} },
    markers: {},
    mappings: {},
  };
  let state: State;
  let subtitleSelection: SubtitleSelection | undefined;
  try {
    const saved = sessionStorage.getItem("nen-subtitle-selection");
    if (saved !== null) subtitleSelection = JSON.parse(saved);
  } catch {}
  try {
    state = {
      ...structuredClone(defaults),
      ...JSON.parse(localStorage.getItem(key) || "null"),
    };
  } catch {
    state = structuredClone(defaults);
  }
  state.settings = {
    ...defaults.settings,
    ...state.settings,
    sourceMode: "auto",
  };
  if (migrateWatchLater(state))
    localStorage.setItem(key, JSON.stringify(state));
  state.version = NEN_BROWSER_VERSION;
  state.anilist.connected = false;
  const playbackListeners = new Set<(p: Playback) => void>(),
    watchListeners = new Set<(s: State) => void>();
  let p: Playback = {
    active: false,
    position: 0,
    duration: 0,
    paused: true,
    tracks: [],
    speed: 0,
    peers: 0,
    markers: [],
  };
  let video: HTMLVideoElement,
    hls: Hls | undefined,
    current: Media | undefined,
    controller: AbortController | undefined,
    lastSave = 0,
    undoPosition = 0,
    imported: Record<string, WatchEntry> | undefined;
  const snapshot = () => structuredClone(state);
  function save(notify = false) {
    localStorage.setItem(key, JSON.stringify(state));
    if (notify) watchListeners.forEach((fn) => fn(snapshot()));
  }
  async function request(path: string, params: Record<string, unknown> = {}) {
    const response = await fetch(
      "/nen-api/" +
        path +
        "?" +
        new URLSearchParams(
          Object.entries(params).map(([k, v]) => [k, String(v)]),
        ),
      { signal: AbortSignal.timeout(90000) },
    );
    const body = await response.json();
    if (!response.ok || body.error)
      throw Error(body.error || "Request failed.");
    return body;
  }
  if (!localStorage.getItem(key)) {
    try {
      const desktop = await request("desktop-data");
      state.watch = validateTransfer({
        version: 1,
        entries: Object.values(desktop.watch),
      });
      state.favorites = validateTransfer({
        version: 1,
        entries: Object.values(desktop.favorites),
      });
      state.progress = desktop.progress;
      state.settings = {
        ...state.settings,
        ...desktop.settings,
        sourceMode: "auto",
      };
      save();
    } catch {
      save();
    }
  }
  function persistProgress() {
    if (
      !current ||
      !p.episode ||
      !video ||
      !Number.isFinite(video.duration) ||
      video.duration <= 0
    )
      return;
    const id = String(current.id),
      entry = (state.watch[id] ||= newEntry(current));
    const previous = activeRun(entry).episodes[String(p.episode)];
    const watched =
      previous?.watched || video.currentTime / video.duration > 0.85;
    markEpisode(entry, p.episode, {
      position: video.currentTime,
      duration: video.duration,
      watched,
    });
    if (watched && entry.status === "PLANNING") entry.status = "CURRENT";
    if (current.episodes && entry.count >= current.episodes)
      entry.status = "COMPLETED";
    state.progress[`${id}:${p.episode}`] = {
      ...state.progress[`${id}:${p.episode}`],
      mediaId: current.id,
      malId: current.idMal,
      title: current.title.english || current.title.romaji,
      cover: current.coverImage.large,
      totalEpisodes: current.episodes,
      episode: p.episode,
      episodeTitle: p.episodeTitle,
      position: video.currentTime,
      duration: video.duration,
      watched,
      updated: Date.now(),
    };
    state.volume = video.volume * 100;
    save();
  }
  const originalCues = new WeakMap<VTTCue, { start: number; end: number }>();
  function updateSubtitles() {
    if (!video) return;
    video.style.setProperty(
      "--subtitle-size",
      `${(2 * (state.settings.subtitleSize ?? 100)) / 100}vw`,
    );
    for (const track of Array.from(video.textTracks))
      for (const cue of Array.from(track.cues || []) as VTTCue[]) {
        if (!originalCues.has(cue))
          originalCues.set(cue, { start: cue.startTime, end: cue.endTime });
        const original = originalCues.get(cue)!;
        const delay = state.settings.subtitleDelay ?? 0;
        cue.startTime = Math.max(0, original.start + delay);
        cue.endTime = Math.max(0.01, original.end + delay);
        cue.snapToLines = false;
        cue.line = 100 - (state.settings.subtitlePosition ?? 15);
        cue.lineAlign = "end";
      }
  }
  async function autoplay() {
    if (room.state.connected) return;
    try {
      await video.play();
    } catch {
      p.loadingNotice = "Press Play to start.";
      publish();
    }
  }
  function publish() {
    document.documentElement.classList.toggle(
      "awaiting-play",
      p.loadingNotice === "Press Play to start.",
    );
    if (video) {
      p.position = video.currentTime;
      p.duration = Number.isFinite(video.duration) ? video.duration : 0;
      p.paused = video.paused;
      p.volume = video.muted ? 0 : video.volume * 100;
      p.playbackRate = video.playbackRate;
      p.ready = video.readyState >= 2;
      p.download = {
        ranges: Array.from(
          { length: video.buffered.length },
          (_, i) =>
            [
              video.buffered.start(i) / (p.duration || 1),
              video.buffered.end(i) / (p.duration || 1),
            ] as [number, number],
        ),
      };
      p.tracks = [
        ...(hls?.audioTracks || []).map((track, i) => ({
          id: i + 1,
          type: "audio",
          title: track.name,
          lang: track.lang,
          selected: hls!.audioTrack === i,
        })),
        ...Array.from(video.textTracks).map((track, i) => ({
          id: i + 1,
          type: "sub",
          title: track.label,
          lang: track.language,
          selected: track.mode === "showing",
        })),
      ];
    }
    playbackListeners.forEach((fn) => fn(structuredClone(p)));
  }
  async function startStream(id: number, episode: number) {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    persistProgress();
    if (!room.state.connected)
      history.replaceState(null, "", `/?player=1&id=${id}&episode=${episode}`);
    hls?.destroy();
    hls = undefined;
    video.pause();
    video.removeAttribute("src");
    video.replaceChildren();
    video.load();
    p = {
      active: true,
      sourceName: "AnimeParadise",
      mediaId: id,
      episode,
      position: 0,
      duration: 0,
      paused: true,
      tracks: [],
      markers: [],
      speed: 0,
      peers: 0,
      loadingNotice: "Finding a stream…",
    };
    publish();
    try {
      current = await request("media", { id });
      if (signal.aborted) return;
      p.title = current!.title.english || current!.title.romaji;
      p.cover = current!.coverImage.large;
      const source = await request("stream", { id, episode });
      if (signal.aborted) return;
      if (!source.streamLink) throw Error("No stream available.");
      p.episodeTitle = undefined;
      void request("episodes", { id, page: Math.floor((episode - 1) / 50) + 1 })
        .then((data) => {
          if (!signal.aborted) {
            p.episodeTitle = data.items.find(
              (item: { number: number }) => item.number === episode,
            )?.title;
            publish();
          }
        })
        .catch(() => {});
      void (async () => {
        const media = current!;
        if (episodeAvailability(media, episode + 1).released === true) {
          if (!signal.aborted) {
            p.nextEpisode = episode + 1;
            publish();
          }
          return;
        }
        if (!media.episodes || episode < media.episodes) return;
        for (const edge of media.relations?.edges || []) {
          if (edge.relationType !== "SEQUEL" || edge.node.type !== "ANIME")
            continue;
          const sequel: Media = await request("media", { id: edge.node.id });
          if (signal.aborted) return;
          if (episodeAvailability(sequel, 1).released === true) {
            p.nextEpisode = 1;
            p.nextMediaId = sequel.id;
            publish();
            break;
          }
        }
      })().catch(() => {});
      p.markers =
        state.markers[`${id}:${episode}`] ||
        Object.entries(source.skipData || {})
          .filter(([, v]: any) => v.end > v.start)
          .map(([name, v]: any) => ({
            type: name === "intro" ? "op" : "ed",
            start: v.start,
            end: v.end,
            confirmed: true,
          }));
      for (const sub of source.subData || []) {
        if (sub.type !== "vtt" || !sub.src) continue;
        const url = new URL(sub.src, "https://stream.animeparadise.moe");
        if (url.protocol !== "https:") continue;
        const track = document.createElement("track");
        track.kind = "subtitles";
        track.label = sub.label || "Subtitles";
        track.srclang = /english/i.test(sub.label) ? "en" : "";
        track.src = url.href;
        track.default =
          state.settings.subtitles !== "no" && !video.children.length;
        track.onload = () => {
          for (const cue of Array.from(track.track.cues || [])) {
            (cue as VTTCue).line = -4;
            (cue as VTTCue).text = (cue as VTTCue).text.replace(/<\/?i>/gi, "");
          }
          updateSubtitles();
        };
        video.append(track);
      }
      if (subtitleSelection !== undefined) {
        const tracks = Array.from(video.querySelectorAll("track"));
        const selected =
          subtitleSelection &&
          matchSubtitle(
            tracks.map((element) => ({
              element,
              title: element.label,
              lang: element.srclang,
            })),
            subtitleSelection,
          );
        if (selected || subtitleSelection === null)
          for (const element of tracks) {
            element.default = element === selected?.element;
            element.track.mode =
              element === selected?.element ? "showing" : "disabled";
          }
      }
      const url =
        "https://stream.animeparadise.moe/m3u8?url=" +
        encodeURIComponent(source.streamLink);
      video.volume = Math.max(0, Math.min(1, (state.volume ?? 100) / 100));
      video.onloadedmetadata = () => {
        const entry = state.watch[String(id)];
        const progress = entry
          ? activeRun(entry).episodes[String(episode)]
          : state.progress[`${id}:${episode}`];
        if (progress && !progress.watched && progress.position > 0)
          video.currentTime = Math.min(progress.position, video.duration - 1);
        publish();
      };
      if (Hls.isSupported()) {
        const engine = (hls = new Hls());
        engine.attachMedia(video);
        engine.loadSource(url);
        engine.on(Hls.Events.MANIFEST_PARSED, () => {
          if (signal.aborted) return;
          const preferred =
            state.seriesAudio?.[String(id)] || state.settings.audio;
          const track = engine.audioTracks.findIndex(
            (t) =>
              t.lang === preferred ||
              t.lang?.slice(0, 2) === preferred.slice(0, 2),
          );
          if (preferred && track >= 0) engine.audioTrack = track;
          const qualities = state.settings.qualities || [];
          const levels = engine.levels
            .map((l, i) => ({ h: l.height, i }))
            .filter((l) => qualities.includes(l.h));
          if (levels.length)
            engine.autoLevelCapping = Math.max(...levels.map((l) => l.i));
          p.loadingNotice = undefined;
          publish();
          void autoplay();
        });
        engine.on(Hls.Events.ERROR, (_event, data) => {
          if (signal.aborted) return;
          const denied = data.response?.code === 403;
          if (data.fatal || denied) {
            engine.stopLoad();
            video.pause();
            p.error = denied
              ? "The stream provider denied access to this video. Try another episode or try again later."
              : `Stream failed: ${data.details}. Reload the page to retry.`;
            p.loadingNotice = undefined;
            p.buffering = false;
            publish();
          }
        });
        engine.on(Hls.Events.AUDIO_TRACK_SWITCHED, publish);
      } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
        video.src = url;
        p.loadingNotice = undefined;
        await autoplay();
      } else throw Error("HLS playback is not supported in this browser.");
    } catch (error) {
      if (!signal.aborted) {
        p.error = (error as Error).message;
        p.loadingNotice = undefined;
        publish();
      }
    }
  }
  function download(name: string, value: unknown) {
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(value, null, 2)], { type: "application/json" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const idle = async () => ({ busy: false, message: "" });
  let playerFrame: HTMLIFrameElement | undefined;
  let pendingSelection: { id: number; episode: number } | undefined;
  const { room, api: roomApi } = browserRoom(
    () => p,
    async (id, episode) => {
      pendingSelection = { id, episode };
      if (!playerFrame) {
        playerFrame = document.createElement("iframe");
        playerFrame.className = "room-player";
        playerFrame.allow = "autoplay; fullscreen";
        playerFrame.src = "/?player=1&id=" + id + "&episode=" + episode;
        document.body.append(playerFrame);
      } else await startStream(id, episode);
    },
    () => video,
  );
  const account = connectAccount(
    () => state,
    () => save(true),
  );
  const desktopOnly = async (): Promise<never> => {
    throw Error("Profiles are available in the desktop app.");
  };
  const api: API = {
    state: async () => snapshot(),
    settings: async (value) => {
      state.settings = { ...defaults.settings, ...value, sourceMode: "auto" };
      save();
    },
    catalog: (mode, search, page, perPage) =>
      request("catalog", {
        mode,
        search,
        page,
        perPage: perPage || 24,
        adult: !!state.settings.showAdult,
      }),
    airing: (ids) => request("airing", { ids: ids.join(",") }),
    catalogOptions: () => request("options"),
    media: (id) => request("media", { id }),
    episodes: (id, page) => request("episodes", { id, page }),
    labels: (id) => request("labels", { id }),
    favoriteSet: async (id, favorite) => {
      await account.remoteFavorite(id, favorite);
      if (favorite)
        state.favorites[String(id)] = newEntry(await request("media", { id }));
      else delete state.favorites[String(id)];
      save();
      return snapshot();
    },
    watchAdd: async (id) => {
      const entry = (state.watch[String(id)] ||= newEntry(
        await request("media", { id }),
      ));
      entry.status = "PLANNING";
      entry.updated = entry.statusUpdated = Date.now();
      await account.remoteWatch(id, entry);
      save();
      return snapshot();
    },
    watchDelete: async (id, sync = false) => {
      if (sync) await account.remoteWatch(id);
      delete state.anilist.baseline[String(id)];
      delete state.watch[String(id)];
      for (const [key, value] of Object.entries(state.progress))
        if (value.mediaId === id) delete state.progress[key];
      save();
      return snapshot();
    },
    watchEdit: async (id, patch) => {
      const entry = (state.watch[String(id)] ||= newEntry(
        await request("media", { id }),
      ));
      if (patch.startRewatch) {
        entry.runs.push({ started: Date.now(), count: 0, episodes: {} });
        entry.status = "REPEATING";
        entry.repeat++;
        entry.count = 0;
      }
      if (patch.status) entry.status = patch.status;
      if (patch.count !== undefined) {
        entry.count = patch.count;
        activeRun(entry).count = patch.count;
      }
      if (patch.episode) {
        markEpisode(entry, patch.episode, patch);
        const saved = state.progress[`${id}:${patch.episode}`];
        if (saved)
          Object.assign(
            saved,
            Object.fromEntries(
              Object.entries(patch).filter(([k]) =>
                ["watched", "position", "duration"].includes(k),
              ),
            ),
          );
      }
      entry.updated = Date.now();
      save();
      return snapshot();
    },
    watchExport: async () => {
      download("Nen-watch-data.json", {
        version: 1,
        exportedAt: Date.now(),
        entries: Object.values(state.watch),
      });
      return "Nen-watch-data.json";
    },
    watchImportPreview: () =>
      new Promise((resolve) => {
        const input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.oncancel = () => resolve(null);
        input.onchange = async () => {
          try {
            const file = input.files?.[0];
            if (!file) return resolve(null);
            if (file.size > 20_000_000) throw Error("File is too large.");
            imported = validateTransfer(JSON.parse(await file.text()));
            resolve({
              count: Object.keys(imported).length,
              episodes: Object.values(imported).reduce(
                (n, e) =>
                  n +
                  e.runs.reduce(
                    (n, r) => n + Object.keys(r.episodes).length,
                    0,
                  ),
                0,
              ),
              newEntries: Object.keys(imported).filter((id) => !state.watch[id])
                .length,
              changedEntries: Object.keys(imported).filter(
                (id) => state.watch[id],
              ).length,
              path: file.name,
            });
          } catch (e) {
            alert((e as Error).message);
            resolve(null);
          }
        };
        input.click();
      }),
    watchImport: async (mode) => {
      if (!imported) throw Error("Choose a watch data file first.");
      if (mode === "replace") {
        download("Nen-watch-backup.json", {
          version: 1,
          entries: Object.values(state.watch),
        });
        state.watch = imported;
        state.progress = {};
      } else mergeWatch(state.watch, imported);
      imported = undefined;
      save();
      return snapshot();
    },
    onWatchState: (fn) => {
      watchListeners.add(fn);
      return () => watchListeners.delete(fn);
    },
    autoPlay: async (id, episode) => {
      if (room.state.connected) {
        if (!room.state.host)
          throw Error("Only the host can choose an episode.");
        room.send({ type: "select", mediaId: id, episode });
        return;
      }
      if (new URLSearchParams(location.search).has("player"))
        return startStream(id, episode);
      location.assign(`/?player=1&id=${id}&episode=${episode}`);
    },
    resume: async (key) => {
      const [id, ep] = key.split(":").map(Number);
      await api.autoPlay(id, ep);
    },
    startVideo: async () => {
      const playerDoc = playerFrame?.contentDocument || document;
      const canvas = playerDoc.querySelector("#video-surface");
      if (!canvas || video?.isConnected) return;
      video = document.createElement("video");
      video.id = "browser-video";
      video.playsInline = true;
      video.preload = "auto";
      video.disableRemotePlayback = true;
      video.crossOrigin = "anonymous";
      canvas.replaceWith(video);
      for (const event of [
        "timeupdate",
        "durationchange",
        "play",
        "pause",
        "volumechange",
        "ratechange",
        "seeked",
        "loadeddata",
      ])
        video.addEventListener(event, () => {
          if (event === "play") p.loadingNotice = undefined;
          if (event === "seeked") p.seeking = false;
          publish();
        });
      video.addEventListener("playing", () => {
        p.buffering = false;
        p.loadingNotice = undefined;
        publish();
      });
      video.addEventListener("waiting", () => {
        p.buffering = true;
        publish();
      });
      video.addEventListener("timeupdate", () => {
        if (Date.now() - lastSave > 5000) {
          persistProgress();
          lastSave = Date.now();
        }
        if (state.settings.autoSkip) {
          const marker = p.markers.find(
            (m) => video.currentTime >= m.start && video.currentTime < m.end,
          );
          if (marker) {
            undoPosition = video.currentTime;
            video.currentTime = marker.end;
          }
        }
      });
      video.addEventListener("ended", () => {
        persistProgress();
        if (!room.state.connected && state.settings.autoNext && p.nextEpisode)
          void startStream(p.nextMediaId ?? p.mediaId!, p.nextEpisode);
      });
      video.addEventListener("error", () => {
        if (video.error) {
          p.error = video.error.message;
          p.loadingNotice = undefined;
          publish();
        }
      });
      const params = new URLSearchParams(location.search);
      void startStream(
        pendingSelection?.id ?? Number(params.get("id")),
        pendingSelection?.episode ?? (Number(params.get("episode")) || 1),
      );
    },
    onVideo: () => () => {},
    playback: async () => structuredClone(p),
    onPlayback: (fn) => {
      playbackListeners.add(fn);
      return () => playbackListeners.delete(fn);
    },
    control: async (action, value) => {
      if (action === "stop" && room.state.connected) {
        room.disconnect();
        playerFrame?.remove();
        playerFrame = undefined;
        video?.pause();
        return;
      }
      if (
        room.state.connected &&
        ["pause", "seek", "seekRelative", "speed"].includes(action)
      ) {
        room.send(
          action === "pause"
            ? { type: "pause", value: !room.state.paused }
            : action === "speed"
              ? { type: "speed", value }
              : {
                  type: "seek",
                  position:
                    action === "seekRelative" ? p.position + value! : value,
                },
        );
        return;
      }
      if (action === "stop") {
        controller?.abort();
        persistProgress();
        hls?.destroy();
        location.assign(
          "/?returnMedia=" +
            (p.mediaId || new URLSearchParams(location.search).get("id")),
        );
        return;
      }
      if (action === "sources") return;
      if (!video) return;
      if (
        ["subtitleDelay", "subtitleSize", "subtitlePosition"].includes(action)
      ) {
        const key = action as
          "subtitleDelay" | "subtitleSize" | "subtitlePosition";
        state.settings[key] = value!;
        updateSubtitles();
        save();
        return;
      }
      if (action === "pause") {
        if (video.paused) await video.play();
        else video.pause();
      }
      if (action === "seek" || action === "seekRelative") {
        if (Number.isFinite(video.duration))
          video.currentTime = Math.max(
            0,
            Math.min(
              video.duration,
              action === "seek" ? value! : video.currentTime + value!,
            ),
          );
      }
      if (action === "speed") video.playbackRate = value!;
      if (action === "volume") {
        video.muted = false;
        video.volume = Math.max(0, Math.min(1, value! / 100));
      }
      if (action === "sub") {
        const tracks = Array.from(video.textTracks),
          selected = tracks[value! - 1];
        subtitleSelection = selected
          ? { title: selected.label, lang: selected.language }
          : null;
        sessionStorage.setItem(
          "nen-subtitle-selection",
          JSON.stringify(subtitleSelection),
        );
        tracks.forEach(
          (t, i) => (t.mode = i === value! - 1 ? "showing" : "disabled"),
        );
      }
      if (action === "audio" && hls) {
        hls.audioTrack = value! - 1;
        const track = hls.audioTracks[value! - 1];
        if (track) {
          state.seriesAudio ||= {};
          state.seriesAudio[String(p.mediaId)] = track.lang || "";
          save();
        }
      }
      if (action === "fullscreen") await toggleFullscreen(video);
      publish();
    },
    marker: async (marker) => {
      state.markers[`${p.mediaId}:${p.episode}`] = [
        ...p.markers.filter((m) => m.type !== marker.type),
        marker,
      ];
      p.markers = state.markers[`${p.mediaId}:${p.episode}`];
      save();
      publish();
    },
    skip: async (type) => {
      const marker = p.markers.find((m) => m.type === type);
      if (marker) {
        undoPosition = video.currentTime;
        video.currentTime = marker.end;
      }
    },
    undo: async () => {
      video.currentTime = undoPosition;
    },
    mapping: async (id, offset) => {
      state.mappings[String(id)] = offset;
      save();
    },
    clear: async (kind) => {
      if (kind === "history") {
        state.watch = {};
        state.progress = {};
        save(true);
      }
    },
    external: async (target, id) => {
      const urls = {
        anilist: `https://anilist.co/anime/${id}`,
        mal: `https://myanimelist.net/anime/${id}`,
        discord: "https://discord.gg/rYgwUYSNRg",
        issues: "https://github.com/may-be-gay/Nen/issues",
        email: "mailto:nen@crygup.com",
        donate: "https://ko-fi.com/crygup",
        license: "https://github.com/may-be-gay/Nen/blob/main/LICENSE",
        aniskip: "https://aniskip.com",
        filler: "https://www.animefillerlist.com",
      };
      window.open(urls[target], "_blank", "noopener,noreferrer");
    },
    ...roomApi,
    togetherLeave: async () => {
      room.disconnect();
      persistProgress();
      hls?.destroy();
      video?.pause();
      playerFrame?.remove();
      playerFrame = undefined;
      p.active = false;
    },
    startupUpdate: idle,
    checkUpdates: idle,
    installUpdate: idle,
    updateStatus: idle,
    onUpdateStatus: () => () => {},
    onBack: () => () => {},
    browserHistory: true,
    changelog: async () => ({
      entries: [],
      hasMore: false,
      stale: false,
      buildCommit: "",
    }),
    openChangelogCommit: async () => {},
    uninstall: async () => {},
    profileCreate: desktopOnly,
    profileSwitch: desktopOnly,
    profileRename: desktopOnly,
    profileDelete: desktopOnly,
    ...account,
    releases: async () => ({
      items: [],
      errors: ["Use the browser stream source controls."],
    }),
    inspect: async () => [],
    play: async (id, ep) => api.autoPlay(id, ep),
  };
  window.nen = api;
  window.addEventListener("pagehide", persistProgress);
  await import("../app/src/main");
}

import "./mobile";
