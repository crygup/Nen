import { spawn } from "node:child_process";
import { join } from "node:path";
import { app, ipcMain, type BrowserWindow } from "electron";

export function captureVideo(hwnd: number, window: BrowserWindow): () => void {
  const executable = join(
    app.isPackaged ? process.resourcesPath : join(app.getAppPath(), "vendor"),
    "ffmpeg",
    "ffmpeg.exe",
  );
  let stopped = false,
    child: ReturnType<typeof spawn>,
    timer: ReturnType<typeof setTimeout>;
  let pending = 0,
    needsKey = true;
  const acknowledge = (event: Electron.IpcMainEvent) => {
    if (event.sender === window.webContents) pending = Math.max(0, pending - 1);
  };
  ipcMain.on("video-frame-ack", acknowledge);
  const start = (hardware: boolean) => {
    let received = false,
      buffer = Buffer.alloc(0),
      errors = "";
    const encoder = hardware
      ? [
          "-c:v",
          "h264_nvenc",
          "-preset",
          "p1",
          "-tune",
          "ull",
          "-rc",
          "constqp",
          "-qp",
          "18",
          "-delay",
          "0",
          "-zerolatency",
          "1",
        ]
      : [
          "-vf",
          "hwdownload,format=bgra,format=yuv420p",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-crf",
          "18",
        ];
    child = spawn(
      executable,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-f",
        "lavfi",
        "-i",
        `gfxcapture=hwnd=${hwnd}:capture_cursor=0:display_border=0:max_framerate=60:width=-2:height=-2:resize_mode=scale_aspect`,
        ...encoder,
        "-bf",
        "0",
        "-g",
        "30",
        "-bsf:v",
        "h264_metadata=aud=insert",
        "-fps_mode",
        "passthrough",
        "-map",
        "0:v:0",
        "-f",
        "tee",
        "[f=h264:flush_packets=1]pipe:1|[f=framecrc:flush_packets=1]pipe:3",
      ],
      { windowsHide: true, stdio: ["ignore", "pipe", "pipe", "pipe"] },
    );
    const fail = (message: string) => {
      if (!stopped && !window.isDestroyed())
        window.webContents.send("video-error", message);
    };
    timer = setTimeout(() => {
      if (!received) {
        child.kill();
        fail("Video capture did not start.");
      }
    }, 15000);
    child.stderr!.on("data", (chunk) => {
      errors = (errors + chunk.toString()).slice(-3000);
    });
    const sizes: number[] = [];
    let metadata = "";
    const drain = () => {
      while (sizes.length && buffer.length >= sizes[0]) {
        const size = sizes.shift()!;
        const frame = buffer.subarray(0, size);
        buffer = buffer.subarray(size);
        let key = false;
        for (let i = 0; i + 3 < frame.length; i++)
          if (
            frame[i] === 0 &&
            frame[i + 1] === 0 &&
            frame[i + 2] === 1 &&
            (frame[i + 3] & 31) === 5
          ) {
            key = true;
            break;
          }
        if (pending >= 2) needsKey = true;
        else if (!stopped && !window.isDestroyed() && (!needsKey || key)) {
          pending++;
          needsKey = false;
          window.webContents.send("video-frame", frame, key);
        }
      }
      if (buffer.length > 16000000) {
        buffer = Buffer.alloc(0);
        fail("Video capture frame is too large.");
      }
    };
    child.stdout!.on("data", (chunk) => {
      received = true;
      clearTimeout(timer);
      buffer = Buffer.concat([buffer, chunk]);
      drain();
    });
    child.stdio[3]!.on("data", (chunk) => {
      metadata += chunk.toString();
      let newline;
      while ((newline = metadata.indexOf("\n")) >= 0) {
        const line = metadata.slice(0, newline);
        metadata = metadata.slice(newline + 1);
        if (line.startsWith("#") || !line.trim()) continue;
        const size = Number(line.split(",")[4]);
        if (!Number.isInteger(size) || size <= 0 || size > 16000000) {
          fail("Invalid capture packet size.");
          child.kill();
          return;
        }
        sizes.push(size);
      }
      drain();
    });
    child.once("error", (e) => {
      clearTimeout(timer);
      fail(e.message);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (stopped) return;
      if (hardware && !received) {
        start(false);
        return;
      }
      fail(`Video capture stopped (${code}). ${errors}`);
    });
  };
  start(true);
  return () => {
    stopped = true;
    clearTimeout(timer);
    ipcMain.removeListener("video-frame-ack", acknowledge);
    child.kill();
  };
}
