import { spawn, type ChildProcess } from "node:child_process";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { Playback, Settings } from "../src/shared";
export class Player {
  child?: ChildProcess;
  socket?: Socket;
  private request = 0;
  private pending = new Map<
    number,
    {
      resolve: (v: any) => void;
      reject: (e: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  onChange: () => void = () => {};
  onClose: () => void = () => {};
  status: Playback = {
    active: false,
    position: 0,
    duration: 0,
    paused: false,
    tracks: [],
    speed: 0,
    peers: 0,
    progress: 0,
    markers: [],
  };
  async start(
    url: string,
    title: string,
    position: number,
    settings: Settings,
    resourcePath: string,
    parentHandle?: string,
  ) {
    const bundled = join(
      resourcePath,
      "mpv",
      process.platform === "win32" ? "nen-player.exe" : "mpv",
    );
    const binary =
      process.env.NEN_MPV || (existsSync(bundled) ? bundled : "mpv");
    const pipe =
      process.platform === "win32"
        ? String.raw`\\.\pipe\nen-${randomUUID()}`
        : join(tmpdir(), `nen-${randomUUID()}.sock`);
    const args = [
      "--no-config",
      "--audio-client-name=Nen",
      ...(process.platform === "win32"
        ? ["--vo=gpu", "--gpu-api=d3d11", "--d3d11-flip=no"]
        : []),
      "--load-scripts=no",
      "--ytdl=no",
      "--input-terminal=no",
      "--terminal=no",
      "--force-window=yes",
      "--keep-open=yes",
      "--osc=no",
      "--osd-level=0",
      "--input-default-bindings=no",
      "--input-vo-keyboard=no",
      ...(parentHandle
        ? [`--wid=${parentHandle}`, "--show-in-taskbar=no"]
        : []),
      `--input-ipc-server=${pipe}`,
      `--title=${title}`,
      `--start=${position}`,
      `--alang=${settings.audio}`,
      `--slang=${settings.subtitles}`,
      ...(settings.subtitles === "no" ? ["--sid=no"] : []),
      "--",
      url,
    ];
    const child = (this.child = spawn(binary, args, {
      windowsHide: !parentHandle,
      stdio: "ignore",
    }));
    let launchError: Error | undefined;
    this.child.once("error", (e) => {
      launchError = e;
    });
    this.child.once("exit", () => {
      if (this.child !== child) return;
      this.status.active = false;
      this.closeSocket();
      this.onClose();
    });
    for (let i = 0; i < 60; i++) {
      if (launchError)
        throw Error(
          "The video player could not start. Reinstall Nen and try again.",
        );
      try {
        await new Promise<void>((resolve, reject) => {
          const s = connect(pipe);
          s.once("error", reject);
          s.once("connect", () => {
            s.removeListener("error", reject);
            this.socket = s;
            resolve();
          });
        });
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!this.socket) {
      this.child.kill();
      throw Error("mpv did not open its control connection.");
    }
    this.status.active = true;
    let buffer = "";
    this.socket.on("error", (e) => {
      this.status.error = e.message;
      this.onChange();
    });
    this.socket.on("data", (chunk) => {
      buffer += chunk.toString();
      if (buffer.length > 2000000) {
        this.socket?.destroy();
        return;
      }
      let end;
      while ((end = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 1);
        try {
          this.message(JSON.parse(line));
        } catch {}
      }
    });
    for (const [id, key] of [
      "time-pos",
      "duration",
      "pause",
      "track-list",
      "volume",
      "speed",
    ].entries())
      await this.command(["observe_property", id, key]);
  }
  private message(data: any) {
    if (data.request_id) {
      const p = this.pending.get(data.request_id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(data.request_id);
        data.error === "success"
          ? p.resolve(data.data)
          : p.reject(Error(data.error));
      }
    }
    if (data.event === "property-change") {
      if (data.name === "time-pos" && Number.isFinite(data.data))
        this.status.position = data.data;
      if (data.name === "duration" && Number.isFinite(data.data))
        this.status.duration = data.data;
      if (data.name === "volume" && Number.isFinite(data.data))
        this.status.volume = data.data;
      if (data.name === "speed" && Number.isFinite(data.data))
        this.status.playbackRate = data.data;
      if (data.name === "pause") this.status.paused = !!data.data;
      if (data.name === "track-list" && Array.isArray(data.data))
        this.status.tracks = data.data;
      this.onChange();
    }
  }
  command(command: (string | number | boolean)[]): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.socket?.writable) {
        reject(Error("Player is not connected."));
        return;
      }
      const request_id = ++this.request;
      const timer = setTimeout(() => {
        this.pending.delete(request_id);
        reject(Error("Player command timed out."));
      }, 4000);
      this.pending.set(request_id, { resolve, reject, timer });
      this.socket.write(JSON.stringify({ command, request_id }) + "\n");
    });
  }
  private closeSocket() {
    this.socket?.destroy();
    this.socket = undefined;
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(Error("Player closed."));
    }
    this.pending.clear();
  }
  stop() {
    this.onClose = () => {};
    this.closeSocket();
    this.child?.kill();
    this.status.active = false;
  }
}
