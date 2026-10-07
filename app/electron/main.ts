import { malAccount } from "./mal-account";
import { malClient, type MalTokens } from "./myanimelist";
import { signInMal } from "./mal-auth";
import { LocalFiles, subtitleExtensions } from "./local-files";
import { Together } from "./together";
import { DiscordPresence, DISCORD_APP_ID } from "./discord";
import { findUpdate, downloadUpdate, type Update } from "./updates";
import { listChangelog } from "./changelog";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
declare const NEN_BUILD_COMMIT: string;
declare const NEN_BUILD_VERSION: string;
import { VideoHost } from "./video-host";
import { captureVideo, seekFrames } from "./capture";
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
  clipboard,
  type UtilityProcess,
} from "electron";
import { join, dirname } from "node:path";
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  existsSync,
  statSync,
  rmSync,
  copyFileSync,
} from "node:fs";
import { pathToFileURL } from "node:url";
import * as providers from "./providers";
import { Player } from "./player";
import {
  readFollowing,
  syncFavorites,
  setRemoteWatch,
  setRemoteFavorite,
  readRemote,
  refreshRemote,
  preview as previewAniList,
  apply as applyAniList,
} from "./anilist";
import {
  markEpisode,
  migrateWatchLater,
  migrateProgress,
  newEntry,
  statuses,
  validateTransfer,
  mergeWatch,
  activeRun,
} from "./watch-data";
import {
  migrateLegacy,
  newProfileId,
  profileDir,
  profileFile,
  profileId,
  profileName,
  readProfile,
  splitState,
  tokenFile,
  uniqueProfileName,
  writeJson,
  writeProfile,
} from "./profiles";
import {
  positive,
  text,
  hash,
  validMarker,
  fileKey,
  parseRelease,
  sourceOffset,
  repairProgress,
  matchesSeason,
  matchesMedia,
  matchingFile,
} from "./rules";
import {
  validateLibrary,
  isWatched,
  audioTrackLanguage,
  canAutoSkip,
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
  ProfileSummary,
} from "../src/shared";
const previewFrames = seekFrames();
let window: BrowserWindow;
let controls: BrowserWindow | undefined;
let videoView: BaseWindow | VideoHost | undefined;
let switching: Progress | undefined;
let worker: UtilityProcess | undefined;
let player: Player | undefined;
let sessionPlaybackRate = 1;
let fullscreenBeforePlayer: boolean | undefined;
let miniWindow:
  | {
      bounds: Electron.Rectangle;
      minimum: number[];
      maximized: boolean;
      fullscreen: boolean;
      pinned: boolean;
    }
  | undefined;
function restorePlayerWindow() {
  if (!miniWindow || window.isDestroyed()) return;
  const saved = miniWindow;
  miniWindow = undefined;
  window.setAlwaysOnTop(saved.pinned);
  window.setFullScreen(false);
  window.setMinimumSize(saved.minimum[0], saved.minimum[1]);
  window.setBounds(saved.bounds);
  if (saved.maximized) window.maximize();
  window.setFullScreen(saved.fullscreen);
}
let files: TorrentFile[] = [];
let selected: Release | undefined;
let current: Progress | undefined;
let busy = false;
let playbackRequest = 0;
let automaticRunning = false;
let automaticFinished = Promise.resolve();
let sourceSearch: AbortController | undefined;
let pendingPlayback: Playback | undefined;
let closing = false;
let stopVideoCapture: (() => void) | undefined;
let captureResize: ReturnType<typeof setTimeout> | undefined;
let updateStatus: UpdateStatus = { busy: false, message: "" };
let state: State;
let statePath: string;
let userRoot: string;
let importFile: string | undefined;
let lastScreenshot: string | undefined;
let tokenPath: string;
let cancelSignIn: ((error: Error) => void) | undefined;
let syncPreview:
  | {
      remote: Awaited<ReturnType<typeof readRemote>>["entries"];
      changes: SyncChange[];
    }
  | undefined;
let syncTimer: ReturnType<typeof setTimeout> | undefined;
let syncRunning = false;
declare const NEN_MAL_APP_ID: string;
const malAppId = NEN_MAL_APP_ID;
const malTokenPath = () =>
  join(profileDir(userRoot, state.profiles!.active), "mal-token.bin");
const malRequest = malClient(
  malAppId,
  (): MalTokens => {
    if (!safeStorage.isEncryptionAvailable() || !existsSync(malTokenPath()))
      throw Error("Connect MyAnimeList first.");
    return JSON.parse(safeStorage.decryptString(readFileSync(malTokenPath())));
  },
  (value) =>
    writeFileSync(
      malTokenPath(),
      safeStorage.encryptString(JSON.stringify(value)),
    ),
);
const malAccounts = malAccount(
  () => state,
  malRequest,
  getToken,
  () => {
    save();
    if (window && !window.isDestroyed())
      window.webContents.send("watch-state", state);
  },
  () => syncRunning,
);

async function refreshAniList() {
  const deadline = Date.now() + 120000;
  while (syncRunning || malAccounts.busy) {
    if (Date.now() > deadline)
      throw Error(
        "Account sync is taking longer than expected. Try again shortly.",
      );
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!state.anilist.connected) throw Error("Connect AniList first.");
  syncRunning = true;
  try {
    const remote = await readRemote(getToken());
    await refreshRemote(state.watch, remote.entries, state.anilist);
    state.anilist.user = remote.user;
    syncPreview = undefined;
    save();
    if (window && !window.isDestroyed())
      window.webContents.send("watch-state", state);
    return state;
  } finally {
    syncRunning = false;
  }
}
async function refreshAccounts() {
  for (const service of ["anilist", "mal"] as const) {
    if (!state[service]?.connected) continue;
    try {
      if (service === "anilist") await refreshAniList();
      else await malAccounts.refresh();
    } catch (error) {
      state[service]!.error =
        error instanceof Error ? error.message : String(error);
      save();
    }
  }
}
function queueSync() {
  if (syncTimer || (!state.anilist.connected && !state.mal?.connected)) return;
  syncTimer = setTimeout(() => {
    syncTimer = undefined;
    void syncUncontested();
  }, 12000);
}
async function syncUncontested() {
  if (syncRunning || malAccounts.busy || malAccounts.reviewing) return;
  if (!state.anilist.connected || !state.anilist.lastSync || syncPreview) {
    await malAccounts.sync();
    return;
  }
  syncRunning = true;
  try {
    await syncFavorites(getToken(), state.favorites, state.favoriteChanges);
    const remote = await readRemote(getToken());
    const changes = previewAniList(
      state.watch,
      remote.entries,
      state.anilist,
    ).changes;
    await applyAniList(
      getToken(),
      state.watch,
      remote.entries,
      state.anilist,
      changes.filter((row) => !row.conflict),
    );
    if (changes.some((row) => row.conflict))
      state.anilist.error = "Some AniList changes need review. Use Refresh.";
    save();
    if (window && !window.isDestroyed())
      window.webContents.send("watch-state", state);
  } catch (error) {
    state.anilist.error = String(error);
    save();
    if (window && !window.isDestroyed())
      window.webContents.send("watch-state", state);
    if (!syncTimer && state.anilist.connected) {
      syncTimer = setTimeout(() => {
        syncTimer = undefined;
        void syncUncontested();
      }, 60000);
      syncTimer.unref();
    }
  } finally {
    syncRunning = false;
  }
  await malAccounts.sync();
}
function getToken(): string {
  if (!existsSync(tokenPath)) throw Error("Connect AniList first.");
  if (!safeStorage.isEncryptionAvailable())
    throw Error("Protected storage is unavailable.");
  return safeStorage.decryptString(readFileSync(tokenPath));
}
async function connectAniList(): Promise<{ sharedWith?: string }> {
  if (!safeStorage.isEncryptionAvailable())
    throw Error("Protected storage is unavailable.");
  if (cancelSignIn) throw Error("AniList sign-in is already open.");
  // Tie the sign-in to this profile so a switch cannot save the token into another one.
  const profile = state.profiles!.active;
  const target = tokenPath;
  const nonce = randomBytes(24).toString("hex");
  const token = await new Promise<string>((resolve, reject) => {
    let done = false;
    const server = createServer((req, res) => {
      if (req.url === "/callback" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
          "Content-Security-Policy":
            "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'",
        });
        res.end(
          `<!doctype html><meta charset="utf-8"><p>Connecting AniList to Nen…</p><script>const token=new URLSearchParams(location.hash.slice(1)).get('access_token');if(token)fetch('/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({token,nonce:'${nonce}'})}).then(()=>{document.body.textContent='AniList is connected. You can close this tab.'});else document.body.textContent='AniList did not send a token.';</script>`,
        );
        return;
      }
      if (req.url === "/token" && req.method === "POST") {
        let body = "";
        req.on("data", (chunk) => {
          body += chunk;
          if (body.length > 10000) req.destroy();
        });
        req.on("end", () => {
          try {
            const data = JSON.parse(body);
            if (
              data.nonce !== nonce ||
              typeof data.token !== "string" ||
              !/^[\w.-]{20,5000}$/.test(data.token)
            )
              throw Error("Invalid sign-in response.");
            res.writeHead(200, {
              "Content-Type": "text/plain",
              "Cache-Control": "no-store",
            });
            res.end("OK");
            finish(undefined, data.token);
          } catch {
            res.writeHead(400);
            res.end("Invalid response");
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    const timer = setTimeout(
      () => finish(Error("AniList sign-in timed out.")),
      180000,
    );
    const finish = (error?: Error, value?: string) => {
      if (done) return;
      done = true;
      cancelSignIn = undefined;
      clearTimeout(timer);
      server.close();
      if (error) reject(error);
      else resolve(value!);
    };
    cancelSignIn = (error) => finish(error);
    server.on("error", (error) => finish(error));
    server.listen(43187, "127.0.0.1", () => {
      const url = new URL("https://anilist.co/api/v2/oauth/authorize");
      url.search = new URLSearchParams({
        client_id: "51914",
        response_type: "token",
      }).toString();
      void shell.openExternal(url.toString()).catch((error) => finish(error));
    });
  });
  const remote = await readRemote(token);
  if (state.profiles!.active !== profile)
    throw Error("The profile changed during AniList sign-in. Connect again.");
  writeFileSync(target, safeStorage.encryptString(token));
  state.anilist = { connected: true, user: remote.user, baseline: {} };
  syncPreview = undefined;
  save();
  const other = state.profiles!.list.find(
    (p) => p.id !== profile && p.anilistUser === remote.user,
  );
  return { sharedWith: other?.name };
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
    autoUpdates: true,
    discordPresence: false,
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
  favorites: {},
  favoriteChanges: {},
  anilist: { connected: false, baseline: {} },
  markers: {},
  mappings: {},
};
function setUpdateStatus(value: UpdateStatus) {
  updateStatus = value;
  if (window && !window.isDestroyed())
    window.webContents.send("update-status", value);
}
let availableUpdate: Update | undefined;
let startupCheck: Promise<UpdateStatus> | undefined;
function startupUpdate() {
  return (startupCheck ??= (async () => {
    await checkUpdates();
    if (availableUpdate && state.settings.autoUpdates && app.isPackaged)
      await installUpdate();
    return updateStatus;
  })());
}
async function checkUpdates() {
  if (updateStatus.busy) return updateStatus;
  setUpdateStatus({
    busy: true,
    message: "Checking for updates…",
    available: !!availableUpdate,
  });
  try {
    const result = await findUpdate(NEN_BUILD_COMMIT);
    availableUpdate = result.update;
    setUpdateStatus({
      busy: false,
      message: result.message,
      available: !!availableUpdate,
    });
  } catch (error) {
    setUpdateStatus({
      busy: false,
      available: !!availableUpdate,
      message:
        error instanceof Error
          ? error.message
          : "The update check failed. Try again later.",
    });
  }
  return updateStatus;
}
async function installUpdate() {
  if (updateStatus.busy || !availableUpdate) return updateStatus;
  if (!app.isPackaged) {
    setUpdateStatus({
      busy: false,
      available: true,
      message: "Run the installed app to install this update.",
    });
    return updateStatus;
  }
  const update = availableUpdate;
  setUpdateStatus({
    busy: true,
    installing: true,
    available: true,
    message: "Updating…",
    percent: 0,
  });
  try {
    const installer = await downloadUpdate(
      update,
      join(app.getPath("userData"), "update-cache"),
      (percent) => {
        if (percent !== updateStatus.percent)
          setUpdateStatus({
            busy: true,
            installing: true,
            available: true,
            message: "Updating…",
            percent,
          });
      },
    );
    setUpdateStatus({
      busy: true,
      installing: true,
      available: true,
      message: "Installing update. Nen will restart…",
    });
    record();
    save();
    await new Promise<void>((resolve, reject) => {
      const child = spawn(installer, ["/S", "--updated", "--force-run"], {
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
      child.once("error", reject);
      child.once("spawn", () => {
        child.unref();
        resolve();
      });
    });
    setTimeout(() => app.quit(), 250);
  } catch (error) {
    setUpdateStatus({
      busy: false,
      available: true,
      message:
        error instanceof Error
          ? error.message
          : "The update failed. Try again later.",
    });
  }
  return updateStatus;
}
function save() {
  const profiles = state.profiles!;
  const summary = profiles.list.find((p) => p.id === profiles.active);
  if (summary) {
    summary.anilistUser = state.anilist.connected
      ? state.anilist.user
      : undefined;
    summary.malUser = state.mal?.connected ? state.mal.user : undefined;
  }
  const { shared, profile } = splitState(state);
  writeProfile(userRoot, profiles.active, profile);
  writeJson(statePath, shared);
}
function activeProfile() {
  return state.profiles!.list.find((p) => p.id === state.profiles!.active)!;
}
function profileBackup(name: string) {
  return profileFile(userRoot, state.profiles!.active) + name;
}
/** Reads and checks a profile before anything is changed. */
function readProfileData(id: string) {
  const stored = readProfile(userRoot, id);
  try {
    return {
      stored,
      settings: settings({
        ...defaults.settings,
        ...stored.settings,
        autoUpdates: state.settings.autoUpdates,
      } as State["settings"]),
    };
  } catch {
    throw Error(
      "Profile settings could not be read. Back up the profiles folder before resetting it.",
    );
  }
}
/** Loads a profile's data into state. Device-wide fields and auto updates are kept. */
function loadProfile(id: string, data = readProfileData(id)) {
  const { stored } = data;
  state.profiles!.active = id;
  state.settings = data.settings;
  state.seriesAudio = stored.seriesAudio;
  state.progress = stored.progress ?? {};
  state.watch = stored.watch ?? {};
  state.favorites = stored.favorites ?? {};
  state.favoriteChanges = stored.favoriteChanges ?? {};
  state.anilist = { ...defaults.anilist, ...stored.anilist, connected: false };
  state.mal = { connected: false, baseline: {}, ...stored.mal };
  state.mal.connected = existsSync(
    join(profileDir(userRoot, id), "mal-token.bin"),
  );
  malAccounts.reset();
  tokenPath = tokenFile(userRoot, id);
  const repaired = repairProgress(state.progress);
  if (JSON.stringify(repaired) !== JSON.stringify(state.progress)) {
    const backup = profileBackup(".before-episode-repair.json");
    if (!existsSync(backup)) copyFileSync(profileFile(userRoot, id), backup);
    state.progress = repaired;
    save();
  }
  if (migrateProgress(state.watch, state.progress)) {
    const backup = profileBackup(".before-watch-migration.json");
    if (!existsSync(backup)) copyFileSync(profileFile(userRoot, id), backup);
    save();
  }
  if (migrateWatchLater(state)) save();
  state.anilist.connected = existsSync(tokenPath);
  if (state.anilist.connected || state.mal.connected)
    syncTimer = setTimeout(() => {
      syncTimer = undefined;
      void refreshAccounts();
    }, 3000);
}
function findProfile(id: unknown): ProfileSummary {
  const found = state.profiles!.list.find((p) => p.id === profileId(id));
  if (!found) throw Error("Profile was not found.");
  return found;
}
async function switchProfile(id: unknown) {
  const target = findProfile(id);
  if (target.id === state.profiles!.active) return;
  if (syncRunning || malAccounts.busy || malAccounts.reviewing)
    throw Error("Account sync is running. Try again shortly.");
  if (busy || automaticRunning)
    throw Error(
      "Wait for the current video to finish loading, then try again.",
    );
  const data = readProfileData(target.id);
  cancelSignIn?.(
    Error("AniList sign-in was cancelled because the profile changed."),
  );
  if (together.state.connected) together.disconnect();
  // stop() records playback progress into the current profile before it is replaced.
  // Everything up to loadProfile() runs in this tick, so the reloaded page only sees the new profile.
  const page = stop(true, false, { profileSwitched: "1" });
  save();
  clearTimeout(syncTimer);
  syncTimer = undefined;
  syncPreview = undefined;
  importFile = undefined;
  loadProfile(target.id, data);
  save();
  nativeTheme.themeSource = state.settings.theme;
  discordPresence.update(
    state.settings.discordPresence === true,
    undefined,
    together.state,
  );
  await page;
}
function playbackSettings(mediaId: number): Settings {
  const audio = state.seriesAudio?.[String(mediaId)];
  return {
    ...state.settings,
    audio:
      typeof audio === "string" && /^[a-z]{3}$/.test(audio)
        ? audio
        : state.settings.audio,
  };
}
let localFiles: LocalFiles;
let localCurrent:
  | {
      id: string;
      path: string;
      info: { size: number; mtimeMs: number };
      next?: string;
    }
  | undefined;
function record() {
  if (localCurrent && player) {
    try {
      localFiles.record(
        localCurrent.id,
        localCurrent.path,
        player.status.position,
        player.status.duration,
        localCurrent.info,
      );
    } catch (error) {
      player.status.error =
        "Local progress could not be saved: " + String(error);
    }
    lastSave = Date.now();
    return;
  }
  if (current && player && player.status.duration > 0) {
    current.position = player.status.position;
    current.duration = player.status.duration;
    const oldMark =
      state.watch[String(current.mediaId)]?.runs.at(-1)?.episodes[
        String(current.episode)
      ];
    current.watched = oldMark?.manual ? oldMark.watched : isWatched(current);
    current.updated = Date.now();
    state.progress[`${current.mediaId}:${current.episode}`] = current;
    let entry = state.watch[String(current.mediaId)];
    if (!entry) {
      entry = newEntry({
        id: current.mediaId,
        title: { english: current.title, romaji: current.title, native: null },
        coverImage: { large: current.cover },
        episodes: current.totalEpisodes,
        isAdult: current.isAdult,
      });
      state.watch[String(current.mediaId)] = entry;
    }
    if (entry.status === "PLANNING") {
      entry.status = "CURRENT";
      entry.statusUpdated = Date.now();
    }
    markEpisode(entry, current.episode, {
      watched: current.watched,
      position: current.position,
      duration: current.duration,
    });
    try {
      save();
      queueSync();
    } catch (error) {
      player.status.error = `Progress could not be saved: ${String(error)}`;
    }
    lastSave = Date.now();
  }
}
const together = new Together({
  version: NEN_BUILD_COMMIT ? app.getVersion() : `${app.getVersion()}-dev`,
  cancel: () => {
    playbackRequest++;
    sourceSearch?.abort();
  },
  changed: (value) => {
    discordPresence.update(
      state.settings.discordPresence === true,
      player?.status,
      value,
    );
    for (const target of new Set([window, controls]))
      if (target && !target.isDestroyed())
        target.webContents.send("together", value);
  },
  playback: () => player?.status,
  prepare: async (id, ep, preferredHash) => {
    if (automaticRunning || busy) throw Error("Wait for the current source.");
    await autoPlay(id, ep, undefined, preferredHash);
  },
  command: (command) => (player ? player.command(command) : Promise.resolve()),
});
let joiningDiscord = false;
const discordPresence = new DiscordPresence((secret) => {
  void joinDiscordSession(secret);
});
async function joinDiscordSession(secret: string) {
  if (joiningDiscord || closing) return;
  if (together.state.connected && together.state.code === secret) return;
  joiningDiscord = true;
  try {
    if (together.state.connected)
      throw Error(
        "Leave your current Watch together session before joining another one.",
      );
    if (busy || automaticRunning)
      throw Error(
        "Wait for the current video to finish loading, then try the invite again.",
      );
    await stop(true, false, { together: "1" });
    await together.connect(secret);
  } catch (error) {
    if (!closing && window && !window.isDestroyed())
      void dialog.showMessageBox(window, {
        type: "error",
        title: "Watch together",
        message: "Could not join the session",
        detail: error instanceof Error ? error.message : String(error),
      });
  } finally {
    joiningDiscord = false;
  }
}
let publishTimer: NodeJS.Timeout | undefined;
function publish() {
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = undefined;
    if (player && selected)
      player.status.sourceName =
        selected.group && selected.group !== "Unknown group"
          ? selected.group
          : selected.source;
    discordPresence.update(
      state.settings.discordPresence === true,
      player?.status,
      together.state,
    );
    for (const target of new Set([window, controls]))
      if (target && !target.isDestroyed())
        target.webContents.send(
          "playback",
          (automaticRunning ? pendingPlayback : undefined) ??
            player?.status ??
            pendingPlayback ?? {
              active: false,
              position: 0,
              duration: 0,
              paused: false,
              tracks: [],
              speed: 0,
              peers: 0,
              markers: [],
            },
        );
  }, 100);
}
function stop(
  closeView = true,
  keepTorrent = false,
  returnQuery?: Record<string, string>,
) {
  let page: Promise<void> | undefined;
  discordPresence.update(
    state.settings.discordPresence === true,
    undefined,
    together.state,
  );
  record();
  cancelPreparation();
  const returnMedia = current?.mediaId ?? pendingPlayback?.mediaId;
  if (localCurrent && !returnQuery)
    returnQuery = {
      localSource: localCurrent.id,
      localPath:
        dirname(localCurrent.path) === "." ? "" : dirname(localCurrent.path),
    };
  if (closeView) {
    playbackRequest++;
    sourceSearch?.abort();
    pendingPlayback = undefined;
    clearTimeout(captureResize);
    stopVideoCapture?.();
    stopVideoCapture = undefined;
    switching = undefined;
    restorePlayerWindow();
    const returning = !!controls && controls === window;
    controls = undefined;
    if (
      returning &&
      !closing &&
      !window.isDestroyed() &&
      fullscreenBeforePlayer !== undefined
    )
      window.setFullScreen(fullscreenBeforePlayer);
    fullscreenBeforePlayer = undefined;
    videoView?.destroy();
    videoView = undefined;
    if ((returning || returnQuery) && !closing && !window.isDestroyed())
      page = loadPage(
        returnQuery ?? { returnMedia: String(returnMedia ?? "") },
      );
  }
  player?.stop();
  player = undefined;
  current = undefined;
  previewFrames.reset();
  localCurrent = undefined;
  remote = [];
  skipped.clear();
  undoPosition = undefined;
  markersRequested = false;
  markerAttempts = 0;
  if (keepTorrent) return;
  const old = worker;
  worker = undefined;
  old?.postMessage({ action: "stop" });
  if (old && !downloadWorkers.has(old))
    setTimeout(() => {
      try {
        old.kill();
      } catch {}
    }, 1500).unref();
  files = [];
  selected = undefined;
  publish();
  return page;
}
let prepared:
  | { worker: UtilityProcess; release: Release; files: TorrentFile[] }
  | undefined;
let preparationSearch: AbortController | undefined;
let preparationKey = "";
function cancelPreparation() {
  preparationSearch?.abort();
  preparationSearch = undefined;
  preparationKey = "";
  try {
    worker?.postMessage({ action: "unprepare" });
  } catch {}
  const old = prepared?.worker;
  prepared = undefined;
  if (old) {
    try {
      old.postMessage({ action: "stop" });
    } catch {}
    setTimeout(() => {
      try {
        old.kill();
      } catch {}
    }, 1500).unref();
  }
}
async function prepareNext() {
  const active = player;
  const episode = active?.status.nextEpisode;
  if (
    !state.settings.prepareNext ||
    !active ||
    !episode ||
    !current ||
    together.state.connected
  )
    return;
  const ranges = active.status.download?.ranges;
  if (!ranges?.some(([start, end]) => start === 0 && end === 1)) return;
  const id = active.status.nextMediaId ?? current.mediaId;
  const key = [current.hash, current.file.index, id, episode].join(":");
  if (key === preparationKey) return;
  cancelPreparation();
  preparationKey = key;
  const search = (preparationSearch = new AbortController());
  let background: UtilityProcess | undefined;
  try {
    const anime = await providers.media(id);
    if (search.signal.aborted || player !== active) return;
    const same =
      selected &&
      matchesMedia(selected.title, anime) &&
      matchingFile(files, selected, anime, episode);
    if (same && worker) {
      worker.postMessage({ action: "prepare", index: same.index });
      return;
    }
    const result = await providers.releases(
      anime,
      episode,
      undefined,
      state.settings.source,
      search.signal,
      playbackSettings(id).audio,
    );
    if (search.signal.aborted || player !== active) return;
    const release = automaticRelease(
      result.items,
      episode,
      playbackSettings(id),
    );
    if (!release) return;
    known.set(release.hash, release);
    background = utilityProcess.fork(join(__dirname, "torrent.mjs"), [], {
      serviceName: "Nen next episode",
      stdio: "ignore",
    });
    prepared = { worker: background, release, files: [] };
    const root = join(app.getPath("userData"), "torrents", release.hash);
    mkdirSync(root, { recursive: true });
    const resultFiles = await workerRequest(
      "files",
      { action: "inspect", hash: release.hash, path: root },
      60000,
      background,
    );
    if (
      search.signal.aborted ||
      player !== active ||
      prepared?.worker !== background
    )
      return;
    const file = matchingFile(resultFiles.files, release, anime, episode);
    if (!file) {
      cancelPreparation();
      preparationKey = key;
      return;
    }
    prepared.files = resultFiles.files;
    await workerRequest(
      "prepared",
      { action: "prepare", index: file.index },
      10000,
      background,
    );
  } catch {
    if (preparationSearch === search) {
      cancelPreparation();
      preparationKey = key;
    }
  }
}
const downloadWorkers = new Set<UtilityProcess>();
function workerRequest(
  event: string,
  payload: object,
  timeout = 60000,
  target = worker,
): Promise<any> {
  if (!target) return Promise.reject(Error("Torrent engine is not ready."));
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      target.removeListener("message", message);
      target.removeListener("exit", exit);
    };
    const message = (data: any) => {
      if (
        target === worker &&
        event === "files" &&
        data.event === "verifying"
      ) {
        clearTimeout(timer);
        timer = setTimeout(
          () => {
            cleanup();
            reject(Error("Checking cached files took too long."));
          },
          10 * 60 * 1000,
        );
        if (pendingPlayback)
          pendingPlayback.loadingNotice = "Connecting to the source…";
        publish();
      }
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
    let timer = timeout
      ? setTimeout(() => {
          cleanup();
          reject(
            Error(
              "No torrent metadata arrived. Try a release with more seeds.",
            ),
          );
        }, timeout)
      : undefined;
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
    const ready =
      prepared?.release.hash === release.hash && prepared.files.length
        ? prepared
        : undefined;
    if (ready) prepared = undefined;
    stop(false);
    selected = release;
    worker =
      ready?.worker ??
      utilityProcess.fork(join(__dirname, "torrent.mjs"), [], {
        serviceName: "Nen torrent engine",
        stdio: "ignore",
      });
    const activeWorker = worker;
    worker.on("message", (data: any) => {
      if (data.event === "stats" && worker === activeWorker && player) {
        Object.assign(player.status, {
          speed: data.speed,
          peers: data.peers,
          download: data.download,
        });
        void prepareNext();
        publish();
      }
      if (data.event === "error" && worker === activeWorker && player) {
        player.status.error = data.message;
        publish();
      }
    });
    worker.on("exit", () => {
      if (worker === activeWorker && player?.status.active) {
        player.status.error = "Torrent engine stopped.";
        publish();
      }
    });
    const root = join(app.getPath("userData"), "torrents", release.hash);
    mkdirSync(root, { recursive: true });
    files =
      ready?.files ??
      (
        await workerRequest(
          "files",
          {
            action: "inspect",
            hash: release.hash,
            path: root,
          },
          timeout,
        )
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
  const chapters: Marker[] = (player.status.chapters ?? [])
    .flatMap<Marker>((chapter, i, list) => {
      const title = chapter.title?.trim() ?? "";
      const type = /^(?:op|opening)(?:\b|\d)/i.test(title)
        ? "op"
        : /^(?:ed|ending)(?:\b|\d)/i.test(title)
          ? "ed"
          : undefined;
      return type
        ? [
            {
              type,
              start: chapter.time,
              end: list[i + 1]?.time ?? player!.status.duration,
              confirmed: false,
            },
          ]
        : [];
    })
    .filter((m) => validMarker(m, player!.status.duration));
  player.status.markers = [
    ...local,
    ...chapters.filter((m) => !local.some((l) => l.type === m.type)),
    ...remote.filter(
      (m) => ![...local, ...chapters].some((l) => l.type === m.type),
    ),
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
  if (
    together.state.connected &&
    (together.state.selection?.mediaId !== mediaId ||
      together.state.selection?.episode !== episode)
  )
    throw Error("Choose the episode with the host first.");
  if (busy) throw Error("Wait for the current playback request.");
  busy = true;
  const request = playbackRequest;
  try {
    if (!selected || !worker) throw Error("Choose a release first.");
    const file = files.find((f) => f.index === index);
    if (!file) throw Error("Choose a playable file.");
    const anime =
      resume &&
      !selected.sourceOffset &&
      !selected.season &&
      !/\bSTAGE\b/i.test(resume.title)
        ? {
            title: { english: resume.title, romaji: resume.title },
            coverImage: { large: resume.cover },
            idMal: resume.malId ?? null,
            episodes: resume.totalEpisodes ?? null,
            nextAiringEpisode: null,
          }
        : await providers.media(mediaId);
    const matched = matchingFile(files, selected, anime as any, episode);
    if (together.state.connected && matched?.index !== file.index)
      throw Error(
        "This source has no clear file match for the session episode. Choose another source.",
      );
    const fileEpisode = parseRelease(
      file.path.split(/[\\/]/).at(-1) ?? "",
      episode,
    ).episode;
    if (
      fileEpisode !== null &&
      fileEpisode !==
        episode + (selected.sourceOffset ?? sourceOffset(anime as any))
    )
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
    if (request !== playbackRequest) throw Error("Playback cancelled.");
    if (
      (!resume && !matchesMedia(selected.title, anime as any)) ||
      (matched?.index !== file.index && !matchesSeason(file.path, anime as any))
    )
      throw Error(
        "This source uses a different season. Choose another source.",
      );
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
    const watchPosition =
      watchEntry?.runs.at(-1)?.episodes[String(episode)]?.position;
    const startAt = together.state.connected
      ? (together.state.position ?? 0)
      : (startPosition ??
        (watchEntry?.status === "REPEATING"
          ? (watchPosition ?? 0)
          : (watchPosition ?? resume?.position)) ??
        (switching?.mediaId === mediaId && switching.episode === episode
          ? switching.position
          : 0));
    if (request !== playbackRequest) throw Error("Playback cancelled.");
    const result = await workerRequest("stream", { action: "stream", index });
    if (request !== playbackRequest) throw Error("Playback cancelled.");
    current = {
      watched:
        state.watch[String(mediaId)]?.runs.at(-1)?.episodes[String(episode)]
          ?.watched ?? isWatched(state.progress[`${mediaId}:${episode}`]),
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
      cover: current.cover,
      episodeTitle: current.episodeTitle,
      release: selected,
    });
    void (resume ? providers.media(mediaId) : Promise.resolve(anime))
      .then(async (media) => {
        if (episodeAvailability(media as any, episode + 1).released === true) {
          if (active === player) active.status.nextEpisode = episode + 1;
        } else if (media.episodes && episode >= media.episodes) {
          const sequels =
            (media as any).relations?.edges?.filter(
              (edge: any) =>
                edge.relationType === "SEQUEL" && edge.node.type === "ANIME",
            ) ?? [];
          for (const edge of sequels) {
            const sequel = await providers.media(edge.node.id);
            if (episodeAvailability(sequel, 1).released === true) {
              if (active === player) {
                active.status.nextEpisode = 1;
                active.status.nextMediaId = sequel.id;
              }
              break;
            }
          }
        }
        if (active === player) publish();
      })
      .catch(() => {});
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
            .catch(() => {
              if (active === player) {
                active.status.skipNotice =
                  "Skip times are unavailable. You can set them in More playback controls.";
                if (markerAttempts < 2)
                  setTimeout(() => {
                    if (active !== player) return;
                    markersRequested = false;
                    active.onChange();
                  }, 5000).unref();
                publish();
              }
            });
      }
      refreshMarkers();
      if (
        active.status.ended &&
        active.status.nextEpisode &&
        !together.state.connected &&
        state.settings.autoNext &&
        !nextStarted &&
        !automaticRunning
      ) {
        nextStarted = true;
        void autoPlay(
          active.status.nextMediaId ?? mediaId,
          active.status.nextEpisode,
        ).catch((error) => {
          active.status.error = error.message;
          publish();
        });
      }
      if (Date.now() - lastSave > 5000) record();
      if (
        !together.state.connected &&
        (state.settings.autoSkip || state.settings.autoSkipRecaps) &&
        !active.status.paused
      )
        for (const m of active.status.markers) {
          const key = JSON.stringify(m);
          if (
            canAutoSkip(
              m,
              active.status.position,
              state.settings.autoSkip,
              state.settings.autoSkipRecaps,
            ) &&
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
    await startPlayer(
      active,
      result.url,
      startAt,
      playbackSettings(mediaId),
      request,
      together.state.connected,
      together.state.connected
        ? (together.state.playbackRate ?? 1)
        : sessionPlaybackRate,
    );
    switching = undefined;
    record();
    publish();
  } catch (e) {
    if (request === playbackRequest) stop(false, !automaticRunning);
    throw e;
  } finally {
    busy = false;
  }
}
async function startPlayer(
  active: Player,
  url: string,
  position: number,
  settings: Settings,
  request: number,
  paused = false,
  rate = sessionPlaybackRate,
) {
  await openPlayerView();
  if (request !== playbackRequest) throw Error("Playback cancelled.");
  previewFrames.reset(url);
  await active.start(
    url,
    position,
    settings,
    app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "vendor"),
    process.platform === "win32"
      ? String(videoView!.getNativeWindowHandle().readUInt32LE())
      : process.platform === "linux"
        ? String(videoView!.getNativeWindowHandle().readBigUInt64LE())
        : undefined,
    paused,
    rate,
    state.volume ?? 100,
  );
  if (request !== playbackRequest) {
    active.stop();
    throw Error("Playback cancelled.");
  }
  controls?.show();
  controls?.moveTop();
  controls?.focus();
}
async function playLocal(id: string, path: string) {
  if (busy || automaticRunning)
    throw Error("Wait for the current video to finish loading.");
  if (together.state.connected)
    throw Error("Leave Watch together before playing local files.");
  busy = true;
  const request = ++playbackRequest;
  try {
    const video = await localFiles.video(id, path);
    const subtitles = await localFiles.subtitles(id, path);
    if (request !== playbackRequest) return;
    stop(false);
    pendingPlayback = undefined;
    localCurrent = { id, path, info: video.info, next: video.next };
    const active = (player = new Player());
    Object.assign(active.status, {
      title: video.folder,
      local: { name: video.name, folder: video.folder },
      sourceName: "Local file",
      nextEpisode: video.next ? 1 : undefined,
    });
    active.onClose = () => {
      if (active === player) void stop();
    };
    let nextStarted = false,
      subtitlesLoaded = false;
    active.onChange = () => {
      if (active !== player) return;
      if (active.status.ready && !subtitlesLoaded) {
        subtitlesLoaded = true;
        void (async () => {
          for (const file of subtitles) {
            if (active !== player) return;
            await active.command(["sub-add", file, "auto"]);
          }
        })().catch((error) => {
          active.status.error = "Could not load subtitles: " + error.message;
          publish();
        });
      }
      if (Date.now() - lastSave > 5000) record();
      if (
        active.status.ended &&
        video.next &&
        state.settings.autoNext &&
        !nextStarted &&
        !busy
      ) {
        nextStarted = true;
        void playLocal(id, video.next).catch((error) => {
          if (player) player.status.error = error.message;
          publish();
        });
      }
      publish();
    };
    await startPlayer(
      active,
      video.full,
      video.position,
      state.settings,
      request,
    );
    publish();
  } catch (error) {
    if (request === playbackRequest && localCurrent && player) {
      player.status.error =
        error instanceof Error ? error.message : String(error);
      publish();
    }
    throw error;
  } finally {
    busy = false;
  }
}
async function cancelAutomatic() {
  if (!automaticRunning) return;
  playbackRequest++;
  sourceSearch?.abort();
  stop(false);
  await automaticFinished;
  if (pendingPlayback)
    pendingPlayback.loadingNotice = "Choose a source to continue.";
  publish();
}
async function autoPlay(
  mediaId: number,
  episode: number,
  saved?: Progress,
  preferredHash?: string,
) {
  if (automaticRunning || busy)
    throw Error("Wait for the current playback request.");
  automaticRunning = true;
  let finished!: () => void;
  automaticFinished = new Promise<void>((resolve) => {
    finished = resolve;
  });
  sourceSearch = new AbortController();
  const request = ++playbackRequest;
  const attempted = new Set<string>();
  let candidates: Release[] | undefined;
  let failure = "No streams found.";
  const watchEntry = state.watch[String(mediaId)];
  let startAt =
    watchEntry?.status === "REPEATING"
      ? (watchEntry.runs.at(-1)?.episodes[String(episode)]?.position ?? 0)
      : (watchEntry?.runs.at(-1)?.episodes[String(episode)]?.position ??
        saved?.position ??
        0);
  try {
    if (together.state.connected) {
      stop(false);
      startAt = together.state.position ?? 0;
    }
    pendingPlayback = {
      active: true,
      position: startAt,
      duration: 0,
      paused: true,
      speed: 0,
      peers: 0,
      tracks: [],
      markers: [],
      mediaId,
      episode,
      loadingNotice: "Finding a source…",
    };
    await openPlayerView();
    publish();
    let anime = saved
      ? ({
          id: saved.mediaId,
          title: { english: saved.title, romaji: saved.title },
        } as any)
      : await providers.media(mediaId);
    if (request !== playbackRequest) return;
    const continuing =
      !saved &&
      (!preferredHash || selected?.hash === preferredHash) &&
      current?.mediaId === mediaId &&
      selected &&
      worker &&
      matchesMedia(selected.title, anime) &&
      matchingFile(files, selected, anime, episode) &&
      (state.settings.source === "all" ||
        selected.source === state.settings.source)
        ? selected
        : undefined;
    for (let attempt = 0; ; attempt++) {
      let release =
        attempt === 0
          ? (saved?.release ??
            continuing ??
            (prepared?.files.length &&
            preparationKey.endsWith(":" + mediaId + ":" + episode)
              ? prepared.release
              : undefined))
          : undefined;
      if (!release) {
        if (!candidates) {
          anime = await providers.media(mediaId);
          const result = await providers.releases(
            anime,
            episode,
            undefined,
            state.settings.source,
            sourceSearch.signal,
            playbackSettings(mediaId).audio,
          );
          candidates = result.items;
          if (!candidates.length && result.errors.length)
            failure = result.errors.join(" ");
          for (const row of candidates) known.set(row.hash, row);
        }
        if (request !== playbackRequest) return;
        release =
          candidates.find(
            (r) => r.hash === preferredHash && !attempted.has(r.hash),
          ) ??
          automaticRelease(
            candidates.filter((r) => !attempted.has(r.hash)),
            episode,
            playbackSettings(mediaId),
          );
      }
      if (!release) break;
      attempted.add(release.hash);
      if (
        saved &&
        release.hash === saved.hash &&
        !matchesMedia(release.title, anime)
      ) {
        anime = await providers.media(mediaId);
        if (request !== playbackRequest) return;
        if (!matchesMedia(release.title, anime)) {
          startAt = 0;
          continue;
        }
      }
      known.set(release.hash, release);
      pendingPlayback = {
        active: true,
        position: startAt,
        duration: 0,
        paused: false,
        speed: 0,
        peers: 0,
        tracks: [],
        markers: [],
        mediaId,
        episode,
        title: anime.title.english || anime.title.romaji,
        loadingNotice: attempt
          ? "Connecting to another source…"
          : "Connecting to the source…",
      };
      publish();
      try {
        const list = await inspect(release.hash, 12000);
        if (request !== playbackRequest) return;
        const file =
          saved && release.hash === saved.hash
            ? list.find(
                (f) => f.path === saved.file.path && f.size === saved.file.size,
              )
            : matchingFile(list, release, anime, episode);
        if (!file)
          throw Error("The source has no unambiguous file for this episode.");
        await play(
          mediaId,
          episode,
          file.index,
          saved?.malEpisode ?? episode,
          saved && release.hash === saved.hash ? saved : undefined,
          startAt,
        );
        if (request !== playbackRequest) return;
        const active = player!;
        const deadline = Date.now() + 15000;
        const started = () =>
          active.status.ready &&
          active.status.duration > 0 &&
          !active.status.buffering &&
          !active.status.seeking &&
          (active.status.paused || active.status.position > startAt + 0.2);
        while (
          request === playbackRequest &&
          player === active &&
          !started() &&
          !active.status.error &&
          Date.now() < deadline
        )
          await new Promise((resolve) => setTimeout(resolve, 100));
        if (request !== playbackRequest) return;
        if (player === active && !active.status.error && started()) {
          pendingPlayback = undefined;
          return;
        }
        failure = active.status.error ?? "This source took too long to start.";
      } catch (error) {
        if (request !== playbackRequest) return;
        failure = (error as Error).message;
      }
    }
    if (request === playbackRequest) {
      const message = attempted.size
        ? "None of the available sources could play this episode. Try again later or choose a source manually."
        : failure;
      if (controls) {
        stop(false);
        if (pendingPlayback) pendingPlayback.error = message;
        publish();
        if (together.state.connected) throw Error(message);
      } else throw Error(message);
    }
  } catch (error) {
    if (request !== playbackRequest) return;
    if (!controls) throw error;
    stop(false);
    const status = pendingPlayback;
    if (status) status.error = (error as Error).message;
    publish();
    if (together.state.connected) throw error;
  } finally {
    if (!controls) pendingPlayback = undefined;
    automaticRunning = false;
    sourceSearch = undefined;
    finished();
    publish();
  }
}
function settings(value: Settings): Settings {
  validateLibrary(value);
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
  for (const key of [
    "showAdult",
    "hideZeroSeeds",
    "autoNext",
    "autoUpdates",
    "discordPresence",
    "hideOpenAniList",
    "hideOpenMyAnimeList",
    "compactView",
    "showEpisodeName",
    "blurUnwatched",
    "privateSession",
    "prepareNext",
    "autoSkipRecaps",
    "subtitleShadow",
  ] as const)
    if (value[key] !== undefined && typeof value[key] !== "boolean")
      throw Error("Invalid content preference.");
  for (const [key, min, max] of [
    ["subtitleSize", 50, 250],
    ["subtitlePosition", 0, 100],
    ["subtitleDelay", -3600, 3600],
  ] as const) {
    const n = value[key];
    if (n !== undefined && (!Number.isFinite(n) || n < min || n > max))
      throw Error("Invalid subtitle setting.");
  }
  for (const key of ["subtitleColour", "subtitleOutlineColour"] as const)
    if (value[key] !== undefined && !/^#[0-9a-f]{6}$/i.test(value[key]!))
      throw Error("Invalid subtitle colour.");
  if (
    value.hiddenContinue !== undefined &&
    (!value.hiddenContinue ||
      typeof value.hiddenContinue !== "object" ||
      Array.isArray(value.hiddenContinue) ||
      Object.entries(value.hiddenContinue).some(
        ([id, n]) => !/^\d+$/.test(id) || !Number.isFinite(n) || n < 0,
      ))
  )
    throw Error("Invalid hidden history.");
  const audio = text(value.audio, 60),
    subtitles = text(value.subtitles, 60);
  if (!/^[a-zA-Z, -]*$/.test(audio + subtitles))
    throw Error("Use language codes such as jpn or eng.");
  return {
    customLists: value.customLists,
    shelfLayouts: value.shelfLayouts,
    hiddenContinue: value.hiddenContinue,
    hideOpenMyAnimeList: value.hideOpenMyAnimeList ?? true,
    compactView: value.compactView ?? false,
    showEpisodeName: value.showEpisodeName ?? true,
    blurUnwatched: value.blurUnwatched ?? false,
    privateSession: value.privateSession ?? false,
    prepareNext: value.prepareNext ?? false,
    autoSkipRecaps: value.autoSkipRecaps ?? false,
    subtitleSize: value.subtitleSize,
    subtitlePosition: value.subtitlePosition,
    subtitleDelay: value.subtitleDelay,
    subtitleColour: value.subtitleColour,
    subtitleOutlineColour: value.subtitleOutlineColour,
    subtitleShadow: value.subtitleShadow ?? true,
    theme: value.theme,
    showAdult: value.showAdult ?? false,
    hideZeroSeeds: value.hideZeroSeeds ?? true,
    hideOpenAniList: value.hideOpenAniList ?? false,
    autoSkip: value.autoSkip,
    autoNext: value.autoNext ?? false,
    autoUpdates: value.autoUpdates ?? true,
    discordPresence: value.discordPresence ?? false,
    audio,
    subtitles,
    source: value.source,
    sourceMode: value.sourceMode ?? "auto",
    qualities: [...new Set(value.qualities ?? [1080, 720, 480, 360])].sort(
      (a, b) => b - a,
    ),
  };
}

app.setName("Nen");
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on("second-instance", () => {
    window?.show();
    window?.focus();
  });
  app
    .whenReady()
    .then(() => {
      userRoot = app.getPath("userData");
      localFiles = new LocalFiles(join(userRoot, "local-files.json"));
      statePath = join(userRoot, "state.json");
      mkdirSync(userRoot, { recursive: true });
      state = structuredClone(defaults);
      try {
        migrateLegacy(userRoot, statePath);
        if (existsSync(statePath)) {
          const { autoUpdates, profiles, ...stored } = JSON.parse(
            readFileSync(statePath, "utf8"),
          );
          if (!Array.isArray(profiles?.list) || !profiles.list.length)
            throw Error();
          const list: ProfileSummary[] = profiles.list.map(
            (p: ProfileSummary) => ({
              id: profileId(p.id),
              name: String(p.name).slice(0, 40),
              created: Number(p.created) || 0,
              anilistUser:
                typeof p.anilistUser === "string" ? p.anilistUser : undefined,
              malUser: typeof p.malUser === "string" ? p.malUser : undefined,
            }),
          );
          state = {
            ...defaults,
            ...stored,
            settings: {
              ...defaults.settings,
              autoUpdates: autoUpdates ?? true,
            },
            profiles: {
              active: list.some((p) => p.id === profiles.active)
                ? profiles.active
                : list[0].id,
              list,
            },
          };
        }
      } catch (error) {
        throw Error(
          "Saved state could not be read. " + (error as Error).message,
        );
      }
      if (!state.profiles) {
        const id = newProfileId([]);
        state.profiles = {
          active: id,
          list: [{ id, name: "Default", created: Date.now() }],
        };
        writeProfile(userRoot, id, {});
      }
      state.volume =
        typeof state.volume === "number" && Number.isFinite(state.volume)
          ? Math.max(0, Math.min(100, state.volume))
          : 100;
      state.version = NEN_BUILD_VERSION;
      providers.initCache(join(userRoot, "provider-cache.json"));
      loadProfile(state.profiles.active);
      save();
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
      if (app.isPackaged)
        app.setAsDefaultProtocolClient(`discord-${DISCORD_APP_ID}`);
      window.webContents.once("did-finish-load", () => discordPresence.start());
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
      window.on("close", (event) => {
        if (miniWindow && !closing) {
          event.preventDefault();
          stop();
          window.show();
          window.focus();
          return;
        }
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
      const sendFullscreen = () =>
        window.webContents.send("window-fullscreen", window.isFullScreen());
      window.on("enter-full-screen", () =>
        window.webContents.send("window-fullscreen", true),
      );
      window.on("leave-full-screen", () =>
        window.webContents.send("window-fullscreen", false),
      );
      window.webContents.on("did-finish-load", () => {
        sendFullscreen();
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
      handle("togetherState", () => together.state);
      handle("togetherCopyCode", () => {
        if (!together.state.connected || !together.state.code)
          throw Error("Join a session first.");
        clipboard.writeText(together.state.code);
      });
      handle("togetherConnect", (code) => {
        if (
          code !== undefined &&
          (typeof code !== "string" || !/^[A-Za-z0-9_-]{24}$/.test(code))
        )
          throw Error("Invalid session code.");
        return together.connect(code);
      });
      handle("togetherSend", (message) => {
        if (
          !message ||
          typeof message !== "object" ||
          JSON.stringify(message).length > 2000 ||
          !["chat", "chatEnabled", "allowPause", "pause", "seek"].includes(
            message.type,
          )
        )
          throw Error("Invalid session request.");
        together.send(message);
      });
      handle("togetherReload", () => together.reload());
      handle("togetherLeave", () => {
        together.disconnect();
        stop();
      });
      handle("seekPreview", (position) => {
        if (
          typeof position !== "number" ||
          !Number.isFinite(position) ||
          position < 0
        )
          throw Error("Invalid preview time.");
        return player && position <= player.status.duration
          ? previewFrames.get(position)
          : null;
      });
      handle("following", () =>
        state.anilist.connected ? readFollowing(getToken()) : [],
      );
      handle("favoriteSet", async (id, favorite) => {
        const mediaId = positive(id);
        if (typeof favorite !== "boolean")
          throw Error("Invalid favorite selection.");
        if (syncRunning || malAccounts.busy || malAccounts.reviewing)
          throw Error("Account sync is running. Try again shortly.");
        syncRunning = true;
        try {
          const entry = favorite
            ? (state.favorites[String(mediaId)] ??
              newEntry(await providers.media(mediaId)))
            : undefined;
          if (state.anilist.connected)
            await setRemoteFavorite(getToken(), mediaId, favorite);
          if (entry) state.favorites[String(mediaId)] = entry;
          else delete state.favorites[String(mediaId)];
          if (state.anilist.connected)
            delete state.favoriteChanges[String(mediaId)];
          else state.favoriteChanges[String(mediaId)] = favorite;
          save();
          return state;
        } finally {
          syncRunning = false;
        }
      });
      handle("watchAdd", async (id) => {
        const mediaId = positive(id);
        if (syncRunning || malAccounts.busy || malAccounts.reviewing)
          throw Error("Account sync is running. Try again shortly.");
        syncRunning = true;
        try {
          const entry = structuredClone(
            state.watch[String(mediaId)] ??
              newEntry(await providers.media(mediaId)),
          );
          entry.status = "PLANNING";
          entry.statusUpdated = entry.updated = Date.now();
          if (state.anilist.connected) {
            await setRemoteWatch(getToken(), mediaId, entry);
            state.anilist.baseline[String(mediaId)] = {
              status: entry.status,
              count: entry.count,
              repeat: entry.repeat,
            };
          }
          state.watch[String(mediaId)] = entry;
          queueSync();
          syncPreview = undefined;
          save();
          return state;
        } finally {
          syncRunning = false;
        }
      });
      handle("watchDelete", async (id, sync = false) => {
        const mediaId = positive(id);
        if (typeof sync !== "boolean") throw Error("Invalid sync option.");
        if (syncRunning || malAccounts.busy || malAccounts.reviewing)
          throw Error("Account sync is running. Try again shortly.");
        syncRunning = true;
        try {
          if (sync && state.anilist.connected)
            await setRemoteWatch(getToken(), mediaId);
          delete state.watch[String(mediaId)];
          delete state.anilist.baseline[String(mediaId)];
          for (const [key, saved] of Object.entries(state.progress))
            if (saved.mediaId === mediaId) delete state.progress[key];
          if (current?.mediaId === mediaId) current = undefined;
          syncPreview = undefined;
          save();
          return state;
        } finally {
          syncRunning = false;
        }
      });
      handle("watchEdit", async (id, patch) => {
        const mediaId = positive(id);
        if (!patch || typeof patch !== "object")
          throw Error("Invalid watch edit.");
        const entry = structuredClone(
          state.watch[String(mediaId)] ??
            newEntry(await providers.media(mediaId)),
        );
        if (
          patch.count !== undefined &&
          (!Number.isSafeInteger(patch.count) ||
            patch.count < 0 ||
            (entry.totalEpisodes != null && patch.count > entry.totalEpisodes))
        )
          throw Error("Episode progress exceeds the valid range.");
        const now = Date.now();
        if (patch.startRewatch) {
          if (entry.status !== "COMPLETED")
            throw Error("Complete the anime before a rewatch.");
          activeRun(entry).completed ??= now;
          entry.runs.push({ started: now, episodes: {}, count: 0 });
          entry.status = "REPEATING";
          entry.count = 0;
          entry.statusUpdated = entry.countUpdated = now;
          for (const saved of Object.values(state.progress)) {
            if (saved.mediaId === entry.mediaId) {
              saved.position = 0;
              saved.watched = false;
              saved.updated = now;
            }
          }
          if (current?.mediaId === entry.mediaId) current = undefined;
        }
        if (patch.status !== undefined) {
          if (!statuses.includes(patch.status as WatchStatus))
            throw Error("Invalid watch status.");
          entry.status = patch.status;
          entry.statusUpdated = now;
          if (patch.status === "COMPLETED") {
            const run = activeRun(entry);
            if (!run.completed) {
              run.completed = now;
              if (entry.runs.length > 1) {
                entry.repeat++;
                entry.repeatUpdated = now;
              }
            }
          }
        }
        if (patch.count !== undefined) {
          entry.count = patch.count;
          entry.countUpdated = now;
          activeRun(entry).count = patch.count;
        }
        if (patch.episode !== undefined) {
          const episode = positive(patch.episode, 100000);
          if (patch.watched !== undefined && typeof patch.watched !== "boolean")
            throw Error("Invalid watched mark.");
          for (const value of [patch.position, patch.duration])
            if (
              value !== undefined &&
              (!Number.isFinite(value) || value < 0 || value > 1000000)
            )
              throw Error("Invalid playback time.");
          markEpisode(entry, episode, {
            watched: patch.watched,
            position: patch.position,
            duration: patch.duration,
          });
          if (patch.watched !== undefined)
            activeRun(entry).episodes[String(episode)].manual = true;
          if (patch.watched === true && entry.status === "PLANNING") {
            entry.status = "CURRENT";
            entry.statusUpdated = now;
          }
          if (
            patch.watched === true &&
            entry.totalEpisodes &&
            entry.count >= entry.totalEpisodes
          ) {
            entry.status = "COMPLETED";
            entry.statusUpdated = now;
            const run = activeRun(entry);
            if (!run.completed) {
              run.completed = now;
              if (entry.runs.length > 1) {
                entry.repeat++;
                entry.repeatUpdated = now;
              }
            }
          }
        }
        entry.updated = now;
        state.watch[String(mediaId)] = entry;
        if (patch.episode !== undefined) {
          const saved = state.progress[`${mediaId}:${patch.episode}`];
          if (saved) {
            if (patch.position !== undefined) saved.position = patch.position;
            if (patch.watched !== undefined) saved.watched = patch.watched;
            saved.updated = now;
          }
        }
        save();
        queueSync();
        return state;
      });
      handle("watchExport", async () => {
        const path = (
          await dialog.showSaveDialog(window, {
            defaultPath: `nen-watch-data-${activeProfile().name.replace(/[^\w-]+/g, "-")}.json`,
            filters: [{ name: "JSON", extensions: ["json"] }],
          })
        ).filePath;
        if (!path) return null;
        writeFileSync(
          path,
          JSON.stringify(
            {
              version: 1,
              exportedAt: Date.now(),
              profile: { name: activeProfile().name },
              entries: Object.values(state.watch),
            },
            null,
            2,
          ),
        );
        return path;
      });
      handle("watchImportPreview", async () => {
        const path = (
          await dialog.showOpenDialog(window, {
            properties: ["openFile"],
            filters: [{ name: "JSON", extensions: ["json"] }],
          })
        ).filePaths[0];
        if (!path) return null;
        const data = readFileSync(path);
        if (data.length > 50 * 1024 * 1024)
          throw Error("Watch data file is too large.");
        const entries = validateTransfer(JSON.parse(data.toString("utf8")));
        importFile = path;
        return {
          count: Object.keys(entries).length,
          episodes: Object.values(entries)
            .flatMap((row) => row.runs)
            .reduce((n, run) => n + Object.keys(run.episodes).length, 0),
          newEntries: Object.keys(entries).filter((id) => !state.watch[id])
            .length,
          changedEntries: Object.keys(entries).filter((id) => !!state.watch[id])
            .length,
          path,
        };
      });
      handle("watchImport", (mode) => {
        if (!importFile || !["merge", "replace"].includes(mode))
          throw Error("Select a watch data file first.");
        const entries = validateTransfer(
          JSON.parse(readFileSync(importFile, "utf8")),
        );
        const backup = profileBackup(`.before-import-${Date.now()}.json`);
        copyFileSync(profileFile(userRoot, state.profiles!.active), backup);
        if (mode === "replace") state.watch = entries;
        else mergeWatch(state.watch, entries);
        importFile = undefined;
        save();
        queueSync();
        return state;
      });
      handle("malConnect", async () => {
        if (syncRunning || malAccounts.busy || malAccounts.reviewing)
          throw Error("Account sync is running.");
        if (!safeStorage.isEncryptionAvailable())
          throw Error("Protected storage is unavailable.");
        syncRunning = true;
        try {
          const tokens = await signInMal(malAppId, (url) =>
            shell.openExternal(url),
          );
          const request = malClient(
            malAppId,
            () => tokens,
            () => {},
          );
          const user = await request("/users/@me");
          writeFileSync(
            malTokenPath(),
            safeStorage.encryptString(JSON.stringify(tokens)),
          );
          state.mal = { connected: true, user: user.name, baseline: {} };
          malAccounts.reset();
          save();
        } finally {
          syncRunning = false;
        }
      });
      handle("malDisconnect", () => {
        if (syncRunning || malAccounts.busy)
          throw Error("Wait for account sync to finish.");
        rmSync(malTokenPath(), { force: true });
        state.mal = { connected: false, baseline: {} };
        malAccounts.reset();
        save();
        return state;
      });
      handle("malRefresh", () => malAccounts.refresh());
      handle("listImport", (source) =>
        malAccounts.importFrom(source, (percent) => {
          if (window && !window.isDestroyed())
            window.webContents.send("list-import-progress", percent);
        }),
      );
      handle("anilistRefresh", () => refreshAniList());
      handle("malPreview", () => malAccounts.preview());
      handle("malApply", (choices) => malAccounts.apply(choices));
      handle("listMergePreview", () => malAccounts.mergePreview());
      handle("listMergeApply", () => malAccounts.mergeApply());
      handle("listMergeCancel", () => malAccounts.cancelMerge());
      handle("anilistConnect", async () => {
        if (syncRunning || malAccounts.busy || malAccounts.reviewing)
          throw Error("Wait for account sync to finish.");
        return connectAniList();
      });
      handle("anilistPreview", async (): Promise<SyncPreview> => {
        if (syncRunning || malAccounts.busy || malAccounts.reviewing)
          throw Error("Account sync is running. Try again shortly.");
        syncRunning = true;
        try {
          await syncFavorites(
            getToken(),
            state.favorites,
            state.favoriteChanges,
          );
          const remote = await readRemote(getToken());
          state.anilist.user = remote.user;
          state.anilist.error = undefined;
          const result = previewAniList(
            state.watch,
            remote.entries,
            state.anilist,
          );
          syncPreview = { remote: remote.entries, changes: result.changes };
          save();
          return result;
        } catch (error) {
          state.anilist.error = String(error);
          save();
          throw error;
        } finally {
          syncRunning = false;
        }
      });
      handle("anilistApply", async (choices: SyncChange[]) => {
        if (!syncPreview || !Array.isArray(choices))
          throw Error("Review AniList changes first.");
        const expected = syncPreview.changes;
        if (
          choices.length !== expected.length ||
          choices.some(
            (row, i) =>
              row.mediaId !== expected[i].mediaId ||
              row.field !== expected[i].field ||
              !["local", "remote", undefined].includes(row.choice),
          )
        )
          throw Error("Sync review changed. Review again.");
        if (syncRunning || malAccounts.busy || malAccounts.reviewing)
          throw Error("Account sync is running. Try again shortly.");
        syncRunning = true;
        try {
          await applyAniList(
            getToken(),
            state.watch,
            syncPreview.remote,
            state.anilist,
            expected.map((row, i) => ({ ...row, choice: choices[i].choice })),
          );
          syncPreview = undefined;
          save();
          return state;
        } catch (error) {
          state.anilist.error = String(error);
          save();
          throw error;
        } finally {
          syncRunning = false;
        }
      });
      handle("profileCreate", async (name, fromFile) => {
        if (typeof fromFile !== "boolean")
          throw Error("Invalid profile request.");
        const list = state.profiles!.list;
        let data = {};
        let fileName: unknown;
        if (fromFile) {
          const path = (
            await dialog.showOpenDialog(window, {
              properties: ["openFile"],
              filters: [{ name: "JSON", extensions: ["json"] }],
            })
          ).filePaths[0];
          if (!path) return null;
          const raw = readFileSync(path);
          if (raw.length > 50 * 1024 * 1024)
            throw Error("Watch data file is too large.");
          const file = JSON.parse(raw.toString("utf8"));
          data = { watch: validateTransfer(file) };
          fileName = file.profile?.name;
        }
        const typed = typeof name === "string" ? name.trim() : "";
        const suggested =
          typeof fileName === "string" && fileName.trim()
            ? fileName
            : fromFile
              ? "Imported"
              : "";
        const finalName = profileName(
          typed || !suggested ? typed : uniqueProfileName(suggested, list),
          list,
        );
        const id = newProfileId(list);
        writeProfile(userRoot, id, data);
        list.push({ id, name: finalName, created: Date.now() });
        save();
        return state;
      });
      handle("profileSwitch", switchProfile);
      handle("profileRename", (id, name) => {
        const profile = findProfile(id);
        profile.name = profileName(name, state.profiles!.list, profile.id);
        save();
        return state;
      });
      handle("profileDelete", (id) => {
        const profile = findProfile(id);
        if (profile.id === state.profiles!.active)
          throw Error("Switch to another profile before deleting this one.");
        if (state.profiles!.list.length < 2)
          throw Error("Nen needs at least one profile.");
        state.profiles!.list = state.profiles!.list.filter(
          (p) => p.id !== profile.id,
        );
        save();
        rmSync(profileDir(userRoot, profile.id), {
          recursive: true,
          force: true,
        });
        return state;
      });
      handle("anilistDisconnect", () => {
        if (syncRunning || malAccounts.busy || malAccounts.reviewing)
          throw Error("Wait for account sync to finish.");
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
      handle("airing", (ids) => providers.airing(ids));
      handle("catalogOptions", () => providers.catalogOptions());
      handle("catalog", (mode, query, page, perPage = 24) => {
        if (!["trending", "season", "search", "romance"].includes(mode))
          throw Error("Invalid view.");
        return providers.catalog(
          mode,
          text(query),
          positive(page, 100),
          state.settings.showAdult,
          positive(perPage, 50),
        );
      });
      handle("episodes", (id, page) =>
        providers.episodes(positive(id), positive(page, 200)),
      );
      handle(
        "playbackState",
        () =>
          (automaticRunning ? pendingPlayback : undefined) ??
          player?.status ??
          pendingPlayback ?? {
            active: false,
            position: 0,
            duration: 0,
            paused: false,
            tracks: [],
            markers: [],
            speed: 0,
            peers: 0,
          },
      );
      handle("media", (id) => providers.media(positive(id)));
      handle("labels", async (id) => {
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
          undefined,
          playbackSettings(anime.id).audio,
        );
        known.clear();
        for (const r of result.items) known.set(r.hash, r);
        return result;
      });
      handle("autoPlay", (id, ep) => {
        id = positive(id);
        ep = positive(ep, 10000);
        if (together.state.connected) {
          if (!together.state.host)
            throw Error("Only the host can choose an episode.");
          if (automaticRunning || busy)
            throw Error("Wait for the current source.");
          return together.send({ type: "select", mediaId: id, episode: ep });
        }
        return autoPlay(id, ep);
      });
      handle("inspect", async (value) => {
        const releaseHash = hash(value);
        await cancelAutomatic();
        playbackRequest++;
        return inspect(releaseHash);
      });
      handle("play", (id, ep, index, malEp) => {
        return play(
          positive(id),
          positive(ep, 10000),
          positive(Number(index) + 1, 100000) - 1,
          positive(malEp, 10000),
        );
      });
      handle("resume", async (key) => {
        const p = state.progress[text(key, 40)];
        if (!p) throw Error("Saved playback was not found.");
        if (together.state.connected) {
          if (!together.state.host)
            throw Error("Only the host can choose an episode.");
          return together.send({
            type: "select",
            mediaId: p.mediaId,
            episode: p.episode,
          });
        }
        if (state.settings.sourceMode !== "manual")
          return autoPlay(p.mediaId, p.episode, p);
        known.set(hash(p.hash), p.release);
        const list = await inspect(p.hash);
        const file = list.find(
          (f) => f.path === p.file.path && f.size === p.file.size,
        );
        if (!file) throw Error("Saved file was not found.");
        return play(p.mediaId, p.episode, file.index, p.malEpisode, p);
      });
      handle("miniPlayer", (action) => {
        if (!["toggle", "pin", "state"].includes(action))
          throw Error("Invalid mini player action.");
        if (action !== "state" && controls !== window)
          throw Error("Start playback first.");
        if (action === "toggle") {
          if (miniWindow) restorePlayerWindow();
          else {
            miniWindow = {
              bounds: window.getNormalBounds(),
              minimum: window.getMinimumSize(),
              maximized: window.isMaximized(),
              fullscreen: window.isFullScreen(),
              pinned: window.isAlwaysOnTop(),
            };
            window.setFullScreen(false);
            window.unmaximize();
            window.setMinimumSize(480, 300);
            const area = screen.getDisplayMatching(window.getBounds()).workArea;
            window.setBounds({
              x: area.x + area.width - 656,
              y: area.y + area.height - 406,
              width: 640,
              height: 390,
            });
          }
        }
        if (action === "pin" && miniWindow)
          window.setAlwaysOnTop(!window.isAlwaysOnTop());
        return {
          active: !!miniWindow,
          pinned: !!miniWindow && window.isAlwaysOnTop(),
        };
      });
      handle("control", async (action, value) => {
        if (action === "stop") {
          return stop();
        }
        if (action === "fullscreen") {
          restorePlayerWindow();
          const fullscreen = !window.isFullScreen();
          window.setFullScreen(fullscreen);
          window.webContents.send("window-fullscreen", fullscreen);
          return;
        }
        if (action === "sources") {
          await cancelAutomatic();
          if (
            player?.status.ready &&
            !player.status.paused &&
            !together.state.connected
          )
            await player.command(["set_property", "pause", true]);
          return;
        }
        if (!player) throw Error("Start playback first.");
        if (action === "volume") {
          if (!Number.isFinite(value) || value < 0 || value > 100)
            throw Error("Invalid volume.");
          await player.command(["set_property", "volume", value]);
          state.volume = value;
          save();
          return;
        }
        if (
          together.state.connected &&
          ["pause", "seek", "seekRelative", "speed"].includes(action)
        ) {
          if (action === "speed") {
            if (!together.state.host)
              throw Error("Only the host can change playback speed.");
            if (!Number.isFinite(value) || value < 0.25 || value > 4)
              throw Error("Invalid playback speed.");
            return together.send({ type: "speed", value });
          }
          if (action === "pause")
            return together.send({
              type: "pause",
              value: !together.state.paused,
            });
          if (!Number.isFinite(value)) throw Error("Invalid playback time.");
          return together.send({
            type: "seek",
            position: Math.max(
              0,
              Math.min(
                player.status.duration,
                action === "seekRelative"
                  ? player.status.position + value
                  : value,
              ),
            ),
          });
        }
        if (action === "pause") return player.command(["cycle", "pause"]);
        if (!Number.isFinite(value)) throw Error("Invalid player value.");
        if (
          ["subtitleDelay", "subtitleSize", "subtitlePosition"].includes(action)
        ) {
          const limits = {
            subtitleDelay: [-30, 30, "sub-delay"],
            subtitleSize: [50, 250, "sub-scale"],
            subtitlePosition: [0, 100, "sub-pos"],
          } as const;
          const key = action as keyof typeof limits;
          const [min, max, property] = limits[key];
          if (!Number.isFinite(value) || value < min || value > max)
            throw Error("Invalid subtitle value.");
          await player.command([
            "set_property",
            property,
            key === "subtitleSize"
              ? value / 100
              : key === "subtitlePosition"
                ? 100 - value
                : value,
          ]);
          state.settings[key] = value;
          save();
          return;
        }
        if (action === "speed") {
          if (value < 0.25 || value > 4) throw Error("Invalid playback speed.");
          await player.command(["set_property", "speed", value]);
          sessionPlaybackRate = value;
          return;
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
          const active = player;
          const mediaId = active.status.mediaId;
          const track = active.status.tracks.find(
            (t) =>
              t.type === (action === "audio" ? "audio" : "sub") &&
              t.id === value,
          );
          await active.command([
            "set_property",
            action === "audio" ? "aid" : "sid",
            value === 0 ? "no" : value,
          ]);
          const language = track && audioTrackLanguage(track);
          if (action === "sub")
            Player.subtitleSelection = track
              ? { lang: track.lang, title: track.title }
              : null;
          if (action === "audio" && mediaId && language) {
            (state.seriesAudio ??= {})[String(mediaId)] = language;
            save();
          }
          return;
        }
        throw Error("Invalid player action.");
      });
      handle("uninstall", async () => {
        const uninstaller = join(
          dirname(app.getPath("exe")),
          "Uninstall Nen.exe",
        );
        if (!app.isPackaged || !existsSync(uninstaller))
          throw Error("Uninstall is available after installing Nen.");
        await new Promise<void>((resolve, reject) => {
          const child = spawn(uninstaller, [], {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
          });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        });
        setTimeout(() => app.quit(), 200);
      });
      handle("localState", () => localFiles.state());
      handle("localEnable", (value) => localFiles.enable(value));
      handle("localAdd", async () => {
        const result = await dialog.showOpenDialog(window, {
          title: "Add local source",
          properties: ["openDirectory"],
        });
        if (!result.canceled && result.filePaths[0])
          await localFiles.add(result.filePaths[0]);
      });
      handle("localRemove", (id) => localFiles.remove(text(id)));
      handle("localList", (id, path) =>
        localFiles.list(text(id), typeof path === "string" ? path : ""),
      );
      handle("localPlay", (id, path) => playLocal(text(id), path));
      handle("localNext", async () => {
        if (localCurrent?.next)
          await playLocal(localCurrent.id, localCurrent.next);
      });
      handle("localSubtitle", async () => {
        const active = player;
        if (!localCurrent || !active) throw Error("Start a local video first.");
        const result = await dialog.showOpenDialog(window, {
          title: "Load subtitle file",
          properties: ["openFile"],
          filters: [{ name: "Subtitles", extensions: subtitleExtensions }],
        });
        if (
          !result.canceled &&
          result.filePaths[0] &&
          player === active &&
          localCurrent
        ) {
          if (!/\.(srt|vtt|ass|ssa)$/i.test(result.filePaths[0]))
            throw Error("Select a subtitle file.");
          await active.command(["sub-add", result.filePaths[0], "select"]);
        }
      });
      handle("copyMagnet", () => {
        if (!current || !selected || !worker)
          throw Error("No torrent source is playing.");
        clipboard.writeText(
          "magnet:?xt=urn:btih:" +
            hash(current.hash) +
            "&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce",
        );
      });
      handle("openTrailer", async (id) => {
        const trailer = (await providers.media(positive(id))).trailer;
        if (!trailer) throw Error("No trailer available.");
        const url =
          trailer.site === "youtube"
            ? "https://www.youtube.com/watch?v="
            : "https://www.dailymotion.com/video/";
        await shell.openExternal(url + encodeURIComponent(trailer.id));
      });
      handle("saveScreenshot", async () => {
        const active = player;
        if (!active?.status.ready) throw Error("Wait for the video to load.");
        const path = await downloadDestination(
          "Nen-screenshot-" + Date.now() + ".png",
        );
        if (!path) return null;
        if (player !== active) throw Error("The video changed. Try again.");
        await active.command(["screenshot-to-file", path, "subtitles"]);
        lastScreenshot = path;
        return path;
      });
      handle("revealScreenshot", () => {
        if (!lastScreenshot || !existsSync(lastScreenshot))
          throw Error("The screenshot is no longer available.");
        shell.showItemInFolder(lastScreenshot);
      });
      handle("downloadVideo", async () => {
        const active = worker,
          episode = current;
        if (!active || !episode) throw Error("No episode file to download.");
        if (downloadWorkers.has(active))
          throw Error("A download is already running for this source.");
        downloadWorkers.add(active);
        try {
          const destination = await downloadDestination(
            episode.file.path.split(/[\\/]/).at(-1) || "Nen-episode.mkv",
          );
          if (!destination) return false;
          if (worker !== active || current !== episode)
            throw Error("The source changed. Start the download again.");
          const saved = await workerRequest(
            "saved",
            {
              action: "save",
              index: episode.file.index,
              destination,
            },
            0,
          );
          if (saved.error) throw Error(saved.error);
          return true;
        } finally {
          downloadWorkers.delete(active);
          if (worker !== active) {
            try {
              active.postMessage({ action: "stop" });
            } catch {
              /* The completed worker can already have exited. */
            }
          }
        }
      });
      handle("state", () => state);
      handle("startupUpdate", startupUpdate);
      handle("checkUpdates", checkUpdates);
      handle("installUpdate", installUpdate);
      handle("updateStatus", () => updateStatus);
      handle("changelog", async (page, refresh) => ({
        ...(await listChangelog(page, refresh === true)),
        buildCommit: NEN_BUILD_COMMIT,
      }));
      handle("openChangelogCommit", (commit) => {
        if (
          commit !== undefined &&
          (typeof commit !== "string" || !/^[a-f0-9]{40}$/.test(commit))
        )
          throw Error("Invalid commit.");
        return shell.openExternal(
          `https://github.com/may-be-gay/Nen/${commit ? `commit/${commit}` : "commits/main/"}`,
        );
      });
      handle("settings", (value) => {
        state.settings = { ...state.settings, ...settings(value) };
        discordPresence.update(
          state.settings.discordPresence === true,
          player?.status,
          together.state,
        );
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
        if (together.state.connected)
          return together.send({ type: "seek", position: m.end });
        await player.command(["seek", m.end, "absolute"]);
      });
      handle("undo", async () => {
        if (player && undoPosition !== undefined) {
          if (together.state.connected)
            return together.send({ type: "seek", position: undoPosition });
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
          mal: `https://myanimelist.net/anime/${positive(id ?? 1)}`,
          filler: "https://anifillerpedia.wiki/",
          license: "https://creativecommons.org/licenses/by-nc-sa/4.0/",
          aniskip: "https://aniskip.com/",
          discord: "https://discord.gg/rYgwUYSNRg",
          issues: "https://github.com/may-be-gay/Nen/issues",
          email: "mailto:nen@crygup.com",
          donate: "https://ko-fi.com/crygup",
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
    together.disconnect();
    closing = true;
    discordPresence.close();
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

  if (process.platform === "win32") {
    const request = playbackRequest;
    const host = await VideoHost.create(window.getContentBounds());
    if (closing || request !== playbackRequest) {
      host.destroy();
      throw Error("Playback cancelled.");
    }
    videoView = host;
  } else {
    videoView = new BaseWindow({
      ...window.getContentBounds(),
      frame: false,
      show: false,
      skipTaskbar: true,
      focusable: false,
      transparent: true,
      backgroundColor: "#00000000",
    });
    videoView.contentView.setVisible(false);
  }
  videoView.showInactive();
  window.moveTop();
  fullscreenBeforePlayer = window.isFullScreen();
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

async function downloadDestination(name: string): Promise<string | undefined> {
  const filename =
    name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_").replace(/[. ]+$/, "") ||
    "Nen-download";
  try {
    const folder = app.getPath("downloads");
    if (statSync(folder).isDirectory()) {
      const ext = filename.lastIndexOf(".");
      const base = ext > 0 ? filename.slice(0, ext) : filename;
      const suffix = ext > 0 ? filename.slice(ext) : "";
      let path = join(folder, filename),
        i = 1;
      while (existsSync(path))
        path = join(folder, base + " (" + i++ + ")" + suffix);
      return path;
    }
  } catch {}
  return (await dialog.showSaveDialog(window, { defaultPath: filename }))
    .filePath;
}
