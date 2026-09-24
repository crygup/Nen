import { findUpdate, downloadUpdate } from "./updates";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
declare const NEN_BUILD_COMMIT: string;
import { captureVideo } from "./capture";
import {
  app,
  BrowserWindow,
  BaseWindow,
  ipcMain,
  nativeTheme,
  screen,
  shell,
  utilityProcess,
  dialog,
  safeStorage,
  type UtilityProcess,
} from "electron";
import { join } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import * as providers from "./providers";
import { Player } from "./player";
import { readRemote, preview as previewAniList, apply as applyAniList } from "./anilist";
import { markEpisode, migrateProgress, newEntry, statuses, validateTransfer, mergeWatch, activeRun } from "./watch-data";
import {
  positive,
  text,
  hash,
  validMarker,
  fileKey,
  parseRelease,
  repairProgress,
  matchesSeason,
  matchesMedia,
  matchingFile,
} from "./rules";
import {
  isWatched,
  canAutoSkip,
  latestEpisode,
  episodeAvailability,
  automaticRelease,
} from "../src/shared";
import type {
  State,
  Settings,
  Release,
  TorrentFile,
  Progress,
  Marker,
  SegmentType,
  Playback,
  UpdateStatus,
  WatchStatus,
  SyncChange,
  SyncPreview,
} from "../src/shared";
let window: BrowserWindow;
let controls: BrowserWindow | undefined;
let videoView: BaseWindow | undefined;
let switching: Progress | undefined;
let worker: UtilityProcess | undefined;
let player: Player | undefined;
let files: TorrentFile[] = [];
let selected: Release | undefined;
let current: Progress | undefined;
let busy = false;
let playbackRequest = 0;
let automaticRunning = false;
let sourceSearch: AbortController | undefined;
let pendingPlayback: Playback | undefined;
let closing = false;
let stopVideoCapture: (() => void) | undefined;
let captureResize: ReturnType<typeof setTimeout> | undefined;
let updateStatus: UpdateStatus = { busy: false, message: "" };
let state: State;
let statePath: string;
let importFile: string | undefined;
let tokenPath: string;
let syncPreview: { remote: Awaited<ReturnType<typeof readRemote>>["entries"]; changes: SyncChange[] } | undefined;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncRunning = false;
function queueSync() {
  if (!state.anilist.connected || !state.anilist.lastSync || syncTimer) return;
  syncTimer = setTimeout(() => { syncTimer = undefined; void syncUncontested(); }, 12000);
}
async function syncUncontested() {
  if (syncRunning || !state.anilist.connected || !state.anilist.lastSync || syncPreview) return;
  syncRunning = true;
  try {
    const remote = await readRemote(getToken());
    const changes = previewAniList(state.watch, remote.entries, state.anilist).changes;
    await applyAniList(getToken(), state.watch, remote.entries, state.anilist, changes.filter(row => !row.conflict));
    if (changes.some(row => row.conflict)) state.anilist.error = "Some AniList changes need review. Open Sync now.";
    save();
    if (window && !window.isDestroyed()) window.webContents.send("watch-state", state);
  } catch (error) {
    state.anilist.error = String(error);
    save();
    if (window && !window.isDestroyed()) window.webContents.send("watch-state", state);
    if (!syncTimer && state.anilist.connected) {
      syncTimer = setTimeout(() => { syncTimer = undefined; void syncUncontested(); }, 60000);
      syncTimer.unref();
    }
  } finally { syncRunning = false; }
}
function getToken(): string {
  if (!existsSync(tokenPath)) throw Error("Connect AniList first.");
  if (!safeStorage.isEncryptionAvailable()) throw Error("Protected storage is unavailable.");
  return safeStorage.decryptString(readFileSync(tokenPath));
}
async function connectAniList(): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw Error("Protected storage is unavailable.");
  const nonce = randomBytes(24).toString("hex");
  const token = process.env.NEN_E2E_USER_DATA && process.env.NEN_E2E_ANILIST_TOKEN
    ? process.env.NEN_E2E_ANILIST_TOKEN : await new Promise<string>((resolve, reject) => {
    let done = false;
    const server = createServer((req, res) => {
      if (req.url === "/callback" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'" });
        res.end(`<!doctype html><meta charset="utf-8"><p>Connecting AniList to Nen…</p><script>const token=new URLSearchParams(location.hash.slice(1)).get('access_token');if(token)fetch('/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,nonce:'${nonce}'})}).then(()=>{document.body.textContent='AniList is connected. You can close this tab.'});else document.body.textContent='AniList did not send a token.';</script>`);
        return;
      }
      if (req.url === "/token" && req.method === "POST") {
        let body = "";
        req.on("data", chunk => { body += chunk; if (body.length > 10000) req.destroy(); });
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (data.nonce !== nonce || typeof data.token !== "string" || !/^[\w.-]{20,5000}$/.test(data.token)) throw Error("Invalid sign-in response.");
            res.writeHead(200, { "Content-Type": "text/plain", "Cache-Control": "no-store" }); res.end("OK");
            finish(undefined, data.token);
          } catch { res.writeHead(400); res.end("Invalid response"); }
        });
        return;
      }
      res.writeHead(404); res.end();
    });
    const timer = setTimeout(() => finish(Error("AniList sign-in timed out.")), 180000);
    const finish = (error?: Error, value?: string) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      server.close();
      if (error) reject(error); else resolve(value!);
    };
    server.on("error", error => finish(error));
    server.listen(43187, "127.0.0.1", () => {
      const url = new URL("https://anilist.co/api/v2/oauth/authorize");
      url.search = new URLSearchParams({ client_id: "51914", response_type: "token" }).toString();
      void shell.openExternal(url.toString()).catch(error => finish(error));
    });
  });
  const remote = await readRemote(token);
  writeFileSync(tokenPath, safeStorage.encryptString(token));
  state.anilist = { connected: true, user: remote.user, baseline: {} };
  syncPreview = undefined;
  save();
}
let lastSave = 0;
let undoPosition: number | undefined;
let remote: Marker[] = [];
let markersRequested = false;
let markerAttempts = 0;
const skipped = new Set<string>();
const known = new Map<string, Release>();
const defaults: State = {
  settings: {
    theme: "system",
    autoSkip: false,
    autoNext: false,
    developmentBuilds: false,
    showAdult: false,
    hideZeroSeeds: true,
    audio: "jpn,ja",
    subtitles: "eng,en",
    source: "all",
    sourceMode: "auto",
    qualities: [1080, 720, 480, 360],
  },
  progress: {},
  watch: {},
  anilist: { connected: false, baseline: {} },
  markers: {},
  mappings: {},
};
function setUpdateStatus(value: UpdateStatus) {
  updateStatus = value;
  if (window && !window.isDestroyed()) window.webContents.send("update-status", value);
}
let startupChecked = false;
async function startupUpdate() {
  if (startupChecked) return false;
  startupChecked = true;
  try {
    const result = await findUpdate(state.settings.developmentBuilds === true, app.getVersion(), NEN_BUILD_COMMIT);
    return !!result.update;
  } catch {
    return false;
  }
}
async function checkUpdates() {
  if (updateStatus.busy) return updateStatus;
  setUpdateStatus({ busy: true, message: "Checking for updates…" });
  try {
    const result = await findUpdate(state.settings.developmentBuilds === true, app.getVersion(), NEN_BUILD_COMMIT);
    if (!result.update) setUpdateStatus({ busy: false, message: result.message });
    else if (!app.isPackaged) setUpdateStatus({ busy: false, message: "An update is available. Run the installed app to install it." });
    else {
      setUpdateStatus({ busy: true, message: result.message, percent: 0 });
      const installer = await downloadUpdate(result.update, join(app.getPath("userData"), "update-cache"), percent => {
        if (percent !== updateStatus.percent) setUpdateStatus({ busy: true, message: result.message, percent });
      });
      setUpdateStatus({ busy: true, message: "Installing update. Nen will restart…" });
      record();
      save();
      await new Promise<void>((resolve, reject) => {
        const child = spawn(installer, ["/S", "--updated", "--force-run"], { detached: true, stdio: "ignore", windowsHide: true });
        child.once("error", reject);
        child.once("spawn", () => { child.unref(); resolve(); });
      });
      setTimeout(() => app.quit(), 250);
    }
  } catch (error) {
    setUpdateStatus({ busy: false, message: error instanceof Error ? error.message : "The update failed. Try again later." });
  }
  return updateStatus;
}
function save() {
  writeFileSync(statePath + ".tmp", JSON.stringify(state));
  renameSync(statePath + ".tmp", statePath);
}
function record() {
  if (current && player && player.status.duration > 0) {
    current.position = player.status.position;
    current.duration = player.status.duration;
    const oldMark = state.watch[String(current.mediaId)]?.runs.at(-1)?.episodes[String(current.episode)];
    current.watched = oldMark?.manual ? oldMark.watched : isWatched(current);
    current.updated = Date.now();
    state.progress[`${current.mediaId}:${current.episode}`] = current;
    let entry = state.watch[String(current.mediaId)];
    if (!entry) {
      entry = newEntry({ id: current.mediaId, title: { english: current.title, romaji: current.title, native: null }, coverImage: { large: current.cover }, episodes: current.totalEpisodes, isAdult: current.isAdult });
      state.watch[String(current.mediaId)] = entry;
    }
    if (entry.status === "PLANNING") { entry.status = "CURRENT"; entry.statusUpdated = Date.now(); }
    markEpisode(entry, current.episode, { watched: current.watched, position: current.position, duration: current.duration });
    try {
      save();
      queueSync();
    } catch (error) {
      player.status.error = `Progress could not be saved: ${String(error)}`;
    }
    lastSave = Date.now();
  }
}
let publishTimer: NodeJS.Timeout | undefined;
function publish() {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    for (const target of new Set([window, controls]))
      if (target && !target.isDestroyed())
        target.webContents.send(
          "playback",
          player?.status ?? pendingPlayback ?? {
            active: false,
            position: 0,
            duration: 0,
            paused: false,
            tracks: [],
            speed: 0,
            peers: 0,
            progress: 0,
            markers: [],
          },
        );
  }, 100);
}
function stop(closeView = true, keepTorrent = false) {
  record();
  const returnMedia = current?.mediaId ?? pendingPlayback?.mediaId;
  if (closeView) {
    playbackRequest++;
    sourceSearch?.abort();
    pendingPlayback = undefined;
    clearTimeout(captureResize);
    stopVideoCapture?.();
    stopVideoCapture = undefined;
    switching = undefined;
    const returning = !!controls && controls === window;
    controls = undefined;
    videoView?.destroy();
    videoView = undefined;
    if (returning && !closing && !window.isDestroyed())
      void loadPage({ returnMedia: String(returnMedia ?? "") });
  }
  player?.stop();
  player = undefined;
  current = undefined;
  remote = [];
  skipped.clear();
  undoPosition = undefined;
  markersRequested = false;
  markerAttempts = 0;
  if (keepTorrent) return;
  const old = worker;
  worker = undefined;
  old?.postMessage({ action: "stop" });
  if (old)
    setTimeout(() => {
      try {
        old.kill();
      } catch {}
    }, 1500).unref();
  files = [];
  selected = undefined;
  publish();
}
function workerRequest(event: string, payload: object, timeout = 60000): Promise<any> {
  const target = worker;
  if (!target) return Promise.reject(Error("Torrent engine is not ready."));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeListener("message", message);
      target.removeListener("exit", exit);
    };
    const message = (data: any) => {
      if (data.event === event) {
        cleanup();
        resolve(data);
      } else if (data.event === "error") {
        cleanup();
        reject(Error(data.message));
      }
    };
    const exit = () => {
      cleanup();
      reject(Error("Torrent engine stopped."));
    };
    const timer = setTimeout(() => {
      cleanup();
      reject(
        Error("No torrent metadata arrived. Try a release with more seeds."),
      );
    }, timeout);
    target.on("message", message);
    target.once("exit", exit);
    target.postMessage(payload);
  });
}
async function inspect(value: string, timeout = 60000) {
  if (busy) throw Error("Wait for the current playback request.");
  busy = true;
  try {
    const release = known.get(hash(value));
    if (!release) throw Error("Search for this release first.");
    if (current)
      switching = {
        ...current,
        position: player?.status.position ?? current.position,
      };
    if (selected?.hash === release.hash && worker && files.length) {
      stop(false, true);
      return files;
    }
    stop(false);
    selected = release;
    worker = utilityProcess.fork(join(__dirname, "torrent.mjs"), [], {
      serviceName: "Nen torrent engine",
      stdio: "ignore",
    });
    worker.on("message", (data: any) => {
      if (data.event === "stats" && player) {
        Object.assign(player.status, {
          speed: data.speed,
          peers: data.peers,
          progress: data.progress,
        });
        publish();
      }
      if (data.event === "error" && player) {
        player.status.error = data.message;
        publish();
      }
    });
    const activeWorker = worker;
    worker.on("exit", () => {
      if (worker === activeWorker && player?.status.active) {
        player.status.error = "Torrent engine stopped.";
        publish();
      }
    });
    const root = join(app.getPath("userData"), "torrents", release.hash);
    mkdirSync(root, { recursive: true });
    files = (
      await workerRequest("files", {
        action: "inspect",
        hash: release.hash,
        path: root,
      }, timeout)
    ).files;
    return files;
  } catch (e) {
    stop(false);
    throw e;
  } finally {
    busy = false;
  }
}
function refreshMarkers() {
  if (!player || !current) return;
  const local =
    state.markers[
      fileKey(current.hash, current.file.path, current.file.size)
    ] ?? [];
  const chapters: Marker[] = (player.status.chapters ?? []).flatMap<Marker>((chapter, i, list) => {
    const title = chapter.title?.trim() ?? "";
    const type = /^(?:op|opening)(?:\b|\d)/i.test(title) ? "op"
      : /^(?:ed|ending)(?:\b|\d)/i.test(title) ? "ed" : undefined;
    return type ? [{ type, start: chapter.time, end: list[i + 1]?.time ?? player!.status.duration, confirmed: false }] : [];
  }).filter(m => validMarker(m, player!.status.duration));
  player.status.markers = [
    ...local,
    ...chapters.filter(m => !local.some(l => l.type === m.type)),
    ...remote.filter((m) => ![...local, ...chapters].some((l) => l.type === m.type)),
  ].filter((m) => validMarker(m, player!.status.duration));
}
async function play(
  mediaId: number,
  episode: number,
  index: number,
  malEpisode: number,
  resume?: Progress,
  startPosition?: number,
) {
  if (busy) throw Error("Wait for the current playback request.");
  busy = true;
  const request = playbackRequest;
  try {
    if (!selected || !worker) throw Error("Choose a release first.");
    const file = files.find((f) => f.index === index);
    if (!file) throw Error("Choose a playable file.");
    const fileEpisode = parseRelease(
      file.path.split(/[\\/]/).at(-1) ?? "",
      episode,
    ).episode;
    if (fileEpisode !== null && fileEpisode !== episode)
      throw Error(
        `This file is episode ${fileEpisode}. Choose a source for episode ${episode}.`,
      );
    if (
      resume &&
      (resume.hash !== selected.hash ||
        file.path !== resume.file.path ||
        file.size !== resume.file.size)
    )
      throw Error("The saved file does not match this release.");
    if (player)
      throw Error("Stop the current player before opening another file.");
    const anime = resume
      ? {
          title: { english: resume.title, romaji: resume.title },
          coverImage: { large: resume.cover },
          idMal: resume.malId ?? null,
          episodes: resume.totalEpisodes ?? null,
          nextAiringEpisode: null,
        }
      : await providers.media(mediaId);
    if (request !== playbackRequest) throw Error("Playback cancelled.");
    if ((!resume && !matchesMedia(selected.title, anime as any)) || !matchesSeason(file.path, anime as any))
      throw Error("This source uses a different season. Choose another source.");
    if (
      !resume &&
      episodeAvailability(anime as any, episode).released === false
    )
      throw Error("This episode has not aired yet.");
    const episodeInfo = resume
      ? undefined
      : await providers
          .episodes(mediaId, Math.floor((episode - 1) / 50) + 1)
          .catch(() => undefined);
    const watchEntry = state.watch[String(mediaId)];
    const watchPosition = watchEntry?.runs.at(-1)?.episodes[String(episode)]?.position;
    const startAt =
      startPosition ?? (watchEntry?.status === "REPEATING" ? watchPosition ?? 0 : watchPosition ?? resume?.position) ??
      (switching?.mediaId === mediaId && switching.episode === episode
        ? switching.position
        : 0);
    if (request !== playbackRequest) throw Error("Playback cancelled.");
    const result = await workerRequest("stream", { action: "stream", index });
    if (request !== playbackRequest) throw Error("Playback cancelled.");
    current = {
      watched: state.watch[String(mediaId)]?.runs.at(-1)?.episodes[String(episode)]?.watched ?? isWatched(state.progress[`${mediaId}:${episode}`]),
      isAdult: "isAdult" in anime ? anime.isAdult === true : resume?.isAdult,
      episodeTitle:
        resume?.episodeTitle ??
        episodeInfo?.items.find((e) => e.number === episode)?.title ??
        `Episode ${episode}`,
      season: resume?.season ?? (anime.title.english || anime.title.romaji),
      malId: anime.idMal,
      totalEpisodes: anime.episodes,
      mediaId,
      title: anime.title.english || anime.title.romaji,
      cover: anime.coverImage.large,
      episode,
      hash: selected.hash,
      release: selected,
      file,
      position: startAt,
      duration: 0,
      updated: Date.now(),
      malEpisode,
    };
    player = new Player();
    const active = player;
    Object.assign(active.status, {
      mediaId,
      episode,
      title: current.title,
      episodeTitle: current.episodeTitle,
      release: selected,
      nextEpisode:
        episode <
        (resume
          ? (resume.totalEpisodes ?? episode)
          : latestEpisode(anime as any))
          ? episode + 1
          : undefined,
    });
    active.onClose = () => {
      if (automaticRunning) {
        active.status.error = "The player closed before video started.";
        publish();
      } else stop();
    };
    let nextStarted = false;
    active.onChange = () => {
      if (active !== player) return;
      if (active.status.duration > 0 && !markersRequested) {
        markersRequested = true;
        markerAttempts++;
        if (anime.idMal)
          providers
            .skips(anime.idMal, malEpisode, active.status.duration)
            .then((markers) => {
              if (active === player) {
                remote = markers;
                refreshMarkers();
                publish();
              }
            })
            .catch((e) => {
              if (active === player) {
                active.status.skipNotice = "Skip times are unavailable. You can set them in More playback controls.";
                if (markerAttempts < 2) setTimeout(() => {
                  if (active !== player) return;
                  markersRequested = false;
                  active.onChange();
                }, 5000).unref();
                publish();
              }
            });
      }
      refreshMarkers();
      if (active.status.ended && active.status.nextEpisode && state.settings.autoNext && !nextStarted && !automaticRunning) {
        nextStarted = true;
        void autoPlay(mediaId, active.status.nextEpisode).catch(error => {
          active.status.error = error.message;
          publish();
        });
      }
      if (Date.now() - lastSave > 5000) record();
      if (state.settings.autoSkip && !active.status.paused)
        for (const m of active.status.markers) {
          const key = JSON.stringify(m);
          if (
            canAutoSkip(m, active.status.position, state.settings.autoSkip) &&
            !skipped.has(key)
          ) {
            skipped.add(key);
            undoPosition = active.status.position;
            void active.command(["seek", m.end, "absolute"]).catch((e) => {
              active.status.error = e.message;
              publish();
            });
            break;
          }
        }
      publish();
    };
    await openPlayerView();
    if (request !== playbackRequest) throw Error("Playback cancelled.");
    await active.start(
      result.url,
      startAt,
      state.settings,
      app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "vendor"),
      process.platform === "win32"
        ? String(videoView!.getNativeWindowHandle().readUInt32LE())
        : process.platform === "linux"
          ? String(videoView!.getNativeWindowHandle().readBigUInt64LE())
          : undefined,
    );
    controls?.show();
    controls?.moveTop();
    controls?.focus();
    switching = undefined;
    record();
    publish();
  } catch (e) {
    if (request === playbackRequest) stop(!automaticRunning);
    throw e;
  } finally {
    busy = false;
  }
}
async function autoPlay(mediaId: number, episode: number, saved?: Progress) {
  if (automaticRunning || busy) throw Error("Wait for the current playback request.");
  automaticRunning = true;
  sourceSearch = new AbortController();
  const request = ++playbackRequest;
  const attempted = new Set<string>();
  let candidates: Release[] | undefined;
  let failure = "No matching source was found.";
  const watchEntry = state.watch[String(mediaId)];
  let startAt = watchEntry?.status === "REPEATING"
    ? watchEntry.runs.at(-1)?.episodes[String(episode)]?.position ?? 0
    : watchEntry?.runs.at(-1)?.episodes[String(episode)]?.position ?? saved?.position ?? 0;
  try {
    let anime = saved ? {
      id: saved.mediaId,
      title: { english: saved.title, romaji: saved.title },
    } as any : await providers.media(mediaId);
    if (request !== playbackRequest) return;
    const continuing = !saved && current?.mediaId === mediaId && selected && worker
      && matchesMedia(selected.title, anime) && matchingFile(files, selected, anime, episode)
      && (state.settings.source === "all" || selected.source === state.settings.source)
      ? selected : undefined;
    for (let attempt = 0; attempt < 6; attempt++) {
      let release = attempt === 0 ? saved?.release ?? continuing : undefined;
      if (!release) {
        if (!candidates) {
          anime = await providers.media(mediaId);
          const result = await providers.releases(anime, episode, undefined, state.settings.source, sourceSearch.signal);
          candidates = result.items;
          if (!candidates.length && result.errors.length) failure = result.errors.join(" ");
          for (const row of candidates) known.set(row.hash, row);
        }
        if (request !== playbackRequest) return;
        release = automaticRelease(candidates.filter(r => !attempted.has(r.hash)), episode, state.settings);
      }
      if (!release) break;
      attempted.add(release.hash);
      if (saved && release.hash === saved.hash && !matchesMedia(release.title, anime)) {
        anime = await providers.media(mediaId);
        if (request !== playbackRequest) return;
        if (!matchesMedia(release.title, anime)) {
          startAt = 0;
          continue;
        }
      }
      known.set(release.hash, release);
      pendingPlayback = {
        active: true, position: startAt, duration: 0, paused: false,
        speed: 0, peers: 0, progress: 0, tracks: [], markers: [],
        mediaId, episode, title: anime.title.english || anime.title.romaji,
        loadingNotice: attempt ? "Connecting to another source…" : "Connecting to the source…",
      };
      publish();
      try {
        const list = await inspect(release.hash, 20000);
        if (request !== playbackRequest) return;
        const file = saved && release.hash === saved.hash
          ? list.find(f => f.path === saved.file.path && f.size === saved.file.size)
          : matchingFile(list, release, anime, episode);
        if (!file) throw Error("The source has no unambiguous file for this episode.");
        await play(mediaId, episode, file.index, saved?.malEpisode ?? episode,
          saved && release.hash === saved.hash ? saved : undefined, startAt);
        if (request !== playbackRequest) return;
        const active = player!;
        const deadline = Date.now() + 30000;
        while (request === playbackRequest && player === active && !active.status.ready
          && !active.status.error && Date.now() < deadline)
          await new Promise(resolve => setTimeout(resolve, 100));
        if (request !== playbackRequest) return;
        if (active.status.ready) {
          pendingPlayback = undefined;
          return;
        }
        failure = active.status.error ?? "This source took too long to start.";
        if (attempt === 5) break;
        const quality = parseInt(release.resolution);
        if (candidates) {
          const sameQuality = candidates.filter(r => parseInt(r.resolution) === quality);
          if (sameQuality.some(r => attempted.has(r.hash) && r.hash !== release!.hash))
            for (const row of sameQuality) attempted.add(row.hash);
        }
      } catch (error) {
        if (request !== playbackRequest) return;
        failure = (error as Error).message;
      }
    }
    if (request === playbackRequest) {
      const message = failure + " Choose another source or try again later.";
      if (controls) {
        if (player) player.status.error = message;
        else if (pendingPlayback) pendingPlayback.error = message;
        publish();
      } else throw Error(message);
    }
  } catch (error) {
    if (request !== playbackRequest) return;
    if (!controls) throw error;
    const status = player?.status ?? pendingPlayback;
    if (status) status.error = (error as Error).message;
    publish();
  } finally {
    if (!controls) pendingPlayback = undefined;
    automaticRunning = false;
    sourceSearch = undefined;
  }
}
function settings(value: Settings): Settings {
  if (
    !value ||
    !["system", "light", "dark"].includes(value.theme) ||
    typeof value.autoSkip !== "boolean" ||
    !["all", "Nyaa", "Bangumi Moe"].includes(value.source)
  )
    throw Error("Invalid settings.");
  if (
    value.sourceMode !== undefined &&
    !["auto", "manual"].includes(value.sourceMode)
  )
    throw Error("Invalid source preference.");
  if (
    value.qualities !== undefined &&
    (!Array.isArray(value.qualities) ||
      !value.qualities.length ||
      !value.qualities.every((q) =>
        [2160, 1440, 1080, 720, 480, 360].includes(q),
      ))
  )
    throw Error("Select at least one quality.");
  for (const key of ["showAdult", "hideZeroSeeds", "autoNext", "developmentBuilds"] as const)
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw Error("Invalid content preference.");
  const audio = text(value.audio, 60),
    subtitles = text(value.subtitles, 60);
  if (!/^[a-zA-Z, -]*$/.test(audio + subtitles))
    throw Error("Use language codes such as jpn or eng.");
  return {
    theme: value.theme,
    showAdult: value.showAdult ?? false,
    hideZeroSeeds: value.hideZeroSeeds ?? true,
    autoSkip: value.autoSkip,
    autoNext: value.autoNext ?? false,
    developmentBuilds: value.developmentBuilds ?? false,
    audio,
    subtitles,
    source: value.source,
    sourceMode: value.sourceMode ?? "auto",
    qualities: [...new Set(value.qualities ?? [1080, 720, 480, 360])].sort(
      (a, b) => b - a,
    ),
  };
}

if (process.platform === "win32")
  app.commandLine.appendSwitch("disable-direct-composition");
app.setName("Nen");
if (process.env.NEN_E2E_USER_DATA) {
  mkdirSync(process.env.NEN_E2E_USER_DATA, { recursive: true });
  app.setPath("userData", process.env.NEN_E2E_USER_DATA);
}
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(() => {
      statePath = join(app.getPath("userData"), "state.json");
      tokenPath = join(app.getPath("userData"), "anilist-token.bin");
      mkdirSync(app.getPath("userData"), { recursive: true });
      state = structuredClone(defaults);
      if (existsSync(statePath)) {
        try {
          const stored = JSON.parse(readFileSync(statePath, "utf8"));
          state = {
            ...defaults,
            ...stored,
            settings: settings(stored.settings),
            watch: stored.watch ?? {},
            anilist: { ...defaults.anilist, ...stored.anilist, connected: false },
          };
        } catch {
          throw Error(
            "Saved state could not be read. Back up state.json before resetting it.",
          );
        }
      }
      state.version = app.getVersion();
      providers.initCache(join(app.getPath("userData"), "provider-cache.json"));
      const repaired = repairProgress(state.progress);
      if (JSON.stringify(repaired) !== JSON.stringify(state.progress)) {
        const backup = statePath + ".before-episode-repair.json";
        if (!existsSync(backup)) writeFileSync(backup, readFileSync(statePath));
        state.progress = repaired;
        save();
      }
      if (migrateProgress(state.watch, state.progress)) {
        const backup = statePath + ".before-watch-migration.json";
        if (existsSync(statePath) && !existsSync(backup)) copyFileSync(statePath, backup);
        save();
      }
      state.anilist.connected = existsSync(tokenPath);
      if (state.anilist.connected) setTimeout(() => void syncUncontested(), 3000);
      const dev = process.env.NEN_DEV_URL;
      const entry = pathToFileURL(join(__dirname, "../dist/index.html")).href;
      const allowed = dev ? new URL(dev).origin : entry;
      nativeTheme.themeSource = state.settings.theme;
      const area = screen.getPrimaryDisplay().workAreaSize;
      const minWidth = Math.min(850, area.width),
        minHeight = Math.min(620, area.height);
      const savedSize = state.window;
      const width = Number.isInteger(savedSize?.width)
        ? savedSize!.width
        : 1320;
      const height = Number.isInteger(savedSize?.height)
        ? savedSize!.height
        : 900;
      let maximized = savedSize?.maximized === true;
      window = new BrowserWindow({
        width: Math.min(area.width, Math.max(minWidth, width)),
        height: Math.min(area.height, Math.max(minHeight, height)),
        minWidth,
        minHeight,
        title: "Nen",
        icon: join(__dirname, "../dist/n.png"),
        backgroundColor: "#111211",
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(__dirname, "preload.cjs"),
          nodeIntegration: false,
          contextIsolation: true,
          sandbox: true,
          webSecurity: true,
        },
      });
      installZoom(window);
      const syncVideo = () => {
        if (videoView && !window.isDestroyed())
          videoView.setBounds(window.getContentBounds());
      };
      window.on("move", syncVideo);
      window.on("resize", () => {
        syncVideo();
        clearTimeout(captureResize);
        if (stopVideoCapture)
          captureResize = setTimeout(() => {
            if (!videoView || !stopVideoCapture) return;
            stopVideoCapture();
            stopVideoCapture = captureVideo(
              videoView.getNativeWindowHandle().readUInt32LE(),
              window,
            );
          }, 150);
      });
      window.on("minimize", () => videoView?.hide());
      window.on("restore", () => {
        videoView?.showInactive();
        syncVideo();
        window.moveTop();
      });
      window.on("maximize", () => {
        maximized = true;
      });
      window.on("unmaximize", () => {
        maximized = false;
      });
      window.on("close", () => {
        closing = true;
        stop();
        const { width, height } = window.getNormalBounds();
        state.window = { width, height, maximized };
        save();
      });
      if (maximized) window.maximize();
      window.on("app-command", (event, command) => {
        if (command !== "browser-backward" && command !== "browser-forward")
          return;
        event.preventDefault();
        if (command === "browser-backward")
          window.webContents.send("navigate-back", "back");
        else window.webContents.send("navigate-back", "forward");
      });
      window.webContents.on("did-finish-load", () => {
        window.webContents.navigationHistory.clear();
      });
      window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
      window.webContents.on("will-navigate", (e) => e.preventDefault());
      window.webContents.on("will-attach-webview", (e) => e.preventDefault());
      const isPlayer = (wc: Electron.WebContents | null) =>
        wc === window.webContents &&
        new URL(wc.getURL()).searchParams.get("player") === "1";
      window.webContents.session.setPermissionRequestHandler(
        (_wc, _permission, cb) => cb(false),
      );
      window.webContents.session.setPermissionCheckHandler(() => false);
      function handle(name: string, fn: (...args: any[]) => unknown) {
        ipcMain.handle(name, (event, ...args) => {
          const frame = event.senderFrame;
          const url = frame?.url ?? "";
          if (
            ![window.webContents, controls?.webContents].includes(
              event.sender,
            ) ||
            frame !== event.sender.mainFrame ||
            !(dev ? url.startsWith(allowed + "/") : url.split("?")[0] === entry)
          )
            throw Error("Untrusted request.");
          return fn(...args);
        });
      }
      handle("watchAdd", async (id) => {
        const anime = await providers.media(positive(id));
        state.watch[String(anime.id)] ??= newEntry(anime);
        save();
        queueSync();
        return state;
      });
      handle("watchDelete", (id) => {
        const mediaId = positive(id);
        delete state.watch[String(mediaId)];
        for (const [key, saved] of Object.entries(state.progress))
          if (saved.mediaId === mediaId) delete state.progress[key];
        if (current?.mediaId === mediaId) current = undefined;
        syncPreview = undefined;
        save();
        return state;
      });
      handle("watchEdit", (id, patch) => {
        const entry = state.watch[String(positive(id))];
        if (!entry || !patch || typeof patch !== "object") throw Error("Watch entry was not found.");
        if (patch.count !== undefined && (!Number.isSafeInteger(patch.count) || patch.count < 0
          || (entry.totalEpisodes != null && patch.count > entry.totalEpisodes)))
          throw Error("Episode progress exceeds the valid range.");
        const now = Date.now();
        if (patch.startRewatch) {
          if (entry.status !== "COMPLETED") throw Error("Complete the anime before a rewatch.");
          activeRun(entry).completed ??= now;
          entry.runs.push({ started: now, episodes: {}, count: 0 });
          entry.status = "REPEATING"; entry.count = 0;
          entry.statusUpdated = entry.countUpdated = now;
          for (const saved of Object.values(state.progress)) {
            if (saved.mediaId === entry.mediaId) { saved.position = 0; saved.watched = false; saved.updated = now; }
          }
          if (current?.mediaId === entry.mediaId) current = undefined;
        }
        if (patch.status !== undefined) {
          if (!statuses.includes(patch.status as WatchStatus)) throw Error("Invalid watch status.");
          entry.status = patch.status;
          entry.statusUpdated = now;
          if (patch.status === "COMPLETED") {
            const run = activeRun(entry);
            if (!run.completed) { run.completed = now; if (entry.runs.length > 1) { entry.repeat++; entry.repeatUpdated = now; } }
          }
        }
        if (patch.count !== undefined) {
          entry.count = patch.count; entry.countUpdated = now; activeRun(entry).count = patch.count;
        }
        if (patch.episode !== undefined) {
          const episode = positive(patch.episode, 100000);
          if (patch.watched !== undefined && typeof patch.watched !== "boolean") throw Error("Invalid watched mark.");
          for (const value of [patch.position, patch.duration])
            if (value !== undefined && (!Number.isFinite(value) || value < 0 || value > 1000000)) throw Error("Invalid playback time.");
          markEpisode(entry, episode, { watched: patch.watched, position: patch.position, duration: patch.duration });
          if (patch.watched !== undefined) activeRun(entry).episodes[String(episode)].manual = true;
        }
        entry.updated = now;
        save();
        queueSync();
        return state;
      });
      handle("watchExport", async () => {
        const path = process.env.NEN_E2E_USER_DATA && process.env.NEN_E2E_EXPORT_PATH
          ? process.env.NEN_E2E_EXPORT_PATH
          : (await dialog.showSaveDialog(window, { defaultPath: "nen-watch-data.json", filters: [{ name: "JSON", extensions: ["json"] }] })).filePath;
        if (!path) return null;
        writeFileSync(path, JSON.stringify({ version: 1, exportedAt: Date.now(), entries: Object.values(state.watch) }, null, 2));
        return path;
      });
      handle("watchImportPreview", async () => {
        const path = process.env.NEN_E2E_USER_DATA && process.env.NEN_E2E_IMPORT_PATH
          ? process.env.NEN_E2E_IMPORT_PATH
          : (await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "JSON", extensions: ["json"] }] })).filePaths[0];
        if (!path) return null;
        const data = readFileSync(path);
        if (data.length > 50 * 1024 * 1024) throw Error("Watch data file is too large.");
        const entries = validateTransfer(JSON.parse(data.toString("utf8")));
        importFile = path;
        return { count: Object.keys(entries).length, episodes: Object.values(entries).flatMap(row => row.runs).reduce((n, run) => n + Object.keys(run.episodes).length, 0), newEntries: Object.keys(entries).filter(id => !state.watch[id]).length, changedEntries: Object.keys(entries).filter(id => !!state.watch[id]).length, path };
      });
      handle("watchImport", (mode) => {
        if (!importFile || !["merge", "replace"].includes(mode)) throw Error("Select a watch data file first.");
        const entries = validateTransfer(JSON.parse(readFileSync(importFile, "utf8")));
        const backup = statePath + `.before-import-${Date.now()}.json`;
        if (existsSync(statePath)) copyFileSync(statePath, backup);
        else writeFileSync(backup, JSON.stringify(state));
        if (mode === "replace") state.watch = entries;
        else mergeWatch(state.watch, entries);
        importFile = undefined;
        save();
        queueSync();
        return state;
      });
      handle("anilistConnect", connectAniList);
      handle("anilistPreview", async (): Promise<SyncPreview> => {
        try {
          const remote = await readRemote(getToken());
          state.anilist.user = remote.user;
          state.anilist.error = undefined;
          const result = previewAniList(state.watch, remote.entries, state.anilist);
          syncPreview = { remote: remote.entries, changes: result.changes };
          save();
          return result;
        } catch (error) {
          state.anilist.error = String(error);
          save();
          throw error;
        }
      });
      handle("anilistApply", async (choices: SyncChange[]) => {
        if (!syncPreview || !Array.isArray(choices)) throw Error("Review AniList changes first.");
        const expected = syncPreview.changes;
        if (choices.length !== expected.length || choices.some((row, i) => row.mediaId !== expected[i].mediaId || row.field !== expected[i].field || !["local", "remote", undefined].includes(row.choice))) throw Error("Sync review changed. Review again.");
        try {
          await applyAniList(getToken(), state.watch, syncPreview.remote, state.anilist, expected.map((row, i) => ({ ...row, choice: choices[i].choice })));
          syncPreview = undefined;
          save();
          return state;
        } catch (error) {
          state.anilist.error = String(error);
          save();
          throw error;
        }
      });
      handle("anilistDisconnect", () => {
        rmSync(tokenPath, { force: true });
        state.anilist = { connected: false, baseline: {} };
        syncPreview = undefined;
        save();
        return state;
      });
      handle("startVideo", () => {
        if (!videoView || !isPlayer(window.webContents))
          throw Error("No active video window.");
        stopVideoCapture?.();
        stopVideoCapture = captureVideo(
          videoView.getNativeWindowHandle().readUInt32LE(),
          window,
        );
      });
      handle("catalogOptions", () => providers.catalogOptions());
      handle("catalog", (mode, query, page, perPage = 24) => {
        if (!["trending", "season", "search"].includes(mode))
          throw Error("Invalid view.");
        return providers.catalog(
          mode,
          text(query),
          positive(page, 100),
          state.settings.showAdult,
          positive(perPage, 24),
        );
      });
      handle("episodes", (id, page) =>
        providers.episodes(positive(id), positive(page, 200)),
      );
      handle(
        "playbackState",
        () =>
          player?.status ?? pendingPlayback ?? {
            active: false,
            position: 0,
            duration: 0,
            paused: false,
            tracks: [],
            markers: [],
            speed: 0,
            peers: 0,
            progress: 0,
          },
      );
      handle("removeHistory", (key) => {
        const valid = text(key, 40);
        if (!/^\d+:\d+$/.test(valid)) throw Error("Invalid history entry.");
        delete state.progress[valid];
        save();
      });
      handle("media", (id) => providers.media(positive(id)));
      handle("labels", async (id, mal) => {
        const anime = await providers.media(positive(id));
        return providers.labels(anime.id, anime.idMal);
      });
      handle("releases", async (id, ep, query) => {
        const anime = await providers.media(positive(id));
        const result = await providers.releases(
          anime,
          positive(ep, 10000),
          query === undefined ? undefined : text(query),
          state.settings.source,
        );
        known.clear();
        for (const r of result.items) known.set(r.hash, r);
        return result;
      });
      handle("autoPlay", (id, ep) => autoPlay(positive(id), positive(ep, 10000)));
      handle("inspect", (value) => {
        playbackRequest++;
        return inspect(hash(value));
      });
      handle("play", (id, ep, index, malEp) =>
        play(
          positive(id),
          positive(ep, 10000),
          positive(Number(index) + 1, 100000) - 1,
          positive(malEp, 10000),
        ),
      );
      handle("resume", async (key) => {
        const p = state.progress[text(key, 40)];
        if (!p) throw Error("Saved playback was not found.");
        if (state.settings.sourceMode !== "manual") return autoPlay(p.mediaId, p.episode, p);
        known.set(hash(p.hash), p.release);
        const list = await inspect(p.hash);
        const file = list.find(
          (f) => f.path === p.file.path && f.size === p.file.size,
        );
        if (!file) throw Error("Saved file was not found.");
        return play(p.mediaId, p.episode, file.index, p.malEpisode, p);
      });
      handle("control", async (action, value) => {
        if (action === "stop") {
          stop();
          return;
        }
        if (action === "fullscreen") {
          window.setFullScreen(!window.isFullScreen());
          return;
        }
        if (!player) throw Error("Start playback first.");
        if (action === "volume") {
          if (!Number.isFinite(value) || value < 0 || value > 100)
            throw Error("Invalid volume.");
          return player.command(["set_property", "volume", value]);
        }
        if (action === "pause") return player.command(["cycle", "pause"]);
        if (!Number.isFinite(value)) throw Error("Invalid player value.");
        if (action === "speed") {
          if (value < 0.25 || value > 4) throw Error("Invalid playback speed.");
          return player.command(["set_property", "speed", value]);
        }
        if (action === "seekRelative") {
          if (value !== 5 && value !== -5) throw Error("Invalid seek step.");
          return player.command(["seek", value, "relative+exact"]);
        }
        if (action === "seek") {
          if (value < 0 || value > player.status.duration)
            throw Error("Invalid playback time.");
          return player.command(["seek", value, "absolute"]);
        }
        if (action === "audio" || action === "sub") {
          if (
            value !== 0 &&
            !player.status.tracks.some(
              (t) =>
                t.id === value &&
                t.type === (action === "audio" ? "audio" : "sub"),
            )
          )
            throw Error("Track not found.");
          return player.command([
            "set_property",
            action === "audio" ? "aid" : "sid",
            value === 0 ? "no" : value,
          ]);
        }
        throw Error("Invalid player action.");
      });
      handle("state", () => state);
      handle("startupUpdate", startupUpdate);
      handle("checkUpdates", checkUpdates);
      handle("updateStatus", () => updateStatus);
      handle("settings", (value) => {
        if (updateStatus.busy && !!value?.developmentBuilds !== !!state.settings.developmentBuilds)
          throw Error("Wait for the update to finish before changing the update channel.");
        state.settings = settings(value);
        nativeTheme.themeSource = state.settings.theme;
        save();
      });
      handle("mapping", (id, offset) => {
        positive(id);
        if (!Number.isInteger(offset) || Math.abs(offset) > 10000)
          throw Error("Invalid episode offset.");
        state.mappings[String(id)] = offset;
        save();
      });
      handle("marker", (marker: Marker) => {
        if (!player || !current || !validMarker(marker, player.status.duration))
          throw Error("Start and end must be within this file.");
        const key = fileKey(current.hash, current.file.path, current.file.size);
        state.markers[key] = [
          ...(state.markers[key] ?? []).filter((m) => m.type !== marker.type),
          {
            type: marker.type,
            start: marker.start,
            end: marker.end,
            confirmed: true,
          },
        ];
        save();
        refreshMarkers();
        publish();
      });
      handle("skip", async (type: SegmentType) => {
        if (!player) throw Error("Start playback first.");
        const m = player.status.markers.find(
          (m) =>
            m.type === type &&
            player!.status.position >= m.start &&
            player!.status.position < m.end,
        );
        if (!m) throw Error("No skip interval at this time.");
        undoPosition = player.status.position;
        skipped.add(JSON.stringify(m));
        await player.command(["seek", m.end, "absolute"]);
      });
      handle("undo", async () => {
        if (player && undoPosition !== undefined) {
          await player.command(["seek", undoPosition, "absolute"]);
          undoPosition = undefined;
        }
      });
      handle("clear", (kind) => {
        if (kind === "history") {
          if (player || busy) throw Error("Stop playback first.");
          state.progress = {};

          save();
        } else if (kind === "cache") {
          if (worker || busy) throw Error("Stop playback first.");
          providers.clearCache();
          const root = join(app.getPath("userData"), "torrents");
          rmSync(root, { recursive: true, force: true });
        } else throw Error("Invalid clear request.");
      });
      handle("external", (target, id) => {
        const urls: Record<string, string> = {
          anilist: `https://anilist.co/anime/${positive(id ?? 1)}`,
          filler: "https://anifillerpedia.wiki/",
          license: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
          aniskip: "https://aniskip.com/",
        };
        if (!Object.hasOwn(urls, target)) throw Error("Invalid link.");
        return shell.openExternal(urls[target]);
      });
      if (dev) void window.loadURL(dev);
      else void window.loadFile(join(__dirname, "../dist/index.html"));
    })
    .catch((error) => {
      dialog.showErrorBox("Nen could not start", String(error));
      app.quit();
    });
  app.on("before-quit", () => {
    closing = true;
    stop();
  });
  app.on("window-all-closed", () => app.quit());
}

async function loadPage(query: Record<string, string>) {
  const dev = process.env.NEN_DEV_URL;
  if (dev) await window.loadURL(dev + "?" + new URLSearchParams(query));
  else await window.loadFile(join(__dirname, "../dist/index.html"), { query });
}
async function openPlayerView() {
  if (controls) return;

  videoView = new BaseWindow({
    ...window.getContentBounds(),

    frame: false,
    show: true,
    skipTaskbar: true,
    focusable: false,
    transparent: true,
    backgroundColor: "#00000000",
  });
  videoView.contentView.setVisible(false);
  window.moveTop();
  controls = window;
  await loadPage({ player: "1" });
}

function installZoom(view: BrowserWindow) {
  view.webContents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown" || !(input.control || input.meta)) return;
    const key = input.key;
    if (
      !["+", "=", "-", "0"].includes(key) &&
      !["NumpadAdd", "NumpadSubtract"].includes(input.code)
    )
      return;
    event.preventDefault();
    const delta = key === "-" || input.code === "NumpadSubtract" ? -0.5 : 0.5;
    view.webContents.setZoomLevel(
      key === "0"
        ? 0
        : Math.max(-3, Math.min(3, view.webContents.getZoomLevel() + delta)),
    );
  });
}
