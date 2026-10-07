import { watchViewKey } from "../electron/watch-data";
import { showToast, dismissToast } from "./toast";
import { mountTogether } from "./together";
import { parseSearch, searchText, seasons, formats, statuses } from "./filters";
import "./style.css";
import {
  escapeHtml as esc,
  recentSeasons,
  labelForEpisode,
  episodePages,
  episodeAvailability,
  latestEpisode,
  rankReleases,
  audioLanguages,
  releaseAudio,
} from "./shared";
import { matchingFile, parseRelease } from "../electron/rules";
import { mountPlayer } from "./watch";
import type {
  Media,
  State,
  Release,
  Labels,
  Playback,
  SegmentType,
  EpisodePage,
  WatchStatus,
  SyncChange,
  ChangelogEntry,
  SavedTitle,
} from "./shared";
const api = window.nen;
document.addEventListener(
  "pointerdown",
  () => document.documentElement.classList.remove("keyboard-focus"),
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Tab")
      document.documentElement.classList.add("keyboard-focus");
  },
  true,
);
const root = document.querySelector<HTMLDivElement>("#app")!;
const title = (m: Media) => m.title.english || m.title.romaji;
const time = (n: number) =>
  `${Math.floor(n / 60)}:${String(Math.floor(n % 60)).padStart(2, "0")}`;
const format = (s: string) =>
  ({
    TV: "TV series",
    TV_SHORT: "Short series",
    MOVIE: "Film",
    SPECIAL: "Special",
    OVA: "OVA",
    ONA: "Web series",
    MUSIC: "Music",
  })[s] ?? s;
const names: Record<SegmentType, string> = {
  op: "Opening",
  ed: "Ending",
  "mixed-op": "Mixed opening",
  "mixed-ed": "Mixed ending",
  recap: "Recap",
};
let state: State;
let mode: "trending" | "season" | "search" | "romance" = "trending";
let query = "";
let page = 1;
let request = 0;
let current: Media | undefined;
let labelData: Labels | undefined;
let hideFiller = false;
let showAllEpisodes = false;
let descendingEpisodes = false;
let episodesCollapsed = false;
let episodeLoad = 0;
let episodeData: EpisodePage | undefined;
const episodeCache = new Map<number, { data: EpisodePage; expires: number }>();
const playerMode = new URLSearchParams(location.search).has("player");
let playback: Playback | undefined;
let route = "home";
let localLocation = { id: "", path: "" };
let seriesReturn = "home";
type BrowseVisit = {
  route: string;
  local?: { id: string; path: string };
  mediaId?: number;
  mode: "trending" | "season" | "search" | "romance";
  query: string;
  page: number;
};
let visits: BrowseVisit[] = [];
let forwardVisits: BrowseVisit[] = [];
let goingBack = false;
type BrowsePosition = {
  scroll: number;
  shelves: Record<string, number>;
  lists: Record<string, { page: number; all: boolean }>;
  episodes?: {
    hideFiller: boolean;
    showAllEpisodes: boolean;
    descendingEpisodes: boolean;
    episodesCollapsed: boolean;
  };
};
const positions: Record<string, BrowsePosition> = {};
try {
  Object.assign(
    positions,
    JSON.parse(sessionStorage.getItem("browse-positions") || "{}"),
  );
} catch {}
const positionKey = () =>
  route === "series"
    ? "series:" + current?.id
    : route === "discover"
      ? [route, mode, query, page].join(":")
      : route;
function position() {
  return (positions[positionKey()] ??= { scroll: 0, shelves: {}, lists: {} });
}
function rememberPosition() {
  position().scroll = scrollY;
  if (route === "series")
    position().episodes = {
      hideFiller,
      showAllEpisodes,
      descendingEpisodes,
      episodesCollapsed,
    };
  try {
    sessionStorage.setItem("browse-positions", JSON.stringify(positions));
  } catch {}
}
function restoreScroll() {
  requestAnimationFrame(() => window.scrollTo(0, position().scroll));
}
window.addEventListener("pagehide", () => {
  if (!playerMode) rememberPosition();
});
function setRoute(next: string, mediaId?: number) {
  if (!playerMode && document.querySelector("#main")) rememberPosition();
  if (api.browserHistory && !playerMode && !goingBack) {
    history.replaceState(
      {
        nenVisit: {
          route,
          mediaId: current?.id,
          mode,
          query,
          page,
          local: { ...localLocation },
        },
      },
      "",
    );
    if (route !== next || next === "series" || (next === "local" && !goingBack))
      history.pushState(
        { nenVisit: { route: next, mediaId, mode, query, page } },
        "",
      );
  }
  if (
    !goingBack &&
    (route !== next || next === "series" || (next === "local" && !goingBack))
  ) {
    visits.push({
      route,
      mediaId: current?.id,
      mode,
      query,
      page,
      local: { ...localLocation },
    });
    forwardVisits = [];
  }
  route = next;
}
async function browseBack(direction: "back" | "forward" = "back") {
  if (goingBack) return;
  if (api.browserHistory) {
    history.go(direction === "back" ? -1 : 1);
    return;
  }
  const previous = (direction === "back" ? visits : forwardVisits).pop();
  if (!previous) return;
  (direction === "back" ? forwardVisits : visits).push({
    route,
    mediaId: current?.id,
    mode,
    query,
    page,
    local: { ...localLocation },
  });
  await restoreVisit(previous);
}
async function restoreVisit(previous: BrowseVisit) {
  goingBack = true;
  mode = previous.mode;
  query = previous.query;
  page = previous.page;
  try {
    if (previous.route === "series" && previous.mediaId)
      await openMedia(previous.mediaId);
    else if (previous.route === "history") await watchlist();
    else if (previous.route === "watchlist") await watchlist();
    else if (previous.route === "together") showTogether();
    else if (previous.route === "local")
      await localLibrary(previous.local?.id, previous.local?.path);
    else if (previous.route === "discover") await discover(page);
    else await home();
    restoreScroll();
  } finally {
    goingBack = false;
  }
}
if (!playerMode)
  window.addEventListener("pagehide", () => {
    sessionStorage.setItem(
      "browse-return",
      JSON.stringify({
        mode,
        query,
        page,
        route,
        seriesReturn,
        visits,
        forwardVisits,
      }),
    );
  });
function error(e: unknown) {
  const raw = e instanceof Error ? e.message : String(e);
  const text = /No matching source was found|No streams found/.test(raw)
    ? "No streams found."
    : raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  showToast(
    text,
    document.querySelector<HTMLDialogElement>("dialog[open]") ?? document.body,
  );
}
async function run(fn: () => Promise<unknown>) {
  try {
    await fn();
  } catch (e) {
    error(e);
  }
}
function applyTheme() {
  document.documentElement.dataset.theme = state.settings.theme;
}
function card(m: Media) {
  return `<button class="poster" data-adult="${!!m.isAdult}" data-media="${m.id}" aria-label="Open ${esc(title(m))}"><div class="cover"><img src="${esc(m.coverImage.large)}" alt="" loading="lazy" decoding="async">${m.averageScore ? `<span class="score">${m.averageScore}%</span>` : ""}</div><h3>${esc(title(m))}</h3><p>${esc(format(m.format))} <span>·</span> ${m.seasonYear ?? "TBA"}</p></button>`;
}
function bindMedia(container: ParentNode = document) {
  const trailer = container.querySelector<HTMLElement>("#view-trailer");
  if (trailer && current)
    trailer.onclick = () => void run(() => api.openTrailer!(current!.id));
  bindShelfDice(container);
  void decorateFriends(container);
  container
    .querySelectorAll<HTMLElement>("[data-media]")
    .forEach(
      (el) =>
        (el.onclick = () => run(() => openMedia(Number(el.dataset.media)))),
    );
}
function movePageHeading() {
  const heading = document.querySelector("#main > .page-heading");
  document
    .querySelector("#page-title")!
    .replaceChildren(...(heading?.querySelectorAll("h1") ?? []));
  document
    .querySelector("#page-actions")!
    .replaceChildren(...(heading?.querySelectorAll("button") ?? []));
  heading?.remove();
}
let synopsisSize: ResizeObserver | undefined;
function activeNav(name: string) {
  leaveTogetherView?.();
  leaveTogetherView = undefined;
  synopsisSize?.disconnect();
  document.querySelector("#page-title")?.replaceChildren();
  document.querySelector("#page-actions")?.replaceChildren();
  document
    .querySelectorAll("[data-nav]")
    .forEach((b) =>
      b.classList.toggle("active", (b as HTMLElement).dataset.nav === name),
    );
}
const uiIcon = (name: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${({ external: '<path d="M15 3h6v6M21 3 10 14M11 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6"/>', message: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>', heart: '<path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/>', subtitles: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6 11h5M14 11h4M6 15h3M12 15h6"/>', streaming: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4Z"/>', account: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>', together: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>', left: '<path d="m14 5-7 7 7 7"/>', right: '<path d="m10 5 7 7-7 7"/>', refresh: '<path d="M20 7v5h-5M4 17v-5h5M19 10a7 7 0 0 0-12-5L4 8m1 6a7 7 0 0 0 12 5l3-3"/>', home: '<path d="m3 11 9-8 9 8M5 9v12h5v-7h4v7h5V9"/>', lists: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>', help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4"/><path d="M12 16v1"/>', history: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>', browse: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>', folder: '<path d="M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z"/>' } as Record<string, string>)[name]}</svg>`;
let filterOptions: Promise<{ genres: string[]; tags: string[] }> | undefined;
const getOptions = () =>
  (filterOptions ??= api.catalogOptions().catch((e) => {
    filterOptions = undefined;
    throw e;
  }));
let leaveTogetherView: (() => void) | undefined;
function showTogether() {
  setRoute("together");
  activeNav("together");
  document.querySelector("#page-title")!.innerHTML = "<h1>Watch together</h1>";
  const main = document.querySelector<HTMLElement>("#main")!;
  main.innerHTML = '<div id="together-lobby"></div>';
  leaveTogetherView?.();
  leaveTogetherView = mountTogether(
    main.querySelector<HTMLElement>("#together-lobby")!,
  );
}
function shell() {
  root.innerHTML = `<aside class="sidebar"><nav aria-label="Main"><button data-nav="home">${uiIcon("home")} Home</button><button data-nav="watchlist">${uiIcon("lists")} Lists</button><button data-nav="together">${uiIcon("together")} Watch together</button><button data-nav="browse">${uiIcon("browse")} Browse</button>${api.local ? `<button data-nav="local" hidden>${uiIcon("folder")} Local files</button>` : ""}</nav><div class="sidebar-bottom"><span class="private-indicator" ${state.settings.privateSession ? "" : "hidden"} title="Private session" aria-label="Private session">${uiIcon("account")} Private session</span><button data-nav="help">${uiIcon("help")} Help</button><button data-nav="settings">${uiIcon("settings")} Settings</button></div></aside><div class="workspace"><header class="topbar"><div id="page-title"></div><form id="search" role="search"><label class="sr-only" for="search-input">Search anime</label>${uiIcon("search")}<input id="search-input" type="text" role="combobox" aria-autocomplete="list" aria-controls="search-suggestions" aria-expanded="false" placeholder="Search for anime" autocomplete="off" maxlength="200"><button type="button" id="clear-search" class="square-button" aria-label="Clear search" hidden>${uiIcon("close")}</button><div id="search-suggestions" role="listbox" aria-label="Anime suggestions" hidden></div></form><div id="page-actions"></div></header><div id="message" role="alert" hidden></div><main id="main" tabindex="-1"></main></div><dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;
  const input = document.querySelector<HTMLInputElement>("#search-input")!;
  const results = document.querySelector<HTMLElement>("#search-suggestions")!;
  const clear = document.querySelector<HTMLButtonElement>("#clear-search")!;
  let timer: ReturnType<typeof setTimeout>;
  let serial = 0;
  let selected = -1;
  let suggestions: Media[] = [];
  let recentSearches: string[] = [];
  try {
    const saved = JSON.parse(localStorage.getItem("recent-searches") ?? "[]");
    if (Array.isArray(saved))
      recentSearches = saved.filter((v) => typeof v === "string").slice(0, 5);
  } catch {}
  const remember = (value: string) => {
    if (!value || state.settings.privateSession) return;
    recentSearches = [
      value,
      ...recentSearches.filter((s) => s !== value),
    ].slice(0, 5);
    localStorage.setItem("recent-searches", JSON.stringify(recentSearches));
  };
  let recentMode = false;
  const close = () => {
    serial++;
    clearTimeout(timer);
    results.hidden = true;
    input.setAttribute("aria-expanded", "false");
    input.removeAttribute("aria-activedescendant");
    selected = -1;
  };
  const choose = (index: number) => {
    if (recentMode) {
      input.value = recentSearches[index];
      query = input.value;
      remember(query);
      clear.hidden = false;
      close();
      mode = "search";
      void discover();
      return;
    }
    const m = suggestions[index];
    if (!m) return;
    close();
    input.value = title(m);
    clear.hidden = false;
    query = title(m);
    remember(query);
    mode = "search";
    void openMedia(m.id);
  };
  document.querySelector<HTMLFormElement>("#search")!.onsubmit = (e) => {
    e.preventDefault();
    close();
    query = input.value.trim();
    remember(query);
    mode = query ? "search" : "trending";
    void discover();
  };
  clear.onclick = () => {
    input.value = "";
    clear.hidden = true;
    close();
    input.focus();
    suggest(true);
  };
  const suggest = (onFocus = false) => {
    close();
    clear.hidden = !input.value;
    const value = input.value.trim(),
      token = serial;
    if (!onFocus && value.length < 2 && value.length > 0) return;
    recentMode = (onFocus || !value) && recentSearches.length > 0;
    timer = setTimeout(async () => {
      try {
        const result = recentMode
          ? { media: [] }
          : await api.catalog(
              !onFocus && value ? "search" : "trending",
              onFocus ? "" : value,
              1,
              !onFocus && value ? 6 : 5,
            );
        if (token !== serial) return;
        suggestions = result.media;
        results.innerHTML = recentMode
          ? recentSearches
              .map(
                (text, i) =>
                  `<button type="button" class="suggestion" role="option" aria-selected="false" id="suggestion-${i}" data-suggestion="${i}">${uiIcon("history")}<span>${esc(text)}</span></button>`,
              )
              .join("")
          : suggestions
              .map(
                (m, i) =>
                  `<button type="button" class="suggestion" role="option" aria-selected="false" id="suggestion-${i}" data-suggestion="${i}"><img src="${esc(m.coverImage.large)}" alt=""><span><strong>${esc(title(m))}</strong><small>${esc(format(m.format))} · ${m.seasonYear ?? "TBA"}${m.genres.length ? " · " + esc(m.genres.slice(0, 2).join(", ")) : ""}</small></span></button>`,
              )
              .join("");
        results.hidden = !(recentMode
          ? recentSearches.length
          : suggestions.length);
        input.setAttribute("aria-expanded", String(!results.hidden));
        results.querySelectorAll<HTMLButtonElement>("button").forEach((b) => {
          b.onmousedown = (e) => e.preventDefault();
          b.onclick = () => choose(Number(b.dataset.suggestion));
        });
      } catch {
        close();
      }
    }, 300);
  };
  input.oninput = () => suggest();
  input.onfocus = () => suggest(true);
  input.onkeydown = (e) => {
    if (e.key === "Escape") {
      close();
      return;
    }
    if (results.hidden) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      selected =
        (selected +
          (e.key === "ArrowDown" ? 1 : -1) +
          results.children.length) %
        results.children.length;
      results
        .querySelectorAll("[role=option]")
        .forEach((el, i) =>
          el.setAttribute("aria-selected", String(i === selected)),
        );
      input.setAttribute("aria-activedescendant", `suggestion-${selected}`);
      results.children[selected]?.scrollIntoView({ block: "nearest" });
    } else if (e.key === "Enter" && selected >= 0) {
      e.preventDefault();
      choose(selected);
    }
  };
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target as Element).closest("#search")) close();
  });
  document.querySelectorAll<HTMLElement>("[data-nav]").forEach(
    (b) =>
      (b.onclick = () => {
        close();
        if (b.dataset.nav === "settings") settings();
        else if (b.dataset.nav === "help") help();
        else if (b.dataset.nav === "history") void watchlist();
        else if (b.dataset.nav === "watchlist") void watchlist();
        else if (b.dataset.nav === "together") showTogether();
        else if (b.dataset.nav === "local") void run(() => localLibrary());
        else if (b.dataset.nav === "home") void home();
        else {
          mode = "trending";
          query = "";
          input.value = "";
          clear.hidden = true;
          void discover();
        }
      }),
  );
  document.addEventListener("keydown", (e) => {
    if (
      e.key === "/" &&
      !(e.target instanceof HTMLInputElement) &&
      !(e.target instanceof HTMLTextAreaElement)
    ) {
      e.preventDefault();
      input.focus();
    }
  });
}
async function browseFilters(token: number) {
  const f = parseSearch(mode === "search" || mode === "romance" ? query : "");
  let options = { genres: [] as string[], tags: [] as string[] };
  try {
    options = await getOptions();
  } catch {}
  if (token !== request || route !== "discover") return;
  const label = (v: string) =>
    v
      .toLowerCase()
      .replaceAll("_", " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
  const select = (
    key: string,
    name: string,
    values: string[],
    value: unknown,
  ) =>
    `<label>${name}<select data-filter="${key}" aria-label="${name}"><option value="">Any</option>${values.map((v) => `<option value="${esc(v)}" ${String(value ?? "").toLowerCase() === v.toLowerCase() ? "selected" : ""}>${esc(key === "format" ? format(v) : key === "season" || key === "status" ? label(v) : v)}</option>`).join("")}</select></label>`;
  const el = document.querySelector("#browse-filters")!;
  el.innerHTML =
    select("genre", "Genre", options.genres, f.genre) +
    select("tag", "Tag", options.tags, f.tag) +
    select(
      "year",
      "Year",
      Array.from({ length: new Date().getFullYear() - 1939 }, (_, i) =>
        String(new Date().getFullYear() + 1 - i),
      ),
      f.year,
    ) +
    select("season", "Season", seasons, f.season) +
    select("format", "Format", formats, f.format) +
    select("status", "Airing status", statuses, f.status);
  el.querySelectorAll<HTMLSelectElement>("select").forEach(
    (select) =>
      (select.onchange = () => {
        const next = { search: f.search } as ReturnType<typeof parseSearch>;
        el.querySelectorAll<HTMLSelectElement>("select").forEach((s) => {
          if (s.value)
            (next as unknown as Record<string, string | number>)[
              s.dataset.filter!
            ] = s.dataset.filter === "year" ? Number(s.value) : s.value;
        });
        query = searchText(next);
        mode = query ? "search" : "trending";
        document.querySelector<HTMLInputElement>("#search-input")!.value =
          query;
        document.querySelector<HTMLElement>("#clear-search")!.hidden = !query;
        void discover();
      }),
  );
}
function watchEditButton(id: number, name: string) {
  return `<button class="list-edit square-button" data-watch-edit="${id}" aria-label="Edit ${esc(name)}" title="Edit"><svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="m16 3 5 5M3 21l5-1L21 7a2 2 0 0 0-5-5L3 15z"/></svg></button>`;
}
function continueCards() {
  const local = recentSeasons(state.progress, state.settings.showAdult).filter(
    ([, p]) =>
      state.watch[String(p.mediaId)]?.format !== "MUSIC" &&
      p.updated > (state.settings.hiddenContinue?.[p.mediaId] ?? 0),
  );
  const ids = new Set(local.map(([, p]) => p.mediaId));
  const imported = Object.values(state.watch)
    .filter(
      (e) =>
        e.format !== "MUSIC" &&
        !state.settings.hiddenContinue?.[e.mediaId] &&
        !ids.has(e.mediaId) &&
        (e.status === "CURRENT" || e.status === "REPEATING") &&
        (state.settings.showAdult || !e.isAdult),
    )
    .sort((a, b) => b.updated - a.updated);
  return [
    ...local.map(
      ([key, p]) =>
        `<article class="list-card"><div class="recent-card" data-adult="${!!p.isAdult}" data-resume="${key}"><button class="recent-play" aria-label="Play ${esc(p.title)}"><div class="cover"><img src="${esc(p.cover)}" alt="" loading="lazy"></div></button><button class="recent-title" data-open-series="${p.mediaId}">${esc(p.title)}</button><small>${esc(p.episodeTitle ?? `Episode ${p.episode}`)} &middot; ${time(p.position)} / ${time(p.duration)}</small></div>${watchEditButton(p.mediaId, p.title)}</article>`,
    ),
    ...imported.map((e) => {
      const episode = Math.min(
        e.count + 1,
        e.totalEpisodes ?? Number.MAX_SAFE_INTEGER,
      );
      return `<article class="list-card"><div class="recent-card" data-continue="${e.mediaId}" data-episode="${episode}"><button class="recent-play" aria-label="Play ${esc(e.title)}"><div class="cover"><img src="${esc(e.cover)}" alt="" loading="lazy"></div></button><button class="recent-title" data-open-series="${e.mediaId}">${esc(e.title)}</button><small>Episode ${episode}${e.totalEpisodes ? ` / ${e.totalEpisodes}` : ""}</small></div>${watchEditButton(e.mediaId, e.title)}</article>`;
    }),
  ];
}
function bindContinue(root: ParentNode) {
  bindShelfDice(root);
  void decorateFriends(root);
  root.querySelectorAll<HTMLButtonElement>("[data-open-series]").forEach(
    (button) =>
      (button.onclick = (event) => {
        event.stopPropagation();
        void openMedia(Number(button.dataset.openSeries));
      }),
  );
  root
    .querySelectorAll<HTMLElement>("[data-resume]")
    .forEach(
      (button) =>
        (button.onclick = () =>
          void run(() => resumeFromHistory(button.dataset.resume!))),
    );
  root.querySelectorAll<HTMLElement>("[data-continue]").forEach(
    (button) =>
      (button.onclick = () =>
        void run(async () => {
          const d = dialog(
            '<h2 id="dialog-title">Continue watching</h2><p class="loading" role="status">Loading episode details…</p>',
          );
          const loading = d.querySelector<HTMLElement>(".loading")!;
          let media: Media;
          try {
            media = await api.media(Number(button.dataset.continue));
          } catch (e) {
            loading.hidden = true;
            if (d.open && loading.isConnected) throw e;
            return;
          }
          if (!d.open || !loading.isConnected) return;
          d.close();
          await startEpisode(media, Number(button.dataset.episode));
        })),
  );
  root
    .querySelectorAll<HTMLElement>("[data-watch-edit]")
    .forEach(
      (button) =>
        (button.onclick = () => editWatch(Number(button.dataset.watchEdit))),
    );
}
async function home() {
  setRoute("home");
  current = undefined;
  activeNav("home");
  const token = ++request;
  state = await api.state();
  if (token !== request) return;
  const recent = continueCards();
  const shelves = homeGenres.filter(([name]) => !shelfHidden("home", name));
  document.querySelector("#main")!.innerHTML =
    `<div class="page-heading"><h1>Home</h1>${shelfEditButton}</div><section class="home-section" data-shelf="Continue watching"><div class="section-heading"><h2>Continue watching</h2><div class="actions"><button id="more-history" class="quiet">View more ${uiIcon("right")}</button><button class="square-button" data-list-step="-1" aria-label="Previous Continue watching titles">${uiIcon("left")}</button><button class="square-button" data-list-step="1" aria-label="Next Continue watching titles">${uiIcon("right")}</button></div></div>${recent.length ? `<div class="home-grid">${recent.join("")}</div>` : '<p class="muted">Your recent watches will appear here.</p>'}</section>${shelves.map(([name], i) => `<section class="home-section" id="shelf-${i}" data-shelf="${name}"><div class="section-heading"><h2>${name}</h2><div class="actions"><button class="quiet shelf-more">View more ${uiIcon("right")}</button><button class="square-button shelf-back" aria-label="Previous ${name} titles" disabled>${uiIcon("left")}</button><button class="square-button shelf-next" aria-label="Next ${name} titles">${uiIcon("right")}</button></div></div><div class="home-grid shelf-items" aria-live="polite"><p class="loading">Loading…</p></div></section>`).join("")}`;
  movePageHeading();
  document.querySelector<HTMLElement>("#more-history")!.onclick = () =>
    void watchlist("CURRENT");
  bindListPage(document.querySelector<HTMLElement>("#main > .home-section")!);
  bindContinue(document.querySelector("#main")!);
  bindShelfEditor("home");
  applyShelfLayout("home");
  if (!shelfHidden("home", "New episodes")) void newEpisodes(token);
  if (!shelfHidden("home", "Following")) void followingShelf(token);
  await Promise.all(
    shelves.map(async ([name, filter], i) => {
      const el = document.querySelector<HTMLElement>(`#shelf-${i}`)!;
      let shelfPage = position().shelves[name] ?? 1;
      let loading = false;
      let refreshPending = false;
      const load = async () => {
        if (loading) {
          refreshPending = true;
          return;
        }
        loading = true;
        const prev = el.querySelector<HTMLButtonElement>(".shelf-back")!,
          next = el.querySelector<HTMLButtonElement>(".shelf-next")!;
        prev.disabled = next.disabled = true;
        try {
          const data = await api.catalog(
            name === "Romance" ? "romance" : filter ? "search" : "trending",
            filter,
            Math.floor((shelfPage - 1) / 5) + 1,
            45,
          );
          if (!el.isConnected) return;
          const grid = el.querySelector<HTMLElement>(".shelf-items")!;
          grid.innerHTML = data.media
            .slice(((shelfPage - 1) % 5) * 9, (((shelfPage - 1) % 5) + 1) * 9)
            .filter((m) => state.settings.showAdult || !m.isAdult)
            .map(card)
            .join("");
          el.hidden = !grid.querySelector(".poster");
          bindMedia(grid);
          prev.disabled = shelfPage === 1;
          next.disabled =
            !data.hasNextPage &&
            (((shelfPage - 1) % 5) + 1) * 9 >= data.media.length;
        } catch {
          const grid = el.querySelector(".shelf-items")!;
          el.hidden = !grid.querySelector(".poster");
        } finally {
          loading = false;
          if (refreshPending && el.isConnected) {
            refreshPending = false;
            void load();
          }
        }
      };
      el.querySelector<HTMLElement>(".shelf-more")!.onclick = () => {
        query = filter;
        mode = name === "Romance" ? "romance" : filter ? "search" : "trending";
        document.querySelector<HTMLInputElement>("#search-input")!.value =
          filter;
        document.querySelector<HTMLElement>("#clear-search")!.hidden = !filter;
        void discover();
      };
      el.querySelector<HTMLElement>(".shelf-back")!.onclick = () => {
        shelfPage--;
        position().shelves[name] = shelfPage;
        void load();
      };
      el.querySelector<HTMLElement>(".shelf-next")!.onclick = () => {
        shelfPage++;
        position().shelves[name] = shelfPage;
        void load();
      };
      el.querySelector(".shelf-items")!.addEventListener(
        "catalog-refresh",
        () => {
          void load();
        },
      );
      await load();
    }),
  );
  applyShelfLayout("home");
  restoreScroll();
}

async function discover(targetPage = 1) {
  setRoute("discover");
  current = undefined;
  page = targetPage;
  activeNav("browse");
  const token = ++request;
  document.querySelector("#message")!.setAttribute("hidden", "");
  const main = document.querySelector<HTMLElement>("#main")!;
  main.innerHTML = `<div class="page-heading"><div><h1>${mode === "search" && parseSearch(query).search ? "Search results" : "Browse"}</h1></div><button id="refresh" class="quiet square-button" aria-label="Refresh" title="Refresh">${uiIcon("refresh")}</button></div><div id="browse-filters" class="browse-filters"></div><div class="tabs" aria-label="Browse category"><button data-mode="trending" class="${mode === "trending" ? "selected" : ""}">Trending</button><button data-mode="season" class="${mode === "season" ? "selected" : ""}">This season</button>${mode === "search" ? '<span class="selected">Search</span>' : ""}</div><p id="catalog-note" class="muted" ${mode !== "search" ? "hidden" : ""}>${mode === "search" ? `Results for ${esc(query)}` : "Loading…"}</p><div class="grid" id="catalog" aria-busy="true"></div><nav id="catalog-pages" class="catalog-pages" aria-label="Catalog pages"></nav>`;
  movePageHeading();
  void browseFilters(token);
  document.querySelectorAll<HTMLElement>("[data-mode]").forEach(
    (b) =>
      (b.onclick = () => {
        mode = b.dataset.mode as typeof mode;
        void discover();
      }),
  );
  document.querySelector<HTMLElement>("#refresh")!.onclick = () =>
    void discover(page);
  try {
    const result = await api.catalog(mode, query, page);
    if (token !== request) return;
    const grid = document.querySelector<HTMLElement>("#catalog")!;
    grid.innerHTML =
      result.media.map(card).join("") ||
      '<div class="empty"><h2>No titles found</h2><p>Try another title.</p></div>';
    grid.setAttribute("aria-busy", "false");
    bindMedia(grid);
    document.querySelector("#catalog-note")!.textContent =
      mode === "search" ? `Results for ${query}` : "";
    const last = Math.min(
      result.lastPage ?? (result.hasNextPage ? page + 1 : page),
      100,
    );
    const numbers = [
      ...new Set([
        1,
        ...Array.from({ length: 5 }, (_, i) => page - 2 + i).filter(
          (n) => n > 1 && n <= last,
        ),
        last,
      ]),
    ].sort((a, b) => a - b);
    document.querySelector("#catalog-pages")!.innerHTML =
      `<button data-page="${page - 1}" ${page === 1 ? "disabled" : ""}>Previous</button>${numbers.map((n, i) => `${i && n > numbers[i - 1] + 1 ? "<span>…</span>" : ""}<button data-page="${n}" ${n === page ? 'aria-current="page"' : ""}>${n}</button>`).join("")}<button data-page="${page + 1}" ${!result.hasNextPage || page >= last ? "disabled" : ""}>Next</button>`;
    document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach(
      (b) =>
        (b.onclick = () => {
          void discover(Number(b.dataset.page));
          window.scrollTo(0, 0);
        }),
    );
  } catch (e) {
    if (token !== request) return;
    document.querySelector<HTMLElement>("#catalog-note")!.hidden = false;
    document.querySelector("#catalog-note")!.textContent =
      "The catalog could not load. Use Refresh to try again.";
    error(e);
  }
}
async function openMedia(id: number) {
  if (route !== "series") seriesReturn = route;
  const token = ++request;
  setRoute("series", id);
  activeNav("");
  document.querySelector("#main")!.innerHTML =
    '<p class="loading">Loading series…</p>';
  try {
    const [m, freshState] = await Promise.all([api.media(id), api.state()]);
    if (token !== request) return;
    state = freshState;
    current = m;
    labelData = undefined;
    const cachedEpisodes = episodeCache.get(id) ?? readEpisodeCache(id);
    episodeData = cachedEpisodes ? cachedEpisodes.data : undefined;
    if (!episodeData && m.streamingEpisodes?.length) {
      const items: import("./shared").EpisodeInfo[] = [];
      for (const item of m.streamingEpisodes) {
        const match = item.title.match(/(?:Episode\s*)?(\d+)\s*[-:–]\s*(.+)/i);
        if (match)
          items.push({
            number: Number(match[1]),
            title: match[2],
            thumbnail: item.thumbnail,
            ...episodeAvailability(m, Number(match[1])),
          });
      }
      episodeData = {
        items,
        total: m.episodes ?? latestEpisode(m),
        latest: latestEpisode(m),
      };
    }
    if (episodeData && !cachedEpisodes) {
      episodeCache.set(id, { data: episodeData, expires: 0 });
      writeEpisodeCache(id);
    }
    hideFiller = false;
    const latest = Object.values(state.progress)
      .filter((p) => p.mediaId === id && (p.position > 0 || p.watched))
      .sort((a, b) => b.updated - a.updated)[0];
    showAllEpisodes = !!latest && latest.episode > 50;
    descendingEpisodes = false;
    episodesCollapsed = false;
    const savedPosition = position().episodes;
    if (savedPosition)
      ({ hideFiller, showAllEpisodes, descendingEpisodes, episodesCollapsed } =
        savedPosition);
    renderSeries();
    if (savedPosition) restoreScroll();
    if (latest && !savedPosition)
      requestAnimationFrame(() => {
        if (token !== request) return;
        const row = document.querySelector<HTMLElement>(
          `[data-episode="${latest.episode}"]`,
        );
        const bounds = row?.getBoundingClientRect();
        if (bounds && (bounds.bottom > innerHeight || bounds.top < 0))
          row!.scrollIntoView({ block: "center" });
      });
    void api
      .labels(m.id)
      .then((labels) => {
        if (token === request) {
          labelData = labels;
          renderEpisodes();
        }
      })
      .catch(() => {});
    void loadEpisodes(token, savedPosition ? undefined : latest?.episode).catch(
      error,
    );
  } catch (e) {
    if (token === request) {
      document.querySelector("#main")!.innerHTML =
        '<div class="empty"><h2>Series unavailable</h2><button id="back">Back to browse</button></div>';
      document.querySelector<HTMLElement>("#back")!.onclick = () =>
        void browseBack();
      error(e);
    }
  }
}
async function loadEpisodes(token = request, preferred?: number) {
  if (!current) return;
  const load = ++episodeLoad;
  const media = current;
  const mediaId = media.id;
  const count =
    media.episodes ??
    Math.max(latestEpisode(media), media.nextAiringEpisode?.episode ?? 0);
  if (preferred === undefined) {
    const visible = [
      ...document.querySelectorAll<HTMLElement>("[data-episode]"),
    ].find((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > 0 && bounds.top < innerHeight;
    });
    preferred = Number(visible?.dataset.episode) || undefined;
  }
  const pages = episodePages(
    count,
    showAllEpisodes,
    descendingEpisodes,
    preferred,
  );
  const active = () => token === request && load === episodeLoad;
  let changed = false;
  async function loadPage(page: number) {
    if (!active()) return;
    try {
      const cached = episodeCache.get(mediaId);
      const required = Array.from(
        { length: Math.min(50, count - (page - 1) * 50) },
        (_, i) => (page - 1) * 50 + i + 1,
      );
      const known = new Map(
        episodeData?.items.map((item) => [item.number, item]),
      );
      const complete = required.every((n) => {
        const item = known.get(n);
        return (
          item?.thumbnail &&
          item.title &&
          !/^(episode\s*\d+|tba|tbd|untitled)$/i.test(item.title)
        );
      });
      if (
        complete ||
        (cached &&
          cached.expires > Date.now() &&
          cached.data.latest >= latestEpisode(media) &&
          required.every((n) => known.has(n)))
      )
        return;
      const result = await api.episodes(mediaId, page);
      if (!active()) return;
      const items = new Map(episodeData?.items.map((e) => [e.number, e]));
      result.items.forEach((e) => {
        const previous = items.get(e.number);
        items.set(e.number, {
          ...e,
          title:
            previous?.title &&
            /^(episode\s*\d+|tba|tbd|untitled)$/i.test(e.title)
              ? previous.title
              : e.title,
          thumbnail: e.thumbnail || previous?.thumbnail,
        });
      });
      episodeData = { ...result, items: [...items.values()] };
      episodeCache.delete(mediaId);
      episodeCache.set(mediaId, {
        data: episodeData,
        expires: Date.now() + 86400000,
      });
      if (episodeCache.size > 30)
        episodeCache.delete(episodeCache.keys().next().value!);
      changed = true;
      renderEpisodes(result.items.map((item) => item.number));
    } catch {}
  }
  try {
    // Resolve the page in view first, then fetch nearby pages with two workers.
    const first = pages.shift();
    if (first !== undefined) await loadPage(first);
    const worker = async () => {
      while (active() && pages.length) await loadPage(pages.shift()!);
    };
    await Promise.all([worker(), worker()]);
  } finally {
    if (changed) writeEpisodeCache(mediaId);
  }
}

function renderSeries() {
  const m = current!;
  const main = document.querySelector("#main")!;
  main.innerHTML = `<button id="back" class="back">${uiIcon("left")} Back</button><article class="series"><div class="series-poster"><img class="series-cover" src="${esc(m.coverImage.large)}" alt="${esc(title(m))}"><div class="series-list-actions"><button id="watchlist-toggle" class="square-button"></button><button id="favorite-toggle" class="square-button" aria-label="Add to favorites"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg></button>${m.trailer && api.openTrailer ? `<button id="view-trailer" class="square-button" aria-label="View trailer" title="View trailer">${uiIcon("streaming")}</button>` : ""}</div></div><div><p class="eyebrow">${esc(format(m.format))} <span> / </span> ${m.seasonYear ?? "TBA"}</p><h1>${esc(title(m))}</h1><div class="facts"><span>${m.episodes != null ? `${m.episodes} episodes` : latestEpisode(m) > 0 ? `${latestEpisode(m)} episodes aired` : "Episode count not announced"}</span><span>${esc(m.status.replaceAll("_", " ").toLowerCase())}</span>${m.averageScore ? `<span>${m.averageScore}% score</span>` : ""}</div><p id="series-synopsis" class="synopsis synopsis-collapsed">${esc(m.description?.replace(/<[^>]*>/g, "") ?? "No synopsis available.")}</p><button id="synopsis-toggle" class="quiet" aria-expanded="false" aria-controls="series-synopsis" hidden>Show more</button><p class="genres">${m.genres.map(esc).join(" / ")}</p></div></article><section id="episodes"></section>${[
    true,
    false,
  ]
    .map((related) => {
      const edges = (m.relations?.edges ?? [])
        .filter(
          (e) =>
            e.node.type === "ANIME" &&
            e.node.format !== "MUSIC" &&
            ["PREQUEL", "SEQUEL"].includes(e.relationType) === related,
        )
        .sort(
          (a, b) =>
            Number(a.relationType === "SEQUEL") -
            Number(b.relationType === "SEQUEL"),
        );
      return edges.length
        ? `<section class="related"><h2>${related ? "Related Titles" : "Other titles"}</h2><div class="related-list">${edges.map((e) => `<button data-media="${e.node.id}">${e.node.coverImage?.large ? `<img src="${esc(e.node.coverImage.large)}" alt="" loading="lazy">` : ""}<div><small>${esc(e.relationType.replaceAll("_", " "))} · ${esc(format(e.node.format))}</small><span>${esc(e.node.title.english || e.node.title.romaji)}</span></div></button>`).join("")}</div></section>`
        : "";
    })
    .join("")}`;
  document.querySelector<HTMLElement>("#back")!.onclick = () =>
    void browseBack();
  bindMedia(main);
  updateSeriesActions();
  const listButton =
    main.querySelector<HTMLButtonElement>("#watchlist-toggle")!;
  const favoriteButton =
    main.querySelector<HTMLButtonElement>("#favorite-toggle")!;
  listButton.onclick = () => saveTo(m);
  favoriteButton.onclick = () =>
    void run(async () => {
      favoriteButton.disabled = true;
      try {
        state = await api.favoriteSet(m.id, !state.favorites[String(m.id)]);
        if (current?.id === m.id) updateSeriesActions();
      } finally {
        favoriteButton.disabled = false;
      }
    });
  synopsisSize?.disconnect();
  const synopsis = main.querySelector<HTMLElement>(".synopsis")!;
  const expand = main.querySelector<HTMLButtonElement>("#synopsis-toggle")!;
  expand.onclick = () => {
    const expanded = expand.getAttribute("aria-expanded") !== "true";
    expand.setAttribute("aria-expanded", String(expanded));
    expand.textContent = expanded ? "Show less" : "Show more";
    synopsis.classList.toggle("synopsis-collapsed", !expanded);
  };
  synopsisSize = new ResizeObserver(() => {
    expand.hidden =
      expand.getAttribute("aria-expanded") !== "true" &&
      synopsis.scrollHeight <= synopsis.clientHeight + 1;
  });
  synopsisSize.observe(synopsis);
  renderEpisodes();
}
function renderEpisodes(updated?: number[]) {
  if (!current || route !== "series") return;
  const m = current;
  const offset = state.mappings[String(m.id)];
  const count =
    m.episodes ?? Math.max(latestEpisode(m), m.nextAiringEpisode?.episode ?? 0);
  const el = document.querySelector("#episodes")!;
  if (!count) {
    el.innerHTML = "<p>No episodes here yet</p>";
    return;
  }
  const known = new Map(episodeData?.items.map((item) => [item.number, item]));
  const visibleCount = showAllEpisodes ? count : Math.min(50, count);
  const numbers = updated
    ? updated.filter((n) =>
        descendingEpisodes
          ? n > count - visibleCount && n <= count
          : n >= 1 && n <= visibleCount,
      )
    : Array.from({ length: visibleCount }, (_, i) =>
        descendingEpisodes ? count - i : i + 1,
      );
  const items = numbers
    .map((n) => {
      const meta = known.get(n);
      return {
        n,
        title: meta?.title ?? `Episode ${n}`,
        thumbnail: meta?.thumbnail,
        ...episodeAvailability(m, n),
        ...labelForEpisode(labelData, n, offset, m.source === "ORIGINAL"),
      };
    })
    .filter((e) => !hideFiller || e.status !== "filler");
  const rows = items
    .map((e) => {
      const watched =
        state.watch[String(m.id)]?.runs.at(-1)?.episodes[String(e.n)] ??
        state.progress[`${m.id}:${e.n}`];
      const future = e.released === false;
      const finished =
        e.n <= (state.watch[String(m.id)]?.count ?? 0) ||
        watched?.watched === true;
      const date = e.airingAt
        ? new Date(e.airingAt * 1000).toLocaleDateString(undefined, {
            month: "short",
            day: "numeric",
          })
        : "";
      const badge = future
        ? `Upcoming${date ? ` · ${date}` : ""}`
        : e.status === "filler"
          ? "Filler"
          : e.status === "mixed"
            ? "Mixed"
            : "";
      return `<button class="episode${!state.settings.compactView ? " episode-with-preview" : ""}" data-episode="${e.n}" aria-label="${esc(state.settings.showEpisodeName === false ? `Episode ${e.n}` : `Episode ${e.n}: ${e.title}`)}" ${future ? "disabled" : ""}>${!state.settings.compactView ? `<span class="episode-preview">${e.thumbnail ? `<img src="${esc(e.thumbnail)}" alt="" loading="lazy" class="${state.settings.blurUnwatched && !finished ? "blurred" : ""}">` : `<span aria-label="No episode image">${uiIcon("streaming")}</span>`}</span>` : ""}<span class="episode-number">${String(e.n).padStart(2, "0")}</span><span>${state.settings.showEpisodeName === false ? "" : esc(e.title)}${watched ? `<small>${time(watched.position)} / ${time(watched.duration)}</small>` : ""}</span><span class="episode-badges">${finished ? '<span class="badge watched-label">Watched</span>' : ""}${badge ? `<span class="badge ${future ? "upcoming" : ""}" title="${e.status === "filler" ? "Not canon. This episode is not adapted from the original story." : e.status === "mixed" ? "Contains both canon story and filler material." : ""}">${esc(badge)}</span>` : ""}</span></button>`;
    })
    .join("");
  if (updated) {
    const content = document.createElement("div");
    content.innerHTML = rows;
    for (const row of content.querySelectorAll<HTMLElement>("[data-episode]")) {
      const previous = el.querySelector<HTMLElement>(
        '[data-episode="' + row.dataset.episode + '"]',
      );
      const focused = previous === document.activeElement;
      previous?.replaceWith(row);
      if (focused) row.focus({ preventScroll: true });
    }
  } else {
    el.innerHTML = `<div class="section-heading"><h2>${m.format === "MOVIE" ? "Film" : "Episodes"} </h2><div class="actions"><button id="episode-order" aria-label="Episode order">${descendingEpisodes ? "Descending" : "Ascending"}</button>${labelData?.items.some((e) => e.status === "filler") ? `<button id="hide-filler" aria-pressed="${hideFiller}">${hideFiller ? "Show filler" : "Hide filler"}</button>` : ""}<button id="toggle-episodes" class="square-button" aria-controls="episode-content" aria-expanded="${!episodesCollapsed}" aria-label="${episodesCollapsed ? "Expand episodes" : "Collapse episodes"}"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="M5 12h14"/><path class="expand-stroke" d="M12 5v14"/></svg></button></div></div><div id="episode-content" class="episode-content${episodesCollapsed ? " collapsed" : ""}" ${episodesCollapsed ? "inert" : ""}><div>${labelData?.needsMapping && offset === undefined ? '<button id="mapping" class="quiet">Set episode numbering for filler labels</button>' : ""}<div class="episode-list">${rows}</div><div class="pagination">${!showAllEpisodes && count > 50 ? '<button id="load-episodes">Load more</button>' : ""}</div></div></div>`;
  }
  el.querySelectorAll<HTMLImageElement>(".episode-preview img").forEach(
    (image) => {
      const fallback = () => {
        const parent = image.parentElement;
        if (parent)
          parent.innerHTML =
            '<span aria-label="No episode image">' +
            uiIcon("streaming") +
            "</span>";
      };
      image.onerror = fallback;
      if (image.complete && !image.naturalWidth) fallback();
    },
  );
  const toggle = el.querySelector<HTMLButtonElement>("#toggle-episodes")!;
  toggle.onclick = () => {
    episodesCollapsed = !episodesCollapsed;
    toggle.setAttribute("aria-expanded", String(!episodesCollapsed));
    toggle.setAttribute(
      "aria-label",
      episodesCollapsed ? "Expand episodes" : "Collapse episodes",
    );
    const content = el.querySelector<HTMLElement>("#episode-content")!;
    content.classList.toggle("collapsed", episodesCollapsed);
    content.inert = episodesCollapsed;
  };
  el.querySelectorAll<HTMLButtonElement>("[data-episode]").forEach(
    (b) => (b.onclick = () => void startEpisode(m, Number(b.dataset.episode))),
  );
  const filter = el.querySelector<HTMLButtonElement>("#hide-filler");
  if (filter)
    filter.onclick = () => {
      hideFiller = !hideFiller;
      renderEpisodes();
    };
  const mappingButton = el.querySelector<HTMLElement>("#mapping");
  if (mappingButton) mappingButton.onclick = mapping;
  el.querySelector<HTMLElement>("#episode-order")!.onclick = () => {
    descendingEpisodes = !descendingEpisodes;
    renderEpisodes();
    void loadEpisodes();
  };
  const more = el.querySelector<HTMLElement>("#load-episodes");
  if (more)
    more.onclick = () => {
      showAllEpisodes = true;
      renderEpisodes();
      void loadEpisodes();
    };
}

function dialog(content: string) {
  const previous = document.querySelector<HTMLDialogElement>("#dialog")!;
  const d = previous.cloneNode(false) as HTMLDialogElement;
  d.removeAttribute("open");
  previous.onclose = null;
  if (previous.open) previous.close();
  previous.replaceWith(d);
  const lightDismiss =
    content.includes('id="settings"') ||
    content.includes('id="help-content"') ||
    content.includes('id="shelf-editor"');
  d.setAttribute("closedby", lightDismiss ? "any" : "closerequest");
  const outside = (event: MouseEvent) => {
    const bounds = d.getBoundingClientRect();
    return (
      event.target === d &&
      (event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom)
    );
  };
  let startedOutside = false;
  d.onpointerdown = (event) => {
    startedOutside = outside(event);
  };
  d.onclick = (event) => {
    if (lightDismiss && startedOutside && outside(event)) d.close();
  };
  d.innerHTML = `<div class="dialog-header"><span class="eyebrow">Nen</span><button id="close-dialog" aria-label="Close dialog">${uiIcon("close")}</button></div>${content}`;
  d.onclose = null;
  if (!d.open) d.showModal();
  d.querySelector<HTMLElement>("#close-dialog")!.onclick = () => d.close();
  return d;
}
function mapping() {
  const m = current!;
  const d = dialog(
    `<h2 id="dialog-title">Episode mapping</h2><p>Set the offset for AniFillerPedia's continuous numbering. For example, an offset of 12 maps episode 1 to episode 13.</p><form id="mapping-form"><label>Episode offset<input id="offset" type="number" min="-9999" max="9999" value="${state.mappings[m.id] ?? 0}" required></label><p>Use 0 only if the provider's episode 1 is this series' episode 1.</p><button class="primary">Confirm mapping</button></form>`,
  );
  d.querySelector<HTMLFormElement>("form")!.onsubmit = (e) => {
    e.preventDefault();
    void run(async () => {
      const offset = Number(
        d.querySelector<HTMLInputElement>("#offset")!.value,
      );
      await api.mapping(m.id, offset);
      state.mappings[m.id] = offset;
      d.close();
      renderEpisodes();
    });
  };
}
let pickerRequest = 0;
async function releasePicker(m: Media, ep: number) {
  const token = ++pickerRequest;
  const d = dialog(
    `<h2 id="dialog-title">${esc(title(m))}</h2><p class="muted">Episode ${ep} · Choose a source</p><div id="releases"><p class="loading">Finding sources…</p></div>`,
  );
  try {
    await api.control("sources");
    const result = await api.releases(m.id, ep);
    if (token !== pickerRequest || !d.open) return;
    const rows = rankReleases(result.items, ep, state.settings);
    d.querySelector("#releases")!.innerHTML =
      '<label>Audio language<select id="source-language"><option value="">All languages</option>' +
      audioLanguages
        .map(
          ([code, name]) =>
            '<option value="' + code + '">' + name + "</option>",
        )
        .join("") +
      '<option value="unknown">Not specified</option></select></label><div id="source-results"></div>';
    const filter = d.querySelector<HTMLSelectElement>("#source-language")!;
    const render = () => {
      const visible = rows
        .map((release, index) => ({ release, index }))
        .filter(({ release }) => {
          const audio = releaseAudio(release);
          return (
            !filter.value ||
            (filter.value === "unknown"
              ? !audio.languages.length
              : audio.languages.includes(filter.value))
          );
        });
      d.querySelector("#source-results")!.innerHTML = visible.length
        ? visible
            .map(({ release: r, index }) => {
              const audio = releaseAudio(r);
              const label = audio.languages.length
                ? audioLanguages
                    .filter(([code]) => audio.languages.includes(code))
                    .map(([, name]) => name)
                    .join(", ") + (audio.inferred ? " audio" : " audio (title)")
                : "Audio not specified";
              return (
                '<button class="release" data-release="' +
                index +
                '"><span class="release-title">' +
                esc(r.title) +
                '</span><span class="release-meta"><b>' +
                r.source +
                "</b><span>" +
                esc(r.resolution) +
                "</span><span>" +
                esc(r.size) +
                "</span><span>" +
                r.seeds +
                " seeds</span><span>" +
                label +
                "</span></span></button>"
              );
            })
            .join("")
        : '<div class="empty"><h3>No matching sources</h3><p>Try All languages or change the source in Settings.</p></div>';
      d.querySelectorAll<HTMLButtonElement>("[data-release]").forEach(
        (button) => {
          button.onclick = () =>
            void chooseFile(m, ep, rows[Number(button.dataset.release)]);
        },
      );
    };
    filter.onchange = render;
    render();
  } catch (e) {
    if (token === pickerRequest && d.open)
      d.querySelector("#releases")!.innerHTML =
        `<p role="alert">${esc((e as Error).message)}</p>`;
  }
}
async function chooseRewatch(id: number): Promise<boolean> {
  if (state.settings.privateSession) return true;
  if (state.watch[String(id)]?.status !== "COMPLETED") return true;
  const choice = await new Promise<string>((resolve) => {
    const d = dialog(
      `<h2 id="dialog-title">Start a full rewatch?</h2><p>Start a new watch record, or play only this episode.</p><div class="actions"><button class="primary" data-rewatch="full">Start full rewatch</button><button data-rewatch="episode">Play this episode</button></div>`,
    );
    d.returnValue = "";
    d.onclose = () => {
      d.onclose = null;
      resolve(d.returnValue);
    };
    d.querySelectorAll<HTMLButtonElement>("[data-rewatch]").forEach(
      (button) => (button.onclick = () => d.close(button.dataset.rewatch)),
    );
  });
  if (choice === "full")
    state = await api.watchEdit(id, { startRewatch: true });
  return choice === "full" || choice === "episode";
}
async function startEpisode(m: Media, ep: number) {
  if ((await api.togetherState()).connected) {
    await api.autoPlay(m.id, ep);
    return;
  }
  if (episodeAvailability(m, ep).released === false) return;
  if (!(await chooseRewatch(m.id))) return;
  if (state.settings.sourceMode === "manual") {
    await releasePicker(m, ep);
    return;
  }
  const saved = state.progress[`${m.id}:${ep}`];
  if (saved) {
    const d = dialog(
      `<h2 id="dialog-title">Resuming ${esc(title(m))}</h2><p class="loading" role="status">Opening ${esc(saved.episodeTitle ?? `episode ${ep}`)}…</p>`,
    );
    try {
      await api.resume(`${m.id}:${ep}`);
      d.close();
      return;
    } catch {
      d.close();
    }
  }
  const token = ++pickerRequest;
  const d = dialog(
    `<h2 id="dialog-title">${esc(title(m))}</h2><p id="finding-source" role="status">Finding a source for episode ${ep}…</p>`,
  );
  try {
    d.onclose = () => {
      void api.control("stop").catch(() => {});
    };
    await api.autoPlay(m.id, ep);
    d.onclose = null;
    if (d.open && token === pickerRequest) d.close();
  } catch (e) {
    const finding = d.querySelector<HTMLElement>("#finding-source");
    if (finding) finding.hidden = true;
    error(e);
  }
}
async function chooseFile(m: Media, ep: number, release: Release) {
  const d = dialog(
    `<h2 id="dialog-title">Choose episode file</h2><p>${esc(release.title)}</p><div id="files"><p class="loading">Connecting…</p></div>`,
  );
  let started = false;
  d.onclose = () => {
    if (!started) void api.control("stop").catch(() => {});
    d.onclose = null;
  };
  try {
    const files = await api.inspect(release.hash);
    if (!d.open) return;
    const matched = matchingFile(files, release, m, ep);
    const play = async (index: number) => {
      await api.play(m.id, ep, index, ep);
      started = true;
      d.close();
    };
    if (matched) {
      await play(matched.index);
      return;
    }
    if (
      files.length &&
      files.every(
        (file) =>
          parseRelease(file.path.split(/[\\/]/).at(-1) ?? "", ep).episode !==
          null,
      )
    )
      throw Error(
        "This source does not contain a clear match for the selected episode. Choose another source.",
      );
    if ((await api.togetherState()).connected)
      throw Error(
        "This source has no clear file match for the session episode. Choose another source.",
      );
    d.querySelector("#files")!.innerHTML = files.length
      ? `<form id="file-form"><label>File for episode ${ep}<select id="file" required><option value="">Choose a file</option>${files.map((f) => `<option value="${f.index}">${esc(f.path)}</option>`).join("")}</select></label><button class="primary">Play</button></form>`
      : "<p>No video files were found.</p>";
    const form = d.querySelector<HTMLFormElement>("form");
    if (form)
      form.onsubmit = (e) => {
        e.preventDefault();
        const b = form.querySelector<HTMLButtonElement>("button")!;
        b.disabled = true;
        void run(() =>
          play(Number(form.querySelector<HTMLSelectElement>("select")!.value)),
        ).finally(() => (b.disabled = false));
      };
  } catch (e) {
    if (!d.open) return;
    d.querySelector("#files")!.innerHTML =
      `<p role="alert">${esc((e as Error).message)}</p><button id="retry-release">Choose another source</button>`;
    d.querySelector<HTMLElement>("#retry-release")!.onclick = () => {
      d.onclose = null;
      void releasePicker(m, ep);
    };
  }
}

async function resumeFromHistory(key: string) {
  const saved = state.progress[key];
  if (!saved) return;
  if (!(await chooseRewatch(saved.mediaId))) return;
  const d = dialog(
    '<h2 id="dialog-title">' +
      esc(saved.title) +
      '</h2><p class="loading" role="status">Opening ' +
      esc(saved.episodeTitle ?? "episode " + saved.episode) +
      "…</p>",
  );
  const loading = d.querySelector<HTMLElement>(".loading")!;
  d.onclose = () => {
    void api.control("stop").catch(() => {});
  };
  try {
    await api.resume(key);
    if (loading.isConnected) {
      d.onclose = null;
      if (d.open) d.close();
    }
  } catch (e) {
    loading.hidden = true;
    if (d.open && loading.isConnected) throw e;
  }
}
const watchStatuses: [WatchStatus, string][] = [
  ["CURRENT", "Watching"],
  ["REPEATING", "Rewatching"],
  ["COMPLETED", "Completed"],
  ["PAUSED", "Paused"],
  ["DROPPED", "Dropped"],
  ["PLANNING", "Planning"],
];
async function watchlist(expandShelf = "") {
  setRoute("watchlist");
  const token = ++request;
  activeNav("watchlist");
  state = await api.state();
  const entries = Object.values(state.watch)
    .filter(
      (e) => e.format !== "MUSIC" && (state.settings.showAdult || !e.isAdult),
    )
    .sort((a, b) => b.updated - a.updated);
  const main = document.querySelector("#main")!;
  main.innerHTML = `<div class="page-heading"><h1>Lists</h1><button id="new-list">New list</button>${shelfEditButton}</div>${(
    [
      ["CURRENT", "Continue watching"],
      ["PLANNING", "Watch Later"],
      ["PAUSED", "Paused"],
      ["DROPPED", "Dropped"],
      ["FAVORITES", "Favorites"],
      ["COMPLETED", "Completed"],
    ] as const
  )
    .map(([status, label]) => {
      const name = status === "CURRENT" ? "Continue watching" : label;
      return `<section class="home-section" data-shelf="${status}"><div class="section-heading"><h2>${name}</h2><div class="actions"><button data-list-all>View all</button><button data-list-step="-1" aria-label="Previous ${name}">&#8249;</button><button data-list-step="1" aria-label="Next ${name}">&#8250;</button></div></div><div class="home-grid list-grid">${
        (status === "CURRENT"
          ? continueCards()
          : (status === "FAVORITES"
              ? Object.values(state.favorites)
                  .filter(
                    (e) =>
                      e.format !== "MUSIC" &&
                      (state.settings.showAdult || !e.isAdult),
                  )
                  .map((e) => state.watch[String(e.mediaId)] ?? e)
              : entries.filter((e) => e.status === status)
            ).map((e) => {
              const saved = Object.values(state.progress)
                .filter((p) => p.mediaId === e.mediaId)
                .sort((a, b) => b.updated - a.updated)[0];
              const latest = Object.entries(e.runs.at(-1)?.episodes ?? {}).sort(
                (a, b) => b[1].updated - a[1].updated,
              )[0];
              const episode =
                latest && latest[1].updated > e.countUpdated
                  ? Number(latest[0])
                  : e.count;
              const info =
                episode > 0
                  ? `Episode ${episode}${e.totalEpisodes ? ` / ${e.totalEpisodes}` : ""}${saved?.episode === episode && saved.episodeTitle && saved.episodeTitle !== `Episode ${episode}` ? ` \u00b7 ${saved.episodeTitle}` : ""}`
                  : e.totalEpisodes
                    ? `${e.totalEpisodes} episodes`
                    : "Not started";
              return `<article class="list-card"><button class="poster" data-media="${e.mediaId}" aria-label="Open ${esc(e.title)}"><div class="cover"><img src="${esc(e.cover)}" alt="" loading="lazy" decoding="async"></div><h3>${esc(e.title)}</h3><p>${esc(info)}</p></button>${state.watch[String(e.mediaId)] ? watchEditButton(e.mediaId, e.title) : ""}</article>`;
            })
        ).join("") || '<p class="muted">No anime here.</p>'
      }</div></section>`;
    })
    .join("")}`;
  movePageHeading();
  for (const list of localLists()) {
    const section = document.createElement("section");
    section.className = "home-section";
    section.dataset.shelf = list.id;
    section.innerHTML = `<div class="section-heading"><h2>${esc(list.name)}</h2><div class="actions">${list.id !== "watch-later" ? `<button data-rename-list="${list.id}">Rename</button><button data-delete-list="${list.id}">Delete list</button>` : ""}<button data-list-all>View all</button><button data-list-step="-1" aria-label="Previous titles">${uiIcon("left")}</button><button data-list-step="1" aria-label="Next titles">${uiIcon("right")}</button></div></div><div class="home-grid list-grid">${
      list.items
        .filter((m) => state.settings.showAdult || !m.isAdult)
        .map(savedCard)
        .join("") || `<p class="muted">No anime here.</p>`
    }</div>`;
    main.append(section);
  }
  document.querySelector<HTMLElement>("#new-list")!.onclick = () => nameList();
  main
    .querySelectorAll<HTMLElement>("[data-rename-list]")
    .forEach((b) => (b.onclick = () => nameList(b.dataset.renameList)));
  main
    .querySelectorAll<HTMLElement>("[data-delete-list]")
    .forEach((b) => (b.onclick = () => deleteList(b.dataset.deleteList!)));
  if (!shelfHidden("watchlist", "Following") || expandShelf === "Following")
    void followingShelf(token, expandShelf === "Following");
  bindShelfEditor("watchlist");
  applyShelfLayout("watchlist");
  bindMedia(main);
  bindContinue(main);
  main
    .querySelectorAll<HTMLElement>(".home-section")
    .forEach((section) =>
      bindListPage(section, section.dataset.shelf === expandShelf),
    );
}

let contextRequest = 0;
document.addEventListener("contextmenu", (event) => {
  const target = event.target as HTMLElement;
  const episodeRow = target.closest<HTMLElement>("#episodes [data-episode]");
  const card = target.closest<HTMLElement>(
    "[data-media], [data-open-series], [data-continue], [data-resume], [data-watch-edit], .series-poster",
  );
  const id = episodeRow
    ? current?.id
    : card?.classList.contains("series-poster")
      ? current?.id
      : Number(
          card?.dataset.media ||
            card?.dataset.openSeries ||
            card?.dataset.continue ||
            card?.dataset.watchEdit ||
            card?.dataset.resume?.split(":")[0],
        );
  if (!id || episodeRow?.hasAttribute("disabled")) return;
  event.preventDefault();
  const request = ++contextRequest;
  document.querySelector("#anime-context-menu")?.remove();
  void run(async () => {
    const media = current?.id === id ? current : await api.media(id);
    if (request !== contextRequest) return;
    const entry = state.watch[String(id)];
    const actions: [string, () => Promise<unknown>][] = [];
    if (episodeRow) {
      const episode = Number(episodeRow.dataset.episode);
      const progress =
        entry?.runs.at(-1)?.episodes[String(episode)] ??
        state.progress[`${id}:${episode}`];
      if (!(episode <= (entry?.count ?? 0) || progress?.watched))
        actions.push([
          "Mark as completed",
          () =>
            api.watchEdit(id, { episode, watched: true }).then((value) => {
              state = value;
            }),
        ]);
      if ((progress?.position ?? 0) > 0)
        actions.push([
          "Reset watch time",
          () =>
            api.watchEdit(id, { episode, position: 0 }).then((value) => {
              state = value;
            }),
        ]);
    } else {
      actions.push([
        state.favorites[String(id)] ? "Unfavorite" : "Favorite",
        () =>
          api.favoriteSet(id, !state.favorites[String(id)]).then((value) => {
            state = value;
          }),
      ]);
      actions.push([
        "Save",
        async () => {
          saveTo(media);
        },
      ]);
      if (
        entry?.status !== "COMPLETED" &&
        !(media.episodes && (entry?.count ?? 0) >= media.episodes)
      )
        actions.push([
          "Mark as completed",
          () =>
            api
              .watchEdit(id, {
                status: "COMPLETED",
                count: media.episodes ?? entry?.count ?? 0,
              })
              .then((value) => {
                state = value;
              }),
        ]);

      if (target.closest(".recent-card"))
        actions.push([
          "Remove from Continue watching",
          async () => {
            const next = {
              ...state.settings,
              hiddenContinue: {
                ...state.settings.hiddenContinue,
                [id]: Date.now(),
              },
            };
            await api.settings(next);
            state.settings = next;
          },
        ]);
      actions.push(["Edit", () => editWatch(id)]);
      if (!state.settings.hideOpenAniList)
        actions.push(["Open on AniList", () => api.external("anilist", id)]);
      if (media.idMal && state.settings.hideOpenMyAnimeList === false)
        actions.push([
          "Open on MyAnimeList",
          () => api.external("mal", media.idMal!),
        ]);
    }
    if (!actions.length) return;
    showContextMenu(
      event,
      "anime-context-menu",
      episodeRow ? "Episode actions" : "Anime actions",
      actions.map(([label, action]) => [
        label,
        async () => {
          await action();
          if (label === "Save") return;
          if (route === "series") {
            updateSeriesActions();
            renderEpisodes();
          } else if (route === "watchlist") await watchlist();
          else if (route === "home") await home();
        },
      ]),
    );
  });
});

function updateSeriesActions() {
  if (!current) return;
  const list = document.querySelector<HTMLButtonElement>("#watchlist-toggle");
  const favorite =
    document.querySelector<HTMLButtonElement>("#favorite-toggle");
  if (list) {
    const selected = state.watch[String(current.id)]?.status === "PLANNING";
    const label = "Save";
    list.setAttribute("aria-pressed", String(selected));
    list.setAttribute("aria-label", label);
    list.title = label;
    list.innerHTML = `<svg class="watchlist-icon" viewBox="0 0 24 24" fill="${selected ? "currentColor" : "none"}" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M6 3h12v18l-6-4-6 4z"/></svg>`;
  }
  if (favorite) {
    const selected = !!state.favorites[String(current.id)];
    favorite.setAttribute("aria-pressed", String(selected));
    favorite.setAttribute(
      "aria-label",
      selected ? "Remove from favorites" : "Add to favorites",
    );
    favorite.title = selected ? "Remove from favorites" : "Add to favorites";
  }
}
async function editWatch(id: number) {
  const media = state.watch[String(id)] ? undefined : await api.media(id);
  const entry = state.watch[String(id)] ?? {
    title: title(media!),
    status: "PLANNING" as WatchStatus,
    count: 0,
    totalEpisodes: media!.episodes,
  };
  const d = dialog(
    `<h2 id="dialog-title">${esc(entry.title)}</h2><form id="watch-form"><label>Watch status<select name="status">${watchStatuses.map(([value, name]) => `<option value="${value}" ${entry.status === value ? "selected" : ""}>${name}</option>`).join("")}</select></label><label>Episode progress<input name="count" type="number" min="0" step="1" ${entry.totalEpisodes != null ? `max="${entry.totalEpisodes}"` : ""} value="${entry.count}" required></label></form><hr><button id="delete-watch">Delete entry</button>`,
  );
  d.querySelector<HTMLButtonElement>("#delete-watch")!.onclick = () =>
    void run(async () => {
      state = await api.watchDelete(id);
      d.onclose = null;
      d.close();
      if (route === "home") await home();
      else if (route === "watchlist") await watchlist();
      else if (route === "series") renderEpisodes();
      showToast("Entry deleted from Nen.");
    });
  const form = d.querySelector<HTMLFormElement>("#watch-form")!;
  form.onsubmit = (e) => {
    e.preventDefault();
    d.close();
  };
  d.onclose = () => {
    d.onclose = null;
    const data = new FormData(form);
    const status = String(data.get("status")) as WatchStatus;
    const value = Number(data.get("count"));
    const count = Number.isFinite(value)
      ? Math.max(
          0,
          Math.min(
            entry.totalEpisodes ?? Number.MAX_SAFE_INTEGER,
            Math.floor(value),
          ),
        )
      : entry.count;
    if (status === entry.status && count === entry.count) return;
    void run(async () => {
      state = await api.watchEdit(id, { status, count });
      if (route === "watchlist") await watchlist();
      if (route === "home") await home();
      if (route === "series" && current?.id === id) renderEpisodes();
    });
  };
}
async function showSyncReview(
  firstConnect = false,
  notice = "",
  service: "anilist" | "mal" = "anilist",
) {
  const name = service === "mal" ? "MyAnimeList" : "AniList";
  const sync =
    service === "mal"
      ? api.mal!
      : { preview: api.anilistPreview, apply: api.anilistApply };
  const preview = await sync.preview();
  notice = [notice, preview.warning].filter(Boolean).join(" ");
  const choices: SyncChange[] = preview.changes.map((row) => ({ ...row }));
  const conflicts = choices
    .map((row, i) => ({ row, i }))
    .filter(({ row }) => row.conflict);
  if (!conflicts.length) {
    state = await sync.apply(choices);
    showToast(
      notice ||
        (choices.length
          ? `${name} sync complete.`
          : firstConnect
            ? "Connected account. No entries to sync."
            : "No new entries to sync."),
    );
    if (route === "watchlist") await watchlist();
    if (route === "home") await home();
    if (route === "series") renderEpisodes();
    return;
  }
  const d = dialog(
    `<h2 id="dialog-title">Review ${name} sync</h2>${notice ? `<p class="notice">${esc(notice)}</p>` : ""}<p>${conflicts.length ? "Choose which values to keep." : "No conflicts. Your lists are ready to sync."}</p><div class="sync-changes">${conflicts.map(({ row, i }) => `<div class="sync-row"><span>${esc(row.title)} - ${row.field === "count" ? "Episode progress" : row.field === "status" ? "Watch status" : "Rewatches"}</span><small>Nen: ${esc(row.local)} &middot; ${name}: ${esc(row.remote)}</small><div class="actions" role="group" aria-label="Choose values for ${esc(row.title)}"><button type="button" data-choice="${i}" data-side="local" aria-pressed="${row.choice === "local"}">Use Nen</button><button type="button" data-choice="${i}" data-side="remote" aria-pressed="${row.choice === "remote"}">Use ${name}</button></div></div>`).join("")}</div>${conflicts.length ? '<div class="actions sync-select-all" role="group" aria-label="Select all"><span>Select all</span><button type="button" data-select-all="local">Nen</button><button type="button" data-select-all="remote">' + name + "</button></div>" : ""}<button id="apply-sync" class="primary">Apply sync</button>`,
  );
  const updateSelectAll = () =>
    d
      .querySelectorAll<HTMLButtonElement>("[data-select-all]")
      .forEach((button) =>
        button.setAttribute(
          "aria-pressed",
          String(
            conflicts.every(
              ({ row }) => row.choice === button.dataset.selectAll,
            ),
          ),
        ),
      );
  updateSelectAll();
  d.querySelectorAll<HTMLButtonElement>("[data-choice]").forEach((button) => {
    button.onclick = () => {
      choices[Number(button.dataset.choice)].choice = button.dataset.side as
        "local" | "remote";
      d.querySelectorAll<HTMLButtonElement>(
        `[data-choice="${button.dataset.choice}"]`,
      ).forEach((option) =>
        option.setAttribute("aria-pressed", String(option === button)),
      );
      updateSelectAll();
    };
  });
  d.querySelectorAll<HTMLButtonElement>("[data-select-all]").forEach(
    (button) => {
      button.onclick = () =>
        d
          .querySelectorAll<HTMLButtonElement>(
            `[data-choice][data-side="${button.dataset.selectAll}"]`,
          )
          .forEach((option) => option.click());
    },
  );
  d.querySelector<HTMLElement>("#apply-sync")!.onclick = () =>
    void run(async () => {
      if (choices.some((row) => !row.choice)) {
        showToast("Choose a side for each change.", d);
        return;
      }
      state = await sync.apply(choices);
      d.close();
      showToast(`${name} sync complete.`);
      if (route === "watchlist") await watchlist();
      if (route === "home") await home();
      if (route === "series") renderEpisodes();
    });
}
function bindSectionTabs(d: HTMLDialogElement) {
  const tabs = [...d.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  for (const tab of tabs) {
    tab.onclick = () => {
      for (const item of tabs) {
        const selected = item === tab;
        item.setAttribute("aria-selected", String(selected));
        item.tabIndex = selected ? 0 : -1;
        d.querySelector<HTMLElement>(
          "#" + item.getAttribute("aria-controls"),
        )!.hidden = !selected;
      }
    };
    tab.onkeydown = (event) => {
      const index = tabs.indexOf(tab);
      const next =
        event.key === "ArrowDown"
          ? (index + 1) % tabs.length
          : event.key === "ArrowUp"
            ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : -1;
      if (next < 0) return;
      event.preventDefault();
      tabs[next].click();
      tabs[next].focus();
    };
  }
}
function help() {
  const sections = [
    ["support", "message", "Support"],
    ["faq", "help", "FAQ"],
    ["donations", "heart", "Support us"],
  ];
  const d = dialog(
    '<h2 id="dialog-title">Help &amp; support</h2><div class="settings-tabs" role="tablist" aria-orientation="vertical" aria-label="Help">' +
      sections
        .map(
          ([id, icon, name], i) =>
            '<button type="button" role="tab" id="help-tab-' +
            id +
            '" aria-controls="help-' +
            id +
            '" aria-selected="' +
            (i === 0) +
            '" tabindex="' +
            (i === 0 ? 0 : -1) +
            '">' +
            uiIcon(icon) +
            "<span>" +
            name +
            "</span></button>",
        )
        .join("") +
      '</div><div id="help-content"><section id="help-support" role="tabpanel" aria-labelledby="help-tab-support"><h3>Contact us</h3><p>Report a problem or ask for help. Include your Nen build, the anime and episode, and steps to repeat the problem.</p><div class="actions"><button data-support="discord">Discord server</button><button data-support="issues">GitHub issues</button><button data-support="email">Email support</button></div></section>' +
      '<section id="help-faq" role="tabpanel" aria-labelledby="help-tab-faq" hidden><h4>Why are no streams found?</h4><p>' +
      (api.browserHistory
        ? "The streaming provider may not have this title or episode. Try again later."
        : "Available sources may have no active seeders or no matching episode.") +
      "</p><h4>Do I need an AniList account?</h4><p>No. Nen can keep your lists and progress locally.</p><h4>When does an episode count as watched?</h4><p>After you watch more than 85% of an episode, or when you go to the next episode.</p><h4>How do I update Nen?</h4><p>" +
      (api.browserHistory
        ? "Reload this browser page to use the latest website build."
        : "Open Settings, then check for updates. You can also enable auto updates to install new builds on launch.") +
      "</p></section>" +
      '<section id="help-donations" role="tabpanel" aria-labelledby="help-tab-donations" hidden><p>You can support Nen on Ko-fi.</p><button data-support="donate">Donate on Ko-fi</button></section></div>',
  );
  const version = d.querySelector(".dialog-header .eyebrow")!;
  version.textContent = "Nen · " + state.version;
  version.classList.add("settings-version");
  d.append(version);
  bindSectionTabs(d);
  d.querySelectorAll<HTMLButtonElement>("[data-support]").forEach((button) => {
    button.onclick = () =>
      void api
        .external(
          button.dataset.support as "discord" | "issues" | "email" | "donate",
        )
        .catch(error);
  });
}
function activeProfileName() {
  return (
    state.profiles?.list.find((p) => p.id === state.profiles!.active)?.name ??
    ""
  );
}
function profileSection(root: HTMLElement, d: HTMLDialogElement) {
  const profiles = state.profiles!;
  const rows = [...profiles.list].sort(
    (a, b) =>
      Number(b.id === profiles.active) - Number(a.id === profiles.active) ||
      a.created - b.created,
  );
  root.innerHTML = `<h3 class="local-data-heading">Profiles</h3><ul class="profile-list">${rows
    .map((p) => {
      const active = p.id === profiles.active;
      const details = [
        active ? "Current profile" : "",
        p.anilistUser ? `AniList: ${esc(p.anilistUser)}` : "",
        p.malUser ? `MyAnimeList: ${esc(p.malUser)}` : "",
      ]
        .filter(Boolean)
        .join(" &middot; ");
      return `<li class="profile-row${active ? " active" : ""}" data-profile="${esc(p.id)}"><div class="profile-info"><strong>${esc(p.name)}</strong>${details ? `<small>${details}</small>` : ""}</div><div class="actions">${active ? "" : `<button type="button" data-profile-action="switch" aria-label="Switch to ${esc(p.name)}">Switch</button>`}<button type="button" data-profile-action="rename" aria-label="Rename ${esc(p.name)}">Rename</button>${active ? "" : `<button type="button" data-profile-action="delete" aria-label="Delete ${esc(p.name)}">Delete</button>`}</div></li>`;
    })
    .join(
      "",
    )}</ul><div class="profile-editor" hidden></div><div class="actions profile-actions"><button id="profile-new" type="button">New profile</button><button id="profile-import" type="button">New profile from file</button></div><hr>`;
  const heading = d.querySelector<HTMLElement>("#anilist-heading");
  if (heading) heading.textContent = `AniList for ${activeProfileName()}`;
  const refresh = () => profileSection(root, d);
  const editor = root.querySelector<HTMLElement>(".profile-editor")!;
  const edit = (
    action: string,
    value: string,
    placeholder: string,
    submit: (name: string) => Promise<void>,
  ) => {
    editor.hidden = false;
    editor.innerHTML = `<label>Profile name<input id="profile-name" type="text" maxlength="40" autocomplete="off" spellcheck="false"></label><div class="actions"><button id="profile-save" type="button" class="primary">${action}</button><button id="profile-cancel" type="button">Cancel</button></div>`;
    const input = editor.querySelector<HTMLInputElement>("#profile-name")!;
    const save = editor.querySelector<HTMLButtonElement>("#profile-save")!;
    input.value = value;
    input.placeholder = placeholder;
    const done = () =>
      void run(async () => {
        save.disabled = true;
        try {
          await submit(input.value);
        } finally {
          save.disabled = false;
        }
      });
    save.onclick = done;
    editor.querySelector<HTMLButtonElement>("#profile-cancel")!.onclick =
      refresh;
    input.onkeydown = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        done();
      } else if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        refresh();
      }
    };
    input.focus();
    input.select();
  };
  root.querySelector<HTMLButtonElement>("#profile-new")!.onclick = () =>
    edit("Create", "", "", async (name) => {
      state = (await api.profileCreate(name, false))!;
      refresh();
      showToast(`Created profile ${name.trim()}.`, d);
    });
  root.querySelector<HTMLButtonElement>("#profile-import")!.onclick = () =>
    edit("Choose file", "", "Use the name in the file", async (name) => {
      const next = await api.profileCreate(name, true);
      if (!next) return;
      state = next;
      refresh();
      showToast(
        `Created profile ${state.profiles!.list.at(-1)!.name} from the file.`,
        d,
      );
    });
  root
    .querySelectorAll<HTMLButtonElement>("[data-profile-action]")
    .forEach((button) => {
      const id =
        button.closest<HTMLElement>("[data-profile]")!.dataset.profile!;
      const profile = profiles.list.find((p) => p.id === id)!;
      button.onclick = () =>
        void run(async () => {
          const action = button.dataset.profileAction;
          if (action === "rename")
            return edit("Save", profile.name, "", async (name) => {
              state = await api.profileRename(id, name);
              refresh();
            });
          if (action === "delete") {
            if (
              !confirm(
                `Delete the ${profile.name} profile? Its lists, progress, settings, and account connections will be removed from this PC. Nothing is removed from AniList or MyAnimeList.`,
              )
            )
              return;
            state = await api.profileDelete(id);
            refresh();
            showToast(`Deleted profile ${profile.name}.`, d);
            return;
          }
          const [room, playing] = await Promise.all([
            api.togetherState(),
            api.playback(),
          ]);
          const leaving = [
            room.connected ? "leave Watch together" : "",
            playing.active ? "stop playback" : "",
          ].filter(Boolean);
          if (
            leaving.length &&
            !confirm(
              `Switching profiles will ${leaving.join(" and ")}. Continue?`,
            )
          )
            return;
          root
            .querySelectorAll("button")
            .forEach((item) => (item.disabled = true));
          try {
            await api.profileSwitch(id);
          } finally {
            root
              .querySelectorAll("button")
              .forEach((item) => (item.disabled = false));
          }
        });
    });
}
function showContextMenu(
  event: MouseEvent,
  id: string,
  label: string,
  actions: [string, () => Promise<unknown>][],
) {
  document.querySelector("#" + id)?.remove();
  const menu = document.createElement("div");
  menu.id = id;
  menu.popover = "auto";
  menu.setAttribute("role", "menu");
  menu.setAttribute("aria-label", label);
  for (const [label, action] of actions) {
    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.textContent = label;
    button.onclick = () => {
      menu.hidePopover();
      void run(action);
    };
    menu.append(button);
  }
  menu.onkeydown = (e) => {
    const buttons = [...menu.querySelectorAll("button")];
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      buttons[
        e.key === "Home"
          ? 0
          : e.key === "End"
            ? buttons.length - 1
            : (index + (e.key === "ArrowDown" ? 1 : -1) + buttons.length) %
              buttons.length
      ].focus();
    }
  };
  menu.addEventListener("toggle", () => {
    if (!menu.matches(":popover-open")) menu.remove();
  });
  ((event.target as HTMLElement).closest("dialog") ?? document.body).append(
    menu,
  );
  menu.showPopover();
  menu.style.left =
    Math.max(4, Math.min(event.clientX, innerWidth - menu.offsetWidth - 4)) +
    "px";
  menu.style.top =
    Math.max(4, Math.min(event.clientY, innerHeight - menu.offsetHeight - 4)) +
    "px";
  menu.querySelector("button")?.focus();
}
function localRefreshMenu(event: MouseEvent, refresh: () => Promise<void>) {
  showContextMenu(event, "local-context-menu", "Local file actions", [
    ["Refresh", refresh],
  ]);
}
async function localNav() {
  const value = await api.local!.state();
  const button = document.querySelector<HTMLElement>('[data-nav="local"]');
  if (button) button.hidden = !value.enabled;
  return value;
}
async function localSettings(section: HTMLElement) {
  const value = await localNav();
  section.innerHTML =
    '<label class="check"><input id="local-enabled" type="checkbox" role="switch" ' +
    (value.enabled ? "checked" : "") +
    '> Enable local files</label><button type="button" id="local-add">Add source</button><hr><div id="local-sources"></div>';
  section.onchange = (event) => event.stopPropagation();
  section.querySelector<HTMLInputElement>("#local-enabled")!.onchange = (
    event,
  ) => {
    event.stopPropagation();
    void run(async () => {
      await api.local!.enable((event.target as HTMLInputElement).checked);
      await localNav();
      if (route === "local") await localLibrary();
    });
  };
  const sources = section.querySelector<HTMLElement>("#local-sources")!;
  for (const source of value.sources) {
    const row = document.createElement("div");
    row.className = "local-source";
    row.innerHTML =
      "<strong>" +
      esc(source.name) +
      "</strong><small>" +
      esc(source.path) +
      "</small>" +
      (!source.available
        ? "<p>Folder unavailable. Connect the drive, then refresh.</p>"
        : "") +
      '<div class="actions"><button type="button" data-refresh>Refresh</button><button type="button" data-remove>Remove</button></div>';
    row.querySelector<HTMLButtonElement>("[data-refresh]")!.onclick = () =>
      void run(() => localSettings(section));
    row.querySelector<HTMLButtonElement>("[data-remove]")!.onclick = () =>
      void run(async () => {
        await api.local!.remove(source.id);
        await localSettings(section);
        if (route === "local") await localLibrary();
      });
    row.oncontextmenu = (event) => {
      event.preventDefault();
      localRefreshMenu(event, () => localSettings(section));
    };
    sources.append(row);
  }
  section.querySelector<HTMLButtonElement>("#local-add")!.onclick = () =>
    void run(async () => {
      await api.local!.add();
      await localSettings(section);
      if (route === "local") await localLibrary();
    });
}
async function localLibrary(id = "", path = "") {
  if (!api.local) return;
  setRoute("local");
  activeNav("local");
  localLocation = { id, path };
  const token = ++request;
  const main = document.querySelector<HTMLElement>("#main")!;
  document.querySelector("#page-title")!.innerHTML = "<h1>Local files</h1>";
  main.innerHTML = '<p role="status">Loading local files…</p>';
  try {
    const value = await localNav();
    if (route !== "local" || token !== request) return;
    if (!value.enabled) {
      main.innerHTML =
        "<p>Enable Local files in Settings to browse your folders.</p>";
      return;
    }
    const source = value.sources.find((s) => s.id === id);
    main.innerHTML =
      (source
        ? '<button id="local-up" class="back">' +
          uiIcon("left") +
          " Back</button>"
        : "") + '<h2 id="local-heading"></h2><div class="local-entries"></div>';
    const up = main.querySelector<HTMLButtonElement>("#local-up");
    if (up) up.onclick = () => void run(() => localLibrary());
    main.oncontextmenu = (event) => {
      if (route !== "local") return;
      event.preventDefault();
      localRefreshMenu(event, () => localLibrary(id, path));
    };
    const list = main.querySelector<HTMLElement>(".local-entries")!;
    if (!source) {
      main.querySelector("#local-heading")!.textContent = "Sources";
      if (!value.sources.length)
        list.innerHTML = "<p>Add a source folder in Settings to begin.</p>";
      for (const item of value.sources) {
        const button = document.createElement("button");
        button.textContent =
          item.name + (item.available ? "" : " (unavailable)");
        button.setAttribute("aria-disabled", String(!item.available));
        button.onclick = () => {
          if (item.available) void run(() => localLibrary(item.id));
        };
        list.append(button);
      }
      return;
    }
    main.querySelector("#local-heading")!.textContent =
      source.name + (path ? " / " + path : "");
    if (!source.available) {
      list.innerHTML =
        "<p>Folder unavailable. Connect the drive, then select Refresh.</p>";
      return;
    }
    const folder = await api.local.list(id, path);
    if (route !== "local" || token !== request) return;
    up!.onclick = () =>
      void run(() =>
        folder.parent === null
          ? localLibrary()
          : localLibrary(id, folder.parent),
      );
    if (!folder.entries.length)
      list.innerHTML = "<p>No video files or folders found.</p>";
    for (const entry of folder.entries) {
      const button = document.createElement("button");
      button.textContent = (entry.directory ? "Folder: " : "") + entry.name;
      button.onclick = () =>
        void run(async () => {
          if (entry.directory) await localLibrary(id, entry.path);
          else {
            button.disabled = true;
            try {
              await api.local!.play(id, entry.path);
            } finally {
              button.disabled = false;
            }
          }
        });
      list.append(button);
    }
  } catch (error) {
    if (route === "local" && token === request) {
      main.replaceChildren();
      const message = document.createElement("p");
      message.textContent = "Could not open the folder: " + String(error);
      const back = document.createElement("button");
      back.textContent = "Back to sources";
      back.onclick = () => void run(() => localLibrary());
      main.append(message, back);
    }
  }
}
function settings() {
  const s = state.settings;
  const languages = audioLanguages;
  const options = (value: string, sub = false) =>
    `${sub ? `<option value="no" ${value === "no" ? "selected" : ""}>Off</option>` : ""}<option value="" ${value === "" ? "selected" : ""}>Use file default</option>${languages.map(([code, name]) => `<option value="${code}" ${value.split(",")[0] === code ? "selected" : ""}>${name}</option>`).join("")}`;
  const d = dialog(
    `<h2 id="dialog-title">Settings</h2>
    <div class="settings-tabs" role="tablist" aria-orientation="vertical" aria-label="Settings">${["App", "Player", "Subtitles", "Account", ...(api.local ? ["Local files"] : []), "Changelog"].map((name, i) => `<button type="button" role="tab" id="settings-tab-${name.toLowerCase().replaceAll(" ", "-")}" aria-controls="settings-${name.toLowerCase().replaceAll(" ", "-")}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${uiIcon(name === "Player" ? "streaming" : name === "Subtitles" ? "subtitles" : name === "Local files" ? "folder" : name === "App" ? "settings" : name === "Changelog" ? "history" : name.toLowerCase())}<span>${name}</span></button>`).join("")}</div>
    <form id="settings">
    <section id="settings-app" role="tabpanel" aria-labelledby="settings-tab-app"><label>Appearance<select name="theme">${["system", "light", "dark"].map((v) => `<option value="${v}" ${s.theme === v ? "selected" : ""}>${v === "system" ? "Use system theme" : v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select></label><label class="check"><input id="auto-updates" name="autoUpdates" type="checkbox" role="switch" ${s.autoUpdates ? "checked" : ""}> Enable auto updates</label><label class="check"><input name="showAdult" type="checkbox" role="switch" ${s.showAdult ? "checked" : ""}> Show NSFW content</label><label class="check"><input name="discordPresence" type="checkbox" role="switch" ${s.discordPresence === true ? "checked" : ""}> Show what I’m watching on Discord</label><label class="check"><input name="compactView" type="checkbox" role="switch" ${s.compactView ? "checked" : ""}> Use compact view</label><label class="check"><input name="showEpisodeName" type="checkbox" role="switch" ${s.showEpisodeName !== false ? "checked" : ""}> Show episode name</label><label class="check"><input name="blurUnwatched" type="checkbox" role="switch" ${s.blurUnwatched ? "checked" : ""}> Blur unwatched episode images</label><label class="check"><input name="privateSession" type="checkbox" role="switch" ${s.privateSession ? "checked" : ""}> Private session</label><label class="check"><input name="hideOpenAniList" type="checkbox" role="switch" ${s.hideOpenAniList ? "checked" : ""}> Hide Open on AniList button</label><label class="check"><input name="hideOpenMyAnimeList" type="checkbox" role="switch" ${s.hideOpenMyAnimeList !== false ? "checked" : ""}> Hide Open on MyAnimeList button</label><hr><div class="actions update-actions"><button id="check-updates" type="button">Check for updates</button></div></section>
    <section id="settings-player" role="tabpanel" aria-labelledby="settings-tab-player" hidden><div class="field-pair"><label>Preferred audio<select name="audio">${options(s.audio)}</select></label><label>Preferred subtitles<select name="subtitles">${options(s.subtitles, true)}</select></label></div><label>Choose a source<select name="sourceMode"><option value="auto" ${s.sourceMode !== "manual" ? "selected" : ""}>Find the best source automatically</option><option value="manual" ${s.sourceMode === "manual" ? "selected" : ""}>Always let me choose</option></select></label><label>Preferred quality</label><details class="quality-dropdown"><summary id="quality-summary">${(s.qualities ?? [1080, 720, 480, 360]).map((q) => q + "p").join(", ")}</summary><fieldset><legend class="sr-only">Allowed video qualities</legend>${[2160, 1440, 1080, 720, 480, 360].map((q) => `<label class="check"><input name="qualities" type="checkbox" role="switch" value="${q}" ${(s.qualities ?? [1080, 720, 480, 360]).includes(q) ? "checked" : ""}> ${q}p${q === 2160 ? " (4K)" : ""}</label>`).join("")}</fieldset></details><label class="check"><input name="autoNext" type="checkbox" role="switch" ${s.autoNext ? "checked" : ""}> Auto play next episode</label><label class="check"><input name="autoSkip" type="checkbox" role="switch" ${s.autoSkip ? "checked" : ""}> Automatically skip intros and outros</label><label class="check"><input name="autoSkipRecaps" type="checkbox" role="switch" ${s.autoSkipRecaps ? "checked" : ""}> Automatically skip recaps</label><label class="check"><input name="prepareNext" type="checkbox" role="switch" ${s.prepareNext ? "checked" : ""}> Prepare next episode when current episode is complete</label><label class="check"><input name="hideZeroSeeds" type="checkbox" role="switch" ${s.hideZeroSeeds !== false ? "checked" : ""}> Hide videos with 0 seeders</label></section>
    <section id="settings-subtitles" role="tabpanel" aria-labelledby="settings-tab-subtitles" hidden><label>Preferred subtitle language<select name="subtitleLanguage">${options(s.subtitles, true)}</select></label><div class="settings-subtitle-row">${[
      ["subtitleSize", "Size", s.subtitleSize ?? 100],
      ["subtitlePosition", "Vertical position", s.subtitlePosition ?? 5],
    ]
      .map(
        ([key, label, value]) =>
          `<div class="settings-subtitle-adjustment"><span>${label}</span><div class="subtitle-stepper" data-setting="${key}"><button type="button" data-step="-1" aria-label="Decrease ${String(label).toLowerCase()}">−</button><output aria-live="polite">${value}%</output><button type="button" data-step="1" aria-label="Increase ${String(label).toLowerCase()}">+</button><input type="hidden" name="${key}" value="${value}"></div></div>`,
      )
      .join("")}</div><div class="subtitle-colours">${[
      ["subtitleColour", "Colour", s.subtitleColour ?? "#ffffff"],
      [
        "subtitleOutlineColour",
        "Outline colour",
        s.subtitleOutlineColour ?? "#000000",
      ],
    ]
      .map(
        ([key, label, value]) =>
          `<div class="subtitle-colour-field" role="group" aria-labelledby="${key}-label"><span id="${key}-label">${label}</span><div class="subtitle-colour-inputs"><input name="${key}" type="color" aria-label="${label}" value="${value}"><input type="text" data-colour-hex="${key}" aria-label="${label} hex value" value="${value}" pattern="#?[a-fA-F0-9]{6}" maxlength="7" required spellcheck="false"></div></div>`,
      )
      .join(
        "",
      )}</div><label class="check"><input name="subtitleShadow" type="checkbox" role="switch" ${s.subtitleShadow !== false ? "checked" : ""}> Drop shadow</label></section>
    <section id="settings-account" role="tabpanel" aria-labelledby="settings-tab-account" hidden></section>
    ${api.local ? `<section id="settings-local-files" role="tabpanel" aria-labelledby="settings-tab-local-files" hidden></section>` : ""}
    <section id="settings-changelog" role="tabpanel" aria-labelledby="settings-tab-changelog" hidden><p id="changelog-status" role="status"></p><div id="changelog-list"></div><button id="changelog-more" type="button" hidden>Load more</button></section>
    </form><p id="settings-message" role="status"></p>`,
  );
  const version = d.querySelector(".dialog-header .eyebrow")!;
  version.innerHTML = `<strong>Nen</strong> - ${esc(state.version)}`;
  version.classList.add("settings-version");
  d.append(version);
  const form = d.querySelector<HTMLFormElement>("#settings")!;
  const message = d.querySelector<HTMLElement>("#settings-message")!;
  bindSectionTabs(d);
  const changelogList = d.querySelector<HTMLElement>("#changelog-list")!;
  const changelogStatus = d.querySelector<HTMLElement>("#changelog-status")!;
  const changelogMore = d.querySelector<HTMLButtonElement>("#changelog-more")!;
  const changelogTab = d.querySelector<HTMLButtonElement>(
    "#settings-tab-changelog",
  )!;
  let changelogEntries: ChangelogEntry[] = [];
  let changelogPage = 0;
  let changelogHasMore = false;
  let changelogLoading = false;
  let changelogRequest = 0;
  const renderChangelog = () => {
    changelogList.replaceChildren();
    const visibleEntries = changelogEntries.filter((entry) => !entry.merge);
    if (!visibleEntries.length) {
      const empty = document.createElement("p");
      empty.textContent = "No commits found.";
      changelogList.append(empty);
      return;
    }
    const days = new Map<string, ChangelogEntry[]>();
    for (const entry of visibleEntries) {
      const day = entry.date
        ? new Date(entry.date).toISOString().slice(0, 10)
        : "";
      if (!days.has(day)) days.set(day, []);
      days.get(day)!.push(entry);
    }
    for (const [day, entries] of days) {
      const group = document.createElement("section");
      group.className = "changelog-day";
      const heading = document.createElement("h3");
      const date = day
        ? new Date(day).toLocaleDateString(undefined, {
            year: "numeric",
            month: "long",
            day: "numeric",
            timeZone: "UTC",
          })
        : "Date unknown";
      heading.textContent = date;
      const link = document.createElement("button");
      link.type = "button";
      link.className = "changelog-link";
      link.innerHTML = uiIcon("external");
      link.setAttribute(
        "aria-label",
        "View commits for " + date + " on GitHub",
      );
      link.onclick = () =>
        void api
          .openChangelogCommit(
            entries.length === 1 ? entries[0].sha : undefined,
            entries.length > 1 && day ? day : undefined,
          )
          .catch(error);
      heading.append(link);
      group.append(heading);
      const list = document.createElement("ul");
      list.className = "changelog-entries";
      group.append(list);
      for (const entry of entries) {
        const item = document.createElement("li");
        item.className = "changelog-entry";
        const title = document.createElement("p");
        title.className = "changelog-title";
        title.textContent = entry.title;
        item.append(title);
        list.append(item);
      }
      changelogList.append(group);
    }
  };
  const loadChangelog = async (nextPage: number, refresh = false) => {
    if (changelogLoading) return;
    changelogLoading = true;
    const request = ++changelogRequest;
    changelogStatus.textContent = "Loading commits…";
    changelogMore.disabled = true;
    try {
      const result = await api.changelog(nextPage, refresh);
      if (request !== changelogRequest || !d.open) return;
      changelogEntries =
        nextPage === 1
          ? result.entries
          : [
              ...changelogEntries,
              ...result.entries.filter(
                (entry) =>
                  !changelogEntries.some((old) => old.sha === entry.sha),
              ),
            ];
      changelogPage = nextPage;
      changelogHasMore = result.hasMore;
      renderChangelog();
      changelogStatus.textContent = result.stale
        ? "Could not refresh. Showing saved commits."
        : "";
    } catch (e) {
      if (request !== changelogRequest || !d.open) return;
      changelogStatus.textContent =
        e instanceof Error
          ? e.message
          : "Could not load the changelog. Try again.";
    } finally {
      if (request === changelogRequest && d.open) {
        changelogLoading = false;
        changelogMore.disabled = false;
        changelogMore.hidden = !changelogHasMore;
      }
    }
  };
  changelogTab.addEventListener("click", () => {
    if (!changelogPage && !changelogLoading) void loadChangelog(1);
  });
  changelogMore.onclick = () => void loadChangelog(changelogPage + 1);
  if (state.profiles) {
    const profiles = document.createElement("section");
    profiles.className = "profiles";
    // Profile name fields are not settings, so keep their changes away from the settings form.
    profiles.onchange = (event) => event.stopPropagation();
    d.querySelector("#settings-account")!.append(profiles);
    profileSection(profiles, d);
  }
  const transfer = document.createElement("section");
  transfer.innerHTML = `<h3 id="anilist-heading" class="local-data-heading">${state.profiles ? `AniList for ${esc(activeProfileName())}` : "AniList"}</h3><p id="anilist-state" ${!state.anilist.connected && !state.anilist.error ? "hidden" : ""}>${state.anilist.connected ? `${state.anilist.lastSync ? `Last sync: ${new Date(state.anilist.lastSync).toLocaleString()}.` : "No sync yet."}` : ""}</p><div class="actions">${state.anilist.connected ? '<button id="anilist-sync" type="button">Refresh</button><button id="anilist-disconnect" type="button">Disconnect</button>' : '<button id="anilist-connect" type="button">Connect AniList</button>'}</div><hr><h3 class="local-data-heading">Local data</h3><div class="actions"><button id="clear-cache" type="button">Clear downloaded cache</button><button id="clear-history" type="button">Clear watch history</button></div><div class="actions watch-transfer-actions"><button id="watch-export" type="button">Export backup</button><button id="watch-import" type="button">Restore backup</button></div>`;
  d.querySelector("#settings-account")!.append(transfer);
  const accountSettings = () => {
    settings();
    document.querySelector<HTMLButtonElement>("#settings-tab-account")!.click();
  };
  const accountAction = async (
    action: () => Promise<unknown>,
    message: string,
  ) => {
    const buttons = [
      ...d.querySelectorAll<HTMLButtonElement>("#settings-account button"),
    ];
    buttons.forEach((button) => (button.disabled = true));
    try {
      await action();
      state = await api.state();
      if (d.open) accountSettings();
      showToast(message);
      if (route === "watchlist") await watchlist();
      else if (route === "home") await home();
    } catch (e) {
      error(e);
    } finally {
      buttons.forEach((button) => (button.disabled = false));
    }
  };
  if (api.mal) {
    const section = document.createElement("section");
    section.innerHTML =
      '<hr><h3 class="local-data-heading">MyAnimeList' +
      (state.mal?.connected && state.mal.user
        ? " for " + esc(state.mal.user)
        : "") +
      "</h3><p>" +
      (state.mal?.connected
        ? state.mal.lastSync
          ? "Last sync: " + new Date(state.mal.lastSync).toLocaleString() + "."
          : "No sync yet."
        : "") +
      '</p><div class="actions">' +
      (state.mal?.connected
        ? '<button type="button" id="mal-sync">Refresh</button><button type="button" id="mal-disconnect">Disconnect</button>'
        : '<button type="button" id="mal-connect">Connect MyAnimeList</button>') +
      "</div>";
    transfer.querySelector("hr")!.before(section);
    section.querySelector<HTMLButtonElement>("#mal-connect")?.addEventListener(
      "click",
      () =>
        void accountAction(async () => {
          await api.mal!.connect();
          await api.mal!.refresh();
        }, "MyAnimeList connected."),
    );
    section
      .querySelector<HTMLButtonElement>("#mal-sync")
      ?.addEventListener(
        "click",
        () =>
          void accountAction(
            () => api.mal!.refresh(),
            "MyAnimeList refreshed.",
          ),
      );
    section
      .querySelector<HTMLButtonElement>("#mal-disconnect")
      ?.addEventListener(
        "click",
        () =>
          void accountAction(
            () => api.mal!.disconnect(),
            "MyAnimeList disconnected.",
          ),
      );
    if (state.mal?.connected && state.anilist.connected) {
      for (const source of ["anilist", "mal"] as const) {
        const from = source === "anilist" ? "AniList" : "MyAnimeList";
        const to = source === "anilist" ? "MyAnimeList" : "AniList";
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = "Import from " + from;
        transfer
          .querySelector(
            source === "anilist" ? "#mal-disconnect" : "#anilist-disconnect",
          )!
          .after(button);
        button.onclick = () => {
          const confirm = dialog(
            '<h2 id="dialog-title">Import from ' +
              from +
              "</h2><p>This will import all of your " +
              from +
              " history to " +
              to +
              ', continue?</p><p>Missing anime will be added. Existing entries will be updated where data is missing or progress is behind. Higher episode and rewatch counts will be kept. Existing scores and notes will be kept.</p><div class="actions"><button type="button" id="confirm-account-import">Continue</button><button type="button" id="cancel-account-import">Cancel</button></div>',
          );
          confirm.querySelector<HTMLButtonElement>(
            "#cancel-account-import",
          )!.onclick = accountSettings;
          confirm.querySelector<HTMLButtonElement>(
            "#confirm-account-import",
          )!.onclick = async () => {
            const start = confirm.querySelector<HTMLButtonElement>(
              "#confirm-account-import",
            )!;
            start.disabled = true;
            const close = confirm.querySelector<HTMLButtonElement>(
              "#cancel-account-import",
            )!;
            close.textContent = "Close";
            close.onclick = () => confirm.close();
            let notice = showToast(
              "Importing 0%. It is safe to close this page. Keep Nen open.",
              confirm,
              true,
            );
            confirm.onclose = () => {
              if (!confirm.open && notice.element.isConnected) {
                document.body.append(notice.element);
                notice.element.showPopover();
              }
            };
            try {
              const result = await api.mal!.importFrom(source, (percent) => {
                const message =
                  "Importing " +
                  percent +
                  "%. It is safe to close this page. Keep Nen open.";
                if (notice.element.isConnected) notice.update(message, true);
                else notice = showToast(message, undefined, true);
              });
              if (confirm.open && start.isConnected) accountSettings();
              showToast(
                "Imported " +
                  (result.addedAniList + result.addedMyAnimeList) +
                  " anime and updated " +
                  (result.updatedAniList + result.updatedMyAnimeList) +
                  " on " +
                  to +
                  ".",
              );
            } catch (e) {
              if (confirm.open && start.isConnected) accountSettings();
              error(e);
            }
          };
        };
      }
    }
  }
  const uninstall = document.createElement("button");
  uninstall.textContent = "Uninstall";
  uninstall.id = "uninstall";
  uninstall.type = "button";
  d.querySelector(".update-actions")!.prepend(uninstall);
  uninstall.onclick = () => {
    d.close();
    const confirm = dialog(
      '<h2 id="dialog-title">Uninstall Nen?</h2><p>Nen will close and open the Windows uninstaller.</p><div class="actions"><button id="confirm-uninstall">Uninstall</button><button id="cancel-uninstall">Cancel</button></div>',
    );
    confirm.querySelector<HTMLButtonElement>("#cancel-uninstall")!.onclick =
      () => {
        confirm.close();
        settings();
      };
    confirm.querySelector<HTMLButtonElement>("#confirm-uninstall")!.onclick =
      () =>
        void run(async () => {
          await api.uninstall();
        });
  };

  transfer.querySelector<HTMLElement>("#watch-export")!.onclick = () =>
    void run(async () => {
      const path = await api.watchExport();
      if (path) showToast(`Saved backup to ${path}`, d);
    });
  transfer.querySelector<HTMLElement>("#watch-import")!.onclick = () =>
    void run(async () => {
      const summary = await api.watchImportPreview();
      if (!summary) return;
      d.close();
      const review = dialog(
        `<h2 id="dialog-title">Restore backup</h2><p>${summary.count} anime, ${summary.episodes} episode records. ${summary.newEntries} new anime and ${summary.changedEntries} existing anime.</p><p>Merge keeps newer watch records and current preferences, and adds missing favorites and custom-list items. Replace restores the sections included in the file. Old watch-only files still work. Account logins and downloaded video files are not included. Nen will save a backup first.${state.anilist.connected ? " AniList entries can return on the next sync. Nen will not delete them from AniList." : ""}</p><div class="actions"><button id="import-merge" class="primary">Merge</button><button id="import-replace">Replace</button></div>`,
      );
      for (const mode of ["merge", "replace"] as const)
        review.querySelector<HTMLElement>(`#import-${mode}`)!.onclick = () =>
          void run(async () => {
            if (
              mode === "replace" &&
              !confirm(
                "Replace the saved sections with this backup? A backup of current data will be saved.",
              )
            )
              return;
            state = await api.watchImport(mode);
            review.close();
            showToast("Backup restored.");
            applyTheme();
            document
              .querySelectorAll<HTMLElement>(".private-indicator")
              .forEach((el) => (el.hidden = !state.settings.privateSession));
            if (state.anilist.connected && !state.settings.privateSession)
              await showSyncReview();
            else if (route === "watchlist") await watchlist();
            if (route === "home") await home();
          });
    });
  const connectAniList = () =>
    void accountAction(async () => {
      await api.anilistConnect();
      await api.anilistRefresh();
    }, "AniList connected.");
  transfer
    .querySelector<HTMLElement>("#anilist-connect")
    ?.addEventListener("click", connectAniList);
  transfer
    .querySelector<HTMLElement>("#anilist-sync")
    ?.addEventListener(
      "click",
      () =>
        void accountAction(() => api.anilistRefresh(), "AniList refreshed."),
    );
  transfer
    .querySelector<HTMLButtonElement>("#anilist-disconnect")
    ?.addEventListener(
      "click",
      () =>
        void accountAction(
          () => api.anilistDisconnect(),
          "AniList disconnected.",
        ),
    );
  if (api.local)
    void localSettings(
      d.querySelector<HTMLElement>("#settings-local-files")!,
    ).catch(error);
  const initialAdult = s.showAdult;
  let saveQueue = Promise.resolve();
  const save = () => {
    if (!form.checkValidity()) return;
    const f = new FormData(form);
    const qualities = f.getAll("qualities").map(Number);
    if (!qualities.length) {
      d.querySelector("#settings-message")!.textContent =
        "Select at least one quality.";
      return;
    }
    const next = {
      ...state.settings,
      theme: f.get("theme") as typeof s.theme,
      source: "all" as const,
      sourceMode: f.get("sourceMode") as "auto" | "manual",
      audio: String(f.get("audio")),
      subtitles: String(f.get("subtitles")),
      qualities,
      autoSkip: f.has("autoSkip"),
      autoSkipRecaps: f.has("autoSkipRecaps"),
      prepareNext: f.has("prepareNext"),
      compactView: f.has("compactView"),
      showEpisodeName: f.has("showEpisodeName"),
      blurUnwatched: f.has("blurUnwatched"),
      hideOpenMyAnimeList: f.has("hideOpenMyAnimeList"),
      subtitleShadow: f.has("subtitleShadow"),
      subtitleSize: Number(f.get("subtitleSize")),
      subtitlePosition: Number(f.get("subtitlePosition")),
      subtitleColour: String(f.get("subtitleColour")),
      subtitleOutlineColour: String(f.get("subtitleOutlineColour")),
      autoNext: f.has("autoNext"),
      discordPresence: f.has("discordPresence"),
      privateSession: f.has("privateSession"),
      autoUpdates: f.has("autoUpdates"),
      showAdult: f.has("showAdult"),
      hideZeroSeeds: f.has("hideZeroSeeds"),
      hideOpenAniList: f.has("hideOpenAniList"),
    };
    state.settings = next;
    applyTheme();
    d.querySelector("#quality-summary")!.textContent = qualities
      .map((q) => q + "p")
      .join(", ");
    saveQueue = saveQueue
      .then(() => api.settings(next))
      .then(() => {
        document
          .querySelectorAll<HTMLElement>(".private-indicator")
          .forEach((el) => (el.hidden = !next.privateSession));
      })
      .then(() => {
        message.textContent = "";
      })
      .catch(async (e) => {
        state = await api.state();
        const input = form.querySelector<HTMLInputElement>(
          '[name="privateSession"]',
        );
        if (input) input.checked = !!state.settings.privateSession;
        error(e);
      });
  };
  form
    .querySelectorAll<HTMLElement>(".subtitle-stepper[data-setting]")
    .forEach((stepper) => {
      const input = stepper.querySelector<HTMLInputElement>("input")!;
      const size = input.name === "subtitleSize";
      const min = size ? 50 : 0,
        max = size ? 250 : 100,
        step = size ? 5 : 1;
      const update = () => {
        stepper.querySelector("output")!.textContent = input.value + "%";
        stepper
          .querySelectorAll<HTMLButtonElement>("button")
          .forEach((button) => {
            button.disabled =
              Number(button.dataset.step) < 0
                ? Number(input.value) <= min
                : Number(input.value) >= max;
          });
      };
      stepper.querySelectorAll<HTMLButtonElement>("button").forEach(
        (button) =>
          (button.onclick = () => {
            input.value = String(
              Math.max(
                min,
                Math.min(
                  max,
                  Number(input.value) + Number(button.dataset.step) * step,
                ),
              ),
            );
            update();
            save();
          }),
      );
      update();
    });
  form.onchange = (event) => {
    const input = event.target as HTMLInputElement;
    if (input.dataset.colourHex && input.checkValidity()) {
      input.value = "#" + input.value.replace(/^#/, "").toLowerCase();
      form.querySelector<HTMLInputElement>(
        `[name="${input.dataset.colourHex}"]`,
      )!.value = input.value;
    } else if (input.type === "color") {
      form.querySelector<HTMLInputElement>(
        `[data-colour-hex="${input.name}"]`,
      )!.value = input.value;
    }
    if (input.name === "subtitles" || input.name === "subtitleLanguage") {
      form
        .querySelectorAll<HTMLSelectElement>(
          '[name="subtitles"], [name="subtitleLanguage"]',
        )
        .forEach((select) => (select.value = input.value));
    }
    if (form.reportValidity()) save();
  };
  d.querySelector<HTMLFormElement>("form")!.onsubmit = (e) =>
    e.preventDefault();
  const check = d.querySelector<HTMLButtonElement>("#check-updates")!;
  let latestUpdate: import("./shared").UpdateStatus = {
    busy: false,
    message: "",
  };
  let updateToast: ReturnType<typeof showToast> | undefined;
  const showUpdate = (
    status: import("./shared").UpdateStatus,
    notify = true,
  ) => {
    latestUpdate = status;
    check.disabled = status.busy;
    check.textContent =
      status.available || status.installing
        ? "Update now"
        : "Check for updates";
    check.classList.toggle("update-ready", !!status.available && !status.busy);
    if (notify && status.message && d.open) {
      const text =
        status.message +
        (status.percent === undefined ? "" : " " + status.percent + "%");
      if (updateToast?.element.isConnected)
        updateToast.update(text, status.busy);
      else updateToast = showToast(text, d, status.busy);
      updateToast.element.classList.toggle("loading", status.busy);
    }
  };
  const unsubscribeUpdate = api.onUpdateStatus(showUpdate);
  void api
    .updateStatus()
    .then((status) => showUpdate(status, false))
    .catch(error);
  check.onclick = () =>
    void run(async () => {
      await saveQueue;
      const install = latestUpdate.available;
      showUpdate({
        busy: true,
        installing: install,
        message: install ? "Updating…" : "Checking for updates…",
      });
      try {
        showUpdate(await (install ? api.installUpdate() : api.checkUpdates()));
      } catch (e) {
        showUpdate({
          busy: false,
          available: install,
          message: e instanceof Error ? e.message : "The update failed.",
        });
      }
    });
  d.onclose = () => {
    changelogRequest++;
    unsubscribeUpdate();
    dismissToast();
    save();
    d.onclose = null;
    void saveQueue.then(() => {
      if (route === "series") renderEpisodes();
      if (initialAdult === state.settings.showAdult) return;
      if (!state.settings.showAdult)
        document
          .querySelectorAll('[data-adult="true"]')
          .forEach((el) => el.remove());
      if (route === "home") void home();
      else if (route === "discover") void discover(page);
      else if (route === "history") void watchlist();
    });
  };
  for (const kind of ["cache", "history"] as const)
    d.querySelector<HTMLElement>("#clear-" + kind)!.onclick = () =>
      run(async () => {
        await api.clear(kind);
        state = await api.state();
        d.querySelector("#settings-message")!.textContent =
          kind === "cache"
            ? "Downloaded cache cleared."
            : "Watch history cleared.";
        if (route === "history") await watchlist();
      });
}

function editMarker() {
  if (!playback) return;
  const p = playback;
  const d = dialog(
    `<h2 id="dialog-title">Confirm skip times</h2><p>Save times for this exact release and file. Use these times for this file.</p><form id="marker-form"><label>Segment<select id="segment">${Object.entries(
      names,
    )
      .map(([v, n]) => `<option value="${v}">${n}</option>`)
      .join(
        "",
      )}</select></label><div class="field-pair"><label>Start, seconds<input id="start" type="number" min="0" max="${p.duration}" step="0.1" value="${Math.floor(p.position)}" required></label><label>End, seconds<input id="end" type="number" min="0" max="${p.duration}" step="0.1" value="${Math.min(Math.floor(p.position + 90), p.duration)}" required></label></div><button class="primary">Save confirmed times</button></form>`,
  );
  const select = d.querySelector<HTMLSelectElement>("#segment")!;
  select.onchange = () => {
    const m = p.markers.find((m) => m.type === select.value);
    if (m) {
      d.querySelector<HTMLInputElement>("#start")!.value = String(m.start);
      d.querySelector<HTMLInputElement>("#end")!.value = String(m.end);
    }
  };
  d.querySelector<HTMLFormElement>("form")!.onsubmit = (e) => {
    e.preventDefault();
    void run(async () => {
      await api.marker({
        type: select.value as SegmentType,
        start: Number(d.querySelector<HTMLInputElement>("#start")!.value),
        end: Number(d.querySelector<HTMLInputElement>("#end")!.value),
        confirmed: true,
      });
      d.close();
    });
  };
}
async function start() {
  if (!api) {
    root.innerHTML =
      '<main class="empty"><h1>Nen</h1><p>Open Nen with npm run dev. The desktop bridge is required for provider requests and playback.</p></main>';
    return;
  }
  const splash = document.createElement("div");
  let animation: ReturnType<typeof setInterval> | undefined;
  if (!playerMode) {
    splash.className = "startup";
    splash.innerHTML =
      '<strong>Nen</strong><span aria-label="Loading">|</span>';
    document.body.append(splash);
    const frames = [
      "|",
      "/",
      String.fromCharCode(8212),
      String.fromCharCode(92),
    ];
    let frame = 0;
    animation = setInterval(() => {
      if (!splash.isConnected) {
        clearInterval(animation);
        return;
      }
      splash.lastElementChild!.textContent = frames[++frame % frames.length];
    }, 160);
  }
  state = await api.state();
  let lastNavigation = { direction: "", time: 0 };
  const navigate = (direction: "back" | "forward") => {
    const now = performance.now();
    if (
      lastNavigation.direction === direction &&
      now - lastNavigation.time < 200
    )
      return;
    lastNavigation = { direction, time: now };
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (dialog) {
      if (direction === "back") dialog.close();
    } else if (playerMode) {
      if (direction === "back") void run(() => api.control("stop"));
    } else void run(() => browseBack(direction));
  };
  api.onBack(navigate);
  if (api.browserHistory && !playerMode)
    window.addEventListener("popstate", (event) => {
      if (event.state?.nenVisit)
        void run(() => restoreVisit(event.state.nenVisit));
    });
  for (const event of ["mousedown", "mouseup", "auxclick"])
    document.addEventListener(
      event,
      (e) => {
        const mouse = e as MouseEvent;
        if (mouse.button !== 3 && mouse.button !== 4) return;
        e.preventDefault();
        if (event === "mouseup")
          navigate(mouse.button === 3 ? "back" : "forward");
      },
      true,
    );
  document.addEventListener(
    "keydown",
    (e) => {
      if (
        (e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) ||
        ["BrowserBack", "BrowserForward"].includes(e.key)
      ) {
        e.preventDefault();
        e.stopImmediatePropagation();
        navigate(
          e.key === "ArrowLeft" || e.key === "BrowserBack" ? "back" : "forward",
        );
      }
    },
    true,
  );
  applyTheme();
  if (playerMode) {
    const update = mountPlayer({
      menu: (event, actions) =>
        showContextMenu(
          event,
          "player-context-menu",
          "Player actions",
          actions,
        ),
      sources: (p) =>
        void run(async () => {
          if (p.mediaId && p.episode) {
            if (api.browserHistory) await api.control("sources");
            else await releasePicker(await api.media(p.mediaId), p.episode);
          }
        }),
      next: (p) =>
        void run(async () => {
          if (p.local) {
            await api.local?.next();
            return;
          }
          const room = await api.togetherState();
          if (room.connected && !room.host)
            throw Error("Only the host can choose the next episode.");
          if (p.mediaId && p.nextEpisode) {
            if (p.episode)
              state = await api.watchEdit(p.mediaId, {
                episode: p.episode,
                watched: true,
              });
            await startEpisode(
              await api.media(p.nextMediaId ?? p.mediaId),
              p.nextEpisode,
            );
          }
        }),
      edit: editMarker,
      error,
    });
    let lastSessionFailure = "";
    const showSessionFailure = (p: Playback) => {
      if (!p.error) {
        lastSessionFailure = "";
        return;
      }
      const key = `${p.mediaId}:${p.episode}:${p.error}`;
      if (key === lastSessionFailure) return;
      lastSessionFailure = key;
      void api
        .togetherState()
        .then((room) => {
          if (!room.connected || playback?.error !== p.error) return;
          const d = dialog(
            `<h2 id="dialog-title">Could not load this episode</h2><p role="alert">${esc(p.error)}</p><p>Automatic source loading failed. Pick a source manually to continue.</p><button id="manual-session-source">Choose a source manually</button>`,
          );
          d.querySelector<HTMLButtonElement>(
            "#manual-session-source",
          )!.onclick = () => {
            if (p.mediaId && p.episode)
              void run(async () =>
                releasePicker(await api.media(p.mediaId!), p.episode!),
              );
          };
        })
        .catch(error);
    };
    api.onPlayback((p) => {
      playback = p;
      const finding = document.querySelector<HTMLElement>("#finding-source");
      if (finding && p.loadingNotice) finding.textContent = p.loadingNotice;
      update(p);
      showSessionFailure(p);
    });
    const p = await api.playback();
    playback = p;
    update(p);
    showSessionFailure(p);
  } else {
    shell();
    if (api.local) void localNav().catch(error);
    api.onWatchState((value) => {
      const changed = watchViewKey(state) !== watchViewKey(value);
      state = value;
      if (!changed) return;
      if (route === "watchlist") void watchlist();
      else if (route === "home") void home();
      else if (route === "series") {
        renderEpisodes();
        updateSeriesActions();
      }
    });
    api.onPlayback((p) => {
      const finding = document.querySelector<HTMLElement>("#finding-source");
      if (finding && p.loadingNotice) finding.textContent = p.loadingNotice;
      if (!p.active)
        void api.state().then((value) => {
          state = value;
          if (route === "history") void watchlist();
          else if (route === "home") void home();
          else if (route === "series") renderEpisodes();
        });
    });
    const returnMedia = Number(
      new URLSearchParams(location.search).get("returnMedia"),
    );
    const localSource = new URLSearchParams(location.search).get("localSource");
    if (localSource && api.local)
      await localLibrary(
        localSource,
        new URLSearchParams(location.search).get("localPath") ?? "",
      );
    else if (returnMedia > 0) {
      try {
        const saved = JSON.parse(
          sessionStorage.getItem("browse-return") ?? "null",
        );
        if (saved) {
          mode = saved.mode;
          query = saved.query;
          page = saved.page;
          route = saved.route ?? saved.seriesReturn;
          seriesReturn = saved.seriesReturn;
          visits = saved.visits ?? [];
          forwardVisits = saved.forwardVisits ?? [];
          if (route !== "series") visits.push({ route, mode, query, page });
          goingBack = true;
        }
      } catch {}
      await openMedia(returnMedia);
      goingBack = false;
    } else if (api.browserHistory && history.state?.nenVisit)
      await restoreVisit(history.state.nenVisit);
    else if (new URLSearchParams(location.search).has("together"))
      showTogether();
    else await home();
    if (new URLSearchParams(location.search).has("profileSwitched"))
      showToast(`Switched to ${activeProfileName()}.`);
    clearInterval(animation);
    splash.classList.add("finished");
    setTimeout(() => splash.remove(), 300);
    let startupToast: ReturnType<typeof showToast> | undefined;
    let lastUpdateNotice = "";
    const notifyUpdate = (status: import("./shared").UpdateStatus) => {
      if (
        document.querySelector("dialog[open] #settings") ||
        (!status.installing && !status.available)
      )
        return;
      const text =
        status.message +
        (status.percent === undefined ? "" : " " + status.percent + "%");
      if (!text || text === lastUpdateNotice) return;
      lastUpdateNotice = text;
      if (startupToast?.element.isConnected) startupToast.update(text, true);
      else
        startupToast = showToast(
          status.available && !status.busy
            ? "New update available. Open Settings to update Nen."
            : text,
          document.querySelector<HTMLDialogElement>("dialog[open]") ??
            document.body,
          true,
        );
      startupToast.element.classList.toggle("loading", status.busy);
    };
    api.onUpdateStatus(notifyUpdate);
    void api
      .startupUpdate()
      .then(notifyUpdate)
      .catch(() => {});
  }
}
void start().catch((e) => {
  document.querySelector(".startup")?.remove();
  root.textContent = `Nen could not start: ${(e as Error).message}`;
});

function bindListPage(section: HTMLElement, expanded = false) {
  const cards = [...section.querySelectorAll<HTMLElement>(".list-card")];
  const key = section.id || section.querySelector("h2")?.textContent || "list";
  const saved = position().lists[key];
  let page = Math.min(
      saved?.page ?? 0,
      Math.max(0, Math.ceil(cards.length / 9) - 1),
    ),
    all = expanded || (saved?.all ?? false);
  const update = () => {
    position().lists[key] = { page, all };
    cards.forEach(
      (card, i) => (card.hidden = !all && Math.floor(i / 9) !== page),
    );
    section
      .querySelectorAll<HTMLButtonElement>("[data-list-step]")
      .forEach((button) => {
        button.disabled =
          all ||
          (Number(button.dataset.listStep) < 0
            ? page === 0
            : (page + 1) * 9 >= cards.length);
      });
    const button = section.querySelector<HTMLButtonElement>("[data-list-all]")!;
    if (button) {
      button.hidden = cards.length <= 9;
      button.textContent = all ? "Show less" : "View all";
    }
  };
  section.querySelectorAll<HTMLButtonElement>("[data-list-step]").forEach(
    (button) =>
      (button.onclick = () => {
        page += Number(button.dataset.listStep);
        update();
      }),
  );
  section
    .querySelector<HTMLButtonElement>("[data-list-all]")
    ?.addEventListener("click", () => {
      all = !all;
      update();
    });
  update();
}

async function newEpisodes(token: number) {
  const ids = Object.values(state.watch)
    .filter((e) => ["CURRENT", "PLANNING", "REPEATING"].includes(e.status))
    .map((e) => e.mediaId);
  const available: Media[] = [];
  try {
    for (let i = 0; i < ids.length; i += 50) {
      const rows = await api.airing(ids.slice(i, i + 50));
      if (token !== request || route !== "home") return;
      available.push(
        ...rows.filter((m) => {
          const aired = m.airingSchedule?.nodes[0];
          const count = state.watch[m.id]?.count ?? 0;
          return (
            aired &&
            aired.airingAt <= Date.now() / 1000 &&
            aired.episode > count &&
            !state.progress[`${m.id}:${aired.episode}`]?.watched &&
            !state.watch[m.id]?.runs.at(-1)?.episodes[String(aired.episode)]
              ?.watched &&
            (state.settings.showAdult || !m.isAdult)
          );
        }),
      );
    }
    if (!available.length || token !== request) return;
    available.sort(
      (a, b) =>
        b.airingSchedule!.nodes[0].airingAt -
        a.airingSchedule!.nodes[0].airingAt,
    );
    const shelf = document.createElement("section");
    shelf.className = "home-section";
    shelf.id = "new-episodes";
    shelf.dataset.shelf = "New episodes";
    shelf.innerHTML = `<div class="section-heading"><h2>New episodes</h2><div class="actions"><button class="square-button" data-list-step="-1" aria-label="Previous new episodes">${uiIcon("left")}</button><button class="square-button" data-list-step="1" aria-label="Next new episodes">${uiIcon("right")}</button></div></div><div class="home-grid">${available.map((m) => '<div class="list-card">' + card(m) + "</div>").join("")}</div>`;
    document.querySelector("#main")!.append(shelf);
    applyShelfLayout("home");
    bindMedia(shelf);
    bindListPage(shelf);
  } catch {
    /* The shelf stays hidden when airing data is unavailable. */
  }
}

const homeGenres = [
  "Trending",
  "Action",
  "Romance",
  "Adventure",
  "Comedy",
  "Drama",
  "Fantasy",
  "Sci-Fi",
  "Mystery",
  "Sports",
  "Slice of Life",
  "Supernatural",
  "Thriller",
  "Horror",
  "Music",
  "Psychological",
  "Mecha",
].map((name) => [name, name === "Trending" ? "" : `genre:${name}`]);
const shelfEditButton = `<button id="edit-shelves" class="square-button" aria-label="Edit shelves" title="Edit shelves"><svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M4 7h16M4 17h16M8 4v6M16 14v6"/></svg></button>`;
function localLists() {
  const lists = state.settings.customLists ?? [];
  return lists.filter((list) => list.id !== "watch-later");
}
function shelfOptions(page: "home" | "watchlist"): [string, string][] {
  return page === "home"
    ? [
        "Continue watching",
        "New episodes",
        "Trending",
        "Following",
        ...homeGenres.slice(1).map(([name]) => name),
      ].map((name) => [name, name === "Following" ? "Friends watching" : name])
    : [
        ["CURRENT", "Continue watching"],
        ["PLANNING", "Watch Later"],
        ["Following", "Friends watching"],
        ["PAUSED", "Paused"],
        ["DROPPED", "Dropped"],
        ["FAVORITES", "Favorites"],
        ["COMPLETED", "Completed"],
        ...localLists()
          .filter((l) => l.id !== "watch-later")
          .map((l) => [l.id, l.name] as [string, string]),
      ];
}
function shelfHidden(page: "home" | "watchlist", id: string) {
  const layout = state.settings.shelfLayouts?.[page];
  return layout
    ? layout.hidden.includes(id)
    : page === "home" && homeGenres.slice(4).some(([name]) => name === id);
}
function applyShelfLayout(page: "home" | "watchlist") {
  const main = document.querySelector("#main")!;
  const defaults = shelfOptions(page).map(([id]) => id);
  const order = [
    ...new Set([
      ...(state.settings.shelfLayouts?.[page]?.order ?? []),
      ...defaults,
    ]),
  ];
  const sections = [...main.querySelectorAll<HTMLElement>("[data-shelf]")];
  sections.sort(
    (a, b) => order.indexOf(a.dataset.shelf!) - order.indexOf(b.dataset.shelf!),
  );
  for (const section of sections) {
    if (shelfHidden(page, section.dataset.shelf!)) section.hidden = true;
    main.append(section);
  }
}
async function saveLibrary(next: State["settings"]) {
  await api.settings(next);
  state.settings = next;
}
function savedCard(m: SavedTitle) {
  return `<article class="list-card"><button class="poster" data-media="${m.id}"><div class="cover"><img src="${esc(m.cover)}" alt="" loading="lazy"></div><h3>${esc(m.name)}</h3></button></article>`;
}
function nameList(id?: string) {
  const existing = localLists().find((l) => l.id === id);
  const d = dialog(
    `<h2 id="dialog-title">${id ? "Rename list" : "New list"}</h2><form id="list-name-form"><label>List name<input id="list-name" maxlength="60" required value="${esc(existing?.name ?? "")}"></label><button type="submit">${id ? "Save" : "Create"}</button></form>`,
  );
  const input = d.querySelector<HTMLInputElement>("#list-name")!;
  input.focus();
  d.querySelector<HTMLFormElement>("form")!.onsubmit = (e) => {
    e.preventDefault();
    void run(async () => {
      const name = input.value.trim();
      if (!name) {
        input.focus();
        return;
      }
      const lists = structuredClone(localLists());
      if (
        lists.some(
          (l) => l.id !== id && l.name.toLowerCase() === name.toLowerCase(),
        )
      )
        throw Error("A list with this name already exists.");
      if (existing) lists.find((l) => l.id === id)!.name = name;
      else lists.push({ id: crypto.randomUUID(), name, items: [] });
      await saveLibrary({ ...state.settings, customLists: lists });
      d.close();
      await watchlist();
    });
  };
}
function deleteList(id: string) {
  const list = localLists().find((l) => l.id === id);
  if (!list) return;
  const d = dialog(
    `<h2 id="dialog-title">Delete ${esc(list.name)}?</h2><p>This removes the custom list. Your watch history stays unchanged.</p><button id="confirm-delete-list">Delete list</button>`,
  );
  d.querySelector<HTMLElement>("#confirm-delete-list")!.onclick = () =>
    void run(async () => {
      await saveLibrary({
        ...state.settings,
        customLists: localLists().filter((l) => l.id !== id),
      });
      d.close();
      await watchlist();
    });
}
function saveTo(media: Media) {
  const lists = localLists();
  const d = dialog(
    `<h2 id="dialog-title">Save</h2><div class="save-menu"><button id="save-watch-later">Watch Later${state.watch[media.id]?.status === "PLANNING" ? " ✓" : ""}</button><label>Default lists<select id="save-default"><option value="">Choose a list</option>${watchStatuses.map(([id, name]) => `<option value="${id}">${name}${state.watch[media.id]?.status === id ? " ✓" : ""}</option>`).join("")}</select></label><label>Custom Lists<select id="save-custom" ${lists.length ? "" : "disabled"}><option value="">${lists.length ? "Choose a list" : "No custom lists"}</option>${lists.map((list) => `<option value="${list.id}">${esc(list.name)}${list.items.some((m) => m.id === media.id) ? " ✓ (remove)" : ""}</option>`).join("")}</select></label></div>`,
  );
  const status = async (value: WatchStatus) => {
    state = await api.watchEdit(media.id, { status: value });
    d.close();
    updateSeriesActions();
    showToast("Watch list updated.");
    if (route === "watchlist") await watchlist();
  };
  d.querySelector<HTMLButtonElement>("#save-watch-later")!.onclick = () =>
    void run(() => status("PLANNING"));
  d.querySelector<HTMLSelectElement>("#save-default")!.onchange = (e) => {
    const value = (e.target as HTMLSelectElement).value as WatchStatus;
    if (value) void run(() => status(value));
  };
  d.querySelector<HTMLSelectElement>("#save-custom")!.onchange = (e) =>
    void run(async () => {
      const next = structuredClone(localLists());
      const list = next.find(
        (l) => l.id === (e.target as HTMLSelectElement).value,
      );
      if (!list) return;
      const exists = list.items.some((m) => m.id === media.id);
      list.items = list.items.filter((m) => m.id !== media.id);
      if (!exists)
        list.items.push({
          id: media.id,
          name: title(media),
          cover: media.coverImage.large,
          isAdult: !!media.isAdult,
        });
      await saveLibrary({ ...state.settings, customLists: next });
      d.close();
      showToast(`${exists ? "Removed from" : "Saved to"} ${list.name}.`);
      if (route === "watchlist") await watchlist();
    });
}
function bindShelfEditor(page: "home" | "watchlist") {
  document.querySelector<HTMLElement>("#edit-shelves")!.onclick = () => {
    const options = shelfOptions(page);
    const ids = options.map(([id]) => id);
    let order = [
      ...new Set([
        ...(state.settings.shelfLayouts?.[page]?.order ?? []).filter((id) =>
          ids.includes(id),
        ),
        ...ids,
      ]),
    ];
    const hidden = new Set(ids.filter((id) => shelfHidden(page, id)));
    let dragged: HTMLElement | undefined;
    const d = dialog(
      `<h2 id="dialog-title">Edit shelves</h2><p>Drag shelves to change their order or move them to Hidden.</p><div id="shelf-editor"></div>`,
    );
    const editor = d.querySelector<HTMLElement>("#shelf-editor")!;
    const positions = () =>
      new Map(
        [...editor.querySelectorAll<HTMLElement>("[data-id]")].map((row) => [
          row.dataset.id!,
          row.getBoundingClientRect(),
        ]),
      );
    const animate = (before: Map<string, DOMRect>) => {
      if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
      editor.querySelectorAll<HTMLElement>("[data-id]").forEach((row) => {
        if (row === dragged) return;
        const old = before.get(row.dataset.id!),
          next = row.getBoundingClientRect();
        if (old && (old.top !== next.top || old.left !== next.left))
          row.animate(
            [
              {
                transform: `translate(${old.left - next.left}px,${old.top - next.top}px)`,
              },
              { transform: "none" },
            ],
            { duration: 180, easing: "ease-out" },
          );
      });
    };
    const readOrder = () => {
      order = [...editor.querySelectorAll<HTMLElement>("[data-id]")].map(
        (row) => row.dataset.id!,
      );
      hidden.clear();
      editor
        .querySelectorAll<HTMLElement>('[data-hidden="true"] [data-id]')
        .forEach((row) => hidden.add(row.dataset.id!));
    };
    const render = () => {
      const before = positions();
      editor.innerHTML = [false, true]
        .map(
          (isHidden) =>
            `<section class="shelf-drop-zone" data-hidden="${isHidden}"><h3>${isHidden ? "Hidden" : "Visible"}</h3><div class="shelf-rows">${order
              .filter((id) => hidden.has(id) === isHidden)
              .map(
                (id, i, group) =>
                  `<div class="shelf-order-row" draggable="true" tabindex="0" data-id="${id}" aria-label="${esc(options.find((o) => o[0] === id)![1])}. Press Space to ${isHidden ? "show" : "hide"}."><span class="drag-handle" aria-hidden="true">⠿</span><span>${esc(options.find((o) => o[0] === id)![1])}</span>${isHidden ? "" : `<div class="actions"><button data-move="-1" aria-label="Move up" ${i === 0 ? "disabled" : ""}>↑</button><button data-move="1" aria-label="Move down" ${i === group.length - 1 ? "disabled" : ""}>↓</button></div>`}</div>`,
              )
              .join("")}</div></section>`,
        )
        .join("");
      animate(before);
      editor.querySelectorAll<HTMLElement>("[data-id]").forEach((row) => {
        const id = row.dataset.id!;
        row.ondragstart = (e) => {
          dragged = row;
          e.dataTransfer!.setData("text/plain", id);
          e.dataTransfer!.effectAllowed = "move";
          requestAnimationFrame(() => row.classList.add("dragging"));
        };
        row.ondragend = () => {
          readOrder();
          dragged = undefined;
          render();
        };
        row.onkeydown = (e) => {
          if (e.target !== row || e.code !== "Space") return;
          e.preventDefault();
          hidden.has(id) ? hidden.delete(id) : hidden.add(id);
          render();
          editor.querySelector<HTMLElement>(`[data-id="${id}"]`)?.focus();
        };
        row.querySelectorAll<HTMLButtonElement>("[data-move]").forEach(
          (b) =>
            (b.onclick = () => {
              const group = order.filter((x) => !hidden.has(x));
              const other = group[group.indexOf(id) + Number(b.dataset.move)];
              if (!other) return;
              const a = order.indexOf(id),
                c = order.indexOf(other);
              [order[a], order[c]] = [order[c], order[a]];
              render();
            }),
        );
      });
      editor
        .querySelectorAll<HTMLElement>(".shelf-drop-zone")
        .forEach((zone) => {
          zone.ondragover = (e) => {
            if (!dragged) return;
            e.preventDefault();
            const rows = zone.querySelector<HTMLElement>(".shelf-rows")!;
            const target = [
              ...rows.querySelectorAll<HTMLElement>("[data-id]"),
            ].find(
              (row) =>
                row !== dragged &&
                e.clientY <
                  row.getBoundingClientRect().top + row.offsetHeight / 2,
            );
            if (
              dragged.parentElement === rows &&
              dragged.nextElementSibling === (target ?? null)
            )
              return;
            editor
              .querySelectorAll<HTMLElement>("[data-id]")
              .forEach((row) =>
                row.getAnimations().forEach((animation) => animation.finish()),
              );
            const before = positions();
            rows.insertBefore(dragged, target ?? null);
            animate(before);
            const bounds = editor.getBoundingClientRect();
            if (e.clientY < bounds.top + 35) editor.scrollTop -= 15;
            if (e.clientY > bounds.bottom - 35) editor.scrollTop += 15;
          };
          zone.ondrop = (e) => {
            if (dragged) {
              e.preventDefault();
              readOrder();
            }
          };
        });
    };
    render();
    d.onclose = () =>
      void run(async () => {
        readOrder();
        try {
          await saveLibrary({
            ...state.settings,
            shelfLayouts: {
              ...state.settings.shelfLayouts,
              [page]: { order, hidden: [...hidden] },
            },
          });
        } catch (e) {
          if (d.isConnected) d.showModal();
          throw e;
        }
        await (page === "home" ? home() : watchlist());
      });
  };
}
async function followingShelf(token: number, expanded = false) {
  const onHome = route === "home";
  if (!state.anilist.connected) return;
  const shelf = document.createElement("section");
  shelf.className = "home-section";
  shelf.dataset.shelf = "Following";
  shelf.innerHTML = `<div class="section-heading"><h2>Friends watching</h2><div class="actions">${onHome ? `<button class="quiet" data-following-more>View more ${uiIcon("right")}</button>` : `<button data-list-all>View all</button>`}<button data-list-step="-1" aria-label="Previous friends' titles">${uiIcon("left")}</button><button data-list-step="1" aria-label="Next friends' titles">${uiIcon("right")}</button></div></div><div class="home-grid"><p class="loading">Loading friends' anime…</p></div>`;
  document.querySelector("#main")!.append(shelf);
  applyShelfLayout(route === "watchlist" ? "watchlist" : "home");
  shelf
    .querySelector<HTMLButtonElement>("[data-following-more]")
    ?.addEventListener("click", () => void watchlist("Following"));
  const grid = shelf.querySelector<HTMLElement>(".home-grid")!;
  const load = async () => {
    try {
      const data = (
        await friendsData(() => {
          if (token === request && shelf.isConnected) void load();
        })
      ).filter((row) => state.settings.showAdult || !row.media.isAdult);
      if (token !== request || !shelf.isConnected) return;
      grid.innerHTML =
        data
          .map(
            ({ media }) =>
              `<article class="list-card following-card">${card(media)}</article>`,
          )
          .join("") ||
        `<p class="muted">No anime found. This shelf shows public watching and rewatching lists from people you follow on AniList.</p>`;
      bindMedia(shelf);
      bindListPage(shelf, expanded);
      if (expanded) {
        shelf.hidden = false;
        shelf.scrollIntoView({ block: "start" });
      }
    } catch (e) {
      if (token !== request || !shelf.isConnected) return;
      grid.innerHTML = `<p class="muted">Friends' anime could not be loaded.</p><button class="retry-following">Retry</button>`;
      grid.querySelector<HTMLButtonElement>("button")!.onclick = () => {
        grid.innerHTML = '<p class="loading">Loading…</p>';
        void load();
      };
      showToast(e instanceof Error ? e.message : String(e));
    }
  };
  await load();
}

function readEpisodeCache(id: number) {
  try {
    const saved = JSON.parse(
      localStorage.getItem(`nen-episodes-v1-${id}`) || "null",
    );
    if (
      !saved ||
      !Array.isArray(saved.data?.items) ||
      !saved.data.items.every(
        (item: import("./shared").EpisodeInfo) =>
          Number.isInteger(item.number) &&
          typeof item.title === "string" &&
          (!item.thumbnail || /^https:\/\//.test(item.thumbnail)),
      )
    )
      return undefined;
    episodeCache.set(id, saved);
    return saved as { data: EpisodePage; expires: number };
  } catch {
    return undefined;
  }
}
function writeEpisodeCache(id: number) {
  try {
    const index: number[] = JSON.parse(
      localStorage.getItem("nen-episode-cache-index") || "[]",
    );
    const next = [...index.filter((n) => n !== id), id];
    while (next.length > 50)
      localStorage.removeItem(`nen-episodes-v1-${next.shift()}`);
    localStorage.setItem(
      `nen-episodes-v1-${id}`,
      JSON.stringify(episodeCache.get(id)),
    );
    localStorage.setItem("nen-episode-cache-index", JSON.stringify(next));
  } catch {
    /* Cached details remain available in memory if disk storage is full. */
  }
}
type Friends = import("./shared").FollowingTitle[];
const friendRequests = new Map<string, Promise<Friends>>();
const friendCache = new Map<string, { expires: number; data: Friends }>();
function friendKey() {
  return `${state.profiles?.active ?? "web"}:${state.anilist.user ?? ""}`;
}
async function friendsData(onRefresh?: () => void): Promise<Friends> {
  if (!state.anilist.connected) return [];
  const key = friendKey();
  let cached = friendCache.get(key);
  if (!cached) {
    try {
      const saved = JSON.parse(
        localStorage.getItem(`nen-friends-v1-${key}`) || "null",
      );
      if (
        saved?.expires > Date.now() - 7 * 86400000 &&
        Array.isArray(saved.data)
      ) {
        cached = saved;
        friendCache.set(key, saved);
      }
    } catch {}
  }
  if (cached && cached.expires > Date.now()) return cached.data;
  const pending =
    friendRequests.get(key) ??
    api
      .following()
      .then((data) => {
        const value = { data, expires: Date.now() + 5 * 60000 };
        friendCache.set(key, value);
        try {
          localStorage.setItem(`nen-friends-v1-${key}`, JSON.stringify(value));
        } catch {}
        return data;
      })
      .finally(() => friendRequests.delete(key));
  friendRequests.set(key, pending);
  if (cached) {
    void pending
      .then(() => {
        if (key === friendKey()) onRefresh?.();
      })
      .catch(() => {});
    return cached.data;
  }
  return pending;
}
const friendCovers = new Set<HTMLElement>();
function fitFriends(cover: HTMLElement) {
  const group = cover.querySelector<HTMLElement>(".following-avatars");
  if (!group) return;
  const available =
    cover.clientWidth -
    (cover.querySelector<HTMLElement>(".score")?.offsetWidth ?? 28) -
    22;
  const avatars = [...group.querySelectorAll<HTMLElement>(".friend-avatar")];
  const overlap = avatars.length > 4;
  group.classList.toggle("overlap", overlap);
  avatars.forEach((avatar, i) => {
    avatar.hidden = 28 + i * (overlap ? 15 : 32) > available;
  });
}
const friendResize = new ResizeObserver((entries) =>
  entries.forEach((entry) => fitFriends(entry.target as HTMLElement)),
);
async function decorateFriends(container: ParentNode) {
  const key = friendKey();
  for (const cover of friendCovers)
    if (!cover.isConnected) {
      friendResize.unobserve(cover);
      friendCovers.delete(cover);
    }
  if (!state.anilist.connected) {
    container
      .querySelectorAll(".following-avatars")
      .forEach((el) => el.remove());
    return;
  }
  let data: Friends;
  try {
    data = await friendsData(() => {
      void decorateFriends(container);
    });
  } catch {
    return;
  }
  if (key !== friendKey() || !state.anilist.connected) return;
  const users = new Map(data.map((row) => [row.media.id, row.users]));
  container.querySelectorAll<HTMLElement>(".cover").forEach((cover) => {
    if (!cover.isConnected) return;
    const card = cover.closest<HTMLElement>(
      "[data-media],[data-continue],[data-resume]",
    );
    const id = Number(
      card?.dataset.media ||
        card?.dataset.continue ||
        card?.dataset.resume?.split(":")[0],
    );
    cover.querySelector(".following-avatars")?.remove();
    const watching = users.get(id);
    if (!watching?.length) return;
    const group = document.createElement("div");
    group.className = "following-avatars";
    group.innerHTML = watching
      .map(
        (user) =>
          `<span class="friend-avatar" tabindex="0" aria-label="${esc(user.name)} is watching"><img src="${esc(user.avatar.medium)}" alt=""><span role="tooltip" class="friend-tooltip">${esc(user.name)}</span></span>`,
      )
      .join("");
    group.onclick = (e) => {
      e.stopPropagation();
      e.preventDefault();
    };
    cover.append(group);
    friendCovers.add(cover);
    friendResize.observe(cover);
    fitFriends(cover);
  });
}

function bindShelfDice(container: ParentNode) {
  const sections = new Set<HTMLElement>(
    container.querySelectorAll<HTMLElement>(".home-section"),
  );
  if (container instanceof Element) {
    const section = container.closest<HTMLElement>(".home-section");
    if (section) sections.add(section);
  }
  for (const section of sections) {
    const heading = section.querySelector(".section-heading h2");
    if (!heading || section.querySelector(".shelf-dice")) continue;
    const button = document.createElement("button");
    button.className = "square-button shelf-dice";
    button.setAttribute(
      "aria-label",
      "Play a random title from " + heading.textContent,
    );
    button.innerHTML =
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="8" cy="8" r="1"/><circle cx="16" cy="8" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="8" cy="16" r="1"/><circle cx="16" cy="16" r="1"/></svg>';
    heading.after(button);
    button.onclick = () =>
      void run(async () => {
        const items = [
          ...section.querySelectorAll<HTMLElement>(
            "[data-resume],[data-continue],[data-media]",
          ),
        ];
        const candidates = items.filter(
          (item, i) =>
            items.findIndex(
              (other) =>
                (other.dataset.media ||
                  other.dataset.continue ||
                  other.dataset.resume?.split(":")[0]) ===
                (item.dataset.media ||
                  item.dataset.continue ||
                  item.dataset.resume?.split(":")[0]),
            ) === i,
        );
        if (!candidates.length) {
          showToast("No titles available in this shelf.");
          return;
        }
        const item = candidates[Math.floor(Math.random() * candidates.length)];
        if (item.dataset.resume || item.dataset.continue) {
          item.click();
          return;
        }
        const id = Number(item.dataset.media),
          media = await api.media(id);
        const entry = state.watch[String(id)];
        const recent = Object.values(state.progress)
          .filter((p) => p.mediaId === id && !p.watched)
          .sort((a, b) => b.updated - a.updated)[0];
        const episode =
          entry?.status === "COMPLETED"
            ? 1
            : (recent?.episode ??
              Math.min(media.episodes || Infinity, (entry?.count || 0) + 1));
        if (episodeAvailability(media, episode).released === false) {
          showToast("This episode has not aired yet.");
          return;
        }
        await startEpisode(media, episode);
      });
  }
}
