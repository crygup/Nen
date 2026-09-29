import { randomBytes } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProfileSummary, Settings, State } from "../src/shared";

export type ProfileSettings = Omit<Settings, "autoUpdates">;
export interface ProfileData {
  settings?: Partial<ProfileSettings>;
  seriesAudio?: State["seriesAudio"];
  progress?: State["progress"];
  watch?: State["watch"];
  favorites?: State["favorites"];
  favoriteChanges?: State["favoriteChanges"];
  anilist?: State["anilist"];
}
export const legacyProfileId = "0000000000000000";

export function profileId(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{16}$/.test(value)) throw Error("Invalid profile.");
  return value;
}
export function newProfileId(list: ProfileSummary[]): string {
  let id: string;
  do id = randomBytes(8).toString("hex"); while (id === legacyProfileId || list.some(p => p.id === id));
  return id;
}
export function profileName(value: unknown, list: ProfileSummary[], except?: string): string {
  if (typeof value !== "string") throw Error("Enter a profile name.");
  const name = value.replace(/\s+/g, " ").trim();
  if (!name || name.length > 40) throw Error("Use a profile name of 1 to 40 characters.");
  if (/[\u0000-\u001f\u007f]/.test(name)) throw Error("Invalid profile name.");
  if (list.some(p => p.id !== except && p.name.toLowerCase() === name.toLowerCase())) throw Error("A profile with that name already exists.");
  return name;
}
export function uniqueProfileName(value: string, list: ProfileSummary[]): string {
  const base = value.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 36) || "Profile";
  for (let n = 1; ; n++) {
    const name = n === 1 ? base : `${base} ${n}`;
    if (!list.some(p => p.name.toLowerCase() === name.toLowerCase())) return name;
  }
}
export const profileDir = (root: string, id: string) => join(root, "profiles", profileId(id));
export const profileFile = (root: string, id: string) => join(profileDir(root, id), "profile.json");
export const tokenFile = (root: string, id: string) => join(profileDir(root, id), "anilist-token.bin");

export function writeJson(path: string, value: unknown) {
  writeFileSync(path + ".tmp", JSON.stringify(value));
  renameSync(path + ".tmp", path);
}
export function writeProfile(root: string, id: string, data: ProfileData) {
  mkdirSync(profileDir(root, id), { recursive: true });
  writeJson(profileFile(root, id), data);
}
export function readProfile(root: string, id: string): ProfileData {
  try {
    const data = JSON.parse(readFileSync(profileFile(root, id), "utf8"));
    if (!data || typeof data !== "object" || Array.isArray(data)) throw Error();
    return data;
  } catch {
    throw Error("Profile data could not be read. Back up the profiles folder before resetting it.");
  }
}

/** Splits the in-memory state into device-wide data and the active profile's data. */
export function splitState(state: State) {
  const { settings: { autoUpdates, ...settings }, seriesAudio, progress, watch, favorites, favoriteChanges, anilist, ...shared } = state;
  return {
    shared: { ...shared, autoUpdates },
    profile: { settings, seriesAudio, progress, watch, favorites, favoriteChanges, anilist } satisfies ProfileData,
  };
}

/**
 * Moves a pre-profile state.json and AniList token into a profile folder.
 * state.json stays the source of truth until it is rewritten, so a crash midway reruns this safely.
 */
export function migrateLegacy(root: string, statePath: string) {
  if (!existsSync(statePath)) return;
  const stored = JSON.parse(readFileSync(statePath, "utf8"));
  const legacyToken = join(root, "anilist-token.bin");
  if (stored.profiles) {
    // Only left behind when a migration stopped after state.json was rewritten; the profile already has a copy.
    rmSync(legacyToken, { force: true });
    return;
  }
  const backup = statePath + ".before-profiles.json";
  if (!existsSync(backup)) copyFileSync(statePath, backup);
  const connected = existsSync(legacyToken);
  const { settings: { autoUpdates, ...settings } = {} as Settings, seriesAudio, progress, watch, favorites, favoriteChanges, anilist, ...shared } = stored;
  const id = legacyProfileId;
  writeProfile(root, id, { settings, seriesAudio, progress, watch, favorites, favoriteChanges, anilist });
  if (connected) copyFileSync(legacyToken, tokenFile(root, id));
  const user = connected && typeof anilist?.user === "string" ? anilist.user : undefined;
  const name = uniqueProfileName(user ?? "Default", []);
  writeJson(statePath, { ...shared, autoUpdates, profiles: { active: id, list: [{ id, name, created: Date.now(), anilistUser: user }] } });
  rmSync(legacyToken, { force: true });
}
