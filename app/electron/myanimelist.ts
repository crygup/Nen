import { request as aniRequest, type RemoteEntry } from "./anilist";
import type { SyncBase, WatchStatus } from "../src/shared";

export interface MalTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
}
export type MalRequest = (
  path: string,
  method?: string,
  body?: Record<string, string | number | boolean>,
) => Promise<any>;
export async function exchangeMal(
  clientId: string,
  fields: Record<string, string>,
  secret = "",
): Promise<MalTokens> {
  const response = await fetch("https://myanimelist.net/v1/oauth2/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId,
      ...fields,
      ...(secret ? { client_secret: secret } : {}),
    }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok)
    throw Error(
      `MyAnimeList sign-in failed (${response.status}). Connect again.`,
    );
  const value = await response.json();
  if (
    typeof value.access_token !== "string" ||
    typeof value.refresh_token !== "string" ||
    !Number.isFinite(value.expires_in) ||
    value.expires_in <= 0
  )
    throw Error("Invalid MyAnimeList token response.");
  return {
    access_token: value.access_token,
    refresh_token: value.refresh_token,
    expires_at: Date.now() + value.expires_in * 1000,
  };
}
export function malClient(
  clientId: string,
  read: () => MalTokens,
  save: (value: MalTokens) => void,
  secret = "",
): MalRequest {
  let refreshing: Promise<void> | undefined;
  return async (path, method = "GET", body) => {
    if (read().expires_at < Date.now() + 60000) {
      refreshing ??= exchangeMal(
        clientId,
        { grant_type: "refresh_token", refresh_token: read().refresh_token },
        secret,
      )
        .then(save)
        .finally(() => {
          refreshing = undefined;
        });
      await refreshing;
    }
    const response = await fetch("https://api.myanimelist.net/v2" + path, {
      method,
      headers: {
        Authorization: `Bearer ${read().access_token}`,
        ...(body
          ? { "Content-Type": "application/x-www-form-urlencoded" }
          : {}),
      },
      body: body
        ? new URLSearchParams(
            Object.entries(body).map(([key, value]) => [key, String(value)]),
          )
        : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (method === "DELETE" && response.status === 404) return;
    if (!response.ok)
      throw Error(
        `MyAnimeList request failed (${response.status}). ${response.status === 401 ? "Connect again." : "Try again later."}`,
      );
    return response.status === 204 || method === "DELETE"
      ? undefined
      : response.json();
  };
}
const toMal: Record<WatchStatus, string> = {
  CURRENT: "watching",
  REPEATING: "watching",
  COMPLETED: "completed",
  PAUSED: "on_hold",
  DROPPED: "dropped",
  PLANNING: "plan_to_watch",
};
const fromMal: Record<string, WatchStatus> = {
  watching: "CURRENT",
  completed: "COMPLETED",
  on_hold: "PAUSED",
  dropped: "DROPPED",
  plan_to_watch: "PLANNING",
};
const ids = new Map<number, number>();
export async function malId(id: number) {
  if (!ids.has(id)) {
    const { Media } = await aniRequest<{ Media: { idMal: number | null } }>(
      "",
      "query($id:Int){Media(id:$id,type:ANIME){idMal}}",
      { id },
    );
    if (!Media?.idMal) throw Error("This anime has no MyAnimeList match.");
    ids.set(id, Media.idMal);
  }
  return ids.get(id)!;
}
export async function writeMal(
  request: MalRequest,
  id: number,
  values?: Partial<SyncBase> & { score?: number; notes?: string },
) {
  const target = await malId(id);
  if (!values) return request(`/anime/${target}/my_list_status`, "DELETE");
  const body: Record<string, string | number | boolean> = {};
  if (values.status !== undefined) {
    body.status = toMal[values.status];
    body.is_rewatching = values.status === "REPEATING";
  }
  if (values.count !== undefined) body.num_watched_episodes = values.count;
  if (values.repeat !== undefined) body.num_times_rewatched = values.repeat;
  if (values.score !== undefined) body.score = Math.round(values.score / 10);
  if (values.notes !== undefined) body.comments = values.notes;
  return request(`/anime/${target}/my_list_status`, "PATCH", body);
}
export interface ListEntry extends RemoteEntry {
  malId?: number;
  score: number;
  notes: string;
}
export async function readMal(request: MalRequest) {
  const user = await request("/users/@me");
  const rows: any[] = [];
  for (let offset = 0; ; offset += 1000) {
    const page = await request(
      `/users/@me/animelist?limit=1000&offset=${offset}&nsfw=true&fields=list_status{status,score,num_episodes_watched,is_rewatching,num_times_rewatched,comments},num_episodes,media_type`,
    );
    if (!Array.isArray(page.data)) throw Error("Invalid MyAnimeList response.");
    rows.push(...page.data);
    if (!page.paging?.next) break;
    if (offset >= 99000)
      throw Error("MyAnimeList list exceeds the supported size.");
  }
  const reverse = new Map([...ids].map(([ani, mal]) => [mal, ani]));
  const missing = rows
    .map((row) => row.node.id)
    .filter((id) => !reverse.has(id));
  for (let i = 0; i < missing.length; i += 50) {
    const { Page } = await aniRequest<{
      Page: { media: { id: number; idMal: number }[] };
    }>(
      "",
      "query($ids:[Int]){Page(perPage:50){media(idMal_in:$ids,type:ANIME){id idMal}}}",
      { ids: missing.slice(i, i + 50) },
    );
    for (const item of Page.media) {
      ids.set(item.id, item.idMal);
      reverse.set(item.idMal, item.id);
    }
  }
  const entries: Record<string, ListEntry> = {},
    skipped: string[] = [];
  for (const { node, list_status: value } of rows) {
    const id = reverse.get(node.id);
    if (!id || !fromMal[value?.status]) {
      skipped.push(node.title);
      continue;
    }
    entries[id] = {
      mediaId: id,
      malId: node.id,
      title: node.title,
      cover: node.main_picture?.large ?? node.main_picture?.medium ?? "",
      episodes: node.num_episodes || null,
      format: node.media_type?.toUpperCase(),
      status: value.is_rewatching ? "REPEATING" : fromMal[value.status],
      count: value.num_episodes_watched ?? 0,
      repeat: value.num_times_rewatched ?? 0,
      score: (value.score ?? 0) * 10,
      notes: value.comments ?? "",
    };
  }
  return {
    user: String(user.name),
    entries,
    skipped,
    malIds: rows.map((row) => row.node.id) as number[],
  };
}
