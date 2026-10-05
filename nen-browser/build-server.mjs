import { build } from "esbuild";
import { writeFile } from "node:fs/promises";
const result = await build({
  entryPoints: ["server.js"],
  bundle: true,
  platform: "node",
  format: "cjs",
  outfile: "server.cjs",
  metafile: true,
});
await writeFile("server-meta.json", JSON.stringify(result.metafile));
