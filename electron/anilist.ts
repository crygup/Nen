import type { AniListState, SyncBase, SyncChange, SyncPreview, WatchEntry, WatchStatus } from "../src/shared";
import { newEntry } from "./watch-data";

interface RemoteEntry extends SyncBase {
  mediaId: number;
  title: string;
  cover: string;
  episodes: number | null;
  isAdult?: boolean;
}
const endpoint = process.env.NEN_E2E_USER_DATA && process.env.NEN_E2E_ANILIST_URL
  ? process.env.NEN_E2E_ANILIST_URL : "https://graphql.anilist.co";
let waitUntil = 0;
async function request<T>(token: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const delay = waitUntil - Date.now();
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify({ query, variables }) });
    if (response.status === 429) {
      waitUntil = Date.now() + (Number(response.headers.get("Retry-After")) || 60) * 1000;
      continue;
    }
    const remainingHeader = response.headers.get("X-RateLimit-Remaining");
    const remaining = Number(remainingHeader);
    if (remainingHeader !== null && Number.isFinite(remaining) && remaining < 2) waitUntil = Date.now() + 60000;
    const body = await response.json() as { data?: T; errors?: { message: string }[] };
    if (!response.ok || body.errors?.length || !body.data) throw Error(body.errors?.[0]?.message || `AniList request failed (${response.status}).`);
    return body.data;
  }
  throw Error("AniList rate limit. Try again later.");
}

export async function readRemote(token: string): Promise<{ user: string; entries: Record<string, RemoteEntry> }> {
  const viewer = await request<{ Viewer: { id: number; name: string } }>(token, "query { Viewer { id name } }");
  const data = await request<{ MediaListCollection: { lists: { entries: { mediaId: number; status: WatchStatus; progress: number; repeat: number; media: { title: { english: string | null; romaji: string }; coverImage: { large: string }; episodes: number | null; isAdult: boolean } }[] }[] } }>(token,
    "query($userId:Int){ MediaListCollection(userId:$userId,type:ANIME){ lists { entries { mediaId status progress repeat media { title { english romaji } coverImage { large } episodes isAdult } } } } }", { userId: viewer.Viewer.id });
  const entries: Record<string, RemoteEntry> = {};
  for (const list of data.MediaListCollection?.lists ?? [])
    for (const row of list.entries ?? [])
      if (row.mediaId && row.status)
        entries[String(row.mediaId)] = { mediaId: row.mediaId, status: row.status, count: row.progress ?? 0, repeat: row.repeat ?? 0, title: row.media.title.english || row.media.title.romaji, cover: row.media.coverImage.large, episodes: row.media.episodes, isAdult: row.media.isAdult };
  return { user: viewer.Viewer.name, entries };
}

export function preview(local: Record<string, WatchEntry>, remote: Record<string, RemoteEntry>, sync: AniListState): SyncPreview {
  const changes: SyncChange[] = [];
  for (const id of new Set([...Object.keys(local), ...Object.keys(remote)])) {
    const here = local[id], there = remote[id], base = sync.baseline[id];
    for (const field of ["status", "count", "repeat"] as const) {
      const a = here?.[field] ?? null, b = there?.[field] ?? null;
      if (a === b) continue;
      const localChanged = !base || a !== base[field];
      const remoteChanged = !base || b !== base[field];
      changes.push({ mediaId: Number(id), title: here?.title || there?.title || id, field, local: a, remote: b, conflict: !!here && !!there && localChanged && remoteChanged, choice: !here ? "remote" : !there ? "local" : localChanged && !remoteChanged ? "local" : !localChanged && remoteChanged ? "remote" : undefined });
    }
  }
  return { changes, first: !sync.lastSync };
}

export async function apply(token: string, local: Record<string, WatchEntry>, remote: Record<string, RemoteEntry>, sync: AniListState, changes: SyncChange[]) {
  const byId = new Map<number, SyncChange[]>();
  for (const change of changes) {
    if (!change.choice) continue;
    if (!byId.has(change.mediaId)) byId.set(change.mediaId, []);
    byId.get(change.mediaId)!.push(change);
  }
  for (const [id, rows] of byId) {
    const there = remote[String(id)];
    const here = local[String(id)];
    const upload = rows.filter(row => row.choice === "local" && row.local !== null);
    if (upload.length) {
      const fields = upload.map(row => `${row.field === "count" ? "progress" : row.field}:$${row.field}`).join(",");
      const decl = upload.map(row => `$${row.field}:${row.field === "status" ? "MediaListStatus" : "Int"}`).join(",");
      const vars = Object.fromEntries(upload.map(row => [row.field, row.local]));
      await request(token, `mutation($mediaId:Int,${decl}){ SaveMediaListEntry(mediaId:$mediaId,${fields}) { id } }`, { mediaId: id, ...vars });
    }
    if (!here && there) {
      local[String(id)] = newEntry({ id, title: { english: there.title, romaji: there.title, native: null }, coverImage: { large: there.cover }, episodes: there.episodes, isAdult: there.isAdult });
    }
    const entry = local[String(id)];
    if (entry) for (const row of rows.filter(row => row.choice === "remote" && row.remote !== null)) {
      (entry as unknown as Record<string, unknown>)[row.field] = row.remote;
      (entry as unknown as Record<string, unknown>)[`${row.field}Updated`] = Date.now();
      if (row.field === "status" && row.remote === "REPEATING" && entry.runs.at(-1)?.completed)
        entry.runs.push({ started: Date.now(), count: there?.count ?? 0, episodes: {} });
    }
    if (entry && rows.length) {
      const base = sync.baseline[String(id)] ?? { status: entry.status, count: entry.count, repeat: entry.repeat };
      for (const row of rows) if (row.choice) (base as unknown as Record<string, unknown>)[row.field] = entry[row.field];
      sync.baseline[String(id)] = base;
    }
  }
  for (const [id, there] of Object.entries(remote)) {
    const here = local[id];
    if (here && here.status === there.status && here.count === there.count && here.repeat === there.repeat)
      sync.baseline[id] = { status: here.status, count: here.count, repeat: here.repeat };
  }
  sync.lastSync = Date.now();
  sync.error = undefined;
}

export async function setRemoteWatch(token: string, mediaId: number, entry?: WatchEntry) {
  if (entry) {
    await request(token, "mutation($mediaId:Int,$status:MediaListStatus,$progress:Int,$repeat:Int){ SaveMediaListEntry(mediaId:$mediaId,status:$status,progress:$progress,repeat:$repeat){ id } }",
      { mediaId, status: entry.status, progress: entry.count, repeat: entry.repeat });
    return;
  }
  const { Viewer } = await request<{ Viewer: { id: number } }>(token, "query { Viewer { id } }");
  const { Page } = await request<{ Page: { mediaList: { id: number }[] } }>(token,
    "query($userId:Int,$mediaId:Int){ Page(perPage:1){ mediaList(userId:$userId,mediaId:$mediaId){ id } } }", { userId: Viewer.id, mediaId });
  if (Page.mediaList[0]) {
    const result = await request<{ DeleteMediaListEntry: { deleted: boolean } }>(token,
      "mutation($id:Int){ DeleteMediaListEntry(id:$id){ deleted } }", { id: Page.mediaList[0].id });
    if (!result.DeleteMediaListEntry.deleted) throw Error("AniList did not remove the entry.");
  }
}
export async function setRemoteFavorite(token: string, id: number, favorite: boolean) {
  const { Media } = await request<{ Media: { isFavourite: boolean } }>(token,
    "query($id:Int){ Media(id:$id,type:ANIME){ isFavourite } }", { id });
  if (Media.isFavourite !== favorite)
    await request(token, "mutation($id:Int){ ToggleFavourite(animeId:$id){ anime { nodes { id } } } }", { id });
}
export async function syncFavorites(token: string, local: Record<string, WatchEntry>, pending: Record<string, boolean>) {
  for (const [id, favorite] of Object.entries(pending)) {
    await setRemoteFavorite(token, Number(id), favorite);
    delete pending[id];
  }
  const favorites: Record<string, WatchEntry> = {};
  for (let page = 1; ; page++) {
    const { Viewer } = await request<{ Viewer: { favourites: { anime: { pageInfo: { hasNextPage: boolean }; nodes: { id: number; title: { english: string | null; romaji: string; native: string | null }; coverImage: { large: string }; episodes: number | null; isAdult: boolean }[] } } } }>(token,
      "query($page:Int){ Viewer { favourites { anime(page:$page,perPage:50){ pageInfo { hasNextPage } nodes { id title { english romaji native } coverImage { large } episodes isAdult } } } } }", { page });
    for (const media of Viewer.favourites.anime.nodes) favorites[String(media.id)] = local[String(media.id)] ?? newEntry(media);
    if (!Viewer.favourites.anime.pageInfo.hasNextPage) break;
  }
  for (const id of Object.keys(local)) delete local[id];
  Object.assign(local, favorites);
}
