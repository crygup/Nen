import { parseSearch } from "../src/filters";
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { XMLParser } from "fast-xml-parser";
import type {
  Catalog,
  Media,
  Labels,
  Label,
  Release,
  Marker,
  EpisodePage,
} from "../src/shared";
import { episodeAvailability, latestEpisode } from "../src/shared";
import { hash, positive, parseRelease, validMarker, matchesMedia, sourceOffset, sourceAliases } from "./rules";
const cache = new Map<
  string,
  { expires: number; body: string; etag: string | null }
>();
const pending = new Map<string, Promise<string>>();
const blocked = new Map<string, number>();
let cachePath: string | undefined;
let cacheTimer: ReturnType<typeof setTimeout> | undefined;
export function initCache(path: string) {
  cachePath = path;
  try {
    const entries = JSON.parse(readFileSync(path, "utf8"));
    if (Array.isArray(entries))
      for (const [key, value] of entries.slice(-100))
        if (
          typeof key === "string" &&
          value?.expires > Date.now() - 7 * 86400000 &&
          typeof value.body === "string" &&
          value.body.length < 5000000
        )
          cache.set(key, value);
  } catch {}
}
function persistCache() {
  if (!cachePath || cacheTimer) return;
  cacheTimer = setTimeout(() => {
    cacheTimer = undefined;
    try {
      writeFileSync(
        cachePath! + ".tmp",
        JSON.stringify(
          [...cache].filter(([, v]) => v.expires > Date.now() - 7 * 86400000),
        ),
      );
      renameSync(cachePath! + ".tmp", cachePath!);
    } catch {}
  }, 500);
  cacheTimer.unref();
}
export function clearCache() {
  cache.clear();
  persistCache();
}
async function request(
  url: string,
  init: RequestInit = {},
  ttl = 300000,
): Promise<string> {
  const key = url + String(init.body ?? "");
  const validate = (body: string) => {
    if (url === "https://graphql.anilist.co") {
      const payload = JSON.parse(body);
      if (payload.errors || !payload.data)
        throw Error(
          payload.errors?.[0]?.message ?? "Catalog response is incomplete.",
        );
      const variables = JSON.parse(String(init.body)).variables;
      if (
        variables?.sort === "TRENDING_DESC" &&
        variables.page === 1 &&
        !payload.data.Page?.media?.length
      )
        throw Error("Trending is temporarily unavailable.");
    }
  };
  let old = cache.get(key);
  if (old) {
    try {
      validate(old.body);
    } catch {
      cache.delete(key);
      old = undefined;
    }
  }
  const stale =
    url === "https://graphql.anilist.co" &&
    old &&
    old.expires > Date.now() - 7 * 86400000;
  if (old && old.expires > Date.now()) return old.body;
  if (pending.has(key)) return stale ? old!.body : pending.get(key)!;
  const task = (async () => {
    const host = new URL(url).host;
    if ((blocked.get(host) ?? 0) > Date.now())
      throw Error(`${host} is rate limited. Try again later.`);
    const response = await fetch(url, {
      ...init,
      redirect: "error",
      headers: {
        "User-Agent": "Nen/0.1 (desktop anime player)",
        ...init.headers,
        ...(old?.etag ? { "If-None-Match": old.etag } : {}),
      },
      signal: init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(18000)]) : AbortSignal.timeout(18000),
    });
    if (response.status === 304 && old) {
      old.expires = Date.now() + ttl;
      return old.body;
    }
    if (response.status === 429) {
      const retry = response.headers.get("retry-after") ?? "60";
      const delay = /^\d+$/.test(retry)
        ? Number(retry) * 1000
        : Date.parse(retry) - Date.now();
      blocked.set(
        host,
        Date.now() + Math.max(60000, Number.isFinite(delay) ? delay : 60000),
      );
      throw Error(`${host} is rate limited. Try again later.`);
    }
    if (!response.ok) throw Error(`${host}: HTTP ${response.status}`);
    const body = await response.text();
    if (body.length > 5000000) throw Error("Provider response is too large.");
    if (cache.size >= 100) cache.delete(cache.keys().next().value!);
    if (url.includes("api.jikan.moe")) {
      const payload = JSON.parse(body);
      if (!Array.isArray(payload.data)) {
        blocked.set(new URL(url).host, Date.now() + 60000);
        throw Error("Episode titles are temporarily unavailable.");
      }
    }
    validate(body);
    cache.set(key, {
      expires: Date.now() + ttl,
      body,
      etag: response.headers.get("etag"),
    });
    persistCache();
    return body;
  })().catch((error) => {
    if (stale) return old!.body;
    throw error;
  });
  pending.set(key, task);
  if (stale) {
    void task.finally(() => pending.delete(key)).catch(() => {});
    return old!.body;
  }
  try {
    return await task;
  } finally {
    pending.delete(key);
  }
}
const fields = `id idMal isAdult title { english romaji native } synonyms description(asHtml:false) coverImage { large } bannerImage format source status episodes seasonYear averageScore genres nextAiringEpisode { episode airingAt }`;
async function gql(query: string, variables: object) {
  const data = JSON.parse(
    await request(
      "https://graphql.anilist.co",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query, variables }),
      },
      1800000,
    ),
  );
  if (data.errors)
    throw Error(data.errors[0]?.message ?? "AniList request failed.");
  return data.data;
}
export async function catalogOptions(): Promise<{
  genres: string[];
  tags: string[];
}> {
  const result = JSON.parse(
    await request(
      "https://graphql.anilist.co",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: "{ GenreCollection MediaTagCollection { name isAdult } }",
        }),
      },
      86400000,
    ),
  );
  if (result.errors) throw Error("Browse filters could not load.");
  return {
    genres: result.data.GenreCollection,
    tags: result.data.MediaTagCollection.filter((t: any) => !t.isAdult)
      .map((t: any) => t.name)
      .sort(),
  };
}
export async function catalog(
  mode: string,
  search: string,
  page: number,
  showAdult = false,
  perPage = 24,
): Promise<Catalog> {
  if (mode === "romance") {
    // Keep this curated shelf to the 100 most popular Romance titles.
    const batches = await Promise.all([1, 2].map(p => catalog("search", "genre:Romance", p, showAdult, 50)));
    const names = new Set(["Heterosexual", "Boys' Love", "Yuri", "Love Triangle", "Cohabitation", "Unrequited Love"]);
    const rank = (m: Media) => Math.max(0, ...(m.tags ?? []).filter(t => names.has(t.name)).map(t => t.rank));
    const titles = batches.flatMap(b => b.media).filter(m => rank(m) >= 90).sort((a, b) => rank(b) - rank(a));
    return { media: titles.slice((page - 1) * perPage, page * perPage), hasNextPage: page * perPage < titles.length, lastPage: Math.max(1, Math.ceil(titles.length / perPage)) };
  }
  const f = parseSearch(mode === "search" ? search : "");
  const now = new Date();
  if (mode === "season") {
    f.season = ["WINTER", "SPRING", "SUMMER", "FALL"][
      Math.floor(now.getMonth() / 3)
    ];
    f.year = now.getFullYear();
  }
  const options = f.genre || f.tag ? await catalogOptions() : undefined;
  const genre = options?.genres.find(
    (g) => g.toLowerCase() === f.genre?.toLowerCase(),
  );
  const tag = options?.tags.find(
    (g) => g.toLowerCase() === f.tag?.toLowerCase(),
  );
  if ((f.genre && !genre) || (f.tag && !tag))
    return { media: [], hasNextPage: false, lastPage: 1 };
  const vars = {
    page,
    perPage,
    search: f.search || undefined,
    genre: genre ? [genre] : undefined,
    tag: tag ? [tag] : undefined,
    year: f.year,
    season: f.season,
    format: f.format,
    status: f.status,
    adult: showAdult ? undefined : false,
    sort: f.search
      ? "SEARCH_MATCH"
      : mode === "trending"
        ? "TRENDING_DESC"
        : "POPULARITY_DESC",
  };
  const data = await gql(
    "query($page:Int,$perPage:Int,$search:String,$genre:[String],$tag:[String],$year:Int,$season:MediaSeason,$format:MediaFormat,$status:MediaStatus,$adult:Boolean,$sort:[MediaSort]){Page(page:$page,perPage:$perPage){pageInfo{hasNextPage lastPage}media(type:ANIME,isAdult:$adult,search:$search,genre_in:$genre,tag_in:$tag,seasonYear:$year,season:$season,format:$format,status:$status,sort:$sort){" +
      "id idMal isAdult title { english romaji native } coverImage { large } format status episodes seasonYear averageScore genres tags { name rank }" +
      "}}}",
    vars,
  );
  return {
    media: data.Page.media.map(normalizeMedia),
    hasNextPage: data.Page.pageInfo.hasNextPage,
    lastPage: data.Page.pageInfo.lastPage,
  };
}
export async function media(id: number): Promise<Media> {
  return normalizeMedia(
    (
      await gql(
        `query($id:Int){Media(id:$id,type:ANIME){${fields} streamingEpisodes { title } airingSchedule(perPage:50) { nodes { episode airingAt } } relations { edges { relationType node { id title { romaji } format type } } }}}`,
        { id },
      )
    ).Media,
  );
}
export async function labels(id: number, mal: number | null): Promise<Labels> {
  const base = "https://anifillerpedia.wiki/api/v1";
  let rows = JSON.parse(await request(`${base}/series?anilist_id=${id}`)).items;
  if (!rows.length && mal)
    rows = JSON.parse(await request(`${base}/series?mal_id=${mal}`)).items;
  const row =
    rows.find((r: { anilist_id: number }) => r.anilist_id === id) ??
    rows.find((r: { mal_id: number }) => r.mal_id === mal);
  if (!row)
    return {
      items: [],
      notice: "No researched episodes for this series.",
      needsMapping: false,
    };
  positive(row.id);
  const detail = JSON.parse(await request(`${base}/series/${row.id}`));
  const episodes = JSON.parse(
    await request(`${base}/series/${row.id}/episodes`),
  );
  const items = (Array.isArray(episodes) ? episodes : (episodes.items ?? []))
    .filter(
      (e: { status: string; episode_number: number }) =>
        ["canon", "filler", "mixed"].includes(e.status) &&
        Number.isInteger(e.episode_number),
    )
    .map(
      (e: {
        episode_number: number;
        status: "canon" | "filler" | "mixed";
        citation?: { description?: string; url?: string };
      }) => ({
        episode: e.episode_number,
        status: e.status,
        citation:
          e.citation?.description ?? "AniFillerPedia community research",
        url: e.citation?.url ?? null,
      }),
    );
  const needsMapping =
    !!detail.previous_series ||
    row.anilist_id !== id ||
    !!(
      detail.anilist_episode_count &&
      items.some((e: Label) => e.episode > detail.anilist_episode_count)
    );
  return {
    items,
    providerId: row.id,
    needsMapping,
    notice: needsMapping
      ? "Confirm the episode offset before applying labels."
      : "Labels from AniFillerPedia · CC BY-NC-SA 4.0",
  };
}
async function nyaa(query: string, episode: number, signal?: AbortSignal): Promise<Release[]> {
  const xml = await request(
    `https://nyaa.si/?page=rss&c=1_2&f=0&q=${encodeURIComponent(query)}`, { signal },
  );
  const root = new XMLParser({ processEntities: false }).parse(xml);
  const entries = root.rss?.channel?.item ?? [];
  return (Array.isArray(entries) ? entries : [entries]).flatMap(
    (r: Record<string, string>) => {
      try {
        const title = String(r.title).slice(0, 600);
        return [
          {
            hash: hash(r["nyaa:infoHash"]),
            title,
            source: "Nyaa" as const,
            size: String(r["nyaa:size"] ?? ""),
            seeds: Number(r["nyaa:seeders"]) || 0,
            ...parseRelease(title, episode),
          },
        ];
      } catch {
        return [];
      }
    },
  );
}
async function bangumi(query: string, episode: number, signal?: AbortSignal): Promise<Release[]> {
  const data = JSON.parse(
    await request("https://bangumi.moe/api/v2/torrent/search", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
      signal,
    }),
  );
  if (!Array.isArray(data.torrents))
    throw Error("Bangumi Moe returned no release list.");
  return data.torrents.flatMap((r: Record<string, string>) => {
    try {
      const title = String(r.title).slice(0, 600);
      return [
        {
          hash: hash(r.infoHash),
          title,
          source: "Bangumi Moe" as const,
          size: String(r.size ?? ""),
          seeds: Number(r.seeders) || 0,
          ...parseRelease(title, episode),
        },
      ];
    } catch {
      return [];
    }
  });
}
export async function releases(
  anime: Media,
  episode: number,
  override?: string,
  source = "all",
  signal?: AbortSignal,
): Promise<{ items: Release[]; errors: string[] }> {
  const offset = sourceOffset(anime.id);
  episode += offset;
  const deadline = AbortSignal.timeout(25000);
  signal = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const aliases = override
    ? [override]
    : [
        ...sourceAliases(anime),
        anime.title.romaji,
        anime.title.english,
        anime.title.native,
        ...anime.synonyms,
      ].filter((s): s is string => !!s);
  const queries = [...new Set(aliases)].slice(0, 2);
  const errors: string[] = [];
  const items = new Map<string, Release>();
  await Promise.all(
    [
      ["Nyaa", nyaa],
      ["Bangumi Moe", bangumi],
    ].filter(([name]) => source === "all" || name === source).map(async ([name, adapter]) => {
      try {
        const usable = (r: Release) => r.seeds > 0 && (r.confidence === "Episode match" ||
          (r.batch && (r.episode === null || (r.episode <= episode && (r.endEpisode ?? 0) >= episode))));
        for (const query of queries) {
          signal.throwIfAborted();
          let rows = await (adapter as typeof nyaa)(
            `${query} ${String(episode).padStart(2, "0")}`,
            episode, signal,
          );
          rows = rows.filter(r => matchesMedia(r.title, anime));
          if (!rows.some(usable))
            rows = [
              ...rows,
              ...(await (adapter as typeof nyaa)(query, episode, signal)),
            ];
          rows = rows.filter(r => matchesMedia(r.title, anime));
          for (const row of rows)
            if (!items.has(row.hash)) items.set(row.hash, row);
          if (!rows.some(r => r.batch && usable(r))) {
            for (const suffix of ["batch", "complete"]) {
              const batches = await (adapter as typeof nyaa)(
                query + " " + suffix,
                episode, signal,
              );
              for (const row of batches)
                if (
                  matchesMedia(row.title, anime) &&
                  row.batch &&
                  row.seeds > 0 &&
                  (row.episode === null ||
                    (row.episode <= episode &&
                      (row.endEpisode ?? 0) >= episode))
                )
                  items.set(row.hash, row);
              if (batches.some(r => matchesMedia(r.title, anime) && usable(r))) break;
            }
          }
          if ([...items.values()].some(r => r.source === name && usable(r))) break;
        }
      } catch (error) {
        errors.push(`${name}: ${(error as Error).message}`);
      }
    }),
  );
  return {
    items: [...items.values()]
      .map(row => offset ? { ...row,
        episode: row.episode === null ? null : row.episode - offset,
        endEpisode: row.endEpisode === null ? null : row.endEpisode - offset,
      } : row)
      .sort(
        (a, b) =>
          Number(b.confidence === "Episode match") -
            Number(a.confidence === "Episode match") || b.seeds - a.seeds,
      )
      .slice(0, 100),
    errors,
  };
}
export async function skips(
  mal: number,
  episode: number,
  duration: number,
): Promise<Marker[]> {
  const base = `https://api.aniskip.com/v2/skip-times/${mal}/${episode}?${["op", "ed", "mixed-op", "mixed-ed", "recap"].map(t => "types=" + t).join("&")}&episodeLength=`;
  const read = async (length: number) => {
    try {
      return JSON.parse(await request(base + length, {}, 86400000)).results ?? [];
    } catch (error) {
      if ((error as Error).message.includes("HTTP 404")) return [];
      throw error;
    }
  };
  const exact = await read(Math.round(duration));
  const rows = exact.some((r: any) => r.skipType === "ed" || r.skipType === "mixed-ed")
    ? exact : [...exact, ...await read(0).catch(error => {
        if (exact.length) return [];
        throw error;
      })];
  const seen = new Set<string>();
  return rows.flatMap((r: any) => {
    if (!r?.interval || seen.has(r.skipType)
      || !Number.isFinite(r.interval.startTime) || !Number.isFinite(r.interval.endTime)
      || r.interval.startTime < 0 || r.interval.endTime <= r.interval.startTime) return [];
    const difference = duration - r.episodeLength;
    if (!Number.isFinite(difference) || Math.abs(difference) > 5) return [];
    const shift = r.skipType === "ed" || r.skipType === "mixed-ed" ? difference : 0;
    const marker: Marker = {
      type: r.skipType,
      start: Math.max(0, r.interval.startTime + shift),
      end: Math.min(duration, r.interval.endTime + shift),
      confirmed: false,
    };
    if (!validMarker(marker, duration)) return [];
    seen.add(marker.type);
    return [marker];
  });
}

function normalizeMedia(input: any): Media {
  const str = (value: unknown, max = 500) =>
    typeof value === "string" ? value.slice(0, max) : "";
  const list = (value: unknown) =>
    Array.isArray(value)
      ? value
          .filter((s): s is string => typeof s === "string")
          .slice(0, 40)
          .map((s) => s.slice(0, 300))
      : [];
  const number = (value: unknown, max = 10000) =>
    Number.isInteger(value) && Number(value) > 0 && Number(value) <= max
      ? Number(value)
      : null;
  const image = (value: unknown) => {
    try {
      const url = new URL(str(value, 2000));
      return url.protocol === "https:" &&
        ["s4.anilist.co", "s5.anilist.co"].includes(url.hostname)
        ? url.href
        : "";
    } catch {
      return "";
    }
  };
  const id = positive(input?.id);
  return {
    id,
    isAdult: input.isAdult === true,
    idMal: number(input.idMal, 10000000),
    title: {
      romaji:
        str(input.title?.romaji) || str(input.title?.english) || `Anime ${id}`,
      english: str(input.title?.english) || null,
      native: str(input.title?.native) || null,
    },
    synonyms: list(input.synonyms),
    description: str(input.description, 30000),
    coverImage: { large: image(input.coverImage?.large) },
    bannerImage: image(input.bannerImage) || null,
    format: str(input.format, 30),
    source: str(input.source, 30),
    status: str(input.status, 30),
    episodes: number(input.episodes),
    seasonYear: number(input.seasonYear),
    averageScore: number(input.averageScore, 100),
    genres: list(input.genres),
    tags: (Array.isArray(input.tags) ? input.tags : []).filter((t: any) => typeof t.name === "string" && Number.isFinite(t.rank) && t.rank >= 0 && t.rank <= 100).map((t: any) => ({ name: t.name, rank: t.rank })),
    nextAiringEpisode: number(input.nextAiringEpisode?.episode)
      ? {
          episode: input.nextAiringEpisode.episode,
          airingAt:
            number(input.nextAiringEpisode.airingAt, 9999999999) ?? undefined,
        }
      : null,
    airingSchedule: {
      nodes: (Array.isArray(input.airingSchedule?.nodes)
        ? input.airingSchedule.nodes
        : []
      )
        .filter((e: any) => number(e.episode) && number(e.airingAt, 9999999999))
        .map((e: any) => ({ episode: e.episode, airingAt: e.airingAt })),
    },
    streamingEpisodes: (Array.isArray(input.streamingEpisodes)
      ? input.streamingEpisodes
      : []
    ).map((e: any) => ({ title: str(e.title) })),
    relations: {
      edges: (Array.isArray(input.relations?.edges)
        ? input.relations.edges
        : []
      )
        .slice(0, 100)
        .filter((e: any) => number(e?.node?.id, 10000000))
        .map((e: any) => ({
          relationType: str(e.relationType, 30),
          node: {
            id: e.node.id,
            title: { romaji: str(e.node.title?.romaji) },
            format: str(e.node.format, 30),
            type: str(e.node.type, 30),
          },
        })),
    },
  };
}

export async function episodes(id: number, page: number): Promise<EpisodePage> {
  const anime = await media(id);
  const titles = new Map<number, string>();
  for (const item of anime.streamingEpisodes ?? []) {
    const match = item.title.match(/(?:Episode\s*)?(\d+)\s*[-:–]\s*(.+)/i);
    if (match) titles.set(Number(match[1]), match[2]);
  }
  for (const [number, title] of titles)
    if (/^(untitled|tba|tbd|episode\s*\d+)$/i.test(title.trim()))
      titles.delete(number);
  let notice: string | undefined;
  if (anime.idMal) {
    try {
      const result = JSON.parse(
        await request(
          `https://api.jikan.moe/v4/anime/${anime.idMal}/episodes?page=${Math.floor((page - 1) / 2) + 1}`,
          {},
          3600000,
        ),
      );
      for (const row of result.data ?? [])
        if (
          Number.isInteger(row.mal_id) &&
          typeof row.title === "string" &&
          !/^(untitled|tba|tbd|episode\s*\d+)$/i.test(row.title.trim())
        )
          titles.set(row.mal_id, row.title.slice(0, 500));
    } catch {
      notice = "Some episode titles are not available yet.";
    }
  }
  const first = (page - 1) * 50 + 1;
  const end = Math.min(first + 49, anime.episodes ?? first + 49);
  if (
    anime.idMal &&
    Array.from({ length: end - first + 1 }, (_, i) => first + i).some(
      (n) => !titles.has(n),
    )
  ) {
    try {
      const mappings = JSON.parse(
        await request(
          "https://kitsu.io/api/edge/mappings?filter[externalSite]=myanimelist/anime&include=item&filter[externalId]=" +
            anime.idMal,
          {},
          86400000,
        ),
      );
      const matches =
        mappings.data?.filter(
          (m: any) =>
            m.attributes?.externalSite === "myanimelist/anime" &&
            String(m.attributes.externalId) === String(anime.idMal) &&
            m.relationships?.item?.data?.type === "anime",
        ) ?? [];
      const kitsu =
        matches.length === 1
          ? matches[0].relationships.item.data.id
          : undefined;
      if (kitsu && /^\d+$/.test(kitsu)) {
        for (
          let offset = Math.floor((first - 1) / 20) * 20;
          offset < end;
          offset += 20
        ) {
          const data = JSON.parse(
            await request(
              "https://kitsu.io/api/edge/anime/" +
                kitsu +
                "/episodes?page[limit]=20&page[offset]=" +
                offset +
                "&sort=number",
              {},
              3600000,
            ),
          );
          for (const row of data.data ?? []) {
            const e = row.attributes;
            const title =
              e?.titles?.en_us || e?.titles?.en || e?.canonicalTitle;
            if (
              Number.isInteger(e?.number) &&
              typeof title === "string" &&
              title.trim() &&
              !/^(untitled|tba|tbd|episode\s*\d+)$/i.test(title.trim()) &&
              !titles.has(e.number)
            )
              titles.set(e.number, title.slice(0, 500));
          }
          if (!data.links?.next) break;
        }
      }
    } catch {
      notice = "Some episode titles are not available yet.";
    }
  }
  const latest = latestEpisode(anime);
  const total =
    anime.episodes ?? Math.max(latest, anime.nextAiringEpisode?.episode ?? 0);
  const items = Array.from(
    { length: Math.min(50, Math.max(0, total - (page - 1) * 50)) },
    (_, i) => {
      const number = (page - 1) * 50 + i + 1;
      return {
        number,
        title: titles.get(number) ?? `Episode ${number}`,
        ...episodeAvailability(anime, number),
      };
    },
  );
  return { items, total, latest, notice };
}
