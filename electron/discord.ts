import { createConnection, type Socket } from "node:net";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Playback } from "../src/shared";

export function watchingActivity(enabled: boolean, p?: Playback, now = Date.now()) {
  if (!enabled || !p?.active || !p.ready || p.ended || p.error || p.seeking || p.buffering || !p.title || !p.episode) return null;
  return {
    type: 3,
    status_display_type: 2,
    details: [...p.title].slice(0, 128).join(""),
    state: [...`Episode ${p.episode}${p.episodeTitle ? ` · ${p.episodeTitle}` : ""}`].slice(0, 128).join(""),
    assets: { large_image: p.cover || "nen", large_text: [...p.title].slice(0, 128).join(""), small_image: p.paused ? "https://raw.githubusercontent.com/google/material-design-icons/master/png/av/pause/materialicons/48dp/2x/baseline_pause_black_48dp.png" : "nen", small_text: p.paused ? "Paused" : "Nen" },
    timestamps: !p.paused ? { start: Math.floor(now / 1000 - Math.max(0, p.position)) } : {},
  };
}

export class DiscordPresence {
  private socket?: Socket;
  private ready = false;
  private activity: ReturnType<typeof watchingActivity> = null;
  private retryAt = 0;
  private sentAt = 0;

  update(enabled: boolean, playback?: Playback) {
    const previousIcon = this.activity?.assets.small_text;
    this.activity = watchingActivity(enabled, playback);
    if (!this.activity) {
      this.close();
      return;
    }
    if (!this.socket && Date.now() >= this.retryAt) {
      this.retryAt = Date.now() + 30000;
      this.connect(0);
    } else if (this.ready && (previousIcon !== this.activity.assets.small_text || Date.now() - this.sentAt >= 15000)) this.sendActivity();
  }

  close() {
    this.retryAt = 0;
    if (this.ready) this.frame(1, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: null }, nonce: randomUUID() });
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.activity = null;
    if (socket) { socket.end(); setTimeout(() => socket.destroy(), 1000).unref(); }
  }

  private frame(opcode: number, data: unknown) {
    if (!this.socket || this.socket.destroyed) return;
    const body = Buffer.isBuffer(data) ? data : Buffer.from(JSON.stringify(data));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(opcode, 0);
    header.writeUInt32LE(body.length, 4);
    this.socket.write(Buffer.concat([header, body]));
  }

  private sendActivity() {
    if (!this.activity) return;
    this.sentAt = Date.now();
    this.frame(1, { cmd: "SET_ACTIVITY", args: { pid: process.pid, activity: this.activity }, nonce: randomUUID() });
  }

  private connect(index: number) {
    if (!this.activity || index > 9) return;
    const path = process.platform === "win32" ? String.raw`\\?\pipe\discord-ipc-${index}`
      : join(process.env.XDG_RUNTIME_DIR || process.env.TMPDIR || process.env.TMP || process.env.TEMP || "/tmp", `discord-ipc-${index}`);
    const socket = this.socket = createConnection(path);
    let buffer = Buffer.alloc(0);
    let connected = false;
    socket.setTimeout(3000, () => socket.destroy());
    socket.on("connect", () => {
      connected = true;
      if (this.socket === socket) this.frame(0, { v: 1, client_id: "1553060136417759366" });
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      if (!connected) this.connect(index + 1);
    });
    socket.on("data", chunk => {
      if (this.socket !== socket) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) { socket.destroy(); return; }
      while (buffer.length >= 8) {
        const opcode = buffer.readUInt32LE(0), length = buffer.readUInt32LE(4);
        if (length > 1024 * 1024) { socket.destroy(); return; }
        if (buffer.length < length + 8) break;
        const body = buffer.subarray(8, length + 8);
        buffer = buffer.subarray(length + 8);
        if (opcode === 3) this.frame(4, body);
        else if (opcode === 2) socket.destroy();
        else if (opcode === 1) {
          try {
            const message = JSON.parse(body.toString("utf8"));
            if (message.evt === "READY") {
              this.ready = true;
              socket.setTimeout(0);
              this.sendActivity();
            } else if (message.evt === "ERROR") socket.destroy();
          } catch { socket.destroy(); }
        }
      }
    });
  }
}
