import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";

const artifactDir = join(process.cwd(), "test-builds", "download-progress-e2e");
await mkdir(artifactDir, { recursive: true });
const checks = [];
const errors = [];
const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
let browser;
try {
  await server.listen();
  const url = server.resolvedUrls.local[0];
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ channel: "msedge" });
  }
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  page.on("pageerror", error => errors.push(error.message));
  await page.route(`${url}download-progress-fixture`, route => route.fulfill({
    contentType: "text/html",
    body: `<!doctype html><html><head><meta charset="utf-8"><style>body{background:radial-gradient(circle at 50% 35%,#493f5f,#11151c 65%);}</style></head><body><div id="app"></div><script>
      window.VideoDecoder = class { state = "configured"; decodeQueueSize = 0; constructor() {} configure() {} decode() {} reset() {} close() { this.state = "closed"; } };
      window.nen = {
        onTogether: () => () => {}, togetherState: async () => ({ connected: false, members: [] }),
        onVideo: () => () => {}, startVideo: async () => {}, control: async (...args) => { window.lastControl = args; },
      };
    </script><script type="module">
      import "/src/style.css";
      import { mountPlayer } from "/src/watch.ts";
      window.renderPlayer = mountPlayer({ sources: () => { window.sourceOpened = true; }, next: () => {}, edit: () => {}, error: error => { throw error; } });
    </script></body></html>`,
  }));
  await page.goto(`${url}download-progress-fixture`);
  await page.waitForFunction(() => typeof window.renderPlayer === "function");
  const playback = {
    active: true, position: 60, duration: 600, paused: true, ready: true,
    title: "Download progress check", episode: 1, tracks: [],
    speed: 0, peers: 1, progress: 0.3, markers: [],
  };
  await page.evaluate(value => window.renderPlayer(value), playback);
  assert.equal(await page.locator("#download-percent").count(), 0);
  checks.push("The percent label is absent");

  await page.evaluate(value => window.renderPlayer(value), {
    ...playback,
    download: { ranges: [[0, 0.2], [0.8, 0.9]] },
  });
  const gradient = await page.locator("#seek").evaluate(element => element.style.getPropertyValue("--downloaded"));
  assert.match(gradient, /20\.000%/);
  assert.match(gradient, /80\.000%/);
  assert.match(gradient, /90\.000%/);
  checks.push("Separate downloaded ranges appear on the scrubber");
  await page.screenshot({ path: join(artifactDir, "partial-download.png") });

  await page.locator("#seek").dispatchEvent("pointerdown");
  await page.locator("#seek").evaluate(element => {
    element.value = "300";
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await page.evaluate(value => window.renderPlayer(value), {
    ...playback, position: 90,
    download: { ranges: [[0, 0.2], [0.8, 0.9]] },
  });
  assert.equal(await page.locator("#seek").inputValue(), "300");
  assert.equal(await page.locator("#position").innerText(), "01:30");
  checks.push("Download updates do not move the scrubber during a drag");

  await page.evaluate(value => window.renderPlayer(value), playback);
  const clearedGradient = await page.locator("#seek").evaluate(element => element.style.getPropertyValue("--downloaded"));
  assert.doesNotMatch(clearedGradient, /rgb\(/);
  checks.push("Downloaded ranges clear when the video changes");

  await page.evaluate(value => window.renderPlayer(value), {
    ...playback, download: { ranges: [[0, 1]] },
  });
  const fullGradient = await page.locator("#seek").evaluate(element => element.style.getPropertyValue("--downloaded"));
  assert.match(fullGradient, /100\.000%/);
  checks.push("A complete file fills the downloaded range");
  assert.deepEqual(errors, []);
  checks.push("No renderer errors");
  await writeFile(join(artifactDir, "result.json"), JSON.stringify({ passed: true, checks, errors }, null, 2));
  process.stdout.write(`Passed ${checks.length} checks. Artifacts: ${artifactDir}\n`);
} catch (error) {
  await writeFile(join(artifactDir, "result.json"), JSON.stringify({ passed: false, checks, errors, failure: String(error) }, null, 2));
  throw error;
} finally {
  await browser?.close();
  await server.close();
}
