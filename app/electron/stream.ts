import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { Readable } from "node:stream";
import { byteRange } from "./rules";
export async function streamFile(file: {
  length: number;
  [Symbol.asyncIterator]?(range: {
    start: number;
    end: number;
  }): AsyncIterableIterator<Uint8Array>;
  createReadStream(range: {
    start: number;
    end: number;
  }): NodeJS.ReadableStream;
}) {
  const token = randomBytes(32).toString("hex");
  const server = createServer((req, res) => {
    if (
      req.url !== `/${token}` ||
      req.headers.host !==
        `127.0.0.1:${(server.address() as { port: number }).port}`
    ) {
      res.writeHead(403).end();
      return;
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405).end();
      return;
    }
    const range = byteRange(req.headers.range, file.length);
    if (!range) {
      res.writeHead(416, { "Content-Range": `bytes */${file.length}` }).end();
      return;
    }
    const headers: Record<string, string | number> = {
      "Accept-Ranges": "bytes",
      "Content-Type": "application/octet-stream",
      "Content-Length": range.end - range.start + 1,
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    if (range.partial)
      headers["Content-Range"] =
        `bytes ${range.start}-${range.end}/${file.length}`;
    res.writeHead(range.partial ? 206 : 200, headers);
    if (req.method === "HEAD") {
      res.end();
      return;
    }
    const slice = { start: range.start, end: range.end };
    const iterator = file[Symbol.asyncIterator]?.(slice);
    const stream = iterator
      ? Readable.from(iterator)
      : (file.createReadStream(slice) as Readable);
    stream.on("error", () => res.destroy());
    res.on("close", () => {
      if (iterator?.return) void iterator.return().catch(() => {});
      stream.destroy();
    });
    stream.pipe(res);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  return {
    server,
    url: `http://127.0.0.1:${(server.address() as { port: number }).port}/${token}`,
  };
}
