import type { Marker, Release, Progress, Media, TorrentFile } from "../src/shared";
// AniList separates the one-episode first stage; releases continue numbering at 02.
export function sourceOffset(mediaId: number): number {
  return mediaId === 210482 ? 1 : 0;
}
export function sourceAliases(media: Media): string[] {
  return media.id === 210482 ? ["JoJo no Kimyou na Bouken: Steel Ball Run"] : [];
}
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
    /(?:^|\s)(\d{1,4})(?:v\d)?(?=\s*\[|\s+Remaster\b|\.(?:mkv|mp4|avi)$)/i,
  );
  const start = seasonEpisode
    ? Number(seasonEpisode[2])
    : range
      ? Number(range[1])
      : single || bare
        ? Number((single || bare)![1])
        : null;
  const end = range ? Number(range[2]) : null;
  const batch = !!range || /\bbatch\b|\bcomplete\b/i.test(title)
    || (start === null && seasonNumber(normalized) !== null);
  return {
    season: seasonEpisode ? Number(seasonEpisode[1]) : seasonNumber(normalized),
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
    const number = file.episode === null ? null : file.episode - sourceOffset(saved.mediaId);
    const p =
      number &&
      number !== saved.episode &&
      !release.batch &&
      release.episode !== null && release.episode - sourceOffset(saved.mediaId) === number &&
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

export function seasonNumber(title: string): number | null {
  const match = title.match(/\b(?:season\s*|s)(\d{1,2})\b/i)
    ?? title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i);
  return match ? Number(match[1]) : null;
}
export function matchesSeason(title: string, media: Media): boolean {
  const season = parseRelease(title, 1).season;
  const expected = seasonNumber(media.title.english ?? "")
    ?? seasonNumber(media.title.romaji) ?? 1;
  return season == null || season === expected;
}
export function matchingFile(files: TorrentFile[], release: Release, media: Media, episode: number): TorrentFile | undefined {
  if (!matchesMedia(release.title, media)) return;
  episode += sourceOffset(media.id);
  const matches = files.filter(f => {
    const parsed = parseRelease(f.path.split(/[\\/]/).at(-1) ?? "", episode);
    return parsed.episode === episode && !parsed.batch && matchesSeason(f.path, media)
      && !/\b(sample|preview|trailer|ncop|nced)\b/i.test(f.path);
  });
  if (matches.length === 1) return matches[0];
  if (files.length === 1 && release.confidence === "Episode match"
    && parseRelease(files[0].path, episode).episode === null
    && matchesSeason(files[0].path, media)) return files[0];
}

export function matchesMedia(title: string, media: Media): boolean {
  if (!matchesSeason(title, media)) return false;
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const name = normalize(title.replace(/^(?:\s*\[[^\]]*\])+\s*/, ""));
  return [media.title.english, media.title.romaji, media.title.native, ...(media.synonyms ?? []), ...sourceAliases(media)]
    .filter((alias): alias is string => !!alias)
    .some(alias => {
      const prefix = normalize(alias);
      if (name === prefix) return true;
      if (!name.startsWith(prefix + " ")) return false;
      const suffix = name.slice(prefix.length + 1);
      return /^(?:\d|s\d|season \d|batch\b|complete\b|remaster\b|bd\b|bdrip\b|bluray\b|blu ray\b|dvd\b|dvdrip\b|web\b|dual audio\b|multi\b|hevc\b|x26[45]\b|tv\b)/i.test(suffix);
    });
}
