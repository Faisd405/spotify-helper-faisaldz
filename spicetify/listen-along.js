// Spicetify extension: Listen Along rooms inside the Spotify desktop app.
// Host: publishes the playing track, position and upcoming queue straight from the player (no Web API,
// so no 403 / Development Mode limits). Listener: plays the exact same track and keeps within ~2 s.
// Uses the same Firebase rooms and rules as the web app and the browser extension.
//
// LISTEN_ALONG_CONFIG = { dbUrl, apiKey, siteUrl } is prepended by the web build (vite.config.js).

(async function listenAlong() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Player.data stays undefined until something has played, so don't wait for it (the button would never show).
  while (!globalThis.Spicetify?.Player?.playUri || !Spicetify.Topbar?.Button || !Spicetify.PopupModal || !Spicetify.LocalStorage) await sleep(300);
  const notify = (msg, isError) => Spicetify.showNotification?.(msg, isError); // loads later than the rest

  const CFG = globalThis.LISTEN_ALONG_CONFIG;
  if (!CFG?.dbUrl || !CFG?.apiKey) return notify("Listen Along: config kosong, download ulang file-nya dari situs.", true);
  const { Player, LocalStorage: store } = Spicetify;

  // ---------- Firebase over REST ----------

  // Concurrent callers share one sign-in: two parallel sign-ups would create two anonymous users, and
  // presence (one uid) and reads (the other) would no longer match, so kicks would not stick.
  let signingIn = null;
  function getAuth() {
    signingIn ??= signIn().finally(() => (signingIn = null));
    return signingIn;
  }

  async function signIn() {
    const saved = JSON.parse(store.get("la:auth") ?? "null");
    if (saved && Date.now() < saved.expiresAt - 60_000) return saved;
    let next;
    if (saved) {
      const j = await (await fetch(`https://securetoken.googleapis.com/v1/token?key=${CFG.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: saved.refreshToken }),
      })).json();
      if (j.id_token) next = { idToken: j.id_token, refreshToken: j.refresh_token, uid: j.user_id, expiresAt: Date.now() + j.expires_in * 1000 };
    }
    if (!next) {
      const j = await (await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${CFG.apiKey}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ returnSecureToken: true }),
      })).json();
      if (!j.idToken) throw new Error(j.error?.message ?? "login Firebase gagal");
      next = { idToken: j.idToken, refreshToken: j.refreshToken, uid: j.localId, expiresAt: Date.now() + Number(j.expiresIn) * 1000 };
    }
    store.set("la:auth", JSON.stringify(next));
    return next;
  }

  // Returns { status, data }. data is the JSON body (null on errors).
  async function db(path, method = "GET", body) {
    const auth = await getAuth();
    const res = await fetch(`${CFG.dbUrl}/${path}.json?auth=${auth.idToken}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, data: await res.json().catch(() => null) };
  }

  // Room timestamps are server time; estimate this machine's offset from writes that echo a server timestamp.
  let serverOffset = 0;
  const serverNow = () => Date.now() + serverOffset;
  async function writeTimed(path, value) {
    const sent = Date.now();
    const r = await db(path, "PUT", value);
    const at = r.data?.at ?? r.data?.track?.at;
    if (typeof at === "number") serverOffset = at - (sent + Date.now()) / 2;
    return r;
  }

  // ---------- Player helpers ----------

  const trackId = (uri) => (uri?.startsWith("spotify:track:") ? uri.split(":")[2] : null);
  const slim = (item, durationMs) => ({
    id: trackId(item.uri),
    title: item.name ?? "",
    artist: item.artists?.[0]?.name ?? "",
    album: item.album?.name ?? "",
    durationSec: Math.round((durationMs ?? item.duration?.milliseconds ?? 0) / 1000),
  });
  function nowPlaying() {
    const item = Player.data?.item;
    if (!trackId(item?.uri)) return null; // podcasts, ads, local files
    return { ...slim(item, Player.getDuration()), progressMs: Player.getProgress(), isPlaying: Player.isPlaying() };
  }
  // Player.data.nextItems is the real upcoming order (queue, then context; respects shuffle).
  const upcoming = () => (Player.data?.nextItems ?? []).filter((i) => trackId(i.uri)).slice(0, 10).map((i) => slim(i));

  async function myName() {
    const typed = store.get("la:name");
    if (typed) return typed;
    const user = await Spicetify.Platform?.UserAPI?.getUser?.().catch(() => null);
    return (user?.displayName || user?.username || "Pendengar (Spotify)").slice(0, 40);
  }

  // ---------- State ----------

  let mode = null; // "host" | "listen"
  let code = null;
  let status = "Belum ada room.";
  let hostInfo = { listeners: [] };
  const say = (text) => { status = text; render(); };

  // ---------- Host ----------

  async function publish() {
    if (mode !== "host") return;
    const auth = await getAuth();
    const t = nowPlaying();
    const queue = upcoming();
    const r = await writeTimed(`rooms/${code}`, {
      hostUid: auth.uid,
      track: t && { ...t, at: { ".sv": "timestamp" }, next: queue[0] ?? null, queue },
    });
    if (r.status !== 200) say(`Gagal mengirim ke room (HTTP ${r.status}).`);
    else say(t ? `Host · ${t.title} — ${t.artist}` : "Host · tidak ada lagu yang diputar");
  }

  async function startHost(wanted) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let i = 0; i < 5; i++) {
      const c = wanted ?? Array.from(crypto.getRandomValues(new Uint8Array(6)), (v) => chars[v % chars.length]).join("");
      const auth = await getAuth();
      const r = await db(`rooms/${c}`, "PUT", { hostUid: auth.uid, track: null });
      if (r.status === 200) {
        mode = "host";
        code = c;
        store.set("la:mode", "host");
        store.set("la:room", c);
        await publish();
        notify(`Room ${c} dibuat`);
        return;
      }
      wanted = undefined; // saved code is taken or gone: make a new one
    }
    say("Gagal membuat room.");
  }

  async function endHost() {
    const c = code;
    stop();
    await db("", "PATCH", { [`requests/${c}`]: null, [`listeners/${c}`]: null, [`kicked/${c}`]: null }); // children first (rules)
    await db(`rooms/${c}`, "DELETE");
    say("Room diakhiri.");
  }

  async function refreshListeners() {
    if (mode !== "host") return;
    const r = await db(`listeners/${code}`);
    const now = serverNow();
    hostInfo.listeners = Object.entries(r.data ?? {}).filter(([, l]) => now - l.at < 45_000).map(([uid, l]) => ({ uid, ...l }));
    render();
  }

  async function kick(uid) {
    await db("", "PATCH", { [`kicked/${code}/${uid}`]: true, [`listeners/${code}/${uid}`]: null });
    refreshListeners();
  }

  // ---------- Listener ----------

  let lastBeat = 0;
  let lastLoad = 0;
  let endTimer;

  async function startListen(c) {
    mode = "listen";
    code = c;
    store.set("la:mode", "listen");
    store.set("la:room", c);
    lastBeat = 0;
    say(`Bergabung ke room ${c}…`);
    follow();
  }

  async function follow() {
    if (mode !== "listen") return;
    const auth = await getAuth();
    if (Date.now() - lastBeat > 15_000) {
      lastBeat = Date.now();
      const beat = await writeTimed(`listeners/${code}/${auth.uid}`, { name: await myName(), via: "spicetify", at: { ".sv": "timestamp" } });
      if (beat.status === 401) return kicked();
    }
    const r = await db(`rooms/${code}/track`);
    if (r.status === 401) return kicked();
    let t = r.data;
    if (!t?.id) return say(`Room ${code}: host belum memutar lagu`);

    if (t.next && t.isPlaying) {
      // Switch to the host's next queued song the moment this one should end; the host's own update corrects it.
      const endAt = t.at + t.durationSec * 1000 - t.progressMs;
      if (serverNow() >= endAt) t = { ...t.next, progressMs: 0, isPlaying: true, at: endAt };
      else if (endAt - serverNow() < 1000) {
        clearTimeout(endTimer);
        endTimer = setTimeout(() => followLoop(), endAt - serverNow() + 30);
      }
    }
    const target = t.progressMs + (t.isPlaying ? serverNow() - t.at : 0);

    if (Player.data?.item?.uri !== `spotify:track:${t.id}`) {
      if (Date.now() - lastLoad < 4000) return; // give playUri time to land
      lastLoad = Date.now();
      say(`Memutar ${t.title} — ${t.artist}…`);
      await Player.playUri(`spotify:track:${t.id}`);
      return;
    }
    if (!t.isPlaying) {
      if (Player.isPlaying()) Player.pause();
      return say(`⏸ ${t.title} — ${t.artist}`);
    }
    if (!Player.isPlaying()) Player.play();
    const drift = Player.getProgress() - target;
    // seek() treats values in 0..1 as a fraction of the track, so never pass less than 2 ms.
    if (Math.abs(drift) > 2000) Player.seek(Math.max(2, Math.round(target)));
    say(`▶ ${t.title} — ${t.artist} (selisih ${(drift / 1000).toFixed(1)} dtk)`);
  }

  function kicked() {
    stop();
    say("Anda dikeluarkan dari room oleh host.");
    notify("Listen Along: Anda dikeluarkan dari room", true);
  }

  function stop() {
    mode = null;
    code = null;
    clearTimeout(endTimer);
    store.remove("la:mode");
    store.remove("la:room");
  }

  // ---------- Loops ----------

  // Runs fn, reporting errors; skips a call while the previous one is still in flight (slow network).
  const guard = (fn) => {
    let busy = false;
    return async () => {
      if (busy) return;
      busy = true;
      try { await fn(); } catch (err) { say(`Error: ${err.message}`); } finally { busy = false; }
    };
  };
  const followLoop = guard(follow); // both no-ops unless in that mode
  const publishLoop = guard(publish);
  setInterval(followLoop, 1000);
  setInterval(publishLoop, 3000);
  setInterval(guard(refreshListeners), 10_000);
  Player.addEventListener("songchange", publishLoop); // host: instant song changes
  Player.addEventListener("onplaypause", publishLoop);

  // ---------- UI: top bar button + modal ----------

  let view = null; // modal element while open
  function el(tag, props = {}, ...kids) {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids);
    return e;
  }
  const btn = (label, onclick) => el("button", { type: "button", textContent: label, onclick: guard(onclick), style: "margin:4px 6px 4px 0;padding:6px 14px;border:0;border-radius:999px;font-weight:700;cursor:pointer;background:#1db954;color:#000" });

  function render() {
    if (!view?.isConnected) return;
    const parts = [el("p", { textContent: status, style: "margin:0 0 12px;opacity:.85" })];
    if (mode === "host") {
      const link = `${CFG.siteUrl ?? ""}?room=${code}`;
      parts.push(
        el("p", { style: "margin:0 0 8px" }, "Kode room: ", el("b", { textContent: code })),
        btn("Salin link", () => Spicetify.Platform?.ClipboardAPI?.copy?.(link) ?? navigator.clipboard.writeText(link)),
        btn("Akhiri room", endHost),
        el("h4", { textContent: `Pendengar (${hostInfo.listeners.length})`, style: "margin:14px 0 6px" }),
        ...hostInfo.listeners.map((l) => el("div", { style: "display:flex;align-items:center;gap:8px;margin:4px 0" },
          el("span", { textContent: `${l.name} · ${l.via}`, style: "flex:1" }), btn("Kick", () => kick(l.uid)))),
      );
    } else if (mode === "listen") {
      parts.push(el("p", { style: "margin:0 0 8px" }, "Mengikuti room ", el("b", { textContent: code })), btn("Keluar", () => { stop(); say("Keluar dari room."); }));
    } else {
      const codeInput = el("input", { placeholder: "Kode room atau link", style: "width:100%;padding:8px;margin:4px 0 8px;border-radius:6px;border:0" });
      const nameInput = el("input", { placeholder: "Nama (kosong = nama akun Spotify)", value: store.get("la:name") ?? "", maxLength: 40, style: "width:100%;padding:8px;margin:4px 0 8px;border-radius:6px;border:0" });
      nameInput.oninput = () => store.set("la:name", nameInput.value.trim());
      parts.push(
        btn("Buat room (host)", () => startHost()),
        el("h4", { textContent: "Atau ikut room", style: "margin:14px 0 4px" }),
        codeInput,
        nameInput,
        btn("Gabung", () => {
          const c = (codeInput.value.match(/room=([A-Za-z0-9]{6})/)?.[1] ?? codeInput.value.trim()).toUpperCase();
          if (!/^[A-Z0-9]{6}$/.test(c)) return say("Kode room harus 6 huruf/angka.");
          return startListen(c);
        }),
      );
    }
    view.replaceChildren(...parts);
  }

  const ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a5 5 0 0 0-5 5v3H2v5h3V9H4V6a4 4 0 0 1 8 0v3h-1v5h3V9h-1V6a5 5 0 0 0-5-5z"/></svg>';
  new Spicetify.Topbar.Button("Listen Along", ICON, () => {
    view = el("div");
    Spicetify.PopupModal.display({ title: "Listen Along", content: view });
    render();
    if (mode === "host") refreshListeners();
  });

  // Resume after Spotify restarts.
  const savedMode = store.get("la:mode");
  const savedRoom = store.get("la:room");
  if (savedMode === "host" && savedRoom) guard(() => startHost(savedRoom))();
  if (savedMode === "listen" && savedRoom) startListen(savedRoom);

  globalThis.ListenAlong = { startHost, startListen, endHost, stop, follow, publish, kick, refreshListeners, get state() { return { mode, code, status, serverOffset, listeners: hostInfo.listeners } } }; // devtools / tests
})();
