import { valid } from "semver";
import { createHash } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const repository = "may-be-gay/Nen";
const api = `https://api.github.com/repos/${repository}`;
const sha = /^[a-f0-9]{40}$/;
const digest = /^sha256:[a-f0-9]{64}$/;
const maxSize = 1024 * 1024 * 1024;
export type Update = { url: string; digest: string; size: number; version?: string; commit?: string };
export type UpdateResult = { update?: Update; message: string };

async function github(path: string): Promise<any> {
  const response = await fetch(api + path, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "Nen", "X-GitHub-Api-Version": "2022-11-28" },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  if (response.status === 403 || response.status === 429) throw Error("GitHub is limiting requests. Try again later.");
  if (!response.ok) throw Error(`Update check failed (HTTP ${response.status}).`);
  return response.json();
}

function assetUpdate(url: string, value: any): Update {
  if (!digest.test(value?.digest) || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > maxSize)
    throw Error("The update has no valid download checksum or size.");
  return { url, digest: value.digest, size: value.size };
}

export async function findUpdate(commit: string): Promise<UpdateResult> {
  if (!commit) return { message: "You are on the latest build" };
  const runs = await github("/actions/workflows/development.yml/runs?branch=main&status=success&per_page=1");
  const run = runs?.workflow_runs?.[0];
  if (!run || !sha.test(run.head_sha) || run.conclusion !== "success" || run.head_branch !== "main"
    || !["push", "workflow_dispatch"].includes(run.event) || run.head_repository?.full_name !== repository)
    return { message: "No completed build is available. Try again later." };
  if (run.head_sha === commit) return { message: "You are on the latest build" };
  const list = await github("/actions/runs/" + run.id + "/artifacts");
  const artifact = list?.artifacts?.find((a: any) => a.name === "nen-windows-x64" && !a.expired);
  if (!artifact || !Number.isSafeInteger(artifact.id)) return { message: "The latest build download is unavailable. Try again later." };
  return { update: { ...assetUpdate("https://nightly.link/" + repository + "/actions/artifacts/" + artifact.id + ".zip", { ...artifact, size: artifact.size_in_bytes }), commit: run.head_sha }, message: "New update available" };
}

export async function downloadUpdate(update: Update, directory: string, progress: (percent: number) => void): Promise<string> {
  await mkdir(directory, { recursive: true });
  const archive = join(directory, "download.zip");
  const installer = join(directory, "setup.exe");
  const destination = update.commit ? archive : installer;
  await rm(installer, { force: true });
  await rm(archive, { force: true });
  try {
    const response = await fetch(update.url, { signal: AbortSignal.timeout(600000) });
    if (!response.ok || !response.body) throw Error(`Update download failed (HTTP ${response.status}).`);
    const hash = createHash("sha256");
    let received = 0;
    await pipeline(Readable.fromWeb(response.body as any), new Transform({
      transform(chunk, _encoding, callback) {
        received += chunk.length;
        if (received > update.size || received > maxSize) { callback(Error("The update download is larger than expected.")); return; }
        hash.update(chunk);
        progress(Math.floor(received / update.size * 100));
        callback(null, chunk);
      },
    }), createWriteStream(destination));
    if (received !== update.size || `sha256:${hash.digest("hex")}` !== update.digest)
      throw Error("The update checksum did not match. Nothing was installed.");
    if (update.commit) {
      const script = `$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip=[IO.Compression.ZipFile]::OpenRead($env:NEN_UPDATE_ARCHIVE)
try {
  $entry=$zip.GetEntry('development.json')
  if(!$entry -or $entry.Length -gt 4096){throw 'Build details are missing.'}
  $reader=[IO.StreamReader]::new($entry.Open())
  try {$text=$reader.ReadToEnd()} finally {$reader.Dispose()}
  $meta=$text | ConvertFrom-Json
  if($meta.commit -ne $env:NEN_UPDATE_COMMIT -or $meta.installer -notmatch '^Nen-Setup-[0-9A-Za-z.+-]+\\.exe$'){throw 'Build details do not match.'}
  $exe=$zip.GetEntry($meta.installer)
  if(!$exe -or $exe.Length -lt 1024 -or $exe.Length -gt 1073741824){throw 'The installer is missing or invalid.'}
  [IO.Compression.ZipFileExtensions]::ExtractToFile($exe,$env:NEN_UPDATE_INSTALLER,$true)
  Write-Output $text
} finally {$zip.Dispose()}`;
      const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
        windowsHide: true, timeout: 120000, maxBuffer: 8192,
        env: { ...process.env, PSModulePath: join(process.env.SystemRoot ?? "C:\\Windows", "System32/WindowsPowerShell/v1.0/Modules"), NEN_UPDATE_ARCHIVE: archive, NEN_UPDATE_INSTALLER: installer, NEN_UPDATE_COMMIT: update.commit },
      });
      const meta = JSON.parse(result.stdout.replace(/^\uFEFF/, ""));
      if (meta.commit !== update.commit || !valid(meta.version) || meta.installer !== `Nen-Setup-${meta.version}.exe`)
        throw Error("The development installer does not match its build details.");
    }
    return installer;
  } catch (error) {
    await rm(installer, { force: true });
    throw error;
  } finally { await rm(archive, { force: true }); }
}
