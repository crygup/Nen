export const seasons = ["WINTER", "SPRING", "SUMMER", "FALL"];
export const formats = [
  "TV",
  "TV_SHORT",
  "MOVIE",
  "SPECIAL",
  "OVA",
  "ONA",
  "MUSIC",
];
export const statuses = [
  "RELEASING",
  "FINISHED",
  "NOT_YET_RELEASED",
  "CANCELLED",
  "HIATUS",
];
export interface Filters {
  search: string;
  genre?: string;
  tag?: string;
  year?: number;
  season?: string;
  format?: string;
  status?: string;
}
export function parseSearch(value: string): Filters {
  const filters: Filters = { search: "" };
  filters.search = value
    .replace(
      /\b(genre|tag|year|season|format|status):(?:"([^"]+)"|([^\s]+))/gi,
      (token, key, quoted, bare) => {
        const v = quoted ?? bare;
        key = key.toLowerCase();
        if (key === "year") {
          if (!/^\d{4}$/.test(v) || +v < 1900 || +v > 2200) return token;
          filters.year = +v;
        } else if (key === "genre" || key === "tag")
          filters[key as "genre" | "tag"] = v;
        else {
          const normalized = v.toUpperCase().replaceAll("-", "_");
          const allowed =
            key === "season" ? seasons : key === "format" ? formats : statuses;
          if (!allowed.includes(normalized)) return token;
          (filters as unknown as Record<string, string>)[key] = normalized;
        }
        return "";
      },
    )
    .replace(/\s+/g, " ")
    .trim();
  return filters;
}
export function searchText(filters: Filters): string {
  return [
    filters.search,
    ...(
      ["genre", "tag", "year", "season", "format", "status"] as const
    ).flatMap((key) =>
      filters[key]
        ? [
            `${key}:${/\s/.test(String(filters[key])) ? JSON.stringify(filters[key]) : filters[key]}`,
          ]
        : [],
    ),
  ]
    .filter(Boolean)
    .join(" ");
}
