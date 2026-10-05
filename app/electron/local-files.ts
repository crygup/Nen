import { readFileSync, existsSync } from "node:fs";
import { realpath, stat, readdir } from "node:fs/promises";
import {
  basename,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { randomUUID } from "node:crypto";
import { writeJson } from "./profiles";
import type { LocalState, LocalFolder } from "../src/shared";

const videos = new Set([
  ".mkv",
  ".mp4",
  ".webm",
  ".avi",
  ".mov",
  ".m4v",
  ".ts",
  ".m2ts",
]);
export const subtitleExtensions = ["srt", "vtt", "ass", "ssa"];
const natural = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
function episode(name: string) {
  const clean = basename(name, extname(name)).replace(/\[[^\]]*\]/g, " ");
  const match = clean.match(
    /(?:S\d+E|\bEP?(?:ISODE)?[ ._-]*|\s-\s)(\d{1,4})(?!\d)/i,
  );
  return match ? Number(match[1]) : undefined;
}
export function localOrder(a: { name: string }, b: { name: string }) {
  const left = episode(a.name),
    right = episode(b.name);
  return (
    (left !== undefined && right !== undefined ? left - right : 0) ||
    natural.compare(a.name, b.name)
  );
}
export class LocalFiles {
  private data: LocalState & {
    progress: Record<
      string,
      { position: number; duration: number; size: number; modified: number }
    >;
  };
  constructor(private file: string) {
    this.data = { enabled: false, sources: [], progress: {} };
    // Read on use so a damaged local library cannot prevent the app from starting.
  }
  private loaded = false;
  private load() {
    if (this.loaded) return;
    if (existsSync(this.file)) {
      const value = JSON.parse(readFileSync(this.file, "utf8"));
      if (
        typeof value.enabled !== "boolean" ||
        !Array.isArray(value.sources) ||
        !value.progress ||
        typeof value.progress !== "object" ||
        Array.isArray(value.progress) ||
        value.sources.some(
          (s: any) =>
            typeof s.id !== "string" ||
            typeof s.path !== "string" ||
            !isAbsolute(s.path) ||
            typeof s.name !== "string",
        )
      )
        throw Error(
          "Local files settings could not be read. Your video files have not been changed.",
        );
      this.data = value;
    }
    this.loaded = true;
  }
  private save() {
    writeJson(this.file, this.data);
  }
  async state(): Promise<LocalState> {
    this.load();
    return {
      enabled: this.data.enabled,
      sources: await Promise.all(
        this.data.sources.map(async (source) => ({
          ...source,
          available: await stat(source.path).then(
            (s) => s.isDirectory(),
            () => false,
          ),
        })),
      ),
    };
  }
  enable(value: boolean) {
    this.load();
    if (typeof value !== "boolean") throw Error("Invalid local files setting.");
    this.data.enabled = value;
    this.save();
  }
  async add(path: string) {
    this.load();
    path = await realpath(path);
    if (!(await stat(path)).isDirectory()) throw Error("Select a folder.");
    if (!this.data.sources.some((s) => s.path === path)) {
      this.data.sources.push({
        id: randomUUID(),
        name: basename(path) || path,
        path,
      });
      this.save();
    }
  }
  remove(id: string) {
    this.load();
    this.data.sources = this.data.sources.filter((s) => s.id !== id);
    for (const key of Object.keys(this.data.progress))
      if (key.startsWith(id + ":")) delete this.data.progress[key];
    this.save();
  }
  async path(id: string, path: string) {
    this.load();
    if (!this.data.enabled)
      throw Error("Enable Local files in Settings first.");
    const source = this.data.sources.find((s) => s.id === id);
    if (!source || typeof path !== "string" || isAbsolute(path))
      throw Error("Invalid local source or file.");
    const root = await realpath(source.path);
    const full = await realpath(resolve(root, path));
    const rel = relative(root, full);
    if (rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel))
      throw Error("The file is outside this source folder.");
    return full;
  }
  async list(id: string, path = ""): Promise<LocalFolder> {
    const full = await this.path(id, path);
    const entries = await readdir(full, { withFileTypes: true });
    const result: LocalFolder = {
      path,
      parent: path ? (dirname(path) === "." ? "" : dirname(path)) : null,
      entries: [],
    };
    for (const entry of entries) {
      // Do not follow links during browsing or subtitle discovery.
      if (
        !entry.isDirectory() &&
        !(entry.isFile() && videos.has(extname(entry.name).toLowerCase()))
      )
        continue;
      const child = join(path, entry.name);
      result.entries.push({
        name: entry.name,
        path: child,
        directory: entry.isDirectory(),
      });
    }
    result.entries.sort(
      (a, b) => Number(b.directory) - Number(a.directory) || localOrder(a, b),
    );
    return result;
  }
  async video(id: string, path: string) {
    const full = await this.path(id, path),
      info = await stat(full);
    if (!info.isFile() || !videos.has(extname(full).toLowerCase()))
      throw Error("Select a supported video file.");
    const folder = await this.list(
      id,
      dirname(path) === "." ? "" : dirname(path),
    );
    const playlist = folder.entries.filter((e) => !e.directory);
    const index = playlist.findIndex((e) => e.path === path);
    if (index < 0) throw Error("This video is no longer in the source folder.");
    const saved = this.data.progress[id + ":" + path];
    const position =
      saved &&
      saved.size === info.size &&
      saved.modified === info.mtimeMs &&
      Number.isFinite(saved.position) &&
      saved.position >= 0 &&
      saved.position < saved.duration - 5
        ? saved.position
        : 0;
    return {
      full,
      info,
      position,
      next: playlist[index + 1]?.path,
      name: basename(path),
      folder: basename(dirname(full)),
    };
  }
  record(
    id: string,
    path: string,
    position: number,
    duration: number,
    info: { size: number; mtimeMs: number },
  ) {
    if (
      !Number.isFinite(position) ||
      !Number.isFinite(duration) ||
      duration <= 0
    )
      return;
    this.data.progress[id + ":" + path] = {
      position,
      duration,
      size: info.size,
      modified: info.mtimeMs,
    };
    this.save();
  }
  async subtitles(id: string, path: string) {
    const stem = basename(path, extname(path)).toLowerCase(),
      folder = dirname(path);
    const found: string[] = [];
    for (const subdir of [
      folder,
      join(folder, "Subs"),
      join(folder, "Subtitles"),
    ]) {
      try {
        const dir = await this.path(id, subdir);
        for (const entry of await readdir(dir, { withFileTypes: true })) {
          if (
            !entry.isFile() ||
            !subtitleExtensions.includes(
              extname(entry.name).slice(1).toLowerCase(),
            )
          )
            continue;
          const name = basename(entry.name, extname(entry.name)).toLowerCase();
          if (
            name !== stem &&
            !name.startsWith(stem + ".") &&
            !name.startsWith(stem + " ") &&
            !name.startsWith(stem + "_")
          )
            continue;
          found.push(await this.path(id, join(subdir, entry.name)));
        }
      } catch {
        /* An optional subtitle folder can be absent or unavailable. */
      }
    }
    return found.sort(natural.compare);
  }
}
