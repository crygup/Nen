import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as asyncFs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const require = createRequire(import.meta.url);
const bundles = new Map();
async function load(file, globals = {}) {
  if (!bundles.has(file))
    bundles.set(
      file,
      build({
        entryPoints: [join(root, file)],
        bundle: true,
        write: false,
        platform: "node",
        format: "cjs",
        logLevel: "silent",
      }),
    );
  const { outputFiles } = await bundles.get(file);
  const module = { exports: {} };
  runInNewContext(outputFiles[0].text, {
    module,
    require,
    console,
    process: { platform: "linux", env: {} },
    URL,
    Response,
    AbortController,
    AbortSignal,
    structuredClone,
    setTimeout,
    clearTimeout,
    ...globals,
  });
  return module.exports;
}
function temporary(t) {
  const parent = resolve(tmpdir());
  const path = fs.mkdtempSync(join(parent, "nen-check-"));
  t.after(() => {
    assert.ok(resolve(path).startsWith(parent + sep + "nen-check-"));
    fs.rmSync(path, { recursive: true, force: true });
  });
  return path;
}
const plain = (value) => JSON.parse(JSON.stringify(value));
const anime = {
  id: 21,
  idMal: 21,
  title: { english: "One Piece", romaji: "One Piece", native: null },
  coverImage: { large: "https://example.test/cover.jpg" },
  episodes: 1180,
  status: "RELEASING",
  streamingEpisodes: [],
};
function state(entry) {
  return {
    settings: {},
    watch: entry ? { [entry.mediaId]: entry } : {},
    progress: {},
    favorites: {},
    favoriteChanges: {},
    markers: {},
    mappings: {},
    anilist: { connected: true, baseline: {}, lastSync: 1000000 },
    mal: { connected: true, baseline: {}, lastSync: 1000000 },
  };
}

test("watch edits reset rewatch progress and count only completed runs", async () => {
  const { newEntry, editWatch } = await load("app/electron/watch-data.ts");
  const s = state(newEntry({ ...anime, episodes: 1 }));
  s.progress["21:1"] = {
    mediaId: 21,
    position: 99,
    duration: 100,
    watched: true,
  };
  editWatch(s, s.watch[21], { status: "COMPLETED", count: 1 });
  editWatch(s, s.watch[21], { startRewatch: true });
  assert.equal(s.watch[21].repeat, 0);
  assert.equal(s.watch[21].status, "REPEATING");
  assert.equal(s.watch[21].count, 0);
  assert.equal(s.progress["21:1"].position, 0);
  assert.equal(s.progress["21:1"].watched, false);
  editWatch(s, s.watch[21], {
    episode: 1,
    watched: true,
    position: 50,
    duration: 101,
  });
  assert.equal(s.watch[21].repeat, 1);
  assert.equal(s.watch[21].status, "COMPLETED");
  assert.equal(s.watch[21].runs.at(-1).episodes[1].manual, true);
  assert.equal(s.progress["21:1"].duration, 101);
  editWatch(s, s.watch[21], { status: "COMPLETED" });
  assert.equal(s.watch[21].repeat, 1);
});

test("invalid watch edits cannot partly reset progress", async () => {
  const { newEntry, editWatch, markEpisode } = await load(
    "app/electron/watch-data.ts",
  );
  const s = state(newEntry(anime));
  editWatch(s, s.watch[21], { status: "COMPLETED" });
  s.progress["21:1"] = {
    mediaId: 21,
    position: 99,
    duration: 100,
    watched: true,
  };
  const before = JSON.stringify(s);
  for (const patch of [
    { startRewatch: true, episode: 1, duration: -1 },
    { startRewatch: true, status: "INVALID" },
    { count: 1181 },
    { startRewatch: "yes" },
    [],
  ]) {
    assert.throws(() => editWatch(s, s.watch[21], patch));
    assert.equal(JSON.stringify(s), before);
  }
  editWatch(s, s.watch[21], { episode: 1, watched: false });
  markEpisode(s.watch[21], 1, { position: 20 });
  assert.equal(s.watch[21].runs.at(-1).episodes[1].manual, true);
  assert.equal(s.watch[21].runs.at(-1).episodes[1].watched, false);
});

test("backup accepts browser language codes and keeps unknown future fields harmless", async () => {
  const { readBackup, exportBackup } = await load("app/electron/backup.ts");
  const s = state();
  s.seriesAudio = { 21: "en", 22: "ja-JP", 23: "ENG", 24: "", 25: "fra" };
  const file = exportBackup(s);
  file.futureSetting = { ignored: true };
  assert.deepEqual(plain(readBackup(file).seriesAudio), {
    21: "eng",
    22: "jpn",
    23: "eng",
    25: "fra",
  });
  file.seriesAudio[21] = "<invalid>";
  assert.throws(() => readBackup(file), /Invalid backup mapping/);
});

test("backup merge preserves newer local edits and adds older missing episodes", async () => {
  const { newEntry } = await load("app/electron/watch-data.ts");
  const { readBackup, restoreBackup, exportBackup } = await load(
    "app/electron/backup.ts",
  );
  const local = newEntry({ ...anime, episodes: 12 });
  local.status = "PAUSED";
  local.statusUpdated = 200;
  local.count = 4;
  local.countUpdated = 200;
  local.runs[0].episodes[1] = {
    watched: false,
    position: 50,
    duration: 100,
    updated: 200,
  };
  const older = structuredClone(local);
  older.status = "CURRENT";
  older.statusUpdated = 100;
  older.count = 2;
  older.countUpdated = 100;
  older.runs[0].episodes[1] = {
    watched: true,
    position: 100,
    duration: 100,
    updated: 100,
  };
  older.runs[0].episodes[2] = {
    watched: true,
    position: 100,
    duration: 100,
    updated: 100,
  };
  const s = state(local);
  const merged = restoreBackup(
    s,
    readBackup(exportBackup(state(older))),
    "merge",
  );
  assert.equal(merged.watch[21].status, "PAUSED");
  assert.equal(merged.watch[21].count, 4);
  assert.equal(merged.watch[21].runs[0].episodes[1].position, 50);
  assert.equal(merged.watch[21].runs[0].episodes[2].watched, true);
  assert.equal(s.watch[21].runs[0].episodes[2], undefined);
});

test("automatic sync ignores playback seconds, detects edits, and polls remote changes", async () => {
  const { newEntry, syncDue, watchViewKey } = await load(
    "app/electron/watch-data.ts",
  );
  const entry = newEntry(anime);
  const s = state(entry);
  s.anilist.baseline[21] = { status: entry.status, count: 0, repeat: 0 };
  s.mal.baseline[21] = { ...s.anilist.baseline[21] };
  for (let n = 1; n <= 24; n++) {
    entry.updated++;
    assert.equal(syncDue(s, "anilist", 1000000 + n * 12000), false);
  }
  assert.equal(syncDue(s, "anilist", 1300000), true);
  s.anilist.lastSync = 1300000;
  assert.equal(syncDue(s, "anilist", 1312000), false);
  entry.status = "PAUSED";
  assert.equal(syncDue(s, "anilist", 1324000), true);
  assert.equal(syncDue(s, "anilist", 1336000), false);
  assert.equal(syncDue(s, "mal", 1324000), true);
  s.anilist.error = "Network error";
  assert.equal(syncDue(s, "anilist", 1348000), false);
  assert.equal(syncDue(s, "anilist", 1384000), true);
  s.settings.privateSession = true;
  assert.equal(syncDue(s, "anilist", 2000000), false);
  s.settings.privateSession = false;
  const before = watchViewKey(s);
  s.anilist.lastSync++;
  assert.equal(watchViewKey(s), before);
  entry.count++;
  assert.notEqual(watchViewKey(s), before);
});

test("favorites trigger sync even when watch counts are unchanged", async () => {
  const { syncDue } = await load("app/electron/watch-data.ts");
  const s = state();
  assert.equal(syncDue(s, "anilist", 1012000), false);
  s.favoriteChanges[21] = true;
  assert.equal(syncDue(s, "anilist", 1012000), true);
  assert.equal(syncDue(s, "mal", 1012000), false);
});

test("long series prioritize the current page and retain all page choices", async () => {
  const { episodePages } = await load("app/src/shared.ts");
  const pages = episodePages(1180, true, false, 948);
  assert.equal(pages[0], 19);
  assert.equal(pages.length, 24);
  assert.equal(new Set(pages).size, 24);
  assert.deepEqual(
    plain(pages.slice(1, 3)).sort((a, b) => a - b),
    [18, 20],
  );
  assert.deepEqual(plain(episodePages(1180, false, false)), [1]);
  assert.deepEqual(plain(episodePages(1180, false, true)), [24, 23]);
  assert.deepEqual(plain(episodePages(0, true, false)), []);
});

test("save queue captures each profile, coalesces writes, and skips unchanged files", async (t) => {
  const dir = temporary(t);
  let reads = 0,
    writes = 0;
  const profiles = await load("app/electron/profiles.ts", {
    require: (name) => {
      if (name === "node:fs")
        return {
          ...fs,
          readFileSync: (...args) => {
            reads++;
            return fs.readFileSync(...args);
          },
        };
      if (name === "node:fs/promises")
        return {
          ...asyncFs,
          writeFile: (...args) => {
            writes++;
            return asyncFs.writeFile(...args);
          },
        };
      return require(name);
    },
  });
  const a = "1111111111111111",
    b = "2222222222222222";
  profiles.writeProfile(dir, a, { watch: {} });
  const data = { watch: { value: 1 } };
  profiles.queueProfile(dir, a, data);
  data.watch.value = 2;
  profiles.queueProfile(dir, b, data);
  const flushing = profiles.flushWrites();
  data.watch.value = 3;
  profiles.queueProfile(dir, b, data);
  await Promise.all([flushing, profiles.flushWrites()]);
  assert.equal(profiles.readProfile(dir, a).watch.value, 1);
  assert.equal(profiles.readProfile(dir, b).watch.value, 3);
  assert.equal(writes, 2);
  const beforeReads = reads;
  profiles.queueProfile(dir, b, data);
  await profiles.flushWrites();
  assert.equal(reads, beforeReads);
  assert.equal(writes, 2);
});

test("failed saves stay queued and future profile formats are never overwritten", async (t) => {
  const dir = temporary(t);
  let fail = true;
  const profiles = await load("app/electron/profiles.ts", {
    require: (name) =>
      name === "node:fs/promises"
        ? {
            ...asyncFs,
            writeFile: (...args) =>
              fail
                ? Promise.reject(Error("disk full"))
                : asyncFs.writeFile(...args),
          }
        : require(name),
  });
  const path = join(dir, "state.json");
  profiles.queueJson(path, { position: 948 });
  await assert.rejects(profiles.flushWrites(), /disk full/);
  fail = false;
  await profiles.flushWrites();
  assert.equal(JSON.parse(fs.readFileSync(path, "utf8")).position, 948);
  const id = "3333333333333333",
    folder = profiles.profileDir(dir, id);
  fs.mkdirSync(folder, { recursive: true });
  fs.writeFileSync(profiles.profileFile(dir, id), '{"schemaVersion":99}');
  assert.throws(() => profiles.queueProfile(dir, id, {}), /unsupported format/);
  assert.equal(
    fs.readFileSync(profiles.profileFile(dir, id), "utf8"),
    '{"schemaVersion":99}',
  );
});

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function until(predicate) {
  for (let n = 0; n < 100; n++) {
    if (predicate()) return;
    await tick();
  }
  assert.fail("Expected operation did not start");
}
function metadata(url) {
  const u = new URL(url);
  if (u.hostname === "graphql.anilist.co") return { data: { Media: anime } };
  if (u.hostname === "api.jikan.moe")
    return {
      data: Array.from({ length: 100 }, (_, i) => ({
        mal_id: 901 + i,
        title: "Title " + (901 + i),
      })),
    };
  if (u.pathname.endsWith("/mappings"))
    return {
      data: [
        {
          attributes: { externalSite: "myanimelist/anime", externalId: "21" },
          relationships: { item: { data: { type: "anime", id: "12" } } },
        },
      ],
    };
  const offset = Number(u.searchParams.get("page[offset]"));
  return {
    data: Array.from({ length: 20 }, (_, i) => ({
      attributes: {
        number: offset + i + 1,
        thumbnail: { original: "https://example.test/frame.jpg" },
      },
    })),
    links: { next: "next" },
  };
}

test("expired metadata survives a restart and returns while network refresh is blocked", async (t) => {
  const path = join(temporary(t), "cache.json");
  let requests = 0;
  const first = await load("app/electron/providers.ts", {
    fetch: async (url) => {
      requests++;
      return new Response(JSON.stringify(metadata(url)));
    },
  });
  first.initCache(path);
  const data = await first.episodes(21, 19);
  assert.equal(data.items.find((e) => e.number === 948).title, "Title 948");
  assert.equal(requests, 6);
  await first.episodes(21, 19);
  assert.equal(requests, 6);
  await new Promise((resolve) => setTimeout(resolve, 550));
  const saved = JSON.parse(fs.readFileSync(path, "utf8"));
  for (const [, value] of saved) value.expires = Date.now() - 86400000;
  fs.writeFileSync(path, JSON.stringify(saved));
  const refresh = [];
  const second = await load("app/electron/providers.ts", {
    fetch: (url) =>
      new Promise((resolve) => {
        refresh.push(() =>
          resolve(new Response(JSON.stringify(metadata(url)))),
        );
      }),
  });
  second.initCache(path);
  let complete = false;
  const loading = second.episodes(21, 19).then((value) => {
    complete = true;
    return value;
  });
  await until(() => complete);
  assert.equal(
    (await loading).items.find((e) => e.number === 948).thumbnail,
    "https://example.test/frame.jpg",
  );
  assert.ok(refresh.length > 0);
  refresh.forEach((resolve) => resolve());
});

function client(url) {
  const req = Object.assign(new EventEmitter(), {
    url,
    method: "GET",
    headers: {},
  });
  const res = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    statusCode: 200,
    setHeader() {},
    end(body) {
      this.body = body;
      this.writableEnded = true;
    },
  });
  return {
    req,
    res,
    cancel() {
      res.destroyed = true;
      res.emit("close");
    },
  };
}

test("one cancelled client does not cancel another client's shared stream lookup", async (t) => {
  const dir = temporary(t);
  let sourceSignal, finishSearch;
  const api = await load("nen-browser/api.js", {
    process: { platform: "linux", env: { NEN_CACHE_DIR: dir } },
    fetch: async (url, options) => {
      if (url.startsWith("https://graphql"))
        return new Response(JSON.stringify(metadata(url)));
      sourceSignal = options.signal;
      return new Promise((resolve, reject) => {
        finishSearch = () =>
          resolve(new Response(JSON.stringify({ success: true, data: [] })));
        options.signal.addEventListener(
          "abort",
          () => reject(options.signal.reason),
          { once: true },
        );
      });
    },
  });
  const a = client("/stream?id=21&episode=948"),
    b = client("/stream?id=21&episode=948");
  const first = api.handleApi(a.req, a.res),
    second = api.handleApi(b.req, b.res);
  await until(() => !!finishSearch);
  a.cancel();
  await first;
  assert.equal(sourceSignal.aborted, false);
  b.cancel();
  await second;
  assert.equal(sourceSignal.aborted, true);
});

test("cancelled metadata requests release server capacity", async (t) => {
  const dir = temporary(t);
  let finish;
  const api = await load("nen-browser/api.js", {
    process: { platform: "linux", env: { NEN_CACHE_DIR: dir } },
    fetch: (url) =>
      new Promise((resolve) => {
        finish = () => resolve(new Response(JSON.stringify(metadata(url))));
      }),
  });
  for (let n = 0; n < 25; n++) {
    const c = client("/media?id=21");
    const task = api.handleApi(c.req, c.res);
    assert.notEqual(c.res.statusCode, 503);
    c.cancel();
    await task;
  }
  finish();
  await tick();
});

import ts from "typescript";
import { createContext, runInContext } from "node:vm";

// Run the actual event callbacks with a controlled disk write and window.
// This covers both the X button and app.quit() without launching a real profile.
function shutdownHarness(flushWrites) {
  const source = ts.createSourceFile(
    "main.ts",
    fs.readFileSync(join(root, "app/electron/main.ts"), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const find = (target, event) => {
    let callback;
    const visit = (node) => {
      if (
        ts.isCallExpression(node) &&
        node.expression.getText(source) === target &&
        node.arguments[0]?.text === event
      )
        callback = node.arguments[1];
      ts.forEachChild(node, visit);
    };
    visit(source);
    assert.ok(callback, `Missing ${event} callback`);
    return ts.transpileModule(`(${callback.getText(source)})`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
  };
  const counts = { save: 0, stop: 0, quit: 0, errors: 0 };
  const context = createContext({
    readyToSave: true,
    savedBeforeQuit: false,
    savingBeforeQuit: false,
    closing: true,
    miniWindow: undefined,
    state: { profiles: {} },
    together: { disconnect() {} },
    discordPresence: { close() {} },
    stop: () => counts.stop++,
    save: () => counts.save++,
    flushWrites,
    dialog: { showErrorBox: () => counts.errors++ },
    window: {
      isDestroyed: () => false,
      getNormalBounds: () => ({ width: 1000, height: 700 }),
      isMaximized: () => false,
    },
  });
  // Each callback shares the same flags, as it does in Electron.
  const onQuit = runInContext(find("app.on", "before-quit"), context);
  const onClose = runInContext(find("window.on", "close"), context);
  context.app = {
    quit() {
      let prevented = false;
      onQuit({
        preventDefault() {
          prevented = true;
        },
      });
      if (!prevented) {
        onClose({
          preventDefault() {
            prevented = true;
          },
        });
        if (!prevented) counts.quit++;
      }
    },
  };
  return { counts, context, close: () => onClose({ preventDefault() {} }) };
}

test("desktop X waits for the final save even when closing was already set", async () => {
  let finish;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const { counts, context, close } = shutdownHarness(() => pending);
  close();
  context.app.quit();
  assert.equal(counts.quit, 0);
  assert.equal(counts.save, 1);
  assert.equal(counts.stop, 1);
  finish();
  await tick();
  assert.equal(counts.quit, 1);
  assert.equal(counts.save, 1);
  assert.equal(context.state.window.width, 1000);
});

test("desktop stays open after a save error and can retry closing", async () => {
  let fail = true;
  const { counts, context } = shutdownHarness(() =>
    fail ? Promise.reject(Error("disk full")) : Promise.resolve(),
  );
  context.app.quit();
  await tick();
  assert.equal(counts.quit, 0);
  assert.equal(counts.errors, 1);
  assert.equal(context.closing, false);
  fail = false;
  context.app.quit();
  await tick();
  assert.equal(counts.quit, 1);
});

test("failed startup does not write an unreadable profile on exit", async () => {
  const { counts, context } = shutdownHarness(() => Promise.resolve());
  context.readyToSave = false;
  context.app.quit();
  await tick();
  assert.equal(counts.quit, 1);
  assert.equal(counts.save, 0);
  assert.equal(counts.stop, 0);
});
