import type { Playback, TogetherState } from "../src/shared";

export class Together {
  state: TogetherState = { connected: false, members: [], messages: [] };
  private socket?: WebSocket;
  private timer?: ReturnType<typeof setInterval>;
  private key = "";
  private revision = -1;
  private loading = false;
  private syncing = false;
  private readySent = "";
  private clockOffset = 0;
  private generation = 0;
  private lastPing = 0;
  private failure = "";
  constructor(private hooks: {
    version: string;
    changed: (state: TogetherState) => void;
    cancel?: () => void;
    playback: () => Playback | undefined;
    prepare: (mediaId: number, episode: number, hash?: string) => Promise<void>;
    command: (command: (string | number | boolean)[]) => Promise<unknown>;
  }) {}
  async connect(code?: string) {
    if (this.socket) throw Error("Leave your current session first.");
    const socket = this.socket = new WebSocket(process.env.NEN_TOGETHER_URL || "wss://together.crygup.com/session");
    this.state = { connected: false, members: [], messages: [] };
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => { socket.close(); reject(Error("The session server did not respond.")); }, 10000);
      socket.onopen = () => { this.send({ type: code ? "join" : "create", version: this.hooks.version, ...(code ? { code } : {}) }); };
      socket.onerror = () => { clearTimeout(timeout); reject(Error("Could not connect to Watch together.")); };
      socket.onclose = () => {
        clearTimeout(timeout);
        if (this.socket !== socket) return;
        this.disconnect("The session connection closed. Join again to reconnect.");
        reject(Error("The session connection closed."));
      };
      socket.onmessage = event => {
        if (this.socket !== socket) return;
        try {
          if (typeof event.data !== "string" || event.data.length > 100000) throw Error("Invalid session response.");
          const m = JSON.parse(event.data);
          if (m.type === "state") {
            if (!Array.isArray(m.members) || m.members.length > 10 || typeof m.self !== "string" || typeof m.code !== "string" ||
              (m.playbackRate !== undefined && (!Number.isFinite(m.playbackRate) || m.playbackRate < 0.25 || m.playbackRate > 4)) ||
              typeof m.host !== "boolean" || typeof m.paused !== "boolean" || !Number.isFinite(m.position) ||
              !Number.isFinite(m.at) || !Number.isSafeInteger(m.revision) ||
              (m.selection && (!Number.isSafeInteger(m.selection.mediaId) || !Number.isSafeInteger(m.selection.episode) ||
                (m.selection.hash !== null && !/^[a-f0-9]{40}$/i.test(m.selection.hash))))) throw Error("Invalid session response.");
            this.state = { ...m, connected: true, messages: this.state.messages };
            clearTimeout(timeout); resolve();
            if (!this.timer) { this.timer = setInterval(() => void this.tick(), 250); this.ping(); }
            this.hooks.changed(this.state);
            void this.tick();
          } else if (m.type === "chat") {
            this.state.messages = [...this.state.messages, m.message].slice(-100); this.hooks.changed(this.state);
          } else if (m.type === "history") {
            this.state.messages = Array.isArray(m.messages) ? m.messages.slice(-100) : []; this.hooks.changed(this.state);
          } else if (m.type === "error") {
            const message = typeof m.message === "string" ? m.message : "Session request failed.";
            this.state.error = message; this.hooks.changed(this.state);
            if (!this.state.connected) { clearTimeout(timeout); this.disconnect(message); reject(Error(message)); }
          } else if (m.type === "ended") {
            this.disconnect(m.message || undefined);
          } else if (m.type === "pong" && Number.isFinite(m.sent) && Number.isFinite(m.now)) {
            this.clockOffset = m.now - (m.sent + Date.now()) / 2;
          }
        } catch (e) { this.disconnect("The session server sent an invalid response."); clearTimeout(timeout); reject(e); }
      };
    });
  }
  send(message: object) {
    if (this.socket?.readyState !== WebSocket.OPEN) throw Error("Not connected to a session.");
    this.socket.send(JSON.stringify(message));
  }
  disconnect(error?: string) {
    const socket = this.socket;
    this.socket = undefined;
    this.generation++;
    this.hooks.cancel?.();
    socket?.close();
    clearInterval(this.timer); this.timer = undefined;
    this.key = ""; this.revision = -1; this.readySent = ""; this.loading = false;
    this.state = { connected: false, members: [], messages: [], error };
    void this.hooks.command(["set_property", "pause", true]).catch(() => {});
    this.hooks.changed(this.state);
  }
  reload() {
    if (this.loading) throw Error("A source is still loading.");
    this.key = ""; this.readySent = ""; this.failure = "";
    if (this.state.selection) this.send({ type: "ready", revision: this.state.revision, ready: false });
  }
  private ping() { this.lastPing = Date.now(); this.send({ type: "ping", sent: this.lastPing }); }
  private async tick() {
    const s = this.state, selection = s.selection;
    if (!s.connected || !selection) return;
    if (Date.now() - this.lastPing > 10000) this.ping();
    const key = selection.mediaId + ":" + selection.episode;
    if (this.revision !== s.revision && !selection.hash) this.key = "";
    if (key !== this.key && !this.loading && (s.host || selection.hash)) {
      this.key = key; this.loading = true; this.failure = ""; this.readySent = ""; this.revision = s.revision!;
      const generation = this.generation;
      try { await this.hooks.command(["set_property", "pause", true]).catch(() => {}); await this.hooks.prepare(selection.mediaId, selection.episode, selection.hash || undefined); }
      catch (error) { if (generation === this.generation && this.state.selection?.mediaId === selection.mediaId && this.state.selection?.episode === selection.episode) { this.failure = String((error as Error).message || "Could not load video. Retry loading.").slice(0, 200); this.send({ type: "ready", revision: s.revision, ready: false, error: this.failure }); } }
      finally { if (generation === this.generation) this.loading = false; }
      return;
    }
    if (key !== this.key && !s.host && !selection.hash) {
      await this.hooks.command(["set_property", "pause", true]).catch(() => {});
      return;
    }
    const p = this.hooks.playback();
    if (this.loading || this.syncing) return;
    if (!p?.active || p.mediaId !== selection.mediaId || p.episode !== selection.episode) {
      if (this.readySent !== "loading") { this.readySent = "loading"; this.send({ type: "ready", revision: s.revision, ready: false, error: this.failure }); }
      return;
    }
    if (s.host && !selection.hash && p.ready && p.release)
      this.send({ type: "source", revision: s.revision, hash: p.release.hash });
    const ready = !!p.ready && !p.error && !p.seeking && !p.buffering && p.duration > 0;
    const error = p.error ? p.error.slice(0, 200) : "";
    const readiness = s.revision + ":" + ready + ":" + error;
    this.syncing = true;
    try {
      if (this.revision !== s.revision && p.ready) {
        this.revision = s.revision!;
        await this.hooks.command(["set_property", "pause", true]);
        await this.hooks.command(["seek", s.position!, "absolute"]);
        this.readySent = "";
        return;
      }
      if (readiness !== this.readySent) {
        this.readySent = readiness; this.send({ type: "ready", revision: s.revision, ready, error });
      }
      if (!ready) return;
      const now = Date.now() + this.clockOffset;
      const paused = s.paused || now < s.at!;
      const target = s.position! + (!s.paused ? Math.max(0, now - s.at!) / 1000 * (s.playbackRate ?? 1) : 0);
      if (Math.abs(p.position - target) > 1.5) await this.hooks.command(["seek", Math.min(target, Math.max(0, p.duration - 0.1)), "absolute"]);
      if ((p.playbackRate ?? 1) !== (s.playbackRate ?? 1)) await this.hooks.command(["set_property", "speed", s.playbackRate ?? 1]);
      if (p.paused !== paused) await this.hooks.command(["set_property", "pause", !!paused]);
    } catch { /* The player may close or change source during a command. */ }
    finally { this.syncing = false; }
  }
}
