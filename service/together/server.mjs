import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";

export function createTogetherServer() {
  const rooms = new Map();
  const http = createServer((req, res) => {
    res.writeHead(req.url === "/health" ? 200 : 404, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
    res.end(req.url === "/health" ? "Nen Watch together\n" : "Not found\n");
  });
  const wss = new WebSocketServer({ server: http, path: "/session", maxPayload: 4096, perMessageDeflate: false, verifyClient: ({ req }) => !req.headers.origin });
  const send = (s, value) => { if (s.readyState === WebSocket.OPEN) { if (s.bufferedAmount > 65536) s.terminate(); else s.send(JSON.stringify(value)); } };
  const chat = (r, name, text, system = false) => {
    if (!r.chatEnabled) return;
    const message = { id: randomUUID(), name, text, system };
    r.chat.push(message); r.chat = r.chat.slice(-100);
    for (const peer of r.members.keys()) send(peer, { type: "chat", message });
  };
  const position = r => r.position + (!r.paused ? Math.max(0, Date.now() - r.at) / 1000 : 0);
  const freeze = r => { r.position = position(r); r.at = Date.now(); r.paused = true; };
  const broadcast = r => {
    const state = { code: r.code, members: [...r.members.values()].map(m => ({ id: m.id, name: m.name, ready: m.ready, error: m.error })),
      selection: r.selection, chatEnabled: r.chatEnabled, allowPause: r.allowPause, paused: r.paused, waiting: r.wantPlay && r.paused, position: position(r), at: Math.max(Date.now(), r.at), revision: r.revision };
    for (const [s, m] of r.members) send(s, { type: "state", ...state, self: m.id, host: m.host });
  };
  const gate = r => {
    if (r.wantPlay && r.selection?.hash && [...r.members.values()].every(m => m.ready)) {
      if (r.paused) { r.at = Date.now() + 800; r.paused = false; chat(r, "System", "Playback started.", true); }
    } else if (!r.paused) { freeze(r); chat(r, "System", "Playback paused while someone loads.", true); }
  };
  const leave = s => {
    const r = s.room;
    if (!r) return;
    s.room = undefined;
    const member = r.members.get(s);
    r.members.delete(s);
    if (member?.host) {
      rooms.delete(r.code);
      for (const peer of r.members.keys()) { peer.room = undefined; send(peer, { type: "ended", message: "The host left the session." }); }
      r.members.clear();
    } else { gate(r); broadcast(r); }
  };
  wss.on("connection", s => {
    const idle = setTimeout(() => { if (!s.room) s.terminate(); }, 10000);
    s.on("close", () => clearTimeout(idle));
    if (wss.clients.size > 1000) { s.close(1013); return; }
    s.alive = true;
    s.on("pong", () => { s.alive = true; });
    let credits = 30, creditAt = Date.now();
    const join = (r, host) => {
      const member = { id: randomUUID(), host, name: host ? "Host" : `Guest ${r.nextGuest++}`, ready: false, error: "" };
      r.members.set(s, member); s.room = r;
      freeze(r); broadcast(r);
      send(s, { type: "history", messages: r.chat });
    };
    s.on("message", raw => {
      try {
        credits = Math.min(30, credits + (Date.now() - creditAt) / 200); creditAt = Date.now();
        if (--credits < 0) { s.terminate(); return; }
        const m = JSON.parse(raw.toString());
        if (!m || typeof m !== "object" || typeof m.type !== "string") throw Error("Invalid request.");
        if (m.type === "ping") { if (!Number.isSafeInteger(m.sent) || m.sent < 0) throw Error("Invalid ping."); send(s, { type: "pong", sent: m.sent, now: Date.now() }); return; }
        if (m.type === "leave") { leave(s); send(s, { type: "ended", message: "" }); return; }
        if (m.type === "create") {
          if (s.room) throw Error("Leave your current session first.");
          if (rooms.size >= 100) throw Error("All sessions are busy. Try again later.");
          const code = randomBytes(18).toString("base64url");
          const r = { code, members: new Map(), nextGuest: 1, selection: null, revision: 0, allowPause: false, chatEnabled: true, paused: true, wantPlay: false, position: 0, at: Date.now(), chat: [], created: Date.now() };
          rooms.set(code, r); join(r, true); return;
        }
        if (m.type === "join") {
          if (s.room) throw Error("Leave your current session first.");
          const r = typeof m.code === "string" && rooms.get(m.code);
          if (!r) throw Error("Session not found. Check the code.");
          if (r.members.size >= 10) throw Error("This session is full (10 people).");
          join(r, false); return;
        }
        const r = s.room, member = r?.members.get(s);
        if (!r || !member) throw Error("Join a session first.");
        if (m.type === "chat") {
          if (!r.chatEnabled) throw Error("Chat is disabled by the host.");
          if (typeof m.text !== "string" || !m.text.trim() || m.text.length > 500) throw Error("Messages must have 1 to 500 characters.");
          chat(r, member.name, m.text.trim());
          return;
        }
        if (m.type === "select") {
          if (!member.host) throw Error("Only the host can choose an episode.");
          if (!Number.isSafeInteger(m.mediaId) || m.mediaId < 1 || !Number.isSafeInteger(m.episode) || m.episode < 1 || m.episode > 10000) throw Error("Invalid episode.");
          freeze(r); r.position = 0; r.wantPlay = true; r.revision++;
          r.selection = { mediaId: m.mediaId, episode: m.episode, hash: null };
          chat(r, "System", `Host selected episode ${m.episode}. Waiting for everyone to load.`, true);
          for (const v of r.members.values()) { v.ready = false; v.error = ""; }
        } else if (m.type === "source") {
          if (!member.host || !r.selection || m.revision !== r.revision || typeof m.hash !== "string" || !/^[a-f0-9]{40}$/i.test(m.hash)) throw Error("Invalid source.");
          if (!r.selection.hash) r.selection.hash = m.hash.toLowerCase();
        } else if (m.type === "ready") {
          if (!r.selection || m.revision !== r.revision) return;
          if (typeof m.ready !== "boolean" || (m.error !== undefined && (typeof m.error !== "string" || m.error.length > 200))) throw Error("Invalid readiness.");
          member.ready = m.ready; member.error = m.error || "";
        } else if (m.type === "chatEnabled") {
          if (!member.host || typeof m.value !== "boolean") throw Error("Only the host can enable or disable chat.");
          r.chatEnabled = m.value;
        } else if (m.type === "allowPause") {
          if (!member.host || typeof m.value !== "boolean") throw Error("Only the host can change this setting.");
          r.allowPause = m.value;
        } else if (m.type === "pause") {
          if (!member.host && !r.allowPause) throw Error("Only the host can pause or resume.");
          if (typeof m.value !== "boolean") throw Error("Invalid pause state.");
          if (m.value && r.wantPlay) chat(r, "System", `${member.name} paused playback.`, true);
          r.wantPlay = !m.value; if (m.value) freeze(r);
        } else if (m.type === "seek") {
          if (!member.host) throw Error("Only the host can seek.");
          if (!r.selection || !Number.isFinite(m.position) || m.position < 0 || m.position > 86400) throw Error("Invalid time.");
          freeze(r); r.position = m.position; r.revision++;
          for (const v of r.members.values()) v.ready = false;
        } else throw Error("Unknown request.");
        gate(r); broadcast(r);
      } catch (e) { send(s, { type: "error", message: e.message }); }
    });
    s.on("close", () => leave(s));
    s.on("error", () => {});
  });
  const timer = setInterval(() => {
    for (const s of wss.clients) { if (!s.alive) s.terminate(); else { s.alive = false; s.ping(); } }
    for (const r of rooms.values()) {
      if (Date.now() - r.created > 12 * 3600000) for (const s of r.members.keys()) s.close(1000, "Session expired.");
      else broadcast(r);
    }
  }, 5000);
  timer.unref();
  return { http, close: async () => { clearInterval(timer); for (const s of wss.clients) s.terminate(); await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => http.close(resolve)); } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createTogetherServer();
  server.http.listen(Number(process.env.PORT || 8090), "0.0.0.0");
  for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => { void server.close().then(() => process.exit(0)); });
}
