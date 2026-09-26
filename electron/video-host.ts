import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";
import { screen, type Rectangle } from "electron";

export class VideoHost {
  private constructor(private child: ChildProcessWithoutNullStreams, private handle: Buffer) {}

  static async create(bounds: Rectangle): Promise<VideoHost> {
    const child = spawn(join(__dirname, "video-host.exe").replace("app.asar", "app.asar.unpacked"), [], { windowsHide: true });
    const handle = await new Promise<Buffer>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => { child.kill(); reject(Error("Video surface did not start.")); }, 10000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(Error("Video surface closed.")); });
      child.stdout.on("data", chunk => {
        output += chunk.toString();
        if (!output.includes("\n")) return;
        clearTimeout(timer);
        const value = Number(output.trim());
        if (!Number.isSafeInteger(value) || value <= 0) {
          child.kill(); reject(Error("Invalid video surface handle.")); return;
        }
        const buffer = Buffer.alloc(8);
        buffer.writeBigUInt64LE(BigInt(value));
        resolve(buffer);
      });
    });
    child.stdin.on("error", () => {});
    const host = new VideoHost(child, handle);
    host.setBounds(bounds);
    return host;
  }
  private send(command: string) {
    if (!this.child.killed && this.child.stdin.writable) this.child.stdin.write(command + "\n");
  }
  getNativeWindowHandle() { return this.handle; }
  setBounds(bounds: Rectangle) {
    const b = screen.dipToScreenRect(null, bounds);
    this.send(`bounds ${b.x} ${b.y} ${b.width} ${b.height}`);
  }
  showInactive() { this.send("show"); }
  hide() { this.send("hide"); }
  destroy() { this.child.kill(); }
}
