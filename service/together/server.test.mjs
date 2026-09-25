import assert from "node:assert/strict";
import { test } from "node:test";
import { WebSocket } from "ws";
import { createTogetherServer } from "./server.mjs";

test("rooms enforce capacity, host permissions, readiness, chat, seeks, and disconnects", async () => {
  const server = createTogetherServer();
  await new Promise(r => server.http.listen(0, "127.0.0.1", r));
  const clients = [];
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.http.address().port}/session`);
    const messages = [];
    socket.on("message", raw => messages.push(JSON.parse(raw.toString())));
    await new Promise(r => socket.on("open", r));
    const client = { socket, messages, send: m => socket.send(JSON.stringify(m)), last: () => messages.filter(m => m.type === "state").at(-1) };
    clients.push(client); return client;
  };
  const until = async fn => { for (let i = 0; i < 100; i++) { if (fn()) return; await new Promise(r => setTimeout(r, 10)); } throw Error("Timeout"); };
  try {
    const host = await connect(); host.send({ type: "create" }); await until(() => host.last());
    const guest = await connect(); guest.send({ type: "join", code: host.last().code }); await until(() => guest.last());
    assert.deepEqual(guest.last().members.map(m => m.name), ["Host", "Guest 1"]);
    guest.send({ type: "select", mediaId: 1, episode: 1 }); await until(() => guest.messages.some(m => m.type === "error"));
    assert.equal(host.last().selection, null);
    host.send({ type: "select", mediaId: 1, episode: 1 }); await until(() => guest.last().selection);
    const revision = host.last().revision;
    host.send({ type: "source", hash: "a".repeat(40), revision });
    host.send({ type: "ready", ready: true, revision });
    await until(() => host.last().waiting);
    assert.equal(host.last().paused, true);
    guest.send({ type: "ready", ready: true, revision });
    await until(() => !host.last().paused);
    guest.send({ type: "pause", value: true }); await until(() => guest.messages.filter(m => m.type === "error").length === 2);
    assert.equal(host.last().paused, false);
    host.send({ type: "allowPause", value: true }); await until(() => guest.last().allowPause);
    guest.send({ type: "pause", value: true }); await until(() => host.last().paused && !host.last().waiting);
    host.send({ type: "pause", value: false }); await until(() => !host.last().paused);
    guest.send({ type: "ready", ready: false, revision }); await until(() => host.last().paused && host.last().waiting);
    guest.send({ type: "ready", ready: true, revision }); await until(() => !host.last().paused);
    guest.send({ type: "seek", position: 30 }); await until(() => guest.messages.filter(m => m.type === "error").length === 3);
    host.send({ type: "seek", position: 60 }); await until(() => host.last().revision === revision + 1);
    assert.equal(host.last().paused, true); assert.equal(host.last().position, 60);
    guest.send({ type: "ready", ready: true, revision }); await new Promise(r => setTimeout(r, 30));
    assert.equal(host.last().members[1].ready, false, "stale readiness must not start a new seek");
    guest.send({ type: "chat", text: "<script>hello</script>" }); await until(() => host.messages.some(m => m.type === "chat" && !m.message.system));
    assert.equal(host.messages.find(m => m.type === "chat" && !m.message.system).message.name, "Guest 1");
    assert.ok(host.messages.some(m => m.type === "chat" && m.message.system && m.message.text === "Playback started."));
    guest.send({ type: "chatEnabled", value: false });
    await until(() => guest.messages.some(m => m.type === "error" && m.message.includes("enable or disable chat")));
    host.send({ type: "chatEnabled", value: false }); await until(() => guest.last().chatEnabled === false);
    const chats = host.messages.filter(m => m.type === "chat").length;
    guest.send({ type: "chat", text: "Blocked message" });
    await until(() => guest.messages.some(m => m.type === "error" && m.message.includes("Chat is disabled")));
    host.send({ type: "select", mediaId: 1, episode: 2 });
    await until(() => guest.last().selection.episode === 2);
    assert.equal(host.messages.filter(m => m.type === "chat").length, chats);
    assert.equal(guest.last().code, host.last().code);
    host.send({ type: "chatEnabled", value: true }); await until(() => guest.last().chatEnabled === true);
    for (let i = 0; i < 8; i++) { const c = await connect(); c.send({ type: "join", code: host.last().code }); await until(() => c.last()); }
    const extra = await connect(); extra.send({ type: "join", code: host.last().code }); await until(() => extra.messages.some(m => m.type === "error"));
    assert.equal(host.last().members.length, 10);
    host.socket.close(); await until(() => guest.messages.some(m => m.type === "ended"));
  } finally { for (const c of clients) c.socket.terminate(); await server.close(); }
});

test("rejects browser origins, oversized messages, and request floods", async () => {
  const server = createTogetherServer();
  await new Promise(r => server.http.listen(0, "127.0.0.1", r));
  const url = `ws://127.0.0.1:${server.http.address().port}/session`;
  try {
    const browser = new WebSocket(url, { origin: "https://example.com" });
    await new Promise(resolve => { browser.on("error", resolve); browser.on("open", () => assert.fail("Browser origin accepted")); });
    for (const oversized of [false, true]) {
      const socket = new WebSocket(url);
      await new Promise(resolve => socket.on("open", resolve));
      const closed = new Promise(resolve => socket.on("close", resolve));
      if (oversized) socket.send("x".repeat(4097));
      else for (let i = 0; i < 40; i++) socket.send(JSON.stringify({ type: "ping", sent: Date.now() }));
      await closed;
    }
  } finally { await server.close(); }
});
