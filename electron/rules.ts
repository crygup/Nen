import type { Marker, Release, Progress } from "../src/shared";
export function positive(value: unknown, max = 10000000): number {
  if (!Number.isInteger(value) || Number(value) < 1 || Number(value) > max)
    throw Error("Invalid number.");
  return Number(value);
}
export function text(value: unknown, max = 200): string {
  if (typeof value !== "string" || value.length > max)
    throw Error("Invalid text.");
  return value.trim();
}
export function hash(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value))
    throw Error("Invalid torrent hash.");
  return value.toLowerCase();
}
export function validMarker(marker: Marker, duration: number): boolean {
  return (
    ["op", "ed", "mixed-op", "mixed-ed", "recap"].includes(marker.type) &&
    Number.isFinite(marker.start) &&
    Number.isFinite(marker.end) &&
    marker.start >= 0 &&
    marker.end > marker.start &&
    marker.end <= duration
  );
}
export function fileKey(hash: string, path: string, size: number) {
  return JSON.stringify([hash, path, size]);
}
export function parseRelease(
  title: string,
  episode: number,
): Pick<
  Release,
  | "season"
  | "resolution"
  | "group"
  | "language"
  | "episode"
  | "endEpisode"
  | "batch"
  | "confidence"
> {
  const normalized = title.replaceAll("_", " ");
  const range = normalized.match(
    /(?:\b|\s-\s)(\d{1,4})\s*[-~]\s*(\d{1,4})(?=\s|\]|\)|\.|$)/,
  );
  const seasonEpisode = normalized.match(
    /\bS(\d{1,2})[ ._-]*E(\d{1,4})(?:v\d)?\b/i,
  );
  const single = normalized.match(
    /(?:\s-\s|\bE(?:P)?\s*)(\d{1,4})(?:v\d)?(?=\s|\]|\)|\.|$)/i,
  );
  const bare = normalized.match(
    /(?:^|\s)(\d{1,3})(?:v\d)?(?=\s*\[|\.(?:mkv|mp4|avi)$)/i,
  );
  const start = seasonEpisode
    ? Number(seasonEpisode[2])
    : range
      ? Number(range[1])
      : single || bare
        ? Number((single || bare)![1])
        : null;
  const end = range ? Number(range[2]) : null;
  const batch = !!range || /\bbatch\b|\bcomplete\b/i.test(title);
  return {
    season: seasonEpisode ? Number(seasonEpisode[1]) : null,
    resolution:
      title.match(/\b(2160|1440|1080|720|480|360)p\b/i)?.[0] ?? "Unspecified",
    group: title.match(/^\[([^\]]+)\]/)?.[1] ?? "Unknown group",
    language:
      title
        .match(
          /dual[ ._-]?audio|multi[ ._-]?(?:sub|audio)|eng(?:lish)?[ ._-]?sub|chs|cht|jpn/gi,
        )
        ?.join(", ") ?? "Check tracks",
    episode: start,
    endEpisode: end,
    batch,
    confidence: start === episode && !batch ? "Episode match" : "Check match",
  };
}
export function byteRange(
  header: string | undefined,
  length: number,
): { start: number; end: number; partial: boolean } | null {
  if (!Number.isSafeInteger(length) || length <= 0) return null;
  if (!header) return { start: 0, end: length - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!m || (!m[1] && !m[2]) || length <= 0) return null;
  const start = m[1] ? Number(m[1]) : Math.max(0, length - Number(m[2]));
  const end = m[1]
    ? m[2]
      ? Math.min(Number(m[2]), length - 1)
      : length - 1
    : length - 1;
  return Number.isSafeInteger(start) &&
    Number.isSafeInteger(end) &&
    start >= 0 &&
    start <= end &&
    start < length
    ? { start, end, partial: true }
    : null;
}

export function repairProgress(
  entries: Record<string, Progress>,
): Record<string, Progress> {
  const repaired: Record<string, Progress> = {};
  for (const saved of Object.values(entries)) {
    const file = parseRelease(
      saved.file.path.split(/[\\/]/).at(-1) ?? "",
      saved.episode,
    );
    const release = parseRelease(saved.release.title, saved.episode);
    const number = file.episode;
    const p =
      number &&
      number !== saved.episode &&
      !release.batch &&
      release.episode === number &&
      number <= (saved.totalEpisodes ?? 10000)
        ? {
            ...saved,
            episode: number,
            malEpisode: number,
            episodeTitle: undefined,
          }
        : saved;
    const key = `${p.mediaId}:${p.episode}`;
    if (!repaired[key] || p.updated > repaired[key].updated) repaired[key] = p;
  }
  return repaired;
}
