import type { ChangelogEntry } from "../src/shared";

const repository = "may-be-gay/Nen";
const pageSize = 20;
const sha = /^[a-f0-9]{40}$/;
const cache = new Map<number, { entries: ChangelogEntry[]; hasMore: boolean; fetchedAt: number }>();

export async function listChangelog(page: number, refresh = false) {
  if (!Number.isInteger(page) || page < 1 || page > 100) throw Error("Invalid changelog page.");
  const saved = cache.get(page);
  if (saved && !refresh && Date.now() - saved.fetchedAt < 10 * 60 * 1000)
    return { entries: saved.entries, hasMore: saved.hasMore, stale: false };

  try {
    const response = await fetch(`https://api.github.com/repos/${repository}/commits?sha=main&per_page=${pageSize}&page=${page}`, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "Nen", "X-GitHub-Api-Version": "2022-11-28" },
      signal: AbortSignal.timeout(15000),
    });
    if (response.status === 403 || response.status === 429) throw Error("GitHub is limiting requests. Try again later.");
    if (!response.ok) throw Error(`Could not load the changelog (HTTP ${response.status}).`);
    const data: unknown = await response.json();
    if (!Array.isArray(data)) throw Error("GitHub sent an invalid changelog.");
    const entries: ChangelogEntry[] = data.map((item: any) => {
      if (!sha.test(item?.sha) || typeof item?.commit?.message !== "string")
        throw Error("GitHub sent an invalid commit.");
      const [first, ...rest] = item.commit.message.replace(/\r\n/g, "\n").split("\n");
      const date = item.commit.committer?.date ?? item.commit.author?.date;
      return {
        sha: item.sha,
        title: (first.trim() || "Untitled commit").slice(0, 300),
        body: rest.join("\n").trim().slice(0, 3000),
        date: typeof date === "string" && !Number.isNaN(Date.parse(date)) ? date : "",
        merge: Array.isArray(item.parents) && item.parents.length > 1,
      };
    });
    const hasMore = /<[^>]+>;\s*rel="next"/.test(response.headers.get("link") ?? "");
    if (page === 1) for (const cachedPage of cache.keys()) if (cachedPage > 1) cache.delete(cachedPage);
    cache.set(page, { entries, hasMore, fetchedAt: Date.now() });
    return { entries, hasMore, stale: false };
  } catch (error) {
    if (saved) return { entries: saved.entries, hasMore: saved.hasMore, stale: true };
    throw error;
  }
}
