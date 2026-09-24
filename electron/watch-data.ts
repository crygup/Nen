import type { Media, Progress, WatchEntry, WatchEpisode, WatchStatus } from "../src/shared";
import { seasonNumber } from "./rules";

export const statuses: WatchStatus[] = ["CURRENT", "REPEATING", "COMPLETED", "PAUSED", "DROPPED", "PLANNING"];

export function newEntry(media: Pick<Media, "id" | "title" | "coverImage" | "episodes"> & { isAdult?: boolean }): WatchEntry {
  const now = Date.now();
  const title = media.title.english || media.title.romaji;
  return {
    mediaId: media.id, isAdult: media.isAdult, title, cover: media.coverImage.large,
    season: title, seasonNumber: seasonNumber(title), totalEpisodes: media.episodes,
    status: "PLANNING", count: 0, repeat: 0,
    runs: [{ started: now, count: 0, episodes: {} }],
    updated: now, statusUpdated: now, countUpdated: now, repeatUpdated: now,
  };
}

export function activeRun(entry: WatchEntry) {
  if (!entry.runs.length) entry.runs.push({ started: Date.now(), count: entry.count, episodes: {} });
  return entry.runs[entry.runs.length - 1];
}

export function contiguousCount(episodes: Record<string, WatchEpisode>): number {
  let count = 0;
  while (episodes[String(count + 1)]?.watched) count++;
  return count;
}

export function markEpisode(entry: WatchEntry, episode: number, patch: Partial<WatchEpisode>) {
  const now = Date.now();
  const run = activeRun(entry);
  const prior = run.episodes[String(episode)];
  run.episodes[String(episode)] = {
    watched: patch.watched ?? prior?.watched ?? false,
    manual: prior?.manual,
    position: patch.position ?? prior?.position ?? 0,
    duration: patch.duration ?? prior?.duration ?? 0,
    updated: now,
  };
  let count = patch.watched === false && episode <= entry.count ? episode - 1 : entry.count;
  while (run.episodes[String(count + 1)]?.watched) count++;
  if (count !== entry.count) {
    entry.count = count;
    entry.countUpdated = now;
  }
  run.count = entry.count;
  entry.updated = now;
}

export function migrateProgress(watch: Record<string, WatchEntry>, progress: Record<string, Progress>): boolean {
  let changed = false;
  for (const saved of Object.values(progress)) {
    if (!Number.isSafeInteger(saved.mediaId) || saved.mediaId < 1 || !Number.isSafeInteger(saved.episode) || saved.episode < 1) continue;
    const key = String(saved.mediaId);
    let entry = watch[key];
    if (!entry) {
      entry = newEntry({ id: saved.mediaId, title: { english: saved.title, romaji: saved.title, native: null }, coverImage: { large: saved.cover }, episodes: saved.totalEpisodes, isAdult: saved.isAdult });
      entry.season = saved.season || saved.title;
      entry.status = "CURRENT";
      watch[key] = entry;
      changed = true;
    }
    const run = activeRun(entry);
    if (entry.runs.length > 1 && saved.updated < run.started) continue;
    if (!run.episodes[String(saved.episode)]) {
      run.episodes[String(saved.episode)] = {
        watched: saved.watched === true || (saved.duration > 0 && saved.position / saved.duration > 0.85),
        position: saved.position, duration: saved.duration, updated: saved.updated,
      };
      changed = true;
    }
    entry.updated = Math.max(entry.updated, saved.updated);
  }
  for (const entry of Object.values(watch)) {
    const count = contiguousCount(activeRun(entry).episodes);
    if (count > entry.count) { entry.count = count; entry.countUpdated = Date.now(); changed = true; }
    activeRun(entry).count = entry.count;
  }
  return changed;
}

export function validateTransfer(value: unknown): Record<string, WatchEntry> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Error("Invalid watch data file.");
  const file = value as Record<string, unknown>;
  if (file.version !== 1 || !Array.isArray(file.entries)) throw Error("Unsupported watch data version.");
  if (file.entries.length > 100000) throw Error("Watch data file is too large.");
  const entries: Record<string, WatchEntry> = {};
  for (const raw of file.entries) {
    if (!raw || typeof raw !== "object") throw Error("Invalid anime entry.");
    const row = raw as WatchEntry;
    if (!Number.isSafeInteger(row.mediaId) || row.mediaId < 1 || row.mediaId > 10000000 ||
      (row.isAdult !== undefined && typeof row.isAdult !== "boolean") ||
      typeof row.title !== "string" || row.title.length > 500 ||
      typeof row.cover !== "string" || row.cover.length > 2000 ||
      typeof row.season !== "string" || row.season.length > 500 ||
      !statuses.includes(row.status) ||
      !Number.isSafeInteger(row.count) || row.count < 0 ||
      !Number.isSafeInteger(row.repeat) || row.repeat < 0 || row.repeat > 100000 ||
      (row.seasonNumber !== undefined && row.seasonNumber !== null && (!Number.isSafeInteger(row.seasonNumber) || row.seasonNumber < 0 || row.seasonNumber > 1000)) ||
      (row.totalEpisodes !== null && (!Number.isSafeInteger(row.totalEpisodes) || row.totalEpisodes < 0 || row.totalEpisodes > 100000)) ||
      !Array.isArray(row.runs) || row.runs.length > 1000 ||
      !Number.isFinite(row.updated) || row.updated < 0 || !Number.isFinite(row.statusUpdated) || row.statusUpdated < 0 ||
      !Number.isFinite(row.countUpdated) || row.countUpdated < 0 || !Number.isFinite(row.repeatUpdated) || row.repeatUpdated < 0)
      throw Error("Invalid anime entry.");
    const runs: WatchEntry["runs"] = [];
    for (const run of row.runs) {
      if (!run || !Number.isFinite(run.started) || run.started < 0 ||
        (run.completed !== undefined && (!Number.isFinite(run.completed) || run.completed < 0)) ||
        !Number.isSafeInteger(run.count) || run.count < 0 ||
        !run.episodes || typeof run.episodes !== "object" || Array.isArray(run.episodes) || Object.keys(run.episodes).length > 100000)
        throw Error("Invalid watch record.");
      const episodes: typeof run.episodes = {};
      for (const [key, ep] of Object.entries(run.episodes)) {
        if (!/^[1-9]\d{0,5}$/.test(key) || !ep || typeof ep.watched !== "boolean" || (ep.manual !== undefined && typeof ep.manual !== "boolean") ||
          !Number.isFinite(ep.position) || ep.position < 0 || ep.position > 1000000 ||
          !Number.isFinite(ep.duration) || ep.duration < 0 || ep.duration > 1000000 ||
          !Number.isFinite(ep.updated) || ep.updated < 0) throw Error("Invalid episode record.");
        episodes[key] = { watched: ep.watched, manual: ep.manual, position: ep.position, duration: ep.duration, updated: ep.updated };
      }
      runs.push({ started: run.started, completed: run.completed, count: run.count, episodes });
    }
    if (entries[String(row.mediaId)]) throw Error("Duplicate anime entry.");
    entries[String(row.mediaId)] = {
      mediaId: row.mediaId, isAdult: row.isAdult, title: row.title, cover: row.cover,
      season: row.season, seasonNumber: row.seasonNumber, totalEpisodes: row.totalEpisodes,
      status: row.status, count: row.count, repeat: row.repeat, runs,
      updated: row.updated, statusUpdated: row.statusUpdated,
      countUpdated: row.countUpdated, repeatUpdated: row.repeatUpdated,
    };
  }
  return entries;
}

export function mergeWatch(target: Record<string, WatchEntry>, incoming: Record<string, WatchEntry>) {
  for (const [id, row] of Object.entries(incoming)) {
    const current = target[id];
    if (!current) { target[id] = structuredClone(row); continue; }
    if (row.statusUpdated > current.statusUpdated) { current.status = row.status; current.statusUpdated = row.statusUpdated; }
    if (row.countUpdated > current.countUpdated) { current.count = row.count; current.countUpdated = row.countUpdated; }
    if (row.repeatUpdated > current.repeatUpdated) { current.repeat = row.repeat; current.repeatUpdated = row.repeatUpdated; }
    for (const run of row.runs) {
      let existing = current.runs.find(r => r.started === run.started);
      if (!existing) { current.runs.push(structuredClone(run)); continue; }
      for (const [ep, value] of Object.entries(run.episodes))
        if (!existing.episodes[ep] || existing.episodes[ep].updated < value.updated)
          existing.episodes[ep] = structuredClone(value);
      existing.count = Math.max(existing.count, run.count);
      existing.completed = Math.max(existing.completed ?? 0, run.completed ?? 0) || undefined;
    }
    current.runs.sort((a, b) => a.started - b.started);
    current.updated = Math.max(current.updated, row.updated);
  }
}
