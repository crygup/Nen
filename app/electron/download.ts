import { createWriteStream } from "node:fs";
import { rename, rm, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export async function saveVideoFile(file: { length: number; createReadStream(): NodeJS.ReadableStream }, destination: string) {
  const temporary = destination + "." + randomUUID() + ".part";
  try {
    await pipeline(file.createReadStream() as Readable, createWriteStream(temporary, { flags: "wx" }));
    if ((await stat(temporary)).size !== file.length) throw Error("The video download was incomplete. Try again.");
    await rename(temporary, destination);
  } finally { await rm(temporary, { force: true }); }
}
