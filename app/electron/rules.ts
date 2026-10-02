import type { Marker, Release, Progress, Media, TorrentFile } from "../src/shared";
// Only join split stages when the catalog confirms the preceding first stage.
export function sourceOffset(media: Pick<Media, "title" | "relations">): number {
  const stage = /\s*-?\s*(\d+)(?:st|nd|rd|th)(?:\s*(?:&|-)\s*\d+(?:st|nd|rd|th))?\s+STAGE$/i;
  const current = media.title.romaji.match(stage);
  if (!current || Number(current[1]) !== 2) return 0;
  const base = media.title.romaji.replace(stage, "").trim().toLowerCase();
  const previous = media.relations?.edges.filter(e => e.relationType === "PREQUEL" && e.node.type === "ANIME"
    && Number(e.node.title.romaji.match(stage)?.[1]) === 1
    && e.node.title.romaji.replace(stage, "").trim().toLowerCase() === base);
  return previous?.length === 1 ? previous[0].node.episodes ?? 0 : 0;
}
export function partOffset(media: Media): number {
  if (!/\bPart[.\s]*2$/i.test(media.title.romaji)) return 0;
  const base = normalizeSeason(media.title.romaji.replace(/\s+Part[.\s]*2$/i, "")).toLowerCase();
  const prequels = media.relations?.edges.filter(e => e.relationType === "PREQUEL" && e.node.type === "ANIME"
    && normalizeSeason(e.node.title.romaji).toLowerCase() === base) ?? [];
  return prequels.length === 1 ? prequels[0].node.episodes ?? 0 : 0;
}
// Final seasons can have a numbered catalog alias such as an acronym followed by a season.
export function catalogSeason(media: Media): number | null {
  const numbered = seasonNumber(media.title.english ?? "") ?? seasonNumber(media.title.romaji);
  if (numbered !== null) return numbered;
  if (!/\bfinal season\b/i.test(media.title.romaji)) return null;
  const initials = [media.title.english, media.title.romaji].filter(Boolean).map(title =>
    title!.replace(/[:\s]*(?:the\s+)?final season.*$/i, "").split(/\s+/).map(word => word[0]).join("").toLowerCase());
  const numbers = [...new Set((media.synonyms ?? []).flatMap(alias => {
    const match = /^([a-z]+)\s+(\d{1,2})$/i.exec(alias);
    return match && initials.includes(match[1].toLowerCase()) ? [Number(match[2])] : [];
  }))];
  return numbers.length === 1 ? numbers[0] : null;
}
function seriesTitles(media: Media): string[] {
  return [media.title.english, media.title.romaji].filter((title): title is string => !!title)
    .map(title => normalizeSeason(title).replace(/[:\s]*(?:(?:the\s+)?final season|S\d+|Part \d+).*$/i, "").trim());
}
export function sourceSearchTitle(title: string, media: Media): string {
  if (sourceOffset(media) || /\b1st\s+STAGE$/i.test(title))
    title = title.replace(/\s*-?\s*\d+(?:st|nd|rd|th)(?:\s*(?:&|-)\s*\d+(?:st|nd|rd|th))?\s+STAGE$/i, "");
  return title;
}
export function sourceAliases(media: Media): string[] {
  return [...new Set([media.title.romaji, media.title.english, ...(media.synonyms ?? []),
    ...(catalogSeason(media) ? seriesTitles(media).flatMap(title => [title + " Season " + catalogSeason(media), title + " S" + catalogSeason(media)]) : []),
    ...(partOffset(media) ? [media.title.romaji, media.title.english].filter(Boolean).map(name => name!.replace(/\s+Part[.\s]*2$/i, "")) : [])]
    .filter((name): name is string => !!name).map(name => {
      let alias = normalizeSeason(name).replace(/\s+Part\s+1(?:\s*&\s*2)?$/i, "");
      alias = sourceSearchTitle(alias, media);
      return alias.trim();
    }))];
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
  // A spaced dash separates the title (which can end in a season number) from episodes.
  const separator = normalized.indexOf(" - ");
  const episodeText = normalized.slice(separator < 0 ? 0 : separator + 3)
    .replace(/\b(?:season\s*|part[.\s]*|cour[.\s]*|p)(\d{1,2})\b/gi, "");
  const range = episodeText.match(
    /(?:\b|\s-\s)(\d{1,4})\s*[-~]\s*(\d{1,4})(?=\s|\]|\)|\.|$)/,
  );
  const seasonEpisode = normalized.match(
    /\bS(\d{1,2})[ ._-]*E(\d{1,4})(?:v\d)?\b/i,
  );
  const single = normalized.match(
    /(?:\s-\s|\bE(?:P)?\s*)(\d{1,4})(?:v\d)?(?=\s|\]|\)|\.|$)/i,
  );
  const bare = episodeText.match(
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
  const batch = /\+\s*(?:OVAs?|specials)\b/i.test(title) || !!range || /\bbatch\b|\bcomplete\b/i.test(title)
    || (start === null && (seasonNumber(normalized) !== null || /\b(?:final\s+season|part[.\s]*\d+)\b/i.test(normalized)));
  return {
    season: seasonEpisode ? Number(seasonEpisode[1]) : seasonNumber(normalized),
    resolution:
      title.match(/(?:\b|BD)((?:2160|1440|1080|720|480|360)p)\b/i)?.[1] ?? "Unspecified",
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
    const number = file.episode === null ? null : file.episode - (saved.release.sourceOffset ?? 0);
    const p =
      !/\bSTAGE\b/i.test(saved.title) && number &&
      number !== saved.episode &&
      !release.batch &&
      release.episode !== null && release.episode - (saved.release.sourceOffset ?? 0) === number &&
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

function normalizeSeason(title: string): string {
  return title.replace(/\bS(\d{1,2})E(\d{1,4})\b/gi, "S$1 E$2").replace(/\b(?:part|cour|p)[.\s-]*(\d{1,2})\b/gi, "Part $1").replace(/\b(?:(\d{1,2})(?:st|nd|rd|th)\s+season|season\s*(\d{1,2})|s(\d{1,2}))\b/gi,
    (_, ordinal, season, short) => `S${Number(ordinal ?? season ?? short)}`);
}
export function seasonNumber(title: string): number | null {
  const match = title.match(/\b(?:season\s*|s)(\d{1,2})\b/i)
    ?? title.match(/\b(\d{1,2})(?:st|nd|rd|th)\s+season\b/i);
  return match ? Number(match[1]) : null;
}
export function matchesSeason(title: string, media: Media): boolean {
  const expected = catalogSeason(media) ?? 1;
  const components = title.split(/[\\/]/);
  let collection = false;
  for (const component of components.reverse()) {
    const range = component.match(/\bS(\d{1,2})\s*-\s*S?(\d{1,2})\b/i);
    if (range) {
      if (components.length === 1) return expected >= Number(range[1]) && expected <= Number(range[2]);
      collection = true;
      continue;
    }
    const season = parseRelease(component, 1).season;
    if (season !== null) return season === expected || (media.synonyms ?? []).some(alias => seasonNumber(alias) === season);
  }
  return !collection;
}
export function matchingFile(files: TorrentFile[], release: Release, media: Media, episode: number): TorrentFile | undefined {
  if (!matchesMedia(release.title, media)) return;
  episode += release.sourceOffset ?? sourceOffset(media);
  const atEpisode = (number: number) => files.filter(f => {
    const parsed = parseRelease(f.path.split(/[\\/]/).at(-1) ?? "", episode);
    return parsed.episode === number && !parsed.batch && (matchesSeason(f.path, media)
      || (files.length === 1 && catalogSeason(media) === null && hasCatalogTitle(release.title, media)
        && parsed.season === parseRelease(release.title, episode).season))
      && !/\b(sample|preview|trailer|ncop|nced)\b/i.test(f.path);
  });
  const matches = atEpisode(episode);
  if (matches.length === 1) return matches[0];
  if (!matches.length && !release.sourceOffset && /\bPart[.\s]*2$/i.test(media.title.romaji)) {
    const offset = partOffset(media);
    const continued = offset ? atEpisode(episode + offset) : [];
    if (continued.length === 1) { release.sourceOffset = offset; return continued[0]; }
  }
  if (!matches.length && catalogSeason(media) && media.episodes) {
    const seasonFiles = files.filter(file => file.path.split(/[\\/]/).some(component =>
      !/\bS\d+\s*-\s*S?\d+/i.test(component) && parseRelease(component, 1).season === catalogSeason(media))
      && matchesSeason(file.path, media) && !/\b(?:sample|preview|trailer|ncop|nced|extras?|creditless|finale|final chapters|movies?|ovas?|oads?)\b/i.test(file.path.split(/[\\/]/).slice(1).join("/")))
      .map(file => ({ file, number: parseRelease(file.path.split(/[\\/]/).at(-1) ?? "", episode).episode }))
      .filter((item): item is { file: TorrentFile; number: number } => item.number !== null)
      .sort((a, b) => a.number - b.number);
    const count = media.episodes + partOffset(media);
    if (seasonFiles.length === count && seasonFiles[0].number > 1
      && seasonFiles.every((item, index) => item.number === seasonFiles[0].number + index)) {
      const local = episode - (release.sourceOffset ?? sourceOffset(media));
      const offset = seasonFiles[0].number - 1 + partOffset(media);
      const match = seasonFiles.find(item => item.number === local + offset);
      if (match) { release.sourceOffset = offset; return match.file; }
    }
  }
  if (files.length === 1 && release.confidence === "Episode match"
    && parseRelease(files[0].path, episode).episode === null
    && matchesSeason(files[0].path, media)) return files[0];
}

function hasCatalogTitle(title: string, media: Media): boolean {
  const normalize = (value: string) => value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const names = [media.title.english, media.title.romaji].filter(Boolean).map(name => normalize(name!));
  return [...title.matchAll(/\(([^()]*)\)/g)].some(match => names.includes(normalize(match[1].split(",")[0])));
}
export function matchesMedia(title: string, media: Media): boolean {
  if (catalogSeason(media) === null && hasCatalogTitle(title, media)) return true;
  if (!matchesSeason(title, media)) return false;
  const part = normalizeSeason(title).match(/\bPart (\d+)\b/i);
  if (partOffset(media) && part && Number(part[1]) !== 2) return false;
  const normalize = (value: string) => normalizeSeason(value.normalize("NFKC").replace(/['’]/g, "")).toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const name = normalize(title.split("|")[0].replace(/^(?:\s*\[[^\]]*\])+\s*/, ""));
  return [media.title.english, media.title.romaji, media.title.native, ...(media.synonyms ?? []), ...sourceAliases(media), ...(catalogSeason(media) && /\b(?:S\d|season\s*\d|complete|collection|batch)/i.test(title) ? seriesTitles(media) : [])]
    .filter((alias): alias is string => !!alias)
    .some(alias => {
      const prefix = normalize(alias);
      if (name === prefix) return true;
      if (!name.startsWith(prefix + " ")) return false;
      const suffix = name.slice(prefix.length + 1);
      return /^(?:\d|e\d|s\d|season \d|batch\b|complete\b|ovas?\b|specials\b|series\b|remaster\b|bd\b|bdrip\b|bluray\b|blu ray\b|dvd\b|dvdrip\b|web\b|dual audio\b|multi\b|hevc\b|x26[45]\b|tv\b)/i.test(suffix);
    });
}
