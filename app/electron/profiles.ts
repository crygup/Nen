import { writeFile, rename } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ProfileSummary, Settings, State } from "../src/shared";

export type ProfileSettings = Omit<Settings, "autoUpdates">;
export interface ProfileData {
  schemaVersion?: number;
  settings?: Partial<ProfileSettings>;
  seriesAudio?: State["seriesAudio"];
  progress?: State["progress"];
  watch?: State["watch"];
  favorites?: State["favorites"];
  favoriteChanges?: State["favoriteChanges"];
  anilist?: State["anilist"];
  mal?: State["mal"];
}
// Increase only when the saved-data format changes, and migrate older formats first.
const schemaVersion = 1;
function checkFormat(data: any) {
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw Error("Invalid saved data.");
  if (data.schemaVersion !== undefined && data.schemaVersion !== schemaVersion)
    throw Error(
      "This saved data uses an unsupported format. Install a compatible Nen version. Your data has not been reset.",
    );
}
export const legacyProfileId = "0000000000000000";

export function profileId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/.test(value))
    throw Error("Invalid profile.");
  return value;
}
export function newProfileId(list: ProfileSummary[]): string {
  let id: string;
  do id = randomBytes(8).toString("hex");
  while (id === legacyProfileId || list.some((p) => p.id === id));
  return id;
}
export function profileName(
  value: unknown,
  list: ProfileSummary[],
  except?: string,
): string {
  if (typeof value !== "string") throw Error("Enter a profile name.");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 40)
    throw Error("Use a profile name of 1 to 40 characters.");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw Error("Invalid profile name.");
  if (
    list.some(
      (p) => p.id !== except && p.name.toLowerCase() === name.toLowerCase(),
    )
  )
    throw Error("A profile with that name already exists.");
  return name;
}
export function uniqueProfileName(
  value: string,
  list: ProfileSummary[],
): string {
  const base =
    value
      .replace(/[\u0000-\u001f\u007f]/g, "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 36) || "Profile";
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!list.some((p) => p.name.toLowerCase() === name.toLowerCase()))
      return name;
  }
}
export const profileDir = (root: string, id: string) =>
  join(root, "profiles", profileId(id));
export const profileFile = (root: string, id: string) =>
  join(profileDir(root, id), "profile.json");
export const tokenFile = (root: string, id: string) =>
  join(profileDir(root, id), "anilist-token.bin");

export function writeJson(path: string, value: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(value));
  renameSync(path + ".tmp", path);
}
const preparedProfiles = new Set<string>();
function prepareProfile(root: string, id: string) {
  const path = profileFile(root, id);
  if (preparedProfiles.has(path)) return path;
  mkdirSync(profileDir(root, id), { recursive: true });
  if (existsSync(path)) {
    const stored = readProfile(root, id);
    if (
      stored.schemaVersion === undefined &&
      !existsSync(path + ".before-format-1.json")
    )
      copyFileSync(path, path + ".before-format-1.json");
  }
  preparedProfiles.add(path);
  return path;
}
export function writeProfile(root: string, id: string, data: ProfileData) {
  writeJson(prepareProfile(root, id), { ...data, schemaVersion });
}

const pendingWrites = new Map<string, string>();
const written = new Map<string, string>();
let writing: Promise<void> | undefined;
export function queueJson(path: string, value: unknown) {
  // Capture the value now so a later profile switch cannot change a queued save.
  const body = JSON.stringify(value);
  if (body !== (pendingWrites.get(path) ?? written.get(path)))
    pendingWrites.set(path, body);
}
export function queueProfile(root: string, id: string, data: ProfileData) {
  queueJson(prepareProfile(root, id), { ...data, schemaVersion });
}
export async function flushWrites(): Promise<void> {
  while (writing || pendingWrites.size) {
    writing ??= (async () => {
      while (pendingWrites.size) {
        const [path, body] = pendingWrites.entries().next().value!;
        await writeFile(path + ".tmp", body);
        await rename(path + ".tmp", path);
        written.set(path, body);
        if (pendingWrites.get(path) === body) pendingWrites.delete(path);
      }
    })().finally(() => {
      writing = undefined;
    });
    await writing;
  }
}
export function readProfile(root: string, id: string): ProfileData {
  try {
    const data = JSON.parse(readFileSync(profileFile(root, id), "utf8"));
    checkFormat(data);
    return data;
  } catch (error) {
    throw Error("Profile data could not be read. " + (error as Error).message);
  }
}

/** Splits the in-memory state into device-wide data and the active profile's data. */
export function splitState(state: State) {
  const {
    settings: { autoUpdates, ...settings },
    seriesAudio,
    progress,
    watch,
    favorites,
    favoriteChanges,
    anilist,
    mal,
    ...shared
  } = state;
  return {
    shared: { ...shared, autoUpdates, schemaVersion },
    profile: {
      settings,
      seriesAudio,
      progress,
      watch,
      favorites,
      favoriteChanges,
      anilist,
      mal,
    } satisfies ProfileData,
  };
}

/**
 * Moves a pre-profile state.json and AniList token into a profile folder.
 * state.json stays the source of truth until it is rewritten, so a crash midway reruns this safely.
 */
export function migrateLegacy(root: string, statePath: string) {
  if (!existsSync(statePath)) return;
  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  checkFormat(stored);
  const legacyToken = join(root, "anilist-token.bin");
  if (stored.profiles) {
    if (!Array.isArray(stored.profiles.list) || !stored.profiles.list.length)
      throw Error("Invalid profile list.");
    for (const profile of stored.profiles.list) readProfile(root, profile.id);
    if (
      stored.schemaVersion === undefined &&
      !existsSync(statePath + ".before-format-1.json")
    )
      copyFileSync(statePath, statePath + ".before-format-1.json");
    // Only left behind when a migration stopped after state.json was rewritten; the profile already has a copy.
    rmSync(legacyToken, { force: true });
    return;
  }
  const backup = statePath + ".before-profiles.json";
  if (!existsSync(backup)) copyFileSync(statePath, backup);
  const connected = existsSync(legacyToken);
  const {
    settings: { autoUpdates, ...settings } = {} as Settings,
    seriesAudio,
    progress,
    watch,
    favorites,
    favoriteChanges,
    anilist,
    mal,
    ...shared
  } = stored;
  const id = legacyProfileId;
  writeProfile(root, id, {
    settings,
    seriesAudio,
    progress,
    watch,
    favorites,
    favoriteChanges,
    anilist,
    mal,
  });
  if (connected) copyFileSync(legacyToken, tokenFile(root, id));
  const user =
    connected && typeof anilist?.user === "string" ? anilist.user : undefined;
  const name = uniqueProfileName(user ?? "Default", []);
  writeJson(statePath, {
    ...shared,
    autoUpdates,
    schemaVersion,
    profiles: {
      active: id,
      list: [{ id, name, created: Date.now(), anilistUser: user }],
    },
  });
  rmSync(legacyToken, { force: true });
}
