import {
  audioTrackLanguage,
  validateLibrary,
  type State,
  type Settings,
} from "../src/shared";
import { validateTransfer, mergeWatch } from "./watch-data";

export function exportBackup(state: State) {
  const { privateSession, ...settings } = state.settings;
  return {
    version: 2,
    exportedAt: Date.now(),
    entries: Object.values(state.watch),
    settings,
    favorites: Object.values(state.favorites),
    markers: state.markers,
    mappings: state.mappings,
    seriesAudio: state.seriesAudio,
    volume: state.volume,
  };
}

export function readBackup(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw Error("Invalid backup.");
  const file = value as Record<string, any>;
  if (![1, 2].includes(file.version))
    throw Error("This backup needs a newer version of Nen.");
  const watch = validateTransfer({ version: 1, entries: file.entries });
  const result: {
    watch: State["watch"];
    settings?: Partial<Settings>;
    favorites?: State["favorites"];
    markers?: State["markers"];
    mappings?: State["mappings"];
    seriesAudio?: State["seriesAudio"];
    volume?: number;
  } = { watch };
  if (file.version === 1) return result;
  if (file.favorites !== undefined)
    result.favorites = validateTransfer({
      version: 1,
      entries: file.favorites,
    });
  const object = (value: any) => {
    if (
      !value ||
      typeof value !== "object" ||
      Array.isArray(value) ||
      Object.keys(value).length > 100000
    )
      throw Error("Invalid backup section.");
    return value as Record<string, any>;
  };
  if (file.settings !== undefined) {
    const raw = object(file.settings),
      clean: Record<string, any> = {};
    const bools = [
      "hideOpenMyAnimeList",
      "compactView",
      "showEpisodeName",
      "blurUnwatched",
      "prepareNext",
      "autoSkipRecaps",
      "subtitleShadow",
      "discordPresence",
      "showAdult",
      "hideZeroSeeds",
      "hideOpenAniList",
      "autoSkip",
      "autoNext",
      "autoUpdates",
    ];
    for (const key of bools)
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "boolean")
          throw Error("Invalid backup setting.");
        clean[key] = raw[key];
      }
    for (const [key, options] of Object.entries({
      theme: ["system", "light", "dark"],
      source: ["all", "Nyaa", "Bangumi Moe"],
      sourceMode: ["auto", "manual"],
    })) {
      if (raw[key] !== undefined) {
        if (!options.includes(raw[key])) throw Error("Invalid backup setting.");
        clean[key] = raw[key];
      }
    }
    for (const key of ["audio", "subtitles"])
      if (raw[key] !== undefined) {
        if (
          typeof raw[key] !== "string" ||
          raw[key].length > 60 ||
          !/^[a-zA-Z, -]*$/.test(raw[key])
        )
          throw Error("Invalid backup language.");
        clean[key] = raw[key];
      }
    for (const [key, min, max] of [
      ["subtitleDelay", -3600, 3600],
      ["subtitleSize", 50, 250],
      ["subtitlePosition", 0, 100],
    ] as const)
      if (raw[key] !== undefined) {
        if (!Number.isFinite(raw[key]) || raw[key] < min || raw[key] > max)
          throw Error("Invalid backup subtitle value.");
        clean[key] = raw[key];
      }
    for (const key of ["subtitleColour", "subtitleOutlineColour"])
      if (raw[key] !== undefined) {
        if (typeof raw[key] !== "string" || !/^#[a-f0-9]{6}$/i.test(raw[key]))
          throw Error("Invalid backup colour.");
        clean[key] = raw[key];
      }
    if (raw.qualities !== undefined) {
      if (
        !Array.isArray(raw.qualities) ||
        !raw.qualities.length ||
        raw.qualities.length > 6 ||
        !raw.qualities.every((q: number) =>
          [2160, 1440, 1080, 720, 480, 360].includes(q),
        )
      )
        throw Error("Invalid backup quality.");
      clean.qualities = raw.qualities;
    }
    for (const key of ["customLists", "shelfLayouts"])
      if (raw[key] !== undefined) clean[key] = raw[key];
    validateLibrary(clean as Settings);
    if (raw.hiddenContinue !== undefined) {
      clean.hiddenContinue = {};
      for (const [id, time] of Object.entries(object(raw.hiddenContinue))) {
        if (!/^\d+$/.test(id) || !Number.isFinite(time) || (time as number) < 0)
          throw Error("Invalid hidden title.");
        clean.hiddenContinue[id] = time;
      }
    }
    result.settings = clean;
  }
  for (const key of ["mappings", "seriesAudio"] as const)
    if (file[key] !== undefined) {
      const clean: Record<string, any> = {};
      for (const [id, raw] of Object.entries(object(file[key]))) {
        if (key === "seriesAudio" && raw === "") continue;
        const value =
          key === "seriesAudio" && typeof raw === "string"
            ? (audioTrackLanguage({ lang: raw }) ?? raw.toLowerCase())
            : raw;
        if (
          !/^\d+$/.test(id) ||
          (key === "mappings"
            ? !Number.isInteger(value) || Math.abs(value as number) > 10000
            : typeof value !== "string" || !/^[a-z]{3}$/.test(value))
        )
          throw Error("Invalid backup mapping.");
        clean[id] = value;
      }
      result[key] = clean;
    }
  if (file.volume !== undefined) {
    if (!Number.isFinite(file.volume) || file.volume < 0 || file.volume > 100)
      throw Error("Invalid backup volume.");
    result.volume = file.volume;
  }
  if (file.markers !== undefined) {
    result.markers = {};
    for (const [key, markers] of Object.entries(object(file.markers))) {
      if (
        !key ||
        key.length > 4000 ||
        ["__proto__", "constructor", "prototype"].includes(key) ||
        !Array.isArray(markers) ||
        markers.length > 1000
      )
        throw Error("Invalid backup markers.");
      result.markers[key] = markers.map((m) => {
        if (
          !m ||
          !["op", "ed", "mixed-op", "mixed-ed", "recap"].includes(m.type) ||
          !Number.isFinite(m.start) ||
          !Number.isFinite(m.end) ||
          m.start < 0 ||
          m.end <= m.start ||
          m.end > 86400
        )
          throw Error("Invalid backup marker.");
        return {
          type: m.type,
          start: m.start,
          end: m.end,
          confirmed: m.confirmed === true,
        };
      });
    }
  }
  return result;
}

export function restoreBackup(
  state: State,
  backup: ReturnType<typeof readBackup>,
  mode: "merge" | "replace",
) {
  const next = structuredClone(state);
  if (mode === "replace") {
    next.watch = backup.watch;
    next.progress = {};
  } else mergeWatch(next.watch, backup.watch);
  if (backup.settings) {
    const current = next.settings;
    next.settings =
      mode === "replace"
        ? { ...current, ...backup.settings }
        : { ...backup.settings, ...current };
    if (mode === "merge") {
      const lists = new Map(
        (current.customLists || []).map((list) => [
          list.id,
          structuredClone(list),
        ]),
      );
      for (const list of backup.settings.customLists || []) {
        const existing = lists.get(list.id);
        if (!existing) lists.set(list.id, structuredClone(list));
        else
          for (const item of list.items)
            if (!existing.items.some((e) => e.id === item.id))
              existing.items.push(item);
      }
      next.settings.customLists = [...lists.values()];
      for (const page of ["home", "watchlist"] as const) {
        const saved = backup.settings.shelfLayouts?.[page],
          existing = current.shelfLayouts?.[page];
        if (!saved) continue;
        next.settings.shelfLayouts = {
          ...next.settings.shelfLayouts,
          [page]: existing
            ? {
                order: [...new Set([...existing.order, ...saved.order])],
                hidden: [
                  ...existing.hidden,
                  ...saved.hidden.filter(
                    (id) =>
                      !existing.order.includes(id) &&
                      !existing.hidden.includes(id),
                  ),
                ],
              }
            : saved,
        };
      }
    }
    next.settings.privateSession = current.privateSession;
    validateLibrary(next.settings);
  }
  if (backup.favorites) {
    if (mode === "replace") next.favorites = backup.favorites;
    else mergeWatch(next.favorites, backup.favorites);
  }
  for (const key of ["markers", "mappings", "seriesAudio"] as const)
    if (backup[key])
      (next as any)[key] =
        mode === "replace" ? backup[key] : { ...backup[key], ...next[key] };
  if (mode === "merge" && backup.markers) {
    for (const [key, markers] of Object.entries(backup.markers)) {
      const current = next.markers[key] ?? [];
      next.markers[key] = [
        ...current,
        ...markers.filter(
          (marker) => !current.some((item) => item.type === marker.type),
        ),
      ];
    }
  }
  if (
    backup.volume !== undefined &&
    (mode === "replace" || next.volume === undefined)
  )
    next.volume = backup.volume;
  return next;
}
