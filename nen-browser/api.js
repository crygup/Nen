import * as providers from "../app/electron/providers";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
const cacheDir = process.env.NEN_CACHE_DIR || join(process.cwd(), ".local");
mkdirSync(cacheDir, { recursive: true });
providers.initCache(join(cacheDir, "provider-cache.json"));
const mappings = new Map(),
  pending = new Map();
let activeRequests = 0;
async function sourceJson(path, signal) {
  const response = await fetch(`https://api.animeparadise.moe${path}`, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20000)]),
  });
  if (!response.ok) throw Error(`Stream provider returned ${response.status}.`);
  const body = await response.json();
  if (!body.success) throw Error("The stream provider is unavailable.");
  return body.data;
}
async function waitFor(task, signal) {
  let cancel;
  const aborted = new Promise((_, reject) => {
    cancel = () => reject(signal.reason);
    if (signal.aborted) cancel();
    else signal.addEventListener("abort", cancel, { once: true });
  });
  try {
    return await Promise.race([task, aborted]);
  } finally {
    signal.removeEventListener("abort", cancel);
  }
}
async function mapped(id, signal) {
  signal.throwIfAborted();
  if (mappings.has(id)) return mappings.get(id);
  let entry = pending.get(id);
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController();
    entry = { controller, users: 0, task: undefined };
    const shared = entry;
    entry.task = findMapping(id, controller.signal).finally(() => {
      if (pending.get(id) === shared) pending.delete(id);
    });
    pending.set(id, entry);
  }
  entry.users++;
  try {
    return await waitFor(entry.task, signal);
  } finally {
    if (--entry.users === 0) entry.controller.abort();
  }
}
async function findMapping(id, signal) {
  const media = await waitFor(providers.media(id), signal);
  const normalize = (text) =>
    (text || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const names = [
    ...new Set([media.title.english, media.title.romaji].filter(Boolean)),
  ];
  for (const name of names) {
    const results = await sourceJson(
      `/search?q=${encodeURIComponent(name)}&limit=20`,
      signal,
    );
    results.sort(
      (a, b) =>
        Number(
          names.some(
            (n) =>
              normalize(n) === normalize(b.title) ||
              normalize(n) === normalize(b.alternativeTitle?.english),
          ),
        ) -
        Number(
          names.some(
            (n) =>
              normalize(n) === normalize(a.title) ||
              normalize(n) === normalize(a.alternativeTitle?.english),
          ),
        ),
    );
    for (const candidate of results.slice(0, 5)) {
      const episodes = await sourceJson(
        `/anime/${encodeURIComponent(candidate._id)}/episode`,
        signal,
      );
      if (!episodes.length) continue;
      const details = await sourceJson(
        `/ep/${encodeURIComponent(episodes[0].uid)}?origin=${encodeURIComponent(candidate._id)}`,
        signal,
      );
      if (Number(details.animeData?.mappings?.anilist) !== id) continue;
      const result = { id: candidate._id, episodes };
      if (mappings.size >= 200) mappings.delete(mappings.keys().next().value);
      signal.throwIfAborted();
      mappings.set(id, result);
      return result;
    }
  }
  throw Error(
    "No matching stream is available for this title on AnimeParadise.",
  );
}

export async function handleApi(req, res, desktop = false) {
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Cache-Control", "no-store");
  const fail = (status, message) => {
    if (res.destroyed || res.writableEnded) return;
    res.statusCode = status;
    res.end(JSON.stringify({ error: message }));
  };
  if (req.method !== "GET") {
    res.setHeader("Allow", "GET");
    fail(405, "Only GET requests are supported.");
    return;
  }
  if (activeRequests >= 20) {
    fail(503, "The server is busy. Try again shortly.");
    return;
  }
  activeRequests++;
  const controller = new AbortController();
  const signal = controller.signal;
  const cancel = () => {
    if (!res.writableEnded) controller.abort();
  };
  req.on("aborted", cancel);
  res.on("close", cancel);
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    if (
      ![
        "/catalog",
        "/airing",
        "/options",
        "/desktop-data",
        "/media",
        "/episodes",
        "/labels",
        "/stream",
      ].includes(url.pathname)
    ) {
      fail(404, "Unknown operation.");
      return;
    }
    const id = Number(url.searchParams.get("id")),
      page = Number(url.searchParams.get("page") || 1);
    const perPage = Number(url.searchParams.get("perPage") || 24),
      mode = url.searchParams.get("mode") || "trending";
    if (
      !Number.isSafeInteger(page) ||
      page < 1 ||
      page > 1000 ||
      !Number.isSafeInteger(perPage) ||
      perPage < 1 ||
      perPage > 50 ||
      !["trending", "season", "search", "romance"].includes(mode)
    ) {
      fail(400, "Invalid catalog request.");
      return;
    }
    const episode = Number(url.searchParams.get("episode"));
    if (
      url.pathname === "/stream" &&
      (!Number.isSafeInteger(episode) || episode < 1 || episode > 10000)
    ) {
      fail(400, "Invalid episode.");
      return;
    }
    let result;
    if (url.pathname === "/airing")
      result = await waitFor(
        providers.airing(
          (url.searchParams.get("ids") || "")
            .split(",")
            .filter(Boolean)
            .map(Number),
        ),
        signal,
      );
    else if (url.pathname === "/catalog")
      result = await waitFor(
        providers.catalog(
          mode,
          (url.searchParams.get("search") || "").slice(0, 200),
          page,
          url.searchParams.get("adult") === "true",
          perPage,
        ),
        signal,
      );
    else if (url.pathname === "/options")
      result = await waitFor(providers.catalogOptions(), signal);
    else if (url.pathname === "/desktop-data") {
      if (!desktop) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: "Not available." }));
        return;
      }
      if (
        !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(
          req.socket.remoteAddress,
        ) ||
        req.headers.host !== "127.0.0.1:5174" ||
        (req.headers.origin && req.headers.origin !== "http://127.0.0.1:5174")
      ) {
        fail(403, "Desktop data import is only available on this PC.");
        return;
      }
      const root = join(process.env.APPDATA, "Nen"),
        shared = JSON.parse(readFileSync(join(root, "state.json"), "utf8")),
        active = shared.profiles?.active;
      if (shared.profiles && !/^[a-f0-9]{16}$/.test(active))
        throw Error("Invalid profile.");
      const saved = shared.profiles
        ? JSON.parse(
            readFileSync(
              join(root, "profiles", active, "profile.json"),
              "utf8",
            ),
          )
        : shared;
      result = {
        watch: saved.watch || {},
        favorites: saved.favorites || {},
        settings: saved.settings || {},
        progress: Object.fromEntries(
          Object.entries(saved.progress || {}).map(([key, p]) => [
            key,
            {
              mediaId: p.mediaId,
              malId: p.malId,
              title: p.title,
              cover: p.cover,
              episode: p.episode,
              episodeTitle: p.episodeTitle,
              totalEpisodes: p.totalEpisodes,
              position: p.position,
              duration: p.duration,
              watched: p.watched,
              updated: p.updated,
            },
          ]),
        ),
      };
    } else {
      if (!Number.isSafeInteger(id) || id <= 0) {
        fail(400, "Invalid anime ID.");
        return;
      }
      if (url.pathname === "/media")
        result = await waitFor(providers.media(id), signal);
      else if (url.pathname === "/episodes")
        result = await waitFor(providers.episodes(id, page), signal);
      else if (url.pathname === "/labels") {
        const m = await waitFor(providers.media(id), signal);
        result = await waitFor(providers.labels(id, m.idMal), signal);
      } else if (url.pathname === "/stream") {
        const mapping = await mapped(id, signal);
        const ep = mapping.episodes.find(
          (item) => Number(item.number) === episode,
        );
        if (!ep)
          throw Error(
            "This episode is not available from the stream provider.",
          );
        const details = await sourceJson(
          `/ep/${encodeURIComponent(ep.uid)}?origin=${encodeURIComponent(mapping.id)}`,
          signal,
        );
        if (Number(details.animeData?.mappings?.anilist) !== id) {
          mappings.delete(id);
          throw Error("The stream provider returned a different season.");
        }
        result = details.episode;
      } else throw Error("Unknown operation.");
    }
    if (!signal.aborted) res.end(JSON.stringify(result));
  } catch {
    if (!signal.aborted)
      fail(502, "The data provider is unavailable. Try again later.");
  } finally {
    req.off("aborted", cancel);
    res.off("close", cancel);
    activeRequests--;
  }
}
