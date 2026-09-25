import type { TogetherState } from "./shared";
const api = window.nen;
const escape = (value: unknown) => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function mountTogether(root: HTMLElement, choose: () => void, player = false, source?: (id: number, episode: number) => void) {
  root.classList.add("together-panel");
  const eye = (visible: boolean) => `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>${visible ? '<path d="m3 3 18 18"/>' : ""}</svg>`;
  root.innerHTML = `${player ? "<h2>Watch together</h2>" : ""}<p class="together-error" role="alert"></p>
    <div class="together-entry"><h2>Watch together</h2><div class="together-entry-actions"><button data-create>Create session</button><button data-join-open>Join session</button></div><span data-connecting role="status" aria-label="Creating session" hidden>|</span></div>
    <dialog class="together-join" aria-label="Join session"><h2>Join session</h2><form data-join><label>Session code<input name="code" maxlength="24" required autocomplete="off"></label><div class="actions"><button type="button" data-join-cancel>Cancel</button><button class="primary">Join session</button></div><p data-join-error role="alert"></p></form></dialog>
    <div class="together-room" hidden><div class="together-controls"><h3>Controls and settings</h3><div class="together-invite"><span>Session code</span><button data-copy aria-label="Copy session code" title="Copy session code"></button><button data-reveal aria-label="Reveal session code" aria-pressed="false"></button><span data-copied role="status"></span></div>
    <p data-title hidden></p><p data-status role="status"></p>
    <div class="together-host" hidden>
    <label><input type="checkbox" data-permission> Allow anyone to pause or resume</label>
    <label><input type="checkbox" data-chat-permission> Enable chat</label>
    </div>
    <div class="actions"><button data-source>Choose another source</button><button data-retry>Retry loading video</button><button data-leave>Leave session</button></div></div>
    <section class="together-member-section"><h3>Members</h3><ul class="together-members"></ul></section><section class="together-chat"><header><h3>Chat</h3><button data-collapse aria-label="Collapse chat" aria-expanded="true" title="Collapse chat"></button></header>
    <div class="together-chat-body"><div class="together-messages" role="log" aria-live="polite" aria-label="Session chat"></div>
    <form data-chat><input name="message" aria-label="Chat message" placeholder="Message" maxlength="500" autocomplete="off"><button>Send</button></form></div></section></div>`;
  const el = <T extends HTMLElement>(selector: string) => root.querySelector<T>(selector)!;
  const run = async (fn: () => Promise<unknown>) => {
    el(".together-error").textContent = "";
    try { await fn(); } catch (e) { el(".together-error").textContent = (e as Error).message; }
  };
  let revealed = false, collapsed = false;
  let state: TogetherState = { connected: false, members: [], messages: [] }, titleKey = "", chatKey = "";
  const renderCode = () => {
    el("[data-copy]").textContent = revealed ? state.code || "" : "••••••••••••";
    el("[data-reveal]").innerHTML = eye(revealed);
    el("[data-reveal]").setAttribute("aria-label", revealed ? "Hide session code" : "Reveal session code");
    el("[data-reveal]").setAttribute("aria-pressed", String(revealed));
  };
  const renderChat = () => {
    root.classList.toggle("chat-collapsed", collapsed);
    root.classList.toggle("chat-enabled", state.connected && state.chatEnabled !== false);
    el(".together-chat").hidden = state.chatEnabled === false;
    el(".together-chat-body").hidden = collapsed;
    el("[data-collapse]").innerHTML = `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="${collapsed ? "m14 5-7 7 7 7" : "m10 5 7 7-7 7"}"/></svg>`;
    el("[data-collapse]").setAttribute("aria-expanded", String(!collapsed));
    el("[data-collapse]").setAttribute("aria-label", collapsed ? "Expand chat" : "Collapse chat");
    el("[data-collapse]").title = collapsed ? "Expand chat" : "Collapse chat";
  };
  const update = (s: TogetherState) => {
    if (!root.isConnected) return;
    if (s.code !== state.code) revealed = false;
    state = s;
    renderCode(); renderChat();
    el(".together-entry").hidden = s.connected || player;
    el(".together-room").hidden = !s.connected;
    el(".together-error").textContent = s.error || "";
    if (!s.connected) return;
    el<HTMLDialogElement>(".together-join").close();
    el(".together-members").innerHTML = s.members.map(m => `<li><span>${escape(m.name)}${m.id === s.self ? " (you)" : ""}</span><span>${escape(m.error || (m.ready ? "Ready" : s.selection ? "Loading" : "In lobby"))}</span></li>`).join("");
    el(".together-host").hidden = !s.host;
    el<HTMLInputElement>("[data-permission]").checked = !!s.allowPause;
    el<HTMLInputElement>("[data-chat-permission]").checked = s.chatEnabled !== false;
    el("[data-title]").hidden = !s.selection;
    el("[data-status]").textContent = !s.selection ? (s.host ? "Pick an episode to start." : "Waiting for the host to choose an episode.") : s.waiting ? "Waiting for everyone to load." : s.paused ? "Paused" : "Watching together";
    el("[data-source]").hidden = !s.selection || !source;
    el("[data-retry]").hidden = !s.selection || !!s.members.find(m => m.id === s.self)?.ready;
    const key = s.selection ? s.selection.mediaId + ":" + s.selection.episode : "";
    if (key !== titleKey) {
      titleKey = key;
      if (s.selection) void api.media(s.selection.mediaId).then(m => {
        if (titleKey === key) el("[data-title]").textContent = (m.title.english || m.title.romaji) + " · Episode " + state.selection?.episode;
      }).catch(() => { el("[data-title]").textContent = "Episode " + state.selection?.episode; });
    }
    const nextChat = s.messages.map(m => m.id).join();
    if (chatKey !== nextChat) {
      chatKey = nextChat;
      const log = el(".together-messages");
      const bottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
      log.innerHTML = s.messages.map(m => `<p class="${m.system ? "system-message" : ""}"><strong>${escape(m.name)}:</strong> ${escape(m.text)}</p>`).join("");
      if (bottom) log.scrollTop = log.scrollHeight;
    }
  };
  el("[data-create]").onclick = () => void run(async () => {
    const button = el<HTMLButtonElement>("[data-create]");
    const join = el<HTMLButtonElement>("[data-join-open]");
    const loading = el("[data-connecting]");
    button.disabled = join.disabled = true;
    loading.hidden = false;
    const frames = ["|", "/", String.fromCharCode(8212), String.fromCharCode(92)];
    let frame = 0;
    const animation = setInterval(() => { loading.textContent = frames[++frame % frames.length]; }, 160);
    try { await api.togetherConnect(); }
    finally { clearInterval(animation); loading.hidden = true; button.disabled = join.disabled = false; }
  });
  el("[data-join-open]").onclick = () => el<HTMLDialogElement>(".together-join").showModal();
  el("[data-join-cancel]").onclick = () => el<HTMLDialogElement>(".together-join").close();
  el<HTMLFormElement>("[data-join]").onsubmit = async e => {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget as HTMLFormElement).get("code")).trim();
    el("[data-join-error]").textContent = "";
    try { await api.togetherConnect(code); } catch (e) { el("[data-join-error]").textContent = (e as Error).message; }
  };
  el("[data-copy]").onclick = () => void run(async () => {
    await api.togetherCopyCode();
    el("[data-copied]").textContent = "Copied";
    setTimeout(() => { el("[data-copied]").textContent = ""; }, 2000);
  });
  el("[data-reveal]").onclick = () => { revealed = !revealed; renderCode(); };
  el("[data-collapse]").onclick = () => { collapsed = !collapsed; renderChat(); };
  el("[data-leave]").onclick = () => void run(() => api.togetherLeave());
  el("[data-source]").onclick = () => { if (state.selection) source?.(state.selection.mediaId, state.selection.episode); };
  el("[data-retry]").onclick = () => void run(() => api.togetherReload());
  el<HTMLInputElement>("[data-permission]").onchange = e => void run(() => api.togetherSend({ type: "allowPause", value: (e.target as HTMLInputElement).checked }));
  el<HTMLInputElement>("[data-chat-permission]").onchange = e => void run(() => api.togetherSend({ type: "chatEnabled", value: (e.target as HTMLInputElement).checked }));
  el<HTMLFormElement>("[data-chat]").onsubmit = e => {
    e.preventDefault();
    const input = el<HTMLInputElement>('[name="message"]');
    const text = input.value.trim();
    if (!text || text.length > 500) return;
    void run(async () => { await api.togetherSend({ type: "chat", text }); input.value = ""; });
  };
  const unsubscribe = api.onTogether(update);
  void api.togetherState().then(update);
  return unsubscribe;
}
