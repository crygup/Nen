import { createConnection, type Socket } from "node:net";
import { createHash, randomUUID } from "node:crypto";
import { join } from "node:path";
import type { Playback, TogetherState } from "../src/shared";

export const DISCORD_APP_ID = "1553060136417759366";

export function watchingActivity(
  enabled: boolean,
  p?: Playback,
  now = Date.now(),
) {
  if (
    !enabled ||
    !p?.active ||
    !p.ready ||
    p.ended ||
    p.error ||
    p.seeking ||
    p.buffering ||
    !p.title ||
    !p.episode
  )
    return null;
  return {
    type: 3,
    status_display_type: 2,
    details: [...p.title].slice(0, 128).join(""),
    state: [
      ...`Episode ${p.episode}${p.episodeTitle ? ` · ${p.episodeTitle}` : ""}`,
    ]
      .slice(0, 128)
      .join(""),
    assets: {
      large_image: p.cover || "nen",
      large_text: [...p.title].slice(0, 128).join(""),
      small_image: p.paused
        ? "https://raw.githubusercontent.com/google/material-design-icons/master/png/av/pause/materialicons/48dp/2x/baseline_pause_black_48dp.png"
        : "nen",
      small_text: p.paused ? "Paused" : "Nen",
    },
    timestamps: !p.paused
      ? { start: Math.floor(now / 1000 - Math.max(0, p.position)) }
      : {},
  };
}

function sessionActivity(
  enabled: boolean,
  playback?: Playback,
  room?: TogetherState,
) {
  const watching = watchingActivity(enabled, playback);
  if (
    !enabled ||
    !room?.connected ||
    !room.code ||
    !/^[A-Za-z0-9_-]{24}$/.test(room.code)
  )
    return watching;
  return {
    ...(watching ?? {
      details: "Watch together",
      state: "In a session",
      assets: { large_image: "nen", small_text: "Nen" },
      timestamps: {},
    }),
    type: 0,
    party: {
      id: createHash("sha256").update(room.code).digest("hex"),
      size: [room.members.length, 10],
    },
    ...(room.members.length < 10 ? { secrets: { join: room.code } } : {}),
    instance: true,
  };
}

export class DiscordPresence {
  private socket?: Socket;
  private ready = false;
  private activity: ReturnType<typeof sessionActivity> = null;
  private retryAt = 0;
  private sentAt = 0;

  private timer?: ReturnType<typeof setInterval>;
  constructor(private onJoin: (secret: string) => void = () => {}) {}

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.ensureConnection(), 30000);
    this.timer.unref();
    this.ensureConnection();
  }

  update(enabled: boolean, playback?: Playback, room?: TogetherState) {
    const previous = JSON.stringify(
      this.activity && { ...this.activity, timestamps: undefined },
    );
    this.activity = sessionActivity(enabled, playback, room);
    this.ensureConnection();
    if (
      this.ready &&
      (previous !==
        JSON.stringify(
          this.activity && { ...this.activity, timestamps: undefined },
        ) ||
        Date.now() - this.sentAt >= 15000)
    )
      this.sendActivity();
  }

  private ensureConnection() {
    if (!this.timer || this.socket || Date.now() < this.retryAt) return;
    this.retryAt = Date.now() + 30000;
    this.connect(0);
  }

  close() {
    clearInterval(this.timer);
    this.timer = undefined;
    this.retryAt = 0;
    if (this.ready)
      this.frame(1, {
        cmd: "SET_ACTIVITY",
        args: { pid: process.pid, activity: null },
        nonce: randomUUID(),
      });
    const socket = this.socket;
    this.socket = undefined;
    this.ready = false;
    this.activity = null;
    if (socket) {
      socket.end();
      setTimeout(() => socket.destroy(), 1000).unref();
    }
  }

  private frame(opcode: number, data: unknown) {
    if (!this.socket || this.socket.destroyed) return;
    const body = Buffer.isBuffer(data)
      ? data
      : Buffer.from(JSON.stringify(data));
    const header = Buffer.alloc(8);
    header.writeUInt32LE(opcode, 0);
    header.writeUInt32LE(body.length, 4);
    this.socket.write(Buffer.concat([header, body]));
  }

  private sendActivity() {
    this.sentAt = Date.now();
    this.frame(1, {
      cmd: "SET_ACTIVITY",
      args: { pid: process.pid, activity: this.activity },
      nonce: randomUUID(),
    });
  }

  private connect(index: number) {
    if (!this.timer || index > 9) return;
    const path =
      process.platform === "win32"
        ? String.raw`\\?\pipe\discord-ipc-${index}`
        : join(
            process.env.XDG_RUNTIME_DIR ||
              process.env.TMPDIR ||
              process.env.TMP ||
              process.env.TEMP ||
              "/tmp",
            `discord-ipc-${index}`,
          );
    const socket = (this.socket = createConnection(path));
    let buffer = Buffer.alloc(0);
    let connected = false;
    socket.setTimeout(3000, () => socket.destroy());
    socket.on("connect", () => {
      connected = true;
      if (this.socket === socket)
        this.frame(0, { v: 1, client_id: DISCORD_APP_ID });
    });
    socket.on("error", () => {});
    socket.on("close", () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      this.ready = false;
      if (!connected) this.connect(index + 1);
    });
    socket.on("data", (chunk) => {
      if (this.socket !== socket) return;
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) {
        socket.destroy();
        return;
      }
      while (buffer.length >= 8) {
        const opcode = buffer.readUInt32LE(0),
          length = buffer.readUInt32LE(4);
        if (length > 1024 * 1024) {
          socket.destroy();
          return;
        }
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
              this.frame(1, {
                cmd: "SUBSCRIBE",
                evt: "ACTIVITY_JOIN",
                nonce: randomUUID(),
              });
              this.sendActivity();
            } else if (
              this.ready &&
              message.cmd === "DISPATCH" &&
              message.evt === "ACTIVITY_JOIN" &&
              typeof message.data?.secret === "string" &&
              /^[A-Za-z0-9_-]{24}$/.test(message.data.secret)
            ) {
              this.onJoin(message.data.secret);
            } else if (message.evt === "ERROR") socket.destroy();
          } catch {
            socket.destroy();
          }
        }
      }
    });
  }
}
