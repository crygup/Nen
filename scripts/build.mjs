import { readFile, writeFile } from "node:fs/promises";
import { NtExecutable, NtExecutableResource, Resource, Data } from "resedit";
import { build } from "esbuild";
if (process.platform === "win32") {
  const executable = NtExecutable.from(await readFile("vendor/mpv/mpv.exe"));
  const resources = NtExecutableResource.from(executable);
  const icon = Data.IconFile.from(await readFile("public/n.ico"));
  for (const group of Resource.IconGroupEntry.fromEntries(resources.entries))
    Resource.IconGroupEntry.replaceIconsForResource(
      resources.entries,
      group.id,
      group.lang,
      icon.icons.map((item) => item.data),
    );
  for (const version of Resource.VersionInfo.fromEntries(resources.entries)) {
    for (const language of version.getAllLanguagesForStringValues())
      version.setStringValues(language, {
        FileDescription: "Nen",
        ProductName: "Nen",
        InternalName: "Nen",
        OriginalFilename: "nen-player.exe",
      });
    version.outputToResourceEntries(resources.entries);
  }
  resources.outputResource(executable);
  await writeFile(
    "vendor/mpv/nen-player.exe",
    Buffer.from(executable.generate()),
  );
}
await build({
  entryPoints: ["electron/main.ts"],
  outfile: "dist-electron/main.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  target: "node22",
});
await build({
  entryPoints: ["electron/preload.ts"],
  outfile: "dist-electron/preload.cjs",
  bundle: true,
  platform: "node",
  format: "cjs",
  external: ["electron"],
  target: "node22",
});
await build({
  entryPoints: ["electron/torrent.ts"],
  outfile: "dist-electron/torrent.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  target: "node22",
});
