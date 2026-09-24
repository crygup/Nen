import { _electron } from "playwright";
import electron from "electron";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createServer } from "node:http";

const root = resolve("test-builds", `e2e-watch-${Date.now()}`);
const firstData = join(root, "first-pc");
const secondData = join(root, "second-pc");
const thirdData = join(root, "replace-pc");
const transfer = join(root, "watch-data.json");
const remote = new Map([
  [1, { mediaId: 1, status: "CURRENT", progress: 2, repeat: 0, media: { title: { english: "Cowboy Bebop", romaji: "Cowboy Bebop" }, coverImage: { large: "" }, episodes: 26, isAdult: false } }],
  [5, { mediaId: 5, status: "COMPLETED", progress: 12, repeat: 0, media: { title: { english: "Remote Anime", romaji: "Remote Anime" }, coverImage: { large: "" }, episodes: 12, isAdult: false } }],
]);
let networkFailure = false;
const requests = [];
const responses = [];
const server = createServer(async (req, res) => {
  res.on("finish", () => responses.push(res.statusCode));
  let body = "";
  for await (const chunk of req) body += chunk;
  res.setHeader("Content-Type", "application/json");
  res.setHeader("Connection", "close");
  if (networkFailure) { res.writeHead(503); res.end(JSON.stringify({ errors: [{ message: "Test network failure" }] })); return; }
  const { query, variables = {} } = JSON.parse(body);
  requests.push(query.slice(0, 80));
  if (query.includes("Viewer")) res.end(JSON.stringify({ data: { Viewer: { id: 99, name: "Test User" } } }));
  else if (query.includes("MediaListCollection")) res.end(JSON.stringify({ data: { MediaListCollection: { lists: [{ entries: [...remote.values()] }] } } }));
  else if (query.includes("SaveMediaListEntry")) {
    const row = remote.get(variables.mediaId);
    if (!row) { res.writeHead(400); res.end(JSON.stringify({ errors: [{ message: "Missing test anime" }] })); return; }
    if (variables.status !== undefined) row.status = variables.status;
    if (variables.count !== undefined) row.progress = variables.count;
    if (variables.repeat !== undefined) row.repeat = variables.repeat;
    res.end(JSON.stringify({ data: { SaveMediaListEntry: { id: variables.mediaId } } }));
  } else { res.writeHead(400); res.end(JSON.stringify({ errors: [{ message: "Unknown query" }] })); }
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/graphql`;
mkdirSync(firstData, { recursive: true });
mkdirSync(secondData, { recursive: true });
mkdirSync(thirdData, { recursive: true });
const now = Date.now();
const legacy = {
  settings: { theme: "dark", autoSkip: false, autoNext: false, developmentBuilds: false, showAdult: false, hideZeroSeeds: true, audio: "jpn,ja", subtitles: "eng,en", source: "all", sourceMode: "auto", qualities: [1080, 720, 480, 360] },
  progress: {
    "1:1": { watched: true, isAdult: false, episodeTitle: "Asteroid Blues", season: "Cowboy Bebop", malId: 1, totalEpisodes: 26, mediaId: 1, title: "Cowboy Bebop", cover: "./n.png", episode: 1, hash: "0".repeat(40), release: { hash: "0".repeat(40), title: "Cowboy Bebop - 01", source: "Nyaa", size: "1 GB", seeds: 1, resolution: "1080p", group: "Test", language: "Japanese", episode: 1, endEpisode: null, batch: false, confidence: "Episode match" }, file: { index: 0, path: "Cowboy Bebop - 01.mkv", size: 1000 }, position: 1200, duration: 1400, updated: now, malEpisode: 1 },
  },
  markers: {}, mappings: {},
};
writeFileSync(join(firstData, "state.json"), JSON.stringify(legacy));
const checks = [];
async function launch(userData, extra = {}) {
  const app = await _electron.launch({ executablePath: electron, args: ["."], env: { ...process.env, NEN_E2E_USER_DATA: userData, ...extra } });
  const page = await app.firstWindow();
  await page.locator('[data-nav="watchlist"]').waitFor();
  return { app, page };
}
let first, second, third;
try {
  first = await launch(firstData, { NEN_E2E_EXPORT_PATH: transfer });
  await first.page.locator('[data-nav="watchlist"]').click();
  await first.page.getByRole("heading", { name: "Watch list" }).waitFor();
  assert.match(await first.page.locator("#main").innerText(), /Cowboy Bebop/);
  let watch = await first.page.evaluate(() => window.nen.state().then(state => state.watch["1"]));
  assert.equal(watch.status, "CURRENT");
  assert.equal(watch.count, 1);
  assert.equal(watch.runs[0].episodes["1"].position, 1200);
  checks.push("Legacy progress moved to watch data with playback time");
  await first.page.screenshot({ path: join(root, "01-migrated-watch-list.png") });

  await first.page.locator('[data-watch-edit="1"]').click();
  await first.page.locator('#watch-form select[name="status"]').selectOption("COMPLETED");
  first.page.once("dialog", dialog => dialog.accept());
  await first.page.getByRole("button", { name: "Save watch data" }).click();
  await first.page.getByRole("heading", { name: "Watch list" }).waitFor();
  watch = await first.page.evaluate(() => window.nen.state().then(state => state.watch["1"]));
  assert.equal(watch.status, "COMPLETED");
  checks.push("Season completion needs confirmation and saves status");

  await first.page.locator('[data-watch-edit="1"]').click();
  await first.page.getByRole("button", { name: "Start rewatch" }).click();
  watch = await first.page.evaluate(() => window.nen.state().then(state => state.watch["1"]));
  assert.equal(watch.status, "REPEATING");
  assert.equal(watch.count, 0);
  assert.equal(watch.runs.length, 2);
  assert.equal(watch.runs[0].episodes["1"].position, 1200);
  checks.push("Rewatch starts at zero and keeps the first run");

  await first.page.locator('[data-watch-edit="1"]').click();
  await first.page.locator('#watch-form input[name="episode"]').fill("1");
  await first.page.locator('#watch-form input[name="watched"]').check();
  await first.page.locator('#watch-form input[name="position"]').fill("45");
  await first.page.locator('#watch-form input[name="duration"]').fill("1400");
  await first.page.getByRole("button", { name: "Save watch data" }).click();
  watch = await first.page.evaluate(() => window.nen.state().then(state => state.watch["1"]));
  assert.equal(watch.count, 1);
  assert.equal(watch.runs[1].episodes["1"].position, 45);
  checks.push("Manual episode mark and playback time save in the new run");

  await first.page.locator('[data-nav="settings"]').click();
  await first.page.getByRole("button", { name: "Export watch data" }).click();
  await first.page.waitForTimeout(300);
  const exported = JSON.parse(readFileSync(transfer, "utf8"));
  assert.equal(exported.version, 1);
  assert.equal(exported.entries[0].runs.length, 2);
  assert.equal(JSON.stringify(exported).includes("hash"), false);
  assert.equal(JSON.stringify(exported).includes("token"), false);
  checks.push("Export has watch records and no source or token");
  await first.app.close(); first = undefined;

  second = await launch(secondData, { NEN_E2E_IMPORT_PATH: transfer, NEN_E2E_ANILIST_URL: endpoint, NEN_E2E_ANILIST_TOKEN: "fake-ani-list-token-for-e2e-check" });
  await second.page.locator('[data-nav="settings"]').click();
  await second.page.getByRole("button", { name: "Import watch data" }).click();
  await second.page.getByRole("heading", { name: "Import watch data" }).waitFor();
  await second.page.getByRole("button", { name: "Merge" }).click();
  const imported = await second.page.evaluate(() => window.nen.state().then(state => state.watch["1"]));
  assert.equal(imported.runs.length, 2);
  assert.equal(imported.runs[1].episodes["1"].position, 45);
  assert.equal(imported.runs[0].episodes["1"].position, 1200);
  checks.push("Transfer to a new data folder restores both runs and playback times");
  await second.page.locator('[data-nav="watchlist"]').click();
  await second.page.getByRole("heading", { name: "Watch list" }).waitFor();
  await second.page.screenshot({ path: join(root, "02-imported-watch-list.png") });

  await second.page.locator('[data-nav="settings"]').click();
  await second.page.getByRole("button", { name: "Connect AniList" }).click();
  await second.page.getByRole("heading", { name: "Review AniList sync" }).waitFor({ timeout: 5000 });
  for (const label of await second.page.locator(".sync-changes label").all())
    await label.locator("select").selectOption((await label.innerText()).includes("Cowboy Bebop") ? "local" : "remote");
  await second.page.getByRole("button", { name: "Apply sync" }).click();
  await second.page.waitForFunction(() => !document.querySelector("dialog[open]"));
  let syncState = await second.page.evaluate(() => window.nen.state());
  assert.equal(syncState.watch["5"].status, "COMPLETED");
  assert.equal(syncState.watch["5"].count, 12);
  assert.equal(Object.keys(syncState.watch["5"].runs[0].episodes).length, 0);
  assert.equal(remote.get(1).status, "REPEATING");
  assert.equal(remote.get(1).progress, 1);
  assert.equal(readFileSync(join(secondData, "anilist-token.bin"), "utf8").includes("fake-ani-list-token"), false);
  checks.push("First sync imports an existing list and reviews conflicts without inventing episodes");

  await second.app.close(); second = undefined;
  remote.get(5).status = "PAUSED";
  second = await launch(secondData, { NEN_E2E_IMPORT_PATH: transfer, NEN_E2E_ANILIST_URL: endpoint, NEN_E2E_ANILIST_TOKEN: "fake-ani-list-token-for-e2e-check" });
  for (let i = 0; i < 40; i++) {
    if ((await second.page.evaluate(() => window.nen.state())).watch["5"]?.status === "PAUSED") break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  await second.page.locator('[data-nav="watchlist"]').click();
  await second.page.getByRole("heading", { name: "Watch list" }).waitFor();
  assert.equal((await second.page.evaluate(() => window.nen.state())).watch["5"].status, "PAUSED");
  checks.push("App start reads later AniList changes");

  remote.get(1).progress = 3;
  await second.page.locator('[data-watch-edit="1"]').click();
  await second.page.locator('#watch-form input[name="count"]').fill("2");
  await second.page.getByRole("button", { name: "Save watch data" }).click();
  await second.page.locator('[data-nav="settings"]').click();
  await second.page.getByRole("button", { name: "Sync now" }).click();
  await second.page.getByRole("heading", { name: "Review AniList sync" }).waitFor();
  assert.match(await second.page.locator(".sync-changes").innerText(), /Nen: 2 · AniList: 3/);
  await second.page.locator(".sync-changes select").selectOption("remote");
  await second.page.getByRole("button", { name: "Apply sync" }).click();
  syncState = await second.page.evaluate(() => window.nen.state());
  assert.equal(syncState.watch["1"].count, 3);
  assert.equal(Object.keys(syncState.watch["1"].runs[1].episodes).length, 1);
  checks.push("Two-sided count conflict waits for a choice and keeps exact local episode records");

  await second.page.locator('[data-watch-edit="1"]').click();
  await second.page.locator('#watch-form select[name="status"]').selectOption("COMPLETED");
  second.page.once("dialog", dialog => dialog.accept());
  await second.page.getByRole("button", { name: "Save watch data" }).click();
  await second.page.locator('[data-nav="settings"]').click();
  await second.page.getByRole("button", { name: "Sync now" }).click();
  await second.page.getByRole("heading", { name: "Review AniList sync" }).waitFor();
  for (const select of await second.page.locator(".sync-changes select").all()) await select.selectOption("local");
  await second.page.getByRole("button", { name: "Apply sync" }).click();
  assert.equal(remote.get(1).status, "COMPLETED");
  assert.equal(remote.get(1).repeat, 1);
  checks.push("Rewatch completion updates status and rewatch count once");

  await second.page.locator('[data-watch-edit="1"]').click();
  await second.page.locator('#watch-form select[name="status"]').selectOption("PAUSED");
  await second.page.getByRole("button", { name: "Save watch data" }).click();
  networkFailure = true;
  await second.page.locator('[data-nav="settings"]').click();
  await second.page.getByRole("button", { name: "Sync now" }).click();
  for (let i = 0; i < 40; i++) {
    if ((await second.page.evaluate(() => window.nen.state())).anilist.error) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok((await second.page.evaluate(() => window.nen.state())).anilist.error);
  assert.equal(remote.get(1).status, "COMPLETED");
  networkFailure = false;
  await second.page.locator('[data-nav="settings"]').click();
  await second.page.getByRole("button", { name: "Sync now" }).click();
  await second.page.getByRole("heading", { name: "Review AniList sync" }).waitFor();
  await second.page.locator(".sync-changes select").selectOption("local");
  await second.page.getByRole("button", { name: "Apply sync" }).click();
  assert.equal(remote.get(1).status, "PAUSED");
  checks.push("Network failure keeps local change and later sync retries it");

  await second.page.locator('[data-nav="settings"]').click();
  await second.page.getByRole("button", { name: "Disconnect" }).click();
  syncState = await second.page.evaluate(() => window.nen.state());
  assert.equal(syncState.anilist.connected, false);
  assert.equal(syncState.watch["1"].status, "PAUSED");
  checks.push("Disconnect removes the token and keeps watch data");
  await second.app.close(); second = undefined;

  const oldEntry = structuredClone(exported.entries[0]);
  oldEntry.mediaId = 99;
  oldEntry.title = "Old local anime";
  writeFileSync(join(thirdData, "state.json"), JSON.stringify({ ...legacy, progress: {}, watch: { "99": oldEntry }, anilist: { connected: false, baseline: {} } }));
  third = await launch(thirdData, { NEN_E2E_IMPORT_PATH: transfer });
  await third.page.locator('[data-nav="settings"]').click();
  await third.page.getByRole("button", { name: "Import watch data" }).click();
  third.page.once("dialog", dialog => dialog.accept());
  await third.page.getByRole("button", { name: "Replace" }).click();
  const replaced = await third.page.evaluate(() => window.nen.state());
  assert.equal(replaced.watch["99"], undefined);
  assert.equal(replaced.watch["1"].title, "Cowboy Bebop");
  assert.ok(readdirSync(thirdData).some(name => name.startsWith("state.json.before-import-")));
  checks.push("Replace removes old entries and creates a local backup");
  await third.app.close(); third = undefined;

  const invalid = join(root, "invalid-watch-data.json");
  writeFileSync(invalid, JSON.stringify({ version: 1, entries: [{ mediaId: 1, title: "Invalid" }] }));
  third = await launch(thirdData, { NEN_E2E_IMPORT_PATH: invalid });
  await third.page.locator('[data-nav="settings"]').click();
  await third.page.getByRole("button", { name: "Import watch data" }).click();
  await third.page.locator(".dialog-error").waitFor();
  assert.match(await third.page.locator(".dialog-error").innerText(), /Invalid anime entry/);
  assert.equal((await third.page.evaluate(() => window.nen.state())).watch["1"].title, "Cowboy Bebop");
  checks.push("Invalid import stops before it changes watch data");
  await third.app.close(); third = undefined;

  const result = { passed: true, checks, artifact: root, date: new Date().toISOString() };
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  let detail = "";
  if (second?.page) {
    await second.page.screenshot({ path: join(root, "failure.png") }).catch(() => {});
    detail = await second.page.locator("body").innerText().catch(() => "");
    detail += `\nDialog error: ${await second.page.locator(".dialog-error").allInnerTexts().catch(() => [])}`;
  }
  const result = { passed: false, checks, error: String(error), detail: detail.slice(0, 3000), requests, responses, artifact: root, date: new Date().toISOString() };
  writeFileSync(join(root, "result.json"), JSON.stringify(result, null, 2));
  console.error(JSON.stringify(result, null, 2));
  process.exitCode = 1;
} finally {
  await first?.app.close().catch(() => {});
  await second?.app.close().catch(() => {});
  await third?.app.close().catch(() => {});
  await new Promise(resolve => server.close(resolve));
}
