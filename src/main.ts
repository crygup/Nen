import { playerNotice } from "./player-notice";
import { mountTogether } from "./together";
import { parseSearch, searchText, seasons, formats, statuses } from "./filters";
import "./style.css";
import {
  recentSeasons,
  isWatched,
  labelForEpisode,
  episodeAvailability,
  latestEpisode,
  rankReleases,
  audioLanguages,
  releaseAudio,
} from "./shared";
import { matchingFile } from "../electron/rules";
import { mountPlayer } from "./watch";
import type {
  Media,
  State,
  Release,
  Labels,
  Playback,
  SegmentType,
  EpisodePage,
  WatchEntry,
  WatchStatus,
  SyncChange,
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
const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
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
let episodeLoad = 0;
let episodeData: EpisodePage | undefined;
const playerMode = new URLSearchParams(location.search).has("player");
let playback: Playback | undefined;
let route = "home";
let seriesReturn = "home";
type BrowseVisit = {
  route: string;
  mediaId?: number;
  mode: "trending" | "season" | "search" | "romance";
  query: string;
  page: number;
};
let visits: BrowseVisit[] = [];
let forwardVisits: BrowseVisit[] = [];
let goingBack = false;
function setRoute(next: string) {
  if (!goingBack && (route !== next || next === "series")) {
    visits.push({ route, mediaId: current?.id, mode, query, page });
    forwardVisits = [];
  }
  route = next;
}
async function browseBack(direction: "back" | "forward" = "back") {
  if (goingBack) return;
  const previous = (direction === "back" ? visits : forwardVisits).pop();
  if (!previous) return;
  (direction === "back" ? forwardVisits : visits).push({ route, mediaId: current?.id, mode, query, page });
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
    else if (previous.route === "discover") await discover(page);
    else await home();
  } finally {
    goingBack = false;
  }
}
if (!playerMode)
  window.addEventListener("pagehide", () => {
    sessionStorage.setItem(
      "browse-return",
      JSON.stringify({ mode, query, page, route, seriesReturn, visits, forwardVisits }),
    );
  });
const backToList = () =>
  seriesReturn === "home"
    ? home()
    : seriesReturn === "watchlist"
      ? watchlist()
    : seriesReturn === "history"
      ? watchlist()
      : discover(page);

let dismissToast = () => {};
function showToast(message: string, parent: HTMLElement = document.body, persistent = false) {
  dismissToast();
  const toast = document.createElement("div");
  toast.className = "update-toast";
  toast.setAttribute("popover", "manual");
  toast.setAttribute("role", "status");
  toast.setAttribute("aria-live", "polite");
  toast.textContent = message;
  parent.append(toast);
  toast.showPopover();
  toast.classList.add("visible");
  let fade: ReturnType<typeof setTimeout> | undefined;
  let remove: ReturnType<typeof setTimeout> | undefined;
  const update = (text: string, keepVisible = false) => {
    clearTimeout(fade);
    clearTimeout(remove);
    toast.textContent = text;
    toast.classList.add("visible");
    if (!keepVisible) fade = setTimeout(() => {
      toast.classList.remove("visible");
      remove = setTimeout(() => toast.remove(), 250);
    }, 3000);
  };
  dismissToast = () => { clearTimeout(fade); clearTimeout(remove); toast.remove(); };
  update(message, persistent);
  return { element: toast, update };
}
function error(e: unknown) {
  const raw = e instanceof Error ? e.message : String(e);
  const text = /No matching source was found|No streams found/.test(raw)
    ? "No streams found." : raw.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, "");
  const open = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (open) {
    let message = open.querySelector<HTMLElement>(".dialog-error");
    if (!message) {
      message = document.createElement("p");
      message.className = "dialog-error notice";
      message.setAttribute("role", "alert");
      open.append(message);
    }
    message.textContent = text;
    return;
  }
  if (playerMode) { playerNotice(text); return; }
  const box = document.querySelector<HTMLElement>(
    "#message",
  )!;
  box.textContent = text;
  box.hidden = false;
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
  leaveTogetherView?.(); leaveTogetherView = undefined;
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
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${({ streaming: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 8 6 4-6 4Z"/>', account: '<circle cx="12" cy="8" r="4"/><path d="M4 21v-2a8 8 0 0 1 16 0v2"/>', together: '<circle cx="9" cy="8" r="3"/><path d="M3 21v-3a6 6 0 0 1 12 0v3M17 5a3 3 0 0 1 0 6M18 15a5 5 0 0 1 3 4v2"/>', search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>', left: '<path d="m14 5-7 7 7 7"/>', right: '<path d="m10 5 7 7-7 7"/>', refresh: '<path d="M20 7v5h-5M4 17v-5h5M19 10a7 7 0 0 0-12-5L4 8m1 6a7 7 0 0 0 12 5l3-3"/>', home: '<path d="m3 11 9-8 9 8M5 9v12h5v-7h4v7h5V9"/>', lists: '<path d="M9 6h12M9 12h12M9 18h12"/><circle cx="4" cy="6" r="1"/><circle cx="4" cy="12" r="1"/><circle cx="4" cy="18" r="1"/>', help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9a2.5 2.5 0 0 1 5 0c0 2-2.5 2-2.5 4"/><path d="M12 16v1"/>', history: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>', browse: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>' } as Record<string, string>)[name]}</svg>`;
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
  leaveTogetherView = mountTogether(main.querySelector<HTMLElement>("#together-lobby")!, () => void home(), false, (id, ep) => void run(async () => releasePicker(await api.media(id), ep)));
}
function shell() {
  root.innerHTML = `<aside class="sidebar"><nav aria-label="Main"><button data-nav="home">${uiIcon("home")} Home</button><button data-nav="watchlist">${uiIcon("lists")} Lists</button><button data-nav="together">${uiIcon("together")} Watch together</button><button data-nav="browse">${uiIcon("browse")} Browse</button></nav><div class="sidebar-bottom"><button data-nav="help">${uiIcon("help")} Help</button><button data-nav="settings">${uiIcon("settings")} Settings</button></div></aside><div class="workspace"><header class="topbar"><div id="page-title"></div><form id="search" role="search"><label class="sr-only" for="search-input">Search anime</label>${uiIcon("search")}<input id="search-input" type="text" role="combobox" aria-autocomplete="list" aria-controls="search-suggestions" aria-expanded="false" placeholder="Search for anime" autocomplete="off" maxlength="200"><button type="button" id="clear-search" class="square-button" aria-label="Clear search" hidden>${uiIcon("close")}</button><div id="search-suggestions" role="listbox" aria-label="Anime suggestions" hidden></div></form><div id="page-actions"></div></header><div id="message" role="alert" hidden></div><main id="main" tabindex="-1"></main></div><dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;
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
    if (!value) return;
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
  const local = recentSeasons(state.progress, state.settings.showAdult);
  const ids = new Set(local.map(([, p]) => p.mediaId));
  const imported = Object.values(state.watch).filter(e => !ids.has(e.mediaId)
    && (e.status === "CURRENT" || e.status === "REPEATING") && (state.settings.showAdult || !e.isAdult))
    .sort((a, b) => b.updated - a.updated);
  return [
    ...local.map(([key, p]) => `<article class="list-card"><div class="recent-card" data-adult="${!!p.isAdult}" data-resume="${key}"><button class="recent-play" aria-label="Play ${esc(p.title)}"><div class="cover"><img src="${esc(p.cover)}" alt="" loading="lazy"></div></button><button class="recent-title" data-open-series="${p.mediaId}">${esc(p.title)}</button><small>${esc(p.episodeTitle ?? `Episode ${p.episode}`)} &middot; ${time(p.position)} / ${time(p.duration)}</small></div>${watchEditButton(p.mediaId, p.title)}</article>`),
    ...imported.map(e => {
      const episode = Math.min(e.count + 1, e.totalEpisodes ?? Number.MAX_SAFE_INTEGER);
      return `<article class="list-card"><div class="recent-card" data-continue="${e.mediaId}" data-episode="${episode}"><button class="recent-play" aria-label="Play ${esc(e.title)}"><div class="cover"><img src="${esc(e.cover)}" alt="" loading="lazy"></div></button><button class="recent-title" data-open-series="${e.mediaId}">${esc(e.title)}</button><small>Episode ${episode}${e.totalEpisodes ? ` / ${e.totalEpisodes}` : ""}</small></div>${watchEditButton(e.mediaId, e.title)}</article>`;
    }),
  ];
}
function bindContinue(root: ParentNode) {
  root.querySelectorAll<HTMLButtonElement>("[data-open-series]").forEach(button => button.onclick = event => {
    event.stopPropagation();
    void openMedia(Number(button.dataset.openSeries));
  });
  root.querySelectorAll<HTMLElement>("[data-resume]").forEach(button => button.onclick = () => void run(() => resumeFromHistory(button.dataset.resume!)));
  root.querySelectorAll<HTMLElement>("[data-continue]").forEach(button => button.onclick = () => void run(async () => {
    const d = dialog('<h2 id="dialog-title">Continue watching</h2><p class="loading" role="status">Loading episode details…</p>');
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
  }));
  root.querySelectorAll<HTMLElement>("[data-watch-edit]").forEach(button => button.onclick = () => editWatch(Number(button.dataset.watchEdit)));
}
async function home() {
  setRoute("home");
  current = undefined;
  activeNav("home");
  const token = ++request;
  state = await api.state();
  if (token !== request) return;
  const recent = continueCards().slice(0, 9);
  const shelves = [
    ["Trending", ""],
    ["Action", "genre:Action"],
    ["Romance", "genre:Romance"],
    ["Adventure", "genre:Adventure"],
  ];
  document.querySelector("#main")!.innerHTML =
    `<div class="page-heading"><h1>Home</h1><button id="refresh-home" class="quiet square-button" aria-label="Refresh">${uiIcon("refresh")}</button></div><section class="home-section"><div class="section-heading"><h2>Continue watching</h2><button id="more-history" class="quiet">View more ${uiIcon("right")}</button></div>${recent.length ? `<div class="home-grid">${recent.join("")}</div>` : '<p class="muted">Your recent watches will appear here.</p>'}</section>${shelves.map(([name], i) => `<section class="home-section" id="shelf-${i}"><div class="section-heading"><h2>${name}</h2><div class="actions"><button class="quiet shelf-more">View more ${uiIcon("right")}</button><button class="square-button shelf-back" aria-label="Previous ${name} titles" disabled>${uiIcon("left")}</button><button class="square-button shelf-next" aria-label="Next ${name} titles">${uiIcon("right")}</button></div></div><div class="home-grid shelf-items" aria-live="polite"><p class="loading">Loading…</p></div></section>`).join("")}`;
  movePageHeading();
  document.querySelector<HTMLElement>("#more-history")!.onclick = () =>
    void watchlist();
  document.querySelector<HTMLElement>("#refresh-home")!.onclick = () =>
    void home();
  bindContinue(document.querySelector("#main")!);
  await Promise.all(
    shelves.map(async ([name, filter], i) => {
      const el = document.querySelector<HTMLElement>(`#shelf-${i}`)!;
      let shelfPage = 1;
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
          grid.innerHTML = data.media.slice(((shelfPage - 1) % 5) * 9, (((shelfPage - 1) % 5) + 1) * 9)
            .filter((m) => state.settings.showAdult || !m.isAdult)
            .map(card)
            .join("");
          el.hidden = !grid.querySelector(".poster");
          bindMedia(grid);
          prev.disabled = shelfPage === 1;
          next.disabled = !data.hasNextPage && (((shelfPage - 1) % 5) + 1) * 9 >= data.media.length;
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
        void load();
      };
      el.querySelector<HTMLElement>(".shelf-next")!.onclick = () => {
        shelfPage++;
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
    document.querySelector("#catalog-note")!.textContent = mode === "search" ? `Results for ${query}` : "";
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
  setRoute("series");
  activeNav("");
  document.querySelector("#main")!.innerHTML =
    '<p class="loading">Loading series…</p>';
  try {
    const [m, freshState] = await Promise.all([api.media(id), api.state()]);
    if (token !== request) return;
    state = freshState;
    current = m;
    labelData = undefined;
    episodeData = undefined;
    hideFiller = false;
    const latest = Object.values(state.progress)
      .filter(p => p.mediaId === id && (p.position > 0 || p.watched))
      .sort((a, b) => b.updated - a.updated)[0];
    showAllEpisodes = !!latest && latest.episode > 50;
    descendingEpisodes = false;
    renderSeries();
    if (latest) requestAnimationFrame(() => {
      if (token !== request) return;
      const row = document.querySelector<HTMLElement>(`[data-episode="${latest.episode}"]`);
      const bounds = row?.getBoundingClientRect();
      if (bounds && (bounds.bottom > innerHeight || bounds.top < 0))
        row!.scrollIntoView({ block: "center" });
    });
    void api
      .labels(m.id, m.idMal)
      .then((labels) => {
        if (token === request) {
          labelData = labels;
          renderEpisodes();
        }
      })
      .catch(() => {});
    await loadEpisodes(token);
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
async function loadEpisodes(token = request) {
  if (!current) return;
  const load = ++episodeLoad;
  const count =
    current.episodes ??
    Math.max(latestEpisode(current), current.nextAiringEpisode?.episode ?? 0);
  const numbers = Array.from(
    { length: showAllEpisodes ? count : Math.min(50, count) },
    (_, i) => (descendingEpisodes ? count - i : i + 1),
  );
  const pages = [...new Set(numbers.map((n) => Math.ceil(n / 50)))];
  for (const page of pages) {
    if (token !== request || load !== episodeLoad) return;
    try {
      const result = await api.episodes(current.id, page);
      if (token !== request || load !== episodeLoad) return;
      const items = new Map(episodeData?.items.map((e) => [e.number, e]));
      result.items.forEach((e) => items.set(e.number, e));
      episodeData = { ...result, items: [...items.values()] };
      renderEpisodes();
    } catch {}
  }
}

function renderSeries() {
  const m = current!;
  const main = document.querySelector("#main")!;
  main.innerHTML = `<button id="back" class="back">${uiIcon("left")} Back</button><article class="series"><div class="series-poster"><img class="series-cover" src="${esc(m.coverImage.large)}" alt="${esc(title(m))}"><div class="series-list-actions"><button id="watchlist-toggle"></button><button id="favorite-toggle" class="square-button" aria-label="Add to favorites"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.7l-1.1-1.1a5.5 5.5 0 0 0-7.8 7.8L12 21l8.8-8.6a5.5 5.5 0 0 0 0-7.8Z"/></svg></button></div></div><div><p class="eyebrow">${esc(format(m.format))} <span> / </span> ${m.seasonYear ?? "TBA"}</p><h1>${esc(title(m))}</h1><div class="facts"><span>${m.episodes ?? "?"} episodes</span><span>${esc(m.status.replaceAll("_", " ").toLowerCase())}</span>${m.averageScore ? `<span>${m.averageScore}% score</span>` : ""}</div><p class="synopsis">${esc(m.description?.replace(/<[^>]*>/g, "") ?? "No synopsis available.")}</p><p class="genres">${m.genres.map(esc).join(" / ")}</p></div></article><section id="episodes"></section>${
    m.relations?.edges.length
      ? `<section class="related"><h2>Related titles</h2><div class="related-list">${m.relations.edges
          .filter((e) => e.node.type === "ANIME")
          .sort((a, b) => (["SEQUEL", "PREQUEL"].includes(a.relationType) ? ["SEQUEL", "PREQUEL"].indexOf(a.relationType) : 2) - (["SEQUEL", "PREQUEL"].includes(b.relationType) ? ["SEQUEL", "PREQUEL"].indexOf(b.relationType) : 2))
          .map(
            (e) =>
              `<button data-media="${e.node.id}"><small>${esc(e.relationType.replaceAll("_", " "))} · ${esc(format(e.node.format))}</small><span>${esc(e.node.title.romaji)}</span></button>`,
          )
          .join("")}</div></section>`
      : ""
  }`;
  document.querySelector<HTMLElement>("#back")!.onclick = () =>
    void browseBack();
  bindMedia(main);
  updateSeriesActions();
  const listButton = main.querySelector<HTMLButtonElement>("#watchlist-toggle")!;
  const favoriteButton = main.querySelector<HTMLButtonElement>("#favorite-toggle")!;
  for (const button of [listButton, favoriteButton]) button.onclick = () => void run(async () => {
    listButton.disabled = favoriteButton.disabled = true;
    try {
      state = button === favoriteButton
        ? await api.favoriteSet(m.id, !state.favorites[String(m.id)])
        : state.watch[String(m.id)]?.status === "PLANNING" ? await api.watchDelete(m.id, true) : await api.watchAdd(m.id);
      if (current?.id === m.id) { updateSeriesActions(); renderEpisodes(); }
    } finally { listButton.disabled = favoriteButton.disabled = false; }
  });
  synopsisSize?.disconnect();
  const synopsis = main.querySelector<HTMLElement>(".synopsis")!;
  let previousWidth = 0;
  synopsisSize = new ResizeObserver(() => {
    if (synopsis.clientWidth === previousWidth) return;
    previousWidth = synopsis.clientWidth;
    let size = 13;
    synopsis.style.fontSize = size + "px";
    while (synopsis.scrollHeight > 210 && size > 11) {
      size -= 0.5;
      synopsis.style.fontSize = size + "px";
    }
  });
  synopsisSize.observe(synopsis);
  renderEpisodes();
}
function renderEpisodes() {
  if (!current || route !== "series") return;
  const m = current;
  const offset = state.mappings[String(m.id)];
  const count =
    m.episodes ?? Math.max(latestEpisode(m), m.nextAiringEpisode?.episode ?? 0);
  const items = Array.from(
    { length: showAllEpisodes ? count : Math.min(50, count) },
    (_, i) => {
      const n = descendingEpisodes ? count - i : i + 1;
      const meta = episodeData?.items.find((e) => e.number === n);
      return {
        n,
        title: meta?.title ?? `Episode ${n}`,
        ...episodeAvailability(m, n),
        ...labelForEpisode(labelData, n, offset, m.source === "ORIGINAL"),
      };
    },
  ).filter((e) => !hideFiller || e.status !== "filler");
  const el = document.querySelector("#episodes")!;
  el.innerHTML = `<div class="section-heading"><h2>${m.format === "MOVIE" ? "Film" : "Episodes"} </h2><div class="actions"><button id="episode-order" aria-label="Episode order">${descendingEpisodes ? "Descending" : "Ascending"}</button>${labelData?.items.some((e) => e.status === "filler") ? `<label class="check"><input id="hide-filler" type="checkbox" ${hideFiller ? "checked" : ""}> Hide filler</label>` : ""}</div></div>${labelData?.needsMapping && offset === undefined ? '<button id="mapping" class="quiet">Set episode numbering for filler labels</button>' : ""}<div class="episode-list">${items
    .map((e) => {
      const watched = state.watch[String(m.id)]?.runs.at(-1)?.episodes[String(e.n)] ?? state.progress[`${m.id}:${e.n}`];
      const future = e.released === false;
      const finished = watched?.watched === true;
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
      return `<button class="episode" data-episode="${e.n}" ${future ? "disabled" : ""}><span class="episode-number">${String(e.n).padStart(2, "0")}</span><span>${esc(e.title)}${watched ? `<small>${time(watched.position)} / ${time(watched.duration)}</small>` : ""}</span><span class="episode-badges">${finished ? '<span class="badge watched-label">Watched</span>' : ""}${badge ? `<span class="badge ${future ? "upcoming" : ""}" title="${e.status === "filler" ? "Not canon. This episode is not adapted from the original story." : e.status === "mixed" ? "Contains both canon story and filler material." : ""}">${esc(badge)}</span>` : ""}</span></button>`;
    })
    .join(
      "",
    )}</div><div class="pagination">${!showAllEpisodes && count > 50 ? '<button id="load-episodes">Load more</button>' : ""}</div>`;
  el.querySelectorAll<HTMLButtonElement>("[data-episode]").forEach(
    (b) => (b.onclick = () => void startEpisode(m, Number(b.dataset.episode))),
  );
  const filter = el.querySelector<HTMLInputElement>("#hide-filler");
  if (filter)
    filter.onchange = () => {
      hideFiller = filter.checked;
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
  const d = document.querySelector<HTMLDialogElement>("#dialog")!;
  d.innerHTML = `<div class="dialog-header"><span class="eyebrow">NEN</span><button id="close-dialog" aria-label="Close dialog">${uiIcon("close")}</button></div>${content}`;
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
    const result = await api.releases(m.id, ep);
    if (token !== pickerRequest || !d.open) return;
    const rows = rankReleases(result.items, ep, state.settings);
    d.querySelector("#releases")!.innerHTML = '<label>Audio language<select id="source-language"><option value="">All languages</option>'
      + audioLanguages.map(([code, name]) => '<option value="' + code + '">' + name + '</option>').join("")
      + '<option value="unknown">Not specified</option></select></label><div id="source-results"></div>';
    const filter = d.querySelector<HTMLSelectElement>("#source-language")!;
    const render = () => {
      const visible = rows.map((release, index) => ({ release, index })).filter(({ release }) => {
        const audio = releaseAudio(release);
        return !filter.value || (filter.value === "unknown" ? !audio.languages.length : audio.languages.includes(filter.value));
      });
      d.querySelector("#source-results")!.innerHTML = visible.length ? visible.map(({ release: r, index }) => {
        const audio = releaseAudio(r);
        const label = audio.inferred ? "Dual audio (languages unverified)" : audio.languages.length ? audioLanguages.filter(([code]) => audio.languages.includes(code)).map(([,name]) => name).join(", ") + " audio (title)" : "Audio not specified";
        return '<button class="release" data-release="' + index + '"><span class="release-title">' + esc(r.title) + '</span><span class="release-meta"><b>' + r.source + '</b><span>' + esc(r.resolution) + '</span><span>' + esc(r.size) + '</span><span>' + r.seeds + ' seeds</span><span>' + label + '</span></span></button>';
      }).join("") : '<div class="empty"><h3>No matching sources</h3><p>Try All languages or change the source in Settings.</p></div>';
      d.querySelectorAll<HTMLButtonElement>("[data-release]").forEach(button => {
        button.onclick = () => void chooseFile(m, ep, rows[Number(button.dataset.release)]);
      });
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
  if (state.watch[String(id)]?.status !== "COMPLETED") return true;
  const choice = await new Promise<string>(resolve => {
    const d = dialog(`<h2 id="dialog-title">Start a full rewatch?</h2><p>Start a new watch record, or play only this episode.</p><div class="actions"><button class="primary" data-rewatch="full">Start full rewatch</button><button data-rewatch="episode">Play this episode</button></div>`);
    d.returnValue = "";
    d.onclose = () => { d.onclose = null; resolve(d.returnValue); };
    d.querySelectorAll<HTMLButtonElement>("[data-rewatch]").forEach(button => button.onclick = () => d.close(button.dataset.rewatch));
  });
  if (choice === "full") state = await api.watchEdit(id, { startRewatch: true });
  return choice === "full" || choice === "episode";
}
async function startEpisode(m: Media, ep: number) {
  if ((await api.togetherState()).connected) { await api.autoPlay(m.id, ep); return; }
  if (episodeAvailability(m, ep).released === false) return;
  if (!await chooseRewatch(m.id)) return;
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
    d.onclose = () => { void api.control("stop").catch(() => {}); };
    await api.autoPlay(m.id, ep);
    d.onclose = null;
    if (d.open && token === pickerRequest) d.close();
  } catch (e) {
    const finding = d.querySelector<HTMLElement>("#finding-source");
    if (finding) finding.hidden = true;
    error(e);
  }
}
async function chooseFile(
  m: Media,
  ep: number,
  release: Release,
) {
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
  if (!await chooseRewatch(saved.mediaId)) return;
  const d = dialog('<h2 id="dialog-title">' + esc(saved.title) + '</h2><p class="loading" role="status">Opening ' + esc(saved.episodeTitle ?? 'episode ' + saved.episode) + '…</p>');
  const loading = d.querySelector<HTMLElement>(".loading")!;
  d.onclose = () => { void api.control("stop").catch(() => {}); };
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
const watchStatuses: [WatchStatus, string][] = [["CURRENT", "Watching"], ["REPEATING", "Rewatching"], ["COMPLETED", "Completed"], ["PAUSED", "Paused"], ["DROPPED", "Dropped"], ["PLANNING", "Planning"]];
async function watchlist() {
  setRoute("watchlist");
  activeNav("watchlist");
  state = await api.state();
  const entries = Object.values(state.watch).filter(e => state.settings.showAdult || !e.isAdult).sort((a, b) => b.updated - a.updated);
  const main = document.querySelector("#main")!;
  main.innerHTML = `<div class="page-heading"><h1>Lists</h1></div>${([["CURRENT", "Continue watching"], ["PLANNING", "Planning"], ["PAUSED", "Paused"], ["DROPPED", "Dropped"], ["FAVORITES", "Favorites"], ["COMPLETED", "Completed"]] as const).map(([status, label]) => { const name = status === "CURRENT" ? "Continue watching" : label; return `<section class="home-section"><div class="section-heading"><h2>${name}</h2><div class="actions"><button data-list-all>View all</button><button data-list-step="-1" aria-label="Previous ${name}">&#8249;</button><button data-list-step="1" aria-label="Next ${name}">&#8250;</button></div></div><div class="home-grid list-grid">${(status === "CURRENT" ? continueCards() : (status === "FAVORITES" ? Object.values(state.favorites).filter(e => state.settings.showAdult || !e.isAdult).map(e => state.watch[String(e.mediaId)] ?? e) : entries.filter(e => e.status === status)).map(e => {
    const saved = Object.values(state.progress).filter(p => p.mediaId === e.mediaId).sort((a, b) => b.updated - a.updated)[0];
    const latest = Object.entries(e.runs.at(-1)?.episodes ?? {}).sort((a, b) => b[1].updated - a[1].updated)[0];
    const episode = latest && latest[1].updated > e.countUpdated ? Number(latest[0]) : e.count;
    const info = episode > 0 ? `Episode ${episode}${e.totalEpisodes ? ` / ${e.totalEpisodes}` : ""}${saved?.episode === episode && saved.episodeTitle && saved.episodeTitle !== `Episode ${episode}` ? ` \u00b7 ${saved.episodeTitle}` : ""}` : (e.totalEpisodes ? `${e.totalEpisodes} episodes` : "Not started");
    return `<article class="list-card"><button class="poster" data-media="${e.mediaId}" aria-label="Open ${esc(e.title)}"><div class="cover"><img src="${esc(e.cover)}" alt="" loading="lazy" decoding="async"></div><h3>${esc(e.title)}</h3><p>${esc(info)}</p></button>${state.watch[String(e.mediaId)] ? watchEditButton(e.mediaId, e.title) : ""}</article>`;
  })).join("") || '<p class="muted">No anime here.</p>'}</div></section>`; }).join("")}`;
  movePageHeading();
  bindMedia(main);
  bindContinue(main);
  main.querySelectorAll<HTMLElement>(".home-section").forEach(section => {
    const cards = [...section.querySelectorAll<HTMLElement>(".list-card")];
    let page = 0, all = false;
    const update = () => {
      cards.forEach((card, i) => card.hidden = !all && Math.floor(i / 9) !== page);
      section.querySelectorAll<HTMLButtonElement>("[data-list-step]").forEach(button => {
        button.disabled = all || (Number(button.dataset.listStep) < 0 ? page === 0 : (page + 1) * 9 >= cards.length);
      });
      const button = section.querySelector<HTMLButtonElement>("[data-list-all]")!;
      button.hidden = cards.length <= 9;
      button.textContent = all ? "Show less" : "View all";
    };
    section.querySelectorAll<HTMLButtonElement>("[data-list-step]").forEach(button => button.onclick = () => { page += Number(button.dataset.listStep); update(); });
    section.querySelector<HTMLButtonElement>("[data-list-all]")!.onclick = () => { all = !all; update(); };
    update();
  });
}
function updateSeriesActions() {
  if (!current) return;
  const list = document.querySelector<HTMLButtonElement>("#watchlist-toggle");
  const favorite = document.querySelector<HTMLButtonElement>("#favorite-toggle");
  if (list) list.textContent = state.watch[String(current.id)]?.status === "PLANNING" ? "Remove from watchlist" : "Add to watchlist";
  if (favorite) {
    const selected = !!state.favorites[String(current.id)];
    favorite.setAttribute("aria-pressed", String(selected));
    favorite.setAttribute("aria-label", selected ? "Remove from favorites" : "Add to favorites");
    favorite.title = selected ? "Remove from favorites" : "Add to favorites";
  }
}
function editWatch(id: number) {
  const entry = state.watch[String(id)];
  if (!entry) return;
  const d = dialog(`<h2 id="dialog-title">${esc(entry.title)}</h2><form id="watch-form"><label>Watch status<select name="status">${watchStatuses.map(([value, name]) => `<option value="${value}" ${entry.status === value ? "selected" : ""}>${name}</option>`).join("")}</select></label><label>Episode progress<input name="count" type="number" min="0" step="1" ${entry.totalEpisodes != null ? `max="${entry.totalEpisodes}"` : ""} value="${entry.count}" required></label></form><hr><button id="delete-watch">Delete entry</button>`);
  d.querySelector<HTMLButtonElement>("#delete-watch")!.onclick = () => void run(async () => {
    state = await api.watchDelete(id);
    d.onclose = null;
    d.close();
    if (route === "home") await home();
    else if (route === "watchlist") await watchlist();
    else if (route === "series") renderEpisodes();
    showToast("Entry deleted from Nen.");
  });
  const form = d.querySelector<HTMLFormElement>("#watch-form")!;
  form.onsubmit = e => { e.preventDefault(); d.close(); };
  d.onclose = () => {
    d.onclose = null;
    const data = new FormData(form);
    const status = String(data.get("status")) as WatchStatus;
    const value = Number(data.get("count"));
    const count = Number.isFinite(value)
      ? Math.max(0, Math.min(entry.totalEpisodes ?? Number.MAX_SAFE_INTEGER, Math.floor(value))) : entry.count;
    if (status === entry.status && count === entry.count) return;
    void run(async () => {
      state = await api.watchEdit(id, { status, count });
      if (route === "watchlist") await watchlist();
      if (route === "home") await home();
      if (route === "series" && current?.id === id) renderEpisodes();
    });
  };
}
async function showSyncReview(firstConnect = false) {
  const preview = await api.anilistPreview();
  const choices: SyncChange[] = preview.changes.map(row => ({ ...row }));
  const conflicts = choices.map((row, i) => ({ row, i })).filter(({ row }) => row.conflict);
  if (!conflicts.length) {
    state = await api.anilistApply(choices);
    showToast(choices.length ? "AniList sync complete." : firstConnect ? "Connected account. No entries to sync." : "No new entries to sync.");
    if (route === "watchlist") await watchlist();
    if (route === "home") await home();
    if (route === "series") renderEpisodes();
    return;
  }
  const d = dialog(`<h2 id="dialog-title">Review AniList sync</h2><p>${conflicts.length ? "Choose which values to keep." : "No conflicts. Your lists are ready to sync."}</p><div class="sync-changes">${conflicts.map(({ row, i }) => `<div class="sync-row"><span>${esc(row.title)} - ${row.field === "count" ? "Episode progress" : row.field === "status" ? "Watch status" : "Rewatches"}</span><small>Nen: ${esc(row.local)} &middot; AniList: ${esc(row.remote)}</small><div class="actions" role="group" aria-label="Choose values for ${esc(row.title)}"><button type="button" data-choice="${i}" data-side="local" aria-pressed="${row.choice === "local"}">Use Nen</button><button type="button" data-choice="${i}" data-side="remote" aria-pressed="${row.choice === "remote"}">Use AniList</button></div></div>`).join("")}</div>${conflicts.length ? '<div class="actions sync-select-all" role="group" aria-label="Select all"><span>Select all</span><button type="button" data-select-all="local">Nen</button><button type="button" data-select-all="remote">AniList</button></div>' : ""}<button id="apply-sync" class="primary">Apply sync</button>`);
  const updateSelectAll = () => d.querySelectorAll<HTMLButtonElement>("[data-select-all]").forEach(button =>
    button.setAttribute("aria-pressed", String(conflicts.every(({ row }) => row.choice === button.dataset.selectAll))));
  updateSelectAll();
  d.querySelectorAll<HTMLButtonElement>("[data-choice]").forEach(button => {
    button.onclick = () => {
      choices[Number(button.dataset.choice)].choice = button.dataset.side as "local" | "remote";
      d.querySelectorAll<HTMLButtonElement>(`[data-choice="${button.dataset.choice}"]`).forEach(option =>
        option.setAttribute("aria-pressed", String(option === button)));
      updateSelectAll();
    };
  });
  d.querySelectorAll<HTMLButtonElement>("[data-select-all]").forEach(button => {
    button.onclick = () => d.querySelectorAll<HTMLButtonElement>(`[data-choice][data-side="${button.dataset.selectAll}"]`).forEach(option => option.click());
  });
  d.querySelector<HTMLElement>("#apply-sync")!.onclick = () => void run(async () => {
    if (choices.some(row => !row.choice)) { showToast("Choose a side for each change.", d); return; }
    state = await api.anilistApply(choices);
    d.close();
    showToast("AniList sync complete.");
    if (route === "watchlist") await watchlist();
    if (route === "home") await home();
    if (route === "series") renderEpisodes();
  });
}
function help() {
  const d = dialog(`<section id="help"><h2 id="dialog-title">Help &amp; support</h2><div class="actions"><button data-support="discord">Discord server</button><button data-support="issues">GitHub issues</button><button data-support="email">Email support</button></div><hr><h3>FAQ</h3><h4>Why are no streams found?</h4><p>Available sources may have no active seeders or no matching episode.</p><h4>Do I need an AniList account?</h4><p>No. Nen can keep your lists and progress locally.</p><h4>When does an episode count as watched?</h4><p>After more than 85% of an episode watched, or when you click onto the next episode.</p><h4>How do I report a problem?</h4><p>Use GitHub issues or our Discord server. Include your Nen version, the anime and episode, and steps to repeat the problem.</p><hr><h3>Donations</h3><div class="actions"><button data-support="donate">Donate on Ko-fi</button></div></section>`);
  d.querySelectorAll<HTMLButtonElement>("[data-support]").forEach(button => {
    button.onclick = () => void api.external(button.dataset.support as "discord" | "issues" | "email" | "donate").catch(error);
  });
}
function settings() {
  const s = state.settings;
  const languages = audioLanguages;
  const options = (value: string, sub = false) =>
    `${sub ? `<option value="no" ${value === "no" ? "selected" : ""}>Off</option>` : ""}<option value="" ${value === "" ? "selected" : ""}>Use file default</option>${languages.map(([code, name]) => `<option value="${code}" ${value.split(",")[0] === code ? "selected" : ""}>${name}</option>`).join("")}`;
  const d = dialog(
    `<h2 id="dialog-title">Settings</h2>
    <div class="settings-tabs" role="tablist" aria-orientation="vertical" aria-label="Settings">${["App", "Streaming", "Account"].map((name, i) => `<button type="button" role="tab" id="settings-tab-${name.toLowerCase()}" aria-controls="settings-${name.toLowerCase()}" aria-selected="${i === 0}" tabindex="${i === 0 ? 0 : -1}">${uiIcon(i === 0 ? "settings" : name.toLowerCase())}<span>${name}</span></button>`).join("")}</div>
    <form id="settings">
    <section id="settings-app" role="tabpanel" aria-labelledby="settings-tab-app"><label>Appearance<select name="theme">${["system", "light", "dark"].map((v) => `<option value="${v}" ${s.theme === v ? "selected" : ""}>${v === "system" ? "Use system theme" : v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select></label><label class="check"><input name="discordPresence" type="checkbox" ${s.discordPresence === true ? "checked" : ""}> Show what I’m watching on Discord</label><hr><div class="actions update-actions"><button id="check-updates" type="button">Check for updates</button><label class="check"><input id="development-builds" name="developmentBuilds" type="checkbox" ${s.developmentBuilds ? "checked" : ""}> Get beta updates</label></div></section>
    <section id="settings-streaming" role="tabpanel" aria-labelledby="settings-tab-streaming" hidden><div class="field-pair"><label>Preferred audio<select name="audio">${options(s.audio)}</select></label><label>Preferred subtitles<select name="subtitles">${options(s.subtitles, true)}</select></label></div><label>Choose a source<select name="sourceMode"><option value="auto" ${s.sourceMode !== "manual" ? "selected" : ""}>Find the best source automatically</option><option value="manual" ${s.sourceMode === "manual" ? "selected" : ""}>Always let me choose</option></select></label><label>Search sources<select name="source">${["all", "Nyaa", "Bangumi Moe"].map((v) => `<option value="${v}" ${s.source === v ? "selected" : ""}>${v === "all" ? "All sources" : v}</option>`).join("")}</select></label><label>Preferred quality</label><details class="quality-dropdown"><summary id="quality-summary">${(s.qualities ?? [1080, 720, 480, 360]).map((q) => q + "p").join(", ")}</summary><fieldset><legend class="sr-only">Allowed video qualities</legend>${[2160, 1440, 1080, 720, 480, 360].map((q) => `<label class="check"><input name="qualities" type="checkbox" value="${q}" ${(s.qualities ?? [1080, 720, 480, 360]).includes(q) ? "checked" : ""}> ${q}p${q === 2160 ? " (4K)" : ""}</label>`).join("")}</fieldset></details><label class="check"><input name="autoNext" type="checkbox" ${s.autoNext ? "checked" : ""}> Auto play next episode</label><label class="check"><input name="autoSkip" type="checkbox" ${s.autoSkip ? "checked" : ""}> Automatically skip intros and outros</label><label class="check"><input name="showAdult" type="checkbox" ${s.showAdult ? "checked" : ""}> Show NSFW content</label><label class="check"><input name="hideZeroSeeds" type="checkbox" ${s.hideZeroSeeds !== false ? "checked" : ""}> Hide videos with 0 seeders</label></section>
    <section id="settings-account" role="tabpanel" aria-labelledby="settings-tab-account" hidden></section>
    </form><p id="settings-message" role="status"></p>`, 
  );
  const version = d.querySelector(".dialog-header .eyebrow")!;
  version.innerHTML = `<strong>NEN</strong> - ${esc(state.version)}`;
  version.classList.add("settings-version");
  d.append(version);
  const form = d.querySelector<HTMLFormElement>("#settings")!;
  const message = d.querySelector<HTMLElement>("#settings-message")!;
  const tabs = [...d.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  for (const tab of tabs) {
    tab.onclick = () => {
      for (const item of tabs) {
        const selected = item === tab;
        item.setAttribute("aria-selected", String(selected));
        item.tabIndex = selected ? 0 : -1;
        d.querySelector<HTMLElement>("#" + item.getAttribute("aria-controls"))!.hidden = !selected;
      }
    };
    tab.onkeydown = event => {
      const index = tabs.indexOf(tab);
      const next = event.key === "ArrowDown" ? (index + 1) % tabs.length
        : event.key === "ArrowUp" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      tabs[next].click();
      tabs[next].focus();
    };
  }
  const transfer = document.createElement("section");
  transfer.innerHTML = `<h3 class="local-data-heading">AniList</h3><p id="anilist-state" ${!state.anilist.connected && !state.anilist.error ? "hidden" : ""}>${state.anilist.connected ? `Connected as ${esc(state.anilist.user)}. ${state.anilist.lastSync ? `Last sync: ${new Date(state.anilist.lastSync).toLocaleString()}.` : "No sync yet."}` : ""} ${esc(state.anilist.error ?? "")}</p><div class="actions">${state.anilist.connected ? '<button id="anilist-sync" type="button">Sync now</button><button id="anilist-disconnect" type="button">Disconnect</button>' : '<button id="anilist-connect" type="button">Connect AniList</button>'}</div><hr><h3 class="local-data-heading">Local data</h3><div class="actions"><button id="clear-cache" type="button">Clear downloaded cache</button><button id="clear-history" type="button">Clear watch history</button></div><div class="actions watch-transfer-actions"><button id="watch-export" type="button">Export watch data</button><button id="watch-import" type="button">Import watch data</button></div>`;
  d.querySelector("#settings-account")!.append(transfer);
  const uninstall = document.createElement("button");
  uninstall.textContent = "Uninstall";
  uninstall.id = "uninstall";
  uninstall.type = "button";
  d.querySelector(".update-actions")!.prepend(uninstall);
  uninstall.onclick = () => {
    d.close();
    const confirm = dialog('<h2 id="dialog-title">Uninstall Nen?</h2><p>Nen will close and open the Windows uninstaller.</p><div class="actions"><button id="confirm-uninstall">Uninstall</button><button id="cancel-uninstall">Cancel</button></div>');
    confirm.querySelector<HTMLButtonElement>("#cancel-uninstall")!.onclick = () => { confirm.close(); settings(); };
    confirm.querySelector<HTMLButtonElement>("#confirm-uninstall")!.onclick = () => void run(async () => { await api.uninstall(); });
  };

  transfer.querySelector<HTMLElement>("#watch-export")!.onclick = () => void run(async () => { const path = await api.watchExport(); if (path) showToast(`Saved watch data to ${path}`, d); });
  transfer.querySelector<HTMLElement>("#watch-import")!.onclick = () => void run(async () => {
    const summary = await api.watchImportPreview();
    if (!summary) return;
    d.close();
    const review = dialog(`<h2 id="dialog-title">Import watch data</h2><p>${summary.count} anime, ${summary.episodes} episode records. ${summary.newEntries} new anime and ${summary.changedEntries} existing anime.</p><p>Choose Merge to keep newer changes from each file. Replace removes all current watch entries. Nen will save a backup first.${state.anilist.connected ? " AniList entries can return on the next sync. Nen will not delete them from AniList." : ""}</p><div class="actions"><button id="import-merge" class="primary">Merge</button><button id="import-replace">Replace</button></div>`);
    for (const mode of ["merge", "replace"] as const) review.querySelector<HTMLElement>(`#import-${mode}`)!.onclick = () => void run(async () => {
      if (mode === "replace" && !confirm("Replace all current watch data? A backup will be saved.")) return;
      state = await api.watchImport(mode);
      review.close();
      showToast("Watch data imported.");
      if (state.anilist.connected) await showSyncReview();
      else if (route === "watchlist") await watchlist();
      if (route === "home") await home();
    });
  });
  const connectAniList = () => void run(async () => { await api.anilistConnect(); state = await api.state(); d.close(); await showSyncReview(true); });
  transfer.querySelector<HTMLElement>("#anilist-connect")?.addEventListener("click", connectAniList);
  transfer.querySelector<HTMLElement>("#anilist-sync")?.addEventListener("click", () => void run(async () => { d.close(); await showSyncReview(); }));
  transfer.querySelector<HTMLButtonElement>("#anilist-disconnect")?.addEventListener("click", event => void run(async () => {
    const button = event.currentTarget as HTMLButtonElement;
    button.disabled = true;
    try {
      state = await api.anilistDisconnect();
      transfer.querySelector<HTMLElement>("#anilist-state")!.textContent = "";
      transfer.querySelector<HTMLElement>("#anilist-state")!.hidden = true;
      transfer.querySelector("#anilist-sync")?.remove();
      button.id = "anilist-connect";
      button.textContent = "Connect AniList";
      const connect = button.cloneNode(true) as HTMLButtonElement;
      connect.disabled = false;
      connect.onclick = connectAniList;
      button.replaceWith(connect);
      showToast("AniList disconnected.", d);
    } finally { button.disabled = false; }
  }));
  const initialAdult = s.showAdult;
  let saveQueue = Promise.resolve();
  const save = () => {
    const f = new FormData(form);
    const qualities = f.getAll("qualities").map(Number);
    if (!qualities.length) {
      d.querySelector("#settings-message")!.textContent =
        "Select at least one quality.";
      return;
    }
    const next = {
      theme: f.get("theme") as typeof s.theme,
      source: f.get("source") as typeof s.source,
      sourceMode: f.get("sourceMode") as "auto" | "manual",
      audio: String(f.get("audio")),
      subtitles: String(f.get("subtitles")),
      qualities,
      autoSkip: f.has("autoSkip"),
      autoNext: f.has("autoNext"),
      discordPresence: f.has("discordPresence"),
      developmentBuilds: d.querySelector<HTMLInputElement>("#development-builds")!.checked,
      showAdult: f.has("showAdult"),
      hideZeroSeeds: f.has("hideZeroSeeds"),
    };
    state.settings = next;
    applyTheme();
    d.querySelector("#quality-summary")!.textContent = qualities
      .map((q) => q + "p")
      .join(", ");
    saveQueue = saveQueue
      .then(() => api.settings(next))
      .then(() => {
        message.textContent = "";
      })
      .catch(error);
  };
  d.querySelector<HTMLFormElement>("form")!.onchange = save;
  d.querySelector<HTMLFormElement>("form")!.onsubmit = (e) =>
    e.preventDefault();
  const check = d.querySelector<HTMLButtonElement>("#check-updates")!;
  const development = d.querySelector<HTMLInputElement>("#development-builds")!;
  let updateToast: ReturnType<typeof showToast> | undefined;
  const showUpdate = (status: import("./shared").UpdateStatus, notify = true) => {
    check.disabled = development.disabled = status.busy;
    if (notify && status.message && d.open) {
      const text = status.message + (status.percent === undefined ? "" : " " + status.percent + "%");
      if (updateToast?.element.isConnected) updateToast.update(text, status.busy);
      else updateToast = showToast(text, d, status.busy);
    }
  };
  const unsubscribeUpdate = api.onUpdateStatus(showUpdate);
  void api.updateStatus().then(status => showUpdate(status, false)).catch(error);
  check.onclick = () => void run(async () => {
    await saveQueue;
    showUpdate({ busy: true, message: "Checking for updates…" });
    try { showUpdate(await api.checkUpdates()); }
    catch (e) { showUpdate({ busy: false, message: e instanceof Error ? e.message : "The update failed." }); }
  });
  d.onclose = () => {
    unsubscribeUpdate();
    dismissToast();
    save();
    d.onclose = null;
    void saveQueue.then(() => {
      if (initialAdult === state.settings.showAdult) return;
      if (!state.settings.showAdult)
        document
          .querySelectorAll('[data-adult="true"]')
          .forEach((el) => el.remove());
      if (route === "home")
        document
          .querySelectorAll<HTMLElement>(".shelf-items")
          .forEach((el) => el.dispatchEvent(new Event("catalog-refresh")));
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
    if (lastNavigation.direction === direction && now - lastNavigation.time < 200) return;
    lastNavigation = { direction, time: now };
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]");
    if (dialog) { if (direction === "back") dialog.close(); }
    else if (playerMode) { if (direction === "back") void run(() => api.control("stop")); }
    else void run(() => browseBack(direction));
  };
  api.onBack(navigate);
  for (const event of ["mousedown", "mouseup", "auxclick"])
    document.addEventListener(event, e => {
      const mouse = e as MouseEvent;
      if (mouse.button !== 3 && mouse.button !== 4) return;
      e.preventDefault();
      if (event === "mouseup") navigate(mouse.button === 3 ? "back" : "forward");
    }, true);
  document.addEventListener("keydown", e => {
    if ((e.altKey && ["ArrowLeft", "ArrowRight"].includes(e.key)) || ["BrowserBack", "BrowserForward"].includes(e.key)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      navigate(e.key === "ArrowLeft" || e.key === "BrowserBack" ? "back" : "forward");
    }
  }, true);
  applyTheme();
  if (playerMode) {
    const update = mountPlayer({
      sources: (p) =>
        void run(async () => {
          if (p.mediaId && p.episode) {
            if (!p.paused && !(await api.togetherState()).connected) await api.control("pause");
            await releasePicker(await api.media(p.mediaId), p.episode);
          }
        }),
      next: (p) =>
        void run(async () => {
          const room = await api.togetherState();
          if (room.connected && !room.host) throw Error("Only the host can choose the next episode.");
          if (p.mediaId && p.nextEpisode) {
            if (p.episode) state = await api.watchEdit(p.mediaId, { episode: p.episode, watched: true });
            await startEpisode(await api.media(p.nextMediaId ?? p.mediaId), p.nextEpisode);
          }
        }),
      edit: editMarker,
      error,
    });
    api.onPlayback((p) => {
      playback = p;
      const finding = document.querySelector<HTMLElement>("#finding-source");
      if (finding && p.loadingNotice) finding.textContent = p.loadingNotice;
      update(p);
    });
    const p = await api.playback();
    playback = p;
    update(p);
  } else {
    shell();
    api.onWatchState(value => {
      state = value;
      if (route === "watchlist") void watchlist();
      else if (route === "home") void home();
      else if (route === "series") { renderEpisodes(); updateSeriesActions(); }
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
    if (returnMedia > 0) {
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
          if (route !== "series")
            visits.push({ route, mode, query, page });
          goingBack = true;
        }
      } catch {}
      await openMedia(returnMedia);
      goingBack = false;
    } else await home();
    clearInterval(animation);
    splash.classList.add("finished");
    setTimeout(() => splash.remove(), 300);
    void api.startupUpdate().then(available => {
      if (available) showToast("A new update is available. Open Settings to update Nen.",
        document.querySelector<HTMLDialogElement>("dialog[open]") ?? document.body);
    }).catch(() => {});
  }
}
void start().catch((e) => {
  document.querySelector(".startup")?.remove();
  root.textContent = `Nen could not start: ${(e as Error).message}`;
});
