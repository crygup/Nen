import { contextBridge, ipcRenderer } from "electron";
import type { API } from "../src/shared";
ipcRenderer.on("window-fullscreen", (_event, value: boolean) => {
  document.documentElement.classList.toggle("window-fullscreen", value === true);
});
function subscribe<T>(channel: string, callback: (value: T) => void) {
  const listener = (_: unknown, value: T) => callback(value);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}
const api: API = {
  togetherCopyCode: () => ipcRenderer.invoke("togetherCopyCode"),
  togetherState: () => ipcRenderer.invoke("togetherState"),
  togetherConnect: code => ipcRenderer.invoke("togetherConnect", code),
  togetherSend: message => ipcRenderer.invoke("togetherSend", message),
  togetherLeave: () => ipcRenderer.invoke("togetherLeave"),
  togetherReload: () => ipcRenderer.invoke("togetherReload"),
  onTogether: callback => subscribe("together", callback),
  favoriteSet: (...a) => ipcRenderer.invoke("favoriteSet", ...a),
  uninstall: () => ipcRenderer.invoke("uninstall"),
  watchAdd: (...a) => ipcRenderer.invoke("watchAdd", ...a),
  watchDelete: (...a) => ipcRenderer.invoke("watchDelete", ...a),
  watchEdit: (...a) => ipcRenderer.invoke("watchEdit", ...a),
  watchExport: () => ipcRenderer.invoke("watchExport"),
  watchImportPreview: () => ipcRenderer.invoke("watchImportPreview"),
  watchImport: (...a) => ipcRenderer.invoke("watchImport", ...a),
  anilistConnect: () => ipcRenderer.invoke("anilistConnect"),
  anilistPreview: () => ipcRenderer.invoke("anilistPreview"),
  anilistApply: (...a) => ipcRenderer.invoke("anilistApply", ...a),
  anilistDisconnect: () => ipcRenderer.invoke("anilistDisconnect"),
  profileCreate: (...a) => ipcRenderer.invoke("profileCreate", ...a),
  profileSwitch: (...a) => ipcRenderer.invoke("profileSwitch", ...a),
  profileRename: (...a) => ipcRenderer.invoke("profileRename", ...a),
  profileDelete: (...a) => ipcRenderer.invoke("profileDelete", ...a),
  onWatchState: callback => subscribe("watch-state", callback),
  startupUpdate: () => ipcRenderer.invoke("startupUpdate"),
  checkUpdates: () => ipcRenderer.invoke("checkUpdates"),
  installUpdate: () => ipcRenderer.invoke("installUpdate"),
  updateStatus: () => ipcRenderer.invoke("updateStatus"),
  changelog: (page, refresh) => ipcRenderer.invoke("changelog", page, refresh),
  openChangelogCommit: sha => ipcRenderer.invoke("openChangelogCommit", sha),
  onUpdateStatus: callback => subscribe("update-status", callback),
  autoPlay: (...a) => ipcRenderer.invoke("autoPlay", ...a),
  startVideo: () => ipcRenderer.invoke("startVideo"),
  onVideo: (callback, error) => {
    const frame = (_: unknown, data: Uint8Array, key: boolean) => {
      try {
        callback(data, key);
      } finally {
        ipcRenderer.send("video-frame-ack");
      }
    };
    const fail = (_: unknown, message: string) => error(message);
    ipcRenderer.on("video-frame", frame);
    ipcRenderer.on("video-error", fail);
    return () => {
      ipcRenderer.removeListener("video-frame", frame);
      ipcRenderer.removeListener("video-error", fail);
    };
  },
  catalogOptions: () => ipcRenderer.invoke("catalogOptions"),
  catalog: (...a) => ipcRenderer.invoke("catalog", ...a),
  episodes: (...a) => ipcRenderer.invoke("episodes", ...a),
  playback: () => ipcRenderer.invoke("playbackState"),
  media: (...a) => ipcRenderer.invoke("media", ...a),
  labels: (...a) => ipcRenderer.invoke("labels", ...a),
  releases: (...a) => ipcRenderer.invoke("releases", ...a),
  inspect: (...a) => ipcRenderer.invoke("inspect", ...a),
  play: (...a) => ipcRenderer.invoke("play", ...a),
  resume: (...a) => ipcRenderer.invoke("resume", ...a),
  control: (...a) => ipcRenderer.invoke("control", ...a),
  state: () => ipcRenderer.invoke("state"),
  settings: (...a) => ipcRenderer.invoke("settings", ...a),
  mapping: (...a) => ipcRenderer.invoke("mapping", ...a),
  marker: (...a) => ipcRenderer.invoke("marker", ...a),
  skip: (...a) => ipcRenderer.invoke("skip", ...a),
  undo: () => ipcRenderer.invoke("undo"),
  clear: (...a) => ipcRenderer.invoke("clear", ...a),
  external: (...a) => ipcRenderer.invoke("external", ...a),
  onBack: callback => subscribe("navigate-back", (direction: "back" | "forward" = "back") => callback(direction)),
  onPlayback: callback => subscribe("playback", callback),
};
contextBridge.exposeInMainWorld("nen", api);
