export type Theme = "system" | "light" | "dark";
export type SegmentType = "op" | "ed" | "mixed-op" | "mixed-ed" | "recap";
export interface Media {
  isAdult?: boolean;
  id: number;
  idMal: number | null;
  title: { english: string | null; romaji: string; native: string | null };
  synonyms: string[];
  description: string;
  coverImage: { large: string };
  bannerImage: string | null;
  format: string;
  source: string;
  status: string;
  episodes: number | null;
  seasonYear: number | null;
  averageScore: number | null;
  genres: string[];
  tags?: { name: string; rank: number }[];
  nextAiringEpisode: { episode: number; airingAt?: number } | null;
  airingSchedule?: { nodes: { episode: number; airingAt: number }[] };
  streamingEpisodes?: { title: string }[];
  relations?: {
    edges: {
      relationType: string;
      node: {
        id: number;
        title: { romaji: string };
        episodes?: number | null;
        format: string;
        type: string;
      };
    }[];
  };
}
export interface Catalog {
  lastPage?: number;
  media: Media[];
  hasNextPage: boolean;
}
export interface Label {
  episode: number;
  status: "canon" | "filler" | "mixed";
  citation: string;
  url: string | null;
}
export interface Labels {
  items: Label[];
  notice: string;
  providerId?: number;
  needsMapping: boolean;
}
export interface Release {
  sourceOffset?: number;
  hash: string;
  title: string;
  source: "Nyaa" | "Bangumi Moe";
  size: string;
  seeds: number;
  resolution: string;
  group: string;
  language: string;
  season?: number | null;
  episode: number | null;
  endEpisode: number | null;
  batch: boolean;
  confidence: "Episode match" | "Check match";
}
export interface TorrentFile {
  index: number;
  path: string;
  size: number;
}
export interface Marker {
  type: SegmentType;
  start: number;
  end: number;
  confirmed: boolean;
}
export interface EpisodeInfo {
  number: number;
  title: string;
  airingAt: number | null;
  released: boolean | null;
}
export interface EpisodePage {
  items: EpisodeInfo[];
  total: number;
  latest: number;
  notice?: string;
}
export interface Settings {
  discordPresence?: boolean;
  showAdult?: boolean;
  hideZeroSeeds?: boolean;
  sourceMode?: "auto" | "manual";
  qualities?: number[];
  theme: Theme;
  autoSkip: boolean;
  autoNext?: boolean;
  autoUpdates?: boolean;
  audio: string;
  subtitles: string;
  source: "all" | "Nyaa" | "Bangumi Moe";
}
export interface Progress {
  watched?: boolean;
  isAdult?: boolean;
  episodeTitle?: string;
  season?: string;
  malId: number | null;
  totalEpisodes: number | null;
  mediaId: number;
  title: string;
  cover: string;
  episode: number;
  hash: string;
  release: Release;
  file: TorrentFile;
  position: number;
  duration: number;
  updated: number;
  malEpisode: number;
}
export type WatchStatus = "CURRENT" | "REPEATING" | "COMPLETED" | "PAUSED" | "DROPPED" | "PLANNING";
export interface WatchEpisode {
  watched: boolean;
  manual?: boolean;
  position: number;
  duration: number;
  updated: number;
}
export interface WatchRun {
  started: number;
  completed?: number;
  episodes: Record<string, WatchEpisode>;
  count: number;
}
export interface WatchEntry {
  mediaId: number;
  isAdult?: boolean;
  title: string;
  cover: string;
  season: string;
  seasonNumber?: number | null;
  totalEpisodes: number | null;
  status: WatchStatus;
  count: number;
  repeat: number;
  runs: WatchRun[];
  updated: number;
  statusUpdated: number;
  countUpdated: number;
  repeatUpdated: number;
}
export interface SyncBase { status: WatchStatus; count: number; repeat: number }
export interface AniListState {
  connected: boolean;
  user?: string;
  lastSync?: number;
  error?: string;
  baseline: Record<string, SyncBase>;
}
export interface SyncChange {
  mediaId: number;
  title: string;
  field: "status" | "count" | "repeat";
  local: WatchStatus | number | null;
  remote: WatchStatus | number | null;
  conflict: boolean;
  choice?: "local" | "remote";
}
export interface SyncPreview { changes: SyncChange[]; first: boolean }
export interface ImportPreview { count: number; episodes: number; newEntries: number; changedEntries: number; path: string }
export interface State {
  version?: string;
  window?: { width: number; height: number; maximized: boolean };
  settings: Settings;
  progress: Record<string, Progress>;
  watch: Record<string, WatchEntry>;
  favorites: Record<string, WatchEntry>;
  favoriteChanges: Record<string, boolean>;
  anilist: AniListState;
  markers: Record<string, Marker[]>;
  mappings: Record<string, number>;
}
export interface Playback {
  cover?: string;
  episodeTitle?: string;
  volume?: number;
  playbackRate?: number;
  release?: Release;
  mediaId?: number;
  episode?: number;
  seeking?: boolean;
  buffering?: boolean;
  nextEpisode?: number;
  nextMediaId?: number;
  title?: string;
  chapters?: { time: number; title?: string }[];
  ended?: boolean;
  ready?: boolean;
  loadingNotice?: string;
  active: boolean;
  position: number;
  duration: number;
  paused: boolean;
  tracks: {
    id: number;
    type: string;
    title?: string;
    lang?: string;
    selected: boolean;
  }[];
  error?: string;
  speed: number;
  peers: number;
  progress: number;
  markers: Marker[];
  skipNotice?: string;
}
export interface UpdateStatus { busy: boolean; message: string; percent?: number; available?: boolean; installing?: boolean }
export interface TogetherState {
  connected: boolean;
  code?: string;
  self?: string;
  host?: boolean;
  members: { id: string; name: string; ready: boolean; error?: string }[];
  messages: { id: string; name: string; text: string; system?: boolean }[];
  chatEnabled?: boolean;
  selection?: { mediaId: number; episode: number; hash: string | null } | null;
  revision?: number;
  allowPause?: boolean;
  playbackRate?: number;
  paused?: boolean;
  waiting?: boolean;
  position?: number;
  at?: number;
  error?: string;
}
export interface API {
  togetherState(): Promise<TogetherState>;
  togetherCopyCode(): Promise<void>;
  togetherConnect(code?: string): Promise<void>;
  togetherSend(message: object): Promise<void>;
  togetherLeave(): Promise<void>;
  togetherReload(): Promise<void>;
  onTogether(callback: (state: TogetherState) => void): () => void;
  uninstall(): Promise<void>;
  favoriteSet(id: number, favorite: boolean): Promise<State>;
  watchAdd(id: number): Promise<State>;
  watchDelete(id: number, sync?: boolean): Promise<State>;
  watchEdit(id: number, patch: { status?: WatchStatus; count?: number; episode?: number; watched?: boolean; position?: number; duration?: number; startRewatch?: boolean }): Promise<State>;
  watchExport(): Promise<string | null>;
  watchImportPreview(): Promise<ImportPreview | null>;
  watchImport(mode: "merge" | "replace"): Promise<State>;
  anilistConnect(): Promise<void>;
  anilistPreview(): Promise<SyncPreview>;
  anilistApply(choices: SyncChange[]): Promise<State>;
  anilistDisconnect(): Promise<State>;
  onWatchState(callback: (state: State) => void): () => void;
  startupUpdate(): Promise<UpdateStatus>;
  installUpdate(): Promise<UpdateStatus>;
  checkUpdates(): Promise<UpdateStatus>;
  updateStatus(): Promise<UpdateStatus>;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  autoPlay(mediaId: number, episode: number): Promise<void>;
  startVideo(): Promise<void>;
  onVideo(
    callback: (data: Uint8Array, key: boolean) => void,
    error: (message: string) => void,
  ): () => void;
  catalogOptions(): Promise<{ genres: string[]; tags: string[] }>;
  catalog(
    mode: "trending" | "season" | "search" | "romance",
    search: string,
    page: number,
    perPage?: number,
  ): Promise<Catalog>;
  media(id: number): Promise<Media>;
  episodes(id: number, page: number): Promise<EpisodePage>;
  removeHistory(key: string): Promise<void>;
  playback(): Promise<Playback>;
  labels(id: number, mal: number | null): Promise<Labels>;
  releases(
    id: number,
    episode: number,
    query?: string,
  ): Promise<{ items: Release[]; errors: string[] }>;
  inspect(hash: string): Promise<TorrentFile[]>;
  play(
    mediaId: number,
    episode: number,
    file: number,
    malEpisode: number,
  ): Promise<void>;
  resume(key: string): Promise<void>;
  control(
    action:
      | "pause"
      | "seek"
      | "seekRelative"
      | "speed"
      | "audio"
      | "sub"
      | "stop"
      | "volume"
      | "fullscreen",
    value?: number,
  ): Promise<void>;
  state(): Promise<State>;
  settings(settings: Settings): Promise<void>;
  mapping(id: number, offset: number): Promise<void>;
  marker(marker: Marker): Promise<void>;
  skip(type: SegmentType): Promise<void>;
  undo(): Promise<void>;
  clear(kind: "history" | "cache"): Promise<void>;
  external(
    target: "anilist" | "filler" | "license" | "aniskip" | "discord" | "issues" | "email" | "donate",
    id?: number,
  ): Promise<void>;
  onBack(callback: (direction: "back" | "forward") => void): () => void;
  onPlayback(callback: (p: Playback) => void): () => void;
}
declare global {
  interface Window {
    nen: API;
  }
}

export function canAutoSkip(
  marker: Marker,
  position: number,
  enabled: boolean,
): boolean {
  return (
    enabled &&
    position >= marker.start &&
    position < marker.end
  );
}
export function labelForEpisode(
  labels: Labels | undefined,
  episode: number,
  offset: number | undefined,
  original: boolean,
): { status: string; row?: Label } {
  if (original) return { status: "Not applicable" };
  if (!labels || (labels.needsMapping && offset === undefined))
    return { status: "Unknown" };
  const row = labels.items.find(
    (label) => label.episode === episode + (offset ?? 0),
  );
  return { status: row?.status ?? "Unknown", row };
}

export function episodeAvailability(
  media: Media,
  episode: number,
  now = Date.now() / 1000,
): { released: boolean | null; airingAt: number | null } {
  if (media.episodes != null && episode > media.episodes)
    return { released: false, airingAt: null };
  const scheduled = media.airingSchedule?.nodes.find(
    (e) => e.episode === episode,
  );
  if (scheduled)
    return {
      released: scheduled.airingAt <= now,
      airingAt: scheduled.airingAt,
    };
  if (media.nextAiringEpisode) {
    const next = media.nextAiringEpisode;
    return {
      released:
        episode < next.episode
          ? true
          : episode === next.episode && next.airingAt
            ? next.airingAt <= now
            : false,
      airingAt: episode === next.episode ? (next.airingAt ?? null) : null,
    };
  }
  return {
    released:
      media.status === "FINISHED"
        ? true
        : media.status === "NOT_YET_RELEASED"
          ? false
          : null,
    airingAt: null,
  };
}
export function latestEpisode(media: Media, now = Date.now() / 1000): number {
  const scheduled = Math.max(
    0,
    ...(media.airingSchedule?.nodes ?? [])
      .filter((e) => e.airingAt <= now)
      .map((e) => e.episode),
  );
  if (media.status === "FINISHED") return media.episodes ?? scheduled;
  const next = media.nextAiringEpisode;
  return Math.max(
    scheduled,
    next ? next.episode - (next.airingAt && next.airingAt <= now ? 0 : 1) : 0,
  );
}
export const audioLanguages = [["jpn", "Japanese"], ["eng", "English"], ["spa", "Spanish"], ["fra", "French"], ["deu", "German"], ["ita", "Italian"], ["por", "Portuguese"], ["zho", "Chinese"], ["kor", "Korean"], ["rus", "Russian"], ["ara", "Arabic"], ["hin", "Hindi"]] as const;
export function releaseAudio(release: Pick<Release, "title">): { languages: string[]; inferred: boolean } {
  const title = release.title.replace(/[._-]/g, " ");
  const languages = audioLanguages.filter(([code, name]) => new RegExp("\\b(?:" + code + "|" + name + ")\\s*(?:dub(?:bed)?|audio)\\b|\\b(?:dub(?:bed)?|audio)\\s*[:=]?\\s*(?:" + code + "|" + name + ")\\b", "i").test(title)).map(([code]) => code);
  // Dual audio is only a language hint until the player reads the actual tracks.
  return languages.length ? { languages, inferred: false } : /\bdual\s*audio\b/i.test(title)
    ? { languages: ["eng", "jpn"], inferred: true } : { languages: [], inferred: false };
}
export function audioRank(release: Release, preference: string): number {
  const preferred = preference.split(",")[0].trim().toLowerCase();
  if (!preferred) return 0;
  const audio = releaseAudio(release);
  return audio.languages.includes(preferred) ? Number(audio.inferred) : audio.languages.length ? 3 : 2;
}
export function rankReleases(
  releases: Release[],
  episode: number,
  settings: Settings,
): Release[] {
  const quality = [...(settings.qualities ?? [1080, 720, 480, 360])].sort(
    (a, b) => b - a,
  );
  return releases
    .filter(
      (r) =>
        (settings.source === "all" || r.source === settings.source) &&
        (settings.hideZeroSeeds === false || r.seeds > 0) &&
        (r.episode === null ||
          r.episode === episode ||
          (r.batch && r.episode <= episode && (r.endEpisode ?? 0) >= episode)),
    )
    .sort((a, b) => {
      const rank = (r: Release) => {
        const q = quality.indexOf(parseInt(r.resolution));
        return q < 0 ? 999 : q;
      };
      return (
        Number(Number.isNaN(parseInt(a.resolution))) - Number(Number.isNaN(parseInt(b.resolution))) ||
        audioRank(a, settings.audio ?? "") - audioRank(b, settings.audio ?? "") ||
        Number(a.confidence !== "Episode match") -
          Number(b.confidence !== "Episode match") ||
        rank(a) - rank(b) ||
        b.seeds - a.seeds
      );
    });
}
export function automaticRelease(
  releases: Release[],
  episode: number,
  settings: Settings,
): Release | undefined {
  return rankReleases(releases, episode, settings)
    .filter(
      (r) =>
        r.seeds > 0 &&
        (r.confidence === "Episode match" || r.batch) &&
        (settings.qualities ?? [1080, 720, 480, 360]).includes(
          parseInt(r.resolution),
        ),
    )
    .sort(
      (a, b) =>
        audioRank(a, settings.audio ?? "") - audioRank(b, settings.audio ?? "") || parseInt(b.resolution) - parseInt(a.resolution) || b.seeds - a.seeds,
    )[0];
}

export function isWatched(
  progress: Pick<Progress, "position" | "duration" | "watched"> | undefined,
): boolean {
  return (
    !!progress &&
    (progress.watched === true ||
      (progress.duration > 0 && progress.position / progress.duration > 0.85))
  );
}

export function recentSeasons(
  progress: Record<string, Progress>,
  showAdult = false,
): [string, Progress][] {
  const seen = new Set<number>();
  return Object.entries(progress)
    .sort((a, b) => b[1].updated - a[1].updated)
    .filter(([, p]) => {
      if ((!showAdult && p.isAdult) || seen.has(p.mediaId)) return false;
      seen.add(p.mediaId);
      return true;
    });
}
