import { mkdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import seven from "7zip-bin";
if (process.platform !== "win32" || process.arch !== "x64")
  throw Error("Nen currently builds for Windows x64.");
const release = await fetch(
  "https://api.github.com/repos/shinchiro/mpv-winbuild-cmake/releases/tags/20260923",
).then((r) => {
  if (!r.ok) throw Error(`GitHub: ${r.status}`);
  return r.json();
});
for (const tool of ["mpv", "ffmpeg"]) {
  const pattern =
    tool === "mpv" ? /^mpv-x86_64-\d.*\.7z$/ : /^ffmpeg-x86_64-git-.*\.7z$/;
  const asset = release.assets.find((a) => pattern.test(a.name));
  if (!asset) throw Error(`No matching ${tool} build.`);
  const directory = `vendor/${tool}`;
  await mkdir(directory, { recursive: true });
  const response = await fetch(asset.browser_download_url);
  if (!response.ok) throw Error(`Download: ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const digest = "sha256:" + createHash("sha256").update(bytes).digest("hex");
  if (!asset.digest || digest !== asset.digest)
    throw Error(`${tool} checksum is missing or does not match GitHub.`);
  const archive = `vendor/${tool}.7z`;
  await writeFile(archive, bytes);
  execFileSync(seven.path7za, ["x", archive, `-o${directory}`, "-y"], {
    stdio: "inherit",
  });
  await writeFile(
    `${directory}/SOURCE.json`,
    JSON.stringify(
      { url: asset.browser_download_url, digest, release: release.tag_name },
      null,
      2,
    ),
  );
}
const filters = execFileSync(
  "vendor/ffmpeg/ffmpeg.exe",
  ["-hide_banner", "-filters"],
  { encoding: "utf8", windowsHide: true },
);
if (!filters.includes("gfxcapture"))
  throw Error("FFmpeg does not support window capture.");
console.log("mpv and FFmpeg are ready.");
