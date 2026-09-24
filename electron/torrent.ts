import WebTorrent from "webtorrent";
import type { Server } from "node:http";
import { streamFile } from "./stream";
import { resolve, relative, isAbsolute, join } from "node:path";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { hash } from "./rules";
import type { TorrentFile } from "../src/shared";
const port = (
  process as unknown as {
    parentPort: {
      on(name: string, cb: (e: { data: any }) => void): void;
      postMessage(value: unknown): void;
    };
  }
).parentPort;
const send = (value: unknown) => port.postMessage(value);
let client: WebTorrent.Instance | undefined,
  torrent: WebTorrent.Torrent | undefined,
  server: Server | undefined;
let timer: NodeJS.Timeout | undefined;
port.on("message", async ({ data }) => {
  try {
    if (data.action === "inspect") {
      const infoHash = hash(data.hash);
      const root = resolve(data.path);
      client = new WebTorrent({
        utp: false,
        webSeeds: false,
        lsd: false,
        natUpnp: false,
        natPmp: false,
      } as WebTorrent.Options);
      client.on("error", (e) => send({ event: "error", message: String(e) }));
      const metadata = join(root, ".nen.torrent");
      torrent = client.add(
        existsSync(metadata)
          ? readFileSync(metadata)
          : `magnet:?xt=urn:btih:${infoHash}&tr=udp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce`,
        {
          path: root,
          skipVerify: false,
          deselect: true,
        } as WebTorrent.TorrentOptions,
        (t) => {
          if (t.infoHash !== infoHash) {
            send({
              event: "error",
              message:
                "Cached torrent metadata does not match the selected release.",
            });
            client?.destroy();
            return;
          }
          try {
            writeFileSync(metadata, t.torrentFile);
          } catch (error) {
            send({
              event: "error",
              message: `Could not save torrent metadata: ${String(error)}`,
            });
            return;
          }
          t.deselect(0, t.pieces.length - 1, 0);
          const files: TorrentFile[] = t.files.flatMap((f, index) => {
            const rel = relative(root, resolve(root, f.path));
            if (rel.startsWith("..") || isAbsolute(rel))
              throw Error("Unsafe torrent path.");
            return /\.(mkv|mp4|webm|avi|m4v|mov|ts)$/i.test(f.name)
              ? [{ index, path: f.path, size: f.length }]
              : [];
          });
          send({ event: "files", files });
        },
      );
      torrent.on("error", (e) => send({ event: "error", message: String(e) }));
      timer = setInterval(
        () =>
          send({
            event: "stats",
            speed: torrent?.downloadSpeed ?? 0,
            peers: torrent?.numPeers ?? 0,
            progress: torrent?.progress ?? 0,
          }),
        1000,
      );
    } else if (data.action === "stream") {
      const file = torrent?.files[data.index];
      if (!file) throw Error("File not found.");
      torrent!.files.forEach((f) => f.deselect());
      const offset = torrent!.files
        .slice(0, data.index)
        .reduce((sum, f) => sum + f.length, 0);
      const first = Math.floor(offset / torrent!.pieceLength);
      const last = Math.floor(
        (offset + file.length - 1) / torrent!.pieceLength,
      );
      const count = Math.max(
        1,
        Math.ceil((2 * 1024 * 1024) / torrent!.pieceLength),
      );
      torrent!.select(first, Math.min(last, first + count - 1), 10);
      torrent!.select(Math.max(first, last - count + 1), last, 10);
      const result = await streamFile(file);
      server = result.server;
      send({ event: "stream", url: result.url });
    } else if (data.action === "stop") {
      if (timer) clearInterval(timer);
      server?.closeAllConnections();
      server?.close();
      client?.destroy(() => process.exit(0));
      if (!client) process.exit(0);
    }
  } catch (error) {
    send({ event: "error", message: (error as Error).message });
  }
});
