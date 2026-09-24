import { parseSearch, searchText, seasons, formats, statuses } from "./filters";
import "./style.css";
import {
  recentSeasons,
  isWatched,
  labelForEpisode,
  episodeAvailability,
  latestEpisode,
  rankReleases,
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
let mode: "trending" | "season" | "search" = "trending";
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
  mode: "trending" | "season" | "search";
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
    else if (previous.route === "history") await history();
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
    : seriesReturn === "history"
      ? history()
      : discover(page);

function error(e: unknown) {
  const open = document.querySelector<HTMLDialogElement>("dialog[open]");
  if (open) {
    let message = open.querySelector<HTMLElement>(".dialog-error");
    if (!message) {
      message = document.createElement("p");
      message.className = "dialog-error notice";
      message.setAttribute("role", "alert");
      open.append(message);
    }
    message.textContent = e instanceof Error ? e.message : String(e);
    return;
  }
  const box = document.querySelector<HTMLElement>(
    playerMode ? "#player-error" : "#message",
  )!;
  box.textContent = e instanceof Error ? e.message : String(e);
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
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true">${({ search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 5 5"/>', close: '<path d="m6 6 12 12M18 6 6 18"/>', left: '<path d="m14 5-7 7 7 7"/>', right: '<path d="m10 5 7 7-7 7"/>', refresh: '<path d="M20 7v5h-5M4 17v-5h5M19 10a7 7 0 0 0-12-5L4 8m1 6a7 7 0 0 0 12 5l3-3"/>', home: '<path d="m3 11 9-8 9 8M5 9v12h5v-7h4v7h5V9"/>', history: '<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>', browse: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>', settings: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="3"/><circle cx="15" cy="17" r="3"/>' } as Record<string, string>)[name]}</svg>`;
let filterOptions: Promise<{ genres: string[]; tags: string[] }> | undefined;
const getOptions = () =>
  (filterOptions ??= api.catalogOptions().catch((e) => {
    filterOptions = undefined;
    throw e;
  }));
function shell() {
  root.innerHTML = `<aside class="sidebar"><nav aria-label="Main"><button data-nav="home">${uiIcon("home")} Home</button><button data-nav="history">${uiIcon("history")} Continue watching</button><button data-nav="browse">${uiIcon("browse")} Browse</button></nav><div class="sidebar-bottom"><button data-nav="settings">${uiIcon("settings")} Settings</button></div></aside><div class="workspace"><header class="topbar"><div id="page-title"></div><form id="search" role="search"><label class="sr-only" for="search-input">Search anime</label>${uiIcon("search")}<input id="search-input" type="text" role="combobox" aria-autocomplete="list" aria-controls="search-suggestions" aria-expanded="false" placeholder="Search for anime" autocomplete="off" maxlength="200"><button type="button" id="clear-search" class="square-button" aria-label="Clear search" hidden>${uiIcon("close")}</button><div id="search-suggestions" role="listbox" aria-label="Anime suggestions" hidden></div></form><div id="page-actions"></div></header><div id="message" role="alert" hidden></div><main id="main" tabindex="-1"></main></div><dialog id="dialog" aria-labelledby="dialog-title"></dialog>`;
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
        else if (b.dataset.nav === "history") void history();
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
  const f = parseSearch(mode === "search" ? query : "");
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
async function home() {
  setRoute("home");
  current = undefined;
  activeNav("home");
  const token = ++request;
  state = await api.state();
  if (token !== request) return;
  const recent = recentSeasons(state.progress, state.settings.showAdult)
    .slice(0, 6)
    .map(([, p]) => p);
  const shelves = [
    ["Trending", ""],
    ["Action", "genre:Action"],
    ["Romance", "genre:Romance"],
    ["Adventure", "genre:Adventure"],
  ];
  document.querySelector("#main")!.innerHTML =
    `<div class="page-heading"><h1>Home</h1><button id="refresh-home" class="quiet square-button" aria-label="Refresh">${uiIcon("refresh")}</button></div><section class="home-section"><div class="section-heading"><h2>Continue watching</h2><button id="more-history" class="quiet">View more ${uiIcon("right")}</button></div>${recent.length ? `<div class="home-grid">${recent.map((p) => `<button class="recent-card" data-adult="${!!p.isAdult}" data-resume="${p.mediaId}:${p.episode}"><div class="cover"><img src="${esc(p.cover)}" alt=""></div><strong>${esc(p.title)}</strong><small>${esc(p.episodeTitle ?? `Episode ${p.episode}`)} · ${time(p.position)} / ${time(p.duration)}</small></button>`).join("")}</div>` : '<p class="muted">Your recent watches will appear here.</p>'}</section>${shelves.map(([name], i) => `<section class="home-section" id="shelf-${i}"><div class="section-heading"><h2>${name}</h2><div class="actions"><button class="quiet shelf-more">View more ${uiIcon("right")}</button><button class="square-button shelf-back" aria-label="Previous ${name} titles" disabled>${uiIcon("left")}</button><button class="square-button shelf-next" aria-label="Next ${name} titles">${uiIcon("right")}</button></div></div><div class="home-grid shelf-items" aria-live="polite"><p class="loading">Loading…</p></div></section>`).join("")}`;
  movePageHeading();
  document.querySelector<HTMLElement>("#more-history")!.onclick = () =>
    void history();
  document.querySelector<HTMLElement>("#refresh-home")!.onclick = () =>
    void home();
  document
    .querySelectorAll<HTMLElement>("[data-resume]")
    .forEach(
      (b) =>
        (b.onclick = () =>
          void run(() => resumeFromHistory(b.dataset.resume!))),
    );
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
            filter ? "search" : "trending",
            filter,
            shelfPage,
            9,
          );
          if (!el.isConnected) return;
          const grid = el.querySelector<HTMLElement>(".shelf-items")!;
          grid.innerHTML = data.media
            .filter((m) => state.settings.showAdult || !m.isAdult)
            .map(card)
            .join("");
          el.hidden = !grid.querySelector(".poster");
          bindMedia(grid);
          prev.disabled = shelfPage === 1;
          next.disabled = !data.hasNextPage;
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
        mode = filter ? "search" : "trending";
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
  main.innerHTML = `<div class="page-heading"><div><h1>${mode === "search" && parseSearch(query).search ? "Search results" : "Browse"}</h1></div><button id="refresh" class="quiet square-button" aria-label="Refresh" title="Refresh">${uiIcon("refresh")}</button></div><div id="browse-filters" class="browse-filters"></div><div class="tabs" aria-label="Browse category"><button data-mode="trending" class="${mode === "trending" ? "selected" : ""}">Trending</button><button data-mode="season" class="${mode === "season" ? "selected" : ""}">This season</button>${mode === "search" ? '<span class="selected">Search</span>' : ""}</div><p id="catalog-note" class="muted">${mode === "search" ? `Results for ${esc(query)}` : "Loading…"}</p><div class="grid" id="catalog" aria-busy="true"></div><nav id="catalog-pages" class="catalog-pages" aria-label="Catalog pages"></nav>`;
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
      mode === "search"
        ? `Results for ${query}`
        : mode === "season"
          ? `Airing this season · ${new Date().getFullYear()}`
          : "Trending anime";
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
    const m = await api.media(id);
    if (token !== request) return;
    current = m;
    labelData = undefined;
    episodeData = undefined;
    hideFiller = false;
    showAllEpisodes = false;
    descendingEpisodes = false;
    renderSeries();
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
  main.innerHTML = `<button id="back" class="back">${uiIcon("left")} Back</button><article class="series"><img class="series-cover" src="${esc(m.coverImage.large)}" alt="${esc(title(m))}"><div><p class="eyebrow">${esc(format(m.format))} <span> / </span> ${m.seasonYear ?? "TBA"}</p><h1>${esc(title(m))}</h1><div class="facts"><span>${m.episodes ?? "?"} episodes</span><span>${esc(m.status.replaceAll("_", " ").toLowerCase())}</span>${m.averageScore ? `<span>${m.averageScore}% score</span>` : ""}</div><p class="synopsis">${esc(m.description?.replace(/<[^>]*>/g, "") ?? "No synopsis available.")}</p><p class="genres">${m.genres.map(esc).join(" / ")}</p></div></article><section id="episodes"></section>${
    m.relations?.edges.length
      ? `<section class="related"><h2>Related titles</h2><div class="related-list">${m.relations.edges
          .filter((e) => e.node.type === "ANIME")
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
      const watched = state.progress[`${m.id}:${e.n}`];
      const future = e.released === false;
      const finished = isWatched(watched);
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
    d.querySelector("#releases")!.innerHTML =
      result.errors.map((e) => `<p class="notice">${esc(e)}</p>`).join("") +
      (rows.length
        ? rows
            .map(
              (r, i) =>
                `<button class="release" data-release="${i}"><span class="release-title">${esc(r.title)}</span><span class="release-meta"><b>${r.source}</b><span>${esc(r.resolution)}</span><span>${esc(r.size)}</span><span>${r.seeds} seeds</span></span></button>`,
            )
            .join("")
        : '<div class="empty"><h3>No releases found</h3><p>Try again later or change the source in Settings.</p></div>');
    d.querySelectorAll<HTMLButtonElement>("[data-release]").forEach(
      (b) =>
        (b.onclick = () =>
          void chooseFile(m, ep, rows[Number(b.dataset.release)])),
    );
  } catch (e) {
    if (token === pickerRequest && d.open)
      d.querySelector("#releases")!.innerHTML =
        `<p role="alert">${esc((e as Error).message)}</p>`;
  }
}
async function startEpisode(m: Media, ep: number) {
  if (episodeAvailability(m, ep).released === false) return;
  if (state.settings.sourceMode === "manual") {
    await releasePicker(m, ep);
    return;
  }
  const saved = state.progress[`${m.id}:${ep}`];
  if (saved) {
    const d = dialog(
      `<h2 id="dialog-title">Resuming ${esc(title(m))}</h2><p>Opening ${esc(saved.episodeTitle ?? `episode ${ep}`)}…</p>`,
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
  await api.resume(key);
}
async function history() {
  setRoute("history");
  request++;
  current = undefined;
  activeNav("history");
  state = await api.state();
  const entries = recentSeasons(state.progress, state.settings.showAdult);
  document.querySelector("#main")!.innerHTML =
    `<div class="page-heading"><div><h1>Continue watching</h1></div>${entries.length ? '<button id="clear-watch-history" class="quiet">Clear watch history</button>' : ""}</div>${entries.length ? `<div class="history-list">${entries.map(([key, p]) => `<article class="history-row"><img src="${esc(p.cover)}" alt=""><div><button class="text-link" data-media="${p.mediaId}">${esc(p.title)}</button><p>${esc(p.episodeTitle ?? `Episode ${p.episode}`)}${p.episodeTitle && p.episodeTitle !== `Episode ${p.episode}` ? ` · Episode ${p.episode}` : ""}</p><small>${time(p.position)} / ${time(p.duration)}</small></div><button class="primary" data-resume="${key}">Resume</button><button class="remove-history" data-remove="${key}" aria-label="Remove ${esc(p.title)} episode ${p.episode} from history" title="Remove from history">${uiIcon("close")}</button></article>`).join("")}</div>` : '<div class="empty"><h2>No saved playback</h2><p>Your watch progress will appear here.</p><button id="browse">Browse anime</button></div>'}`;
  movePageHeading();
  bindMedia();
  document.querySelectorAll<HTMLButtonElement>("[data-resume]").forEach(
    (b) =>
      (b.onclick = () => {
        b.disabled = true;
        b.textContent = "Connecting…";
        void run(() => resumeFromHistory(b.dataset.resume!)).finally(() => {
          b.disabled = false;
          b.textContent = "Resume";
        });
      }),
  );
  document.querySelectorAll<HTMLButtonElement>("[data-remove]").forEach(
    (b) =>
      (b.onclick = () =>
        run(async () => {
          await api.removeHistory(b.dataset.remove!);
          await history();
        })),
  );
  const clear = document.querySelector<HTMLElement>("#clear-watch-history");
  if (clear)
    clear.onclick = () =>
      run(async () => {
        await api.clear("history");
        await history();
      });
  const browse = document.querySelector<HTMLElement>("#browse");
  if (browse) browse.onclick = () => void discover();
}
function settings() {
  const s = state.settings;
  const languages = [
    ["jpn", "Japanese"],
    ["eng", "English"],
    ["spa", "Spanish"],
    ["fra", "French"],
    ["deu", "German"],
    ["ita", "Italian"],
    ["por", "Portuguese"],
    ["zho", "Chinese"],
    ["kor", "Korean"],
    ["rus", "Russian"],
    ["ara", "Arabic"],
    ["hin", "Hindi"],
  ];
  const options = (value: string, sub = false) =>
    `${sub ? `<option value="no" ${value === "no" ? "selected" : ""}>Off</option>` : ""}<option value="" ${value === "" ? "selected" : ""}>Use file default</option>${languages.map(([code, name]) => `<option value="${code}" ${value.split(",")[0] === code ? "selected" : ""}>${name}</option>`).join("")}`;
  const d = dialog(
    `<h2 id="dialog-title">Settings</h2><form id="settings"><label>Appearance<select name="theme">${["system", "light", "dark"].map((v) => `<option value="${v}" ${s.theme === v ? "selected" : ""}>${v === "system" ? "Use system theme" : v[0].toUpperCase() + v.slice(1)}</option>`).join("")}</select></label><div class="field-pair"><label>Preferred audio<select name="audio">${options(s.audio)}</select></label><label>Preferred subtitles<select name="subtitles">${options(s.subtitles, true)}</select></label></div><label>Choose a source<select name="sourceMode"><option value="auto" ${s.sourceMode !== "manual" ? "selected" : ""}>Find the best source automatically</option><option value="manual" ${s.sourceMode === "manual" ? "selected" : ""}>Always let me choose</option></select></label><label>Search sources<select name="source">${["all", "Nyaa", "Bangumi Moe"].map((v) => `<option value="${v}" ${s.source === v ? "selected" : ""}>${v === "all" ? "All sources" : v}</option>`).join("")}</select></label><label>Preferred quality</label><details class="quality-dropdown"><summary id="quality-summary">${(s.qualities ?? [1080, 720, 480, 360]).map((q) => q + "p").join(", ")}</summary><fieldset><legend class="sr-only">Allowed video qualities</legend>${[2160, 1440, 1080, 720, 480, 360].map((q) => `<label class="check"><input name="qualities" type="checkbox" value="${q}" ${(s.qualities ?? [1080, 720, 480, 360]).includes(q) ? "checked" : ""}> ${q}p${q === 2160 ? " (4K)" : ""}</label>`).join("")}</fieldset></details><label class="check"><input name="autoNext" type="checkbox" ${s.autoNext ? "checked" : ""}> Auto play next episode</label><label class="check"><input name="autoSkip" type="checkbox" ${s.autoSkip ? "checked" : ""}> Automatically skip intros and outros</label><label class="check"><input name="showAdult" type="checkbox" ${s.showAdult ? "checked" : ""}> Show NSFW content</label><label class="check"><input name="hideZeroSeeds" type="checkbox" ${s.hideZeroSeeds !== false ? "checked" : ""}> Hide videos with 0 seeders</label></form><hr><h3 class="local-data-heading">Local data</h3><div class="actions"><button id="clear-cache">Clear downloaded cache</button><button id="clear-history">Clear watch history</button></div><p id="settings-message" role="status"></p><p class="muted"><strong>NEN</strong> - ${esc(state.version)}</p>`,
  );
  const form = d.querySelector<HTMLFormElement>("#settings")!;
  const message = d.querySelector<HTMLElement>("#settings-message")!;
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
  d.onclose = () => {
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
      else if (route === "history") void history();
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
        if (route === "history") await history();
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
            if (!p.paused) await api.control("pause");
            await releasePicker(await api.media(p.mediaId), p.episode);
          }
        }),
      next: (p) =>
        void run(async () => {
          if (p.mediaId && p.nextEpisode)
            await startEpisode(await api.media(p.mediaId), p.nextEpisode);
        }),
      edit: editMarker,
      error,
    });
    api.onPlayback((p) => {
      playback = p;
      update(p);
    });
    const p = await api.playback();
    playback = p;
    update(p);
  } else {
    shell();
    api.onPlayback((p) => {
      const finding = document.querySelector<HTMLElement>("#finding-source");
      if (finding && p.loadingNotice) finding.textContent = p.loadingNotice;
      if (!p.active)
        void api.state().then((value) => {
          state = value;
          if (route === "history") void history();
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
  }
}
void start().catch((e) => {
  document.querySelector(".startup")?.remove();
  root.textContent = `Nen could not start: ${(e as Error).message}`;
});
