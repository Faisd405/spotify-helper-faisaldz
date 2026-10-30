// Spicetify extension: Listen Along rooms inside the Spotify desktop app, with a Jam-style side panel.
// Host: publishes the track, position and queue straight from the player (no Web API app login, so no 403 /
// Development Mode limits), plays the shared room queue, carries out guest commands.
// Listener: plays the exact same track and keeps within ~2 s; can add songs and (if allowed) control playback.
// Same Firebase rooms and rules as the web app and the browser extension.
//
// LISTEN_ALONG_CONFIG = { dbUrl, apiKey, siteUrl } is prepended by the web build (vite.config.js).

(async function listenAlong() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  // Player.data stays undefined until something has played, so don't wait for it (the button would never show).
  while (!globalThis.Spicetify?.Player?.playUri || !Spicetify.Topbar?.Button || !Spicetify.LocalStorage || !Spicetify.GraphQL?.Request) await sleep(300);
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
  const TS = { ".sv": "timestamp" };

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

  // ---------- Spotify helpers ----------

  const trackId = (uri) => (uri?.startsWith("spotify:track:") ? uri.split(":")[2] : null);
  // Player images are "spotify:image:<id>" URIs; the room stores https URLs.
  function toArt(images) {
    const u = (images?.find((i) => i.label === "standard") ?? images?.[0])?.url;
    if (u?.startsWith("spotify:image:")) return `https://i.scdn.co/image/${u.split(":")[2]}`;
    return u?.startsWith("https://") ? u : null;
  }
  const slim = (item, durationMs) => ({
    id: trackId(item.uri),
    title: item.name ?? "",
    artist: item.artists?.[0]?.name ?? "",
    album: item.album?.name ?? "",
    art: toArt(item.images ?? item.album?.images),
    durationSec: Math.round((durationMs ?? item.duration?.milliseconds ?? 0) / 1000),
  });
  function nowPlaying() {
    const item = Player.data?.item;
    if (!trackId(item?.uri)) return null; // podcasts, ads, local files
    return { ...slim(item, Player.getDuration()), progressMs: Player.getProgress(), isPlaying: Player.isPlaying() };
  }
  // Player.data.nextItems is Spotify's own upcoming order (queue, then context; respects shuffle).
  const spotifyUpcoming = () => (Player.data?.nextItems ?? []).filter((i) => trackId(i.uri)).slice(0, 10).map((i) => slim(i));

  // Song lookup through Spotify's own GraphQL (what the app's search uses). The public Web API through
  // CosmosAsync answers 429 for desktop clients now. Queries need exact variables: found by trial,
  // so this can break when Spotify changes them.
  const gql = (name, vars) => Spicetify.GraphQL.Request(Spicetify.GraphQL.Definitions[name], vars);
  async function gqlSearch(term) {
    const r = await gql("searchModalResults", { searchTerm: term, offset: 0, limit: 10, numberOfTopResults: 10, includeAuthors: false });
    return (r?.data?.searchV2?.topResultsV2?.itemsV2 ?? []).filter((i) => i.item?.__typename === "TrackResponseWrapper").map((i) => i.item.data);
  }
  const fromGql = (d) => {
    const sources = d.albumOfTrack?.coverArt?.sources ?? [];
    return {
      id: trackId(d.uri),
      title: d.name ?? "",
      artist: d.artists?.items?.[0]?.profile?.name ?? "",
      album: d.albumOfTrack?.name ?? "",
      art: (sources.find((x) => x.width === 300) ?? sources[0])?.url ?? null,
      durationSec: Math.round((d.duration?.totalMilliseconds ?? 0) / 1000), // not in search results: 0
    };
  };
  // Free text, or a track link / URI (searching by URI doesn't work: look the name up, then match the URI).
  async function resolveTrack(text) {
    const id = text.match(/track[/:]([A-Za-z0-9]{22})/)?.[1];
    if (!id) {
      const d = (await gqlSearch(text))[0];
      return d ? fromGql(d) : null;
    }
    const uri = `spotify:track:${id}`;
    const name = (await gql("getTrackName", { uri }))?.data?.trackUnion?.name;
    if (!name) return null;
    const hit = (await gqlSearch(name)).find((d) => d.uri === uri);
    return hit ? fromGql(hit) : { id, title: name, artist: "", album: "", art: null, durationSec: 0 };
  }

  let me = null; // { name, avatar }
  async function myProfile() {
    if (me) return me;
    const user = await Spicetify.Platform?.UserAPI?.getUser?.().catch(() => null);
    const avatar = user?.images?.find?.((i) => i.url?.startsWith("https://"))?.url ?? null;
    me = { name: (user?.displayName || user?.username || "Pendengar (Spotify)").slice(0, 40), avatar };
    return me;
  }
  const myName = async () => store.get("la:name") || (await myProfile()).name;

  // ---------- State ----------

  let mode = null; // "host" | "listen"
  let code = null;
  let uid = null;
  let status = "";
  let room = { hostUid: null, host: null, settings: {}, track: null }; // last known room object
  let members = {};
  let queue = {};
  let requests = {};
  let settings = { guestControl: false, approval: false, ...JSON.parse(store.get("la:settings") ?? "{}") };
  const say = (text) => { status = text; renderStatus(); };
  const isHost = () => mode === "host";
  const guestCtl = () => !!room.settings?.guestControl;
  // Spotify's own "up next" (after the room queue): from the player as host, from the room as listener.
  const upNext = () => (isHost() ? spotifyUpcoming() : room.track?.upcoming ?? []);
  const sortedQueue = () => Object.entries(queue).map(([key, v]) => ({ key, ...v })).sort((a, b) => a.order - b.order || a.at - b.at);
  const nextOrder = () => Math.max(0, ...Object.values(queue).map((q) => q.order)) + 1;

  // ---------- Host ----------

  async function publish() {
    if (!isHost()) return;
    const t = nowPlaying();
    const q = sortedQueue().filter((it) => it.id !== t?.id);
    const upcoming = spotifyUpcoming();
    const host = await myProfile();
    room = { hostUid: uid, host, settings, track: t && { ...t, at: serverNow(), next: q[0] ?? upcoming[0] ?? null, upcoming } };
    const r = await writeTimed(`rooms/${code}`, {
      hostUid: uid,
      host,
      settings,
      track: t && { ...t, at: TS, next: (q[0] && slimItem(q[0])) ?? upcoming[0] ?? null, upcoming },
    });
    if (r.status !== 200) say(`Gagal mengirim ke room (HTTP ${r.status}).`);
  }
  const slimItem = ({ id, title, artist, album, art, durationSec }) => ({ id, title, artist, album: album ?? "", art: art ?? null, durationSec });

  async function startHost(wanted) {
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let i = 0; i < 5; i++) {
      const c = wanted ?? Array.from(crypto.getRandomValues(new Uint8Array(6)), (v) => chars[v % chars.length]).join("");
      const auth = await getAuth();
      const r = await db(`rooms/${c}`, "PUT", { hostUid: auth.uid, track: null });
      if (r.status === 200) {
        mode = "host";
        code = c;
        uid = auth.uid;
        store.set("la:mode", "host");
        store.set("la:room", c);
        await publish();
        notify(`Room ${c} dibuat`);
        openPanel(true);
        render();
        return;
      }
      wanted = undefined; // saved code is taken or gone: make a new one
    }
    say("Gagal membuat room.");
  }

  async function endHost() {
    const c = code;
    stop();
    await db("", "PATCH", Object.fromEntries(["requests", "listeners", "kicked", "queues", "commands"].map((p) => [`${p}/${c}`, null]))); // children first (rules)
    await db(`rooms/${c}`, "DELETE");
    say("Room diakhiri.");
    render();
  }

  async function addToRoomQueue(track, by) {
    await db(`queues/${code}`, "POST", { ...slimItem(track), by: by.uid, name: by.name, avatar: by.avatar ?? null, order: nextOrder(), at: TS });
    await pullRoomData();
  }

  let justPlayed = null;
  async function playItem(key) {
    const it = queue[key];
    if (!it) return;
    justPlayed = it.id;
    await Player.playUri(`spotify:track:${it.id}`);
    await db(`queues/${code}/${key}`, "DELETE");
    delete queue[key];
    render();
    setTimeout(publish, 500);
  }

  // Playback controls: the host acts directly; guests send a command the host carries out.
  async function control(a, extra = {}) {
    if (!isHost()) return db(`commands/${code}`, "POST", { by: uid, a, ...extra, at: TS });
    const q = sortedQueue();
    if (a === "play") Player.play();
    else if (a === "pause") Player.pause();
    else if (a === "next") await (q[0] ? playItem(q[0].key) : Player.next());
    else if (a === "prev") Player.back();
    else if (a === "seek" && typeof extra.pos === "number") Player.seek(Math.max(2, extra.pos));
    else if (a === "playItem" && extra.key) await playItem(extra.key);
    setTimeout(publish, 400);
  }

  const lastCommand = new Map(); // uid -> time: max one command per guest per 0.5 s
  async function handleCommands() {
    if (!isHost()) return;
    const r = await db(`commands/${code}`);
    for (const [key, c] of Object.entries(r.data ?? {})) {
      await db(`commands/${code}/${key}`, "DELETE");
      if (!settings.guestControl || !c?.by || Date.now() - (lastCommand.get(c.by) ?? 0) < 500) continue;
      lastCommand.set(c.by, Date.now());
      await control(c.a, c).catch((e) => say(`Error: ${e.message}`));
    }
  }

  // Listener requests: free text or links, looked up with the app's own Spotify login.
  const resolving = new Set();
  async function handleRequests() {
    if (!isHost()) return;
    for (const [key, r] of Object.entries(requests)) {
      if (r.track || r.status || resolving.has(key)) continue;
      resolving.add(key);
      try {
        const t = await resolveTrack(r.text);
        if (!t) await db(`requests/${code}/${key}`, "PATCH", { status: "notfound" });
        else if (settings.approval) await db(`requests/${code}/${key}`, "PATCH", { track: t });
        else {
          await addToRoomQueue(t, { uid: r.by, name: r.name });
          await db(`requests/${code}/${key}`, "DELETE");
        }
      } catch (e) {
        say(`Request gagal dicari: ${e.message}`);
      } finally {
        resolving.delete(key);
      }
    }
  }
  async function approve(key) {
    const r = requests[key];
    if (!r?.track) return;
    await addToRoomQueue(r.track, { uid: r.by, name: r.name });
    await db(`requests/${code}/${key}`, "DELETE");
  }

  // The room queue plays before Spotify's own "up next": start it right as the current song ends.
  let advancedFrom = null;
  let polledId = null;
  function advanceCheck() {
    if (!isHost()) return;
    const t = nowPlaying();
    if (!t) return;
    if (t.id !== polledId) {
      // Started outside the room queue (e.g. picked in Spotify): drop one queued copy of it.
      if (t.id !== justPlayed) {
        const dup = sortedQueue().find((it) => it.id === t.id);
        if (dup) db(`queues/${code}/${dup.key}`, "DELETE");
      }
      justPlayed = null;
      polledId = t.id;
      publish(); // instant song changes
    }
    const next = sortedQueue().find((it) => it.id !== t.id);
    const left = t.durationSec * 1000 - t.progressMs;
    if (next && t.isPlaying && left < 700 && advancedFrom !== t.id) {
      advancedFrom = t.id;
      playItem(next.key).catch((e) => say(`Error: ${e.message}`));
    }
  }

  // ---------- Listener ----------

  let lastBeat = 0;
  let lastLoad = 0;
  let endTimer;

  async function startListen(c) {
    // Sign in before switching modes: the 1 s follow loop would otherwise send a heartbeat for uid null,
    // get a 401 and treat it as a kick.
    uid = (await getAuth()).uid;
    mode = "listen";
    code = c;
    store.set("la:mode", "listen");
    store.set("la:room", c);
    lastBeat = 0;
    say(`Bergabung ke room ${c}…`);
    openPanel(true);
    render();
    follow();
  }

  async function follow() {
    if (mode !== "listen") return;
    if (Date.now() - lastBeat > 15_000) {
      lastBeat = Date.now();
      const p = await myProfile();
      const beat = await writeTimed(`listeners/${code}/${uid}`, { name: await myName(), via: "spicetify", avatar: p.avatar ?? null, at: TS });
      if (beat.status === 401) return kicked();
    }
    const r = await db(`rooms/${code}`);
    if (r.status === 401) return kicked();
    const before = `${room.track?.id}|${room.track?.isPlaying}|${room.settings?.guestControl}`;
    room = { hostUid: r.data?.hostUid ?? null, host: r.data?.host ?? null, settings: r.data?.settings ?? {}, track: r.data?.track ?? null };
    if (before !== `${room.track?.id}|${room.track?.isPlaying}|${room.settings?.guestControl}`) render();
    let t = room.track;
    if (!t?.id) return say(room.hostUid ? `Room ${code}: host belum memutar lagu` : `Room ${code} tidak ada atau sudah diakhiri`);

    if (t.next && t.isPlaying) {
      // Switch to the host's next song the moment this one should end; the host's own update corrects it.
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
    say(`Sinkron dengan host (selisih ${(drift / 1000).toFixed(1)} dtk)`);
  }

  function kicked() {
    stop();
    say("Anda dikeluarkan dari room oleh host.");
    notify("Listen Along: Anda dikeluarkan dari room", true);
    render();
  }

  function stop() {
    mode = null;
    code = null;
    room = { hostUid: null, host: null, settings: {}, track: null };
    members = queue = requests = {};
    clearTimeout(endTimer);
    store.remove("la:mode");
    store.remove("la:room");
  }

  // Members, queue and requests for both roles (REST has no live listeners here, so poll).
  let dataKey = "";
  async function pullRoomData() {
    if (!code) return;
    const [m, q, r] = await Promise.all([db(`listeners/${code}`), db(`queues/${code}`), db(`requests/${code}`)]);
    if ([m, q, r].some((x) => x.status === 401)) return mode === "listen" ? kicked() : undefined;
    members = m.data ?? {};
    queue = q.data ?? {};
    requests = r.data ?? {};
    const key = JSON.stringify([members, queue, requests]);
    if (key !== dataKey) { dataKey = key; render(); }
    if (isHost()) await handleRequests();
  }

  // ---------- Loops ----------

  // Runs fn, reporting errors; skips a call while the previous one is still in flight (slow network).
  const guard = (fn) => {
    let busy = false;
    return async (...args) => { // pass arguments through: the context menu hands over the clicked uris
      if (busy) return;
      busy = true;
      try { await fn(...args); } catch (err) { say(`Error: ${err.message}`); notify(`Listen Along: ${err.message}`, true); } finally { busy = false; }
    };
  };
  const followLoop = guard(follow); // each is a no-op unless in that mode
  setInterval(followLoop, 1000);
  setInterval(guard(publish), 3000);
  setInterval(guard(handleCommands), 1000);
  setInterval(guard(pullRoomData), 2000);
  setInterval(guard(async () => advanceCheck()), 400);
  setInterval(() => panelEl?.isConnected && panelOpen && renderProgress(), 1000);
  const publishNow = guard(publish);
  Player.addEventListener("onplaypause", publishNow);

  // Right-click a song anywhere in Spotify -> add it to the room.
  const trackUris = (uris) => (Array.isArray(uris) ? uris : [uris]).filter((u) => trackId(u));
  const contextAdd = guard(async (uris) => {
    let added = 0;
    for (const u of trackUris(uris)) {
      if (isHost()) {
        const t = await resolveTrack(u);
        if (!t) continue;
        await addToRoomQueue(t, { uid, ...(await myProfile()) });
      } else {
        await db(`requests/${code}`, "POST", { by: uid, name: await myName(), text: `https://open.spotify.com/track/${trackId(u)}`, at: TS });
      }
      added++;
    }
    notify(added ? (isHost() ? "Ditambahkan ke antrian room" : "Request dikirim ke host") : "Lagu tidak bisa ditambahkan", !added);
  });
  const contextItem = new Spicetify.ContextMenu.Item("Tambah ke antrian room", contextAdd, (uris) => !!code && trackUris(uris).length > 0);
  contextItem.register();

  // ---------- UI: Jam-style side panel ----------

  const css = `
    #la-panel { position: fixed; top: 64px; right: 8px; bottom: 96px; width: 340px; z-index: 1000; background: #121212; color: #fff;
      border-radius: 10px; box-shadow: 0 8px 32px #000c; display: flex; flex-direction: column; font: 14px var(--font-family, system-ui), sans-serif; }
    #la-panel[hidden] { display: none; }
    #la-panel .la-head { display: flex; align-items: center; gap: 8px; padding: 12px 14px; border-bottom: 1px solid #ffffff14; }
    #la-panel .la-head b { flex: 1; }
    #la-panel .la-body { overflow-y: auto; padding: 12px 14px; display: grid; gap: 16px; align-content: start; }
    #la-panel h4 { margin: 0 0 8px; font-size: 11px; letter-spacing: .1em; text-transform: uppercase; opacity: .6; }
    #la-panel button { border: 0; border-radius: 999px; padding: 7px 14px; font-weight: 700; cursor: pointer; background: #1db954; color: #000; }
    #la-panel button.sec { background: #2a2a2a; color: #fff; }
    #la-panel button.icon { background: transparent; color: #fff; padding: 4px 7px; opacity: .7; }
    #la-panel button.icon:hover { opacity: 1; background: #ffffff14; }
    #la-panel button:disabled { opacity: .5; cursor: progress; }
    #la-panel input { padding: 8px 10px; border-radius: 8px; border: 1px solid #ffffff22; background: #2a2a2a; color: #fff; min-width: 0; }
    #la-panel .row { display: flex; gap: 6px; align-items: center; }
    #la-panel .row > input { flex: 1; }
    #la-panel .muted { opacity: .65; }
    #la-panel .live { color: #1db954; font-size: 11px; font-weight: 800; letter-spacing: .1em; }
    #la-panel .code { font-family: monospace; font-size: 16px; font-weight: 800; letter-spacing: .12em; flex: 1; }
    #la-panel .card { background: #1e1e1e; border-radius: 10px; padding: 12px; }
    #la-panel .np { display: flex; gap: 12px; align-items: center; }
    #la-panel .np img, #la-panel .np .ph { width: 56px; height: 56px; border-radius: 6px; object-fit: cover; flex: none; background: #333; }
    #la-panel .np-t { flex: 1; min-width: 0; display: grid; gap: 2px; }
    #la-panel .np-t b, #la-panel .np-t span, #la-panel .q-t b, #la-panel .q-t span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    #la-panel .bar { height: 4px; background: #ffffff33; border-radius: 2px; margin-top: 6px; overflow: hidden; }
    #la-panel .bar > i { display: block; height: 100%; background: #1db954; width: 0; }
    #la-panel .ctrls { display: flex; justify-content: center; gap: 12px; margin-top: 10px; }
    #la-panel .ctrls button { width: 36px; height: 36px; padding: 0; background: #ffffff14; color: #fff; }
    #la-panel .ctrls button:nth-child(2) { background: #fff; color: #000; }
    #la-panel ul { list-style: none; margin: 0; padding: 0; display: grid; gap: 4px; }
    #la-panel li { display: flex; align-items: center; gap: 8px; }
    #la-panel .av { width: 26px; height: 26px; border-radius: 50%; flex: none; object-fit: cover; display: inline-grid; place-items: center; font-size: 10px; font-weight: 700; }
    #la-panel .av.xs { width: 18px; height: 18px; font-size: 8px; }
    #la-panel .q-art { width: 36px; height: 36px; border-radius: 4px; object-fit: cover; flex: none; background: #333; }
    #la-panel .q-t { flex: 1; min-width: 0; display: grid; font-size: 13px; }
    #la-panel .q-t span { font-size: 11px; opacity: .65; }
    #la-panel .badge { font-size: 9px; font-weight: 800; background: #1db954; color: #000; padding: 2px 5px; border-radius: 4px; }
    #la-panel .toggle { display: flex; justify-content: space-between; align-items: center; gap: 8px; font-size: 13px; }
    #la-panel .hero { text-align: center; display: grid; gap: 10px; padding: 12px 0; }
    #la-panel .status { font-size: 12px; opacity: .7; }
    #la-panel .nx { display: flex; align-items: center; gap: 8px; margin-top: 10px; padding-top: 10px; border-top: 1px solid #ffffff14; font-size: 12px; }
    #la-panel .nx .muted { font-size: 10px; letter-spacing: .08em; flex: none; }
    #la-panel .nx img { width: 22px; height: 22px; border-radius: 3px; object-fit: cover; }
    #la-panel .nx-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  `;
  const h = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids.filter((k) => k != null && k !== false));
    return e;
  };
  const btn = (label, fn, cls = "", title = "") => {
    const b = h("button", { type: "button", textContent: label, className: cls, title });
    b.onclick = async () => {
      b.disabled = true;
      try { await fn(); } catch (e) { say(`Error: ${e.message}`); } finally { b.disabled = false; }
    };
    return b;
  };
  const COLORS = ["#e91e63", "#9c27b0", "#3f51b5", "#03a9f4", "#009688", "#8bc34a", "#ff9800", "#ff5722"];
  function av(name = "?", url = null, cls = "av") {
    if (url) {
      const img = h("img", { className: cls, src: url, alt: "", title: name });
      img.onerror = () => img.replaceWith(av(name, null, cls));
      return img;
    }
    const hash = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    return h("span", { className: cls, textContent: name.trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase(), title: name, style: `background:${COLORS[hash % COLORS.length]}` });
  }
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

  let panelEl = null;
  let panelOpen = false;
  function ensurePanel() {
    if (panelEl?.isConnected) return panelEl;
    document.head.append(h("style", { textContent: css }));
    panelEl = h("div", { id: "la-panel", hidden: true });
    document.body.append(panelEl);
    return panelEl;
  }
  function openPanel(open = !panelOpen) {
    panelOpen = open;
    ensurePanel().hidden = !open;
    if (open) render();
  }

  function liveMembers() {
    const now = serverNow();
    const host = { uid: room.hostUid, name: room.host?.name ?? "Host", avatar: room.host?.avatar ?? null, isHost: true };
    const others = Object.entries(members).filter(([u, l]) => u !== room.hostUid && now - l.at < 45_000).map(([u, l]) => ({ uid: u, ...l }));
    return (room.hostUid ? [host] : []).concat(others).map((m) => ({ ...m, isMe: m.uid === uid }));
  }

  function renderStatus() {
    const el = panelEl?.querySelector(".status");
    if (el) el.textContent = status;
  }
  function renderProgress() {
    const bar = panelEl?.querySelector(".bar > i");
    const t = isHost() ? nowPlaying() : room.track;
    if (!bar || !t) return;
    const pos = isHost() ? t.progressMs : t.progressMs + (t.isPlaying ? serverNow() - t.at : 0);
    bar.style.width = `${Math.min(100, (pos / 10 / Math.max(1, t.durationSec)))}%`;
    const el = panelEl.querySelector(".pos");
    if (el) el.textContent = `${mmss(pos / 1000)} / ${mmss(t.durationSec)}`;
  }

  function render() {
    if (!panelOpen) return;
    // The panel is rebuilt on every data change: keep what the user is typing (and the caret) across it.
    const kept = {};
    for (const el of panelEl.querySelectorAll("input[data-keep]")) {
      kept[el.dataset.keep] = { value: el.value, focused: el === document.activeElement, at: el.selectionStart };
    }
    const body = h("div", { className: "la-body" });
    const head = h("div", { className: "la-head" }, h("b", { textContent: "Listen Along" }), btn("✕", () => openPanel(false), "icon", "Tutup"));
    panelEl.replaceChildren(head, body);

    if (!code) {
      const codeIn = h("input", { placeholder: "Kode room atau link" });
      codeIn.dataset.keep = "code";
      const nameIn = h("input", { placeholder: "Nama (kosong = nama akun Spotify)", value: store.get("la:name") ?? "", maxLength: 40 });
      nameIn.oninput = () => store.set("la:name", nameIn.value.trim());
      body.append(h("div", { className: "hero" },
        h("b", { textContent: "Dengar bareng, tetap sinkron", style: "font-size:18px" }),
        h("span", { className: "muted", textContent: "Teman bisa ikut dari app Spotify, HP, web, atau YouTube." }),
        btn("Buat room", () => startHost()),
        h("span", { className: "muted", textContent: "atau gabung" }),
        h("div", { className: "row" }, codeIn, btn("Gabung", () => {
          const c = (codeIn.value.match(/room=([A-Za-z0-9]{6})/)?.[1] ?? codeIn.value.trim()).toUpperCase();
          if (!/^[A-Z0-9]{6}$/.test(c)) return say("Kode room harus 6 huruf/angka.");
          return startListen(c);
        })),
        nameIn,
      ), h("div", { className: "status", textContent: status }));
      return;
    }

    const link = `${CFG.siteUrl ?? ""}?room=${code}`;
    const copy = () => Spicetify.Platform?.ClipboardAPI?.copy?.(link) ?? navigator.clipboard.writeText(link);
    body.append(h("div", { className: "row" },
      h("span", { className: "live", textContent: "● LIVE" }),
      h("span", { className: "code", textContent: code }),
      btn("Salin link", async () => { await copy(); notify("Link room disalin"); }, "sec"),
      btn(isHost() ? "Akhiri" : "Keluar", () => (isHost() ? endHost() : (stop(), say("Keluar dari room."), render())), "sec"),
    ));

    // now playing
    const t = isHost() ? nowPlaying() : room.track;
    const controls = isHost() || guestCtl();
    body.append(h("div", {}, h("h4", { textContent: "Sedang diputar" }), h("div", { className: "card" },
      t ? h("div", { className: "np" },
        t.art ? h("img", { src: t.art, alt: "" }) : h("span", { className: "ph" }),
        h("div", { className: "np-t" }, h("b", { textContent: t.title }), h("span", { className: "muted", textContent: t.artist }),
          h("div", { className: "bar" }, h("i")), h("span", { className: "muted pos", style: "font-size:11px" })),
      ) : h("span", { className: "muted", textContent: "Belum ada lagu yang diputar." }),
      (() => {
        const nx = sortedQueue().find((it) => it.id !== t?.id) ?? upNext().find((it) => it.id !== t?.id);
        return t && nx ? h("div", { className: "nx" }, h("span", { className: "muted", textContent: "BERIKUTNYA" }),
          nx.art ? h("img", { src: nx.art, alt: "" }) : null, h("span", { className: "nx-t", textContent: `${nx.title} — ${nx.artist}` })) : null;
      })(),
      t && controls ? h("div", { className: "ctrls" },
        btn("⏮", () => control("prev"), "", "Sebelumnya"),
        btn(t.isPlaying ? "⏸" : "▶", () => control(t.isPlaying ? "pause" : "play"), "", t.isPlaying ? "Jeda" : "Putar"),
        btn("⏭", () => control("next"), "", "Berikutnya"),
      ) : null,
    )));

    // members
    const list = liveMembers();
    body.append(h("div", {}, h("h4", { textContent: `Di room (${list.length})` }), h("ul", {}, ...list.map((m) => h("li", {},
      av(m.name, m.avatar),
      h("span", { style: "flex:1;min-width:0", textContent: m.name + (m.isMe ? " (Anda)" : "") }),
      m.isHost ? h("span", { className: "badge", textContent: "HOST" }) : h("span", { className: "muted", style: "font-size:11px", textContent: m.via }),
      isHost() && !m.isHost ? btn("Kick", async () => {
        await db("", "PATCH", { [`kicked/${code}/${m.uid}`]: true, [`listeners/${code}/${m.uid}`]: null });
        await pullRoomData();
      }, "sec") : null,
    )))));

    // queue + add
    const addIn = h("input", { placeholder: "Tambah lagu: judul atau link", maxLength: 200 });
    addIn.dataset.keep = "add";
    const add = async () => {
      const text = addIn.value.trim();
      if (!text) return;
      if (isHost()) {
        const tr = await resolveTrack(text);
        if (!tr) throw new Error(`"${text}" tidak ketemu`);
        await addToRoomQueue(tr, { uid, ...(await myProfile()) });
      } else {
        await db(`requests/${code}`, "POST", { by: uid, name: await myName(), text, at: TS });
        await pullRoomData();
      }
      // The panel may have re-rendered while this was saving: clear the input that is on screen now.
      for (const el of [addIn, panelEl.querySelector("input[data-keep=\"add\"]")]) if (el) el.value = "";
    };
    addIn.onkeydown = (e) => e.key === "Enter" && add().catch((err) => say(`Error: ${err.message}`));
    const items = sortedQueue();
    const pend = Object.entries(requests).map(([key, r]) => ({ key, ...r })).sort((a, b) => a.at - b.at);
    body.append(h("div", {},
      h("h4", { textContent: "Antrian" }),
      h("div", { className: "row", style: "margin-bottom:8px" }, addIn, btn("Tambah", add)),
      h("ul", {}, ...pend.map((r) => h("li", { style: "font-size:12px" },
        h("span", { style: "flex:1;min-width:0", textContent: `${r.track ? `${r.track.title} — ${r.track.artist}` : r.text} · ${r.name} · ${r.status === "notfound" ? "tidak ketemu" : r.track ? "menunggu persetujuan" : "mencari…"}` }),
        isHost() && r.track ? btn("Setujui", () => approve(r.key)) : null,
        isHost() || r.by === uid ? btn("✕", async () => { await db(`requests/${code}/${r.key}`, "DELETE"); await pullRoomData(); }, "icon", "Hapus") : null,
      ))),
      items.length ? h("ul", {}, ...items.map((it, i) => h("li", {},
        it.art ? h("img", { className: "q-art", src: it.art, alt: "" }) : h("span", { className: "q-art" }),
        h("div", { className: "q-t" }, h("b", { textContent: it.title }), h("span", { textContent: it.durationSec ? `${it.artist} · ${mmss(it.durationSec)}` : it.artist })),
        av(it.name, it.avatar, "av xs"),
        controls && i > 0 ? btn("↑", async () => {
          const rest = items.filter((x) => x.key !== it.key);
          const before = rest[i - 2]?.order, after = rest[i - 1]?.order;
          const order = before == null ? after - 1 : (before + after) / 2;
          await db(`queues/${code}/${it.key}/order`, "PUT", order);
          await pullRoomData();
        }, "icon", "Naikkan") : null,
        controls ? btn("▶", () => (isHost() ? playItem(it.key) : control("playItem", { key: it.key })), "icon", "Putar sekarang") : null,
        isHost() || guestCtl() || it.by === uid ? btn("✕", async () => { await db(`queues/${code}/${it.key}`, "DELETE"); await pullRoomData(); }, "icon", "Hapus") : null,
      ))) : h("span", { className: "muted", style: "font-size:12px", textContent: "Antrian room kosong. Klik kanan lagu mana pun → Tambah ke antrian room." }),
    ));

    const later = upNext().slice(0, 8);
    if (later.length) body.append(h("div", {}, h("h4", { textContent: "Up next dari Spotify" }), h("ul", {}, ...later.map((it) => h("li", { style: "opacity:.8" },
      it.art ? h("img", { className: "q-art", src: it.art, alt: "" }) : h("span", { className: "q-art" }),
      h("div", { className: "q-t" }, h("b", { textContent: it.title }), h("span", { textContent: it.artist })),
    )))));

    if (isHost()) {
      const toggle = (label, keyName) => {
        const input = h("input", { type: "checkbox", checked: !!settings[keyName] });
        input.onchange = () => {
          settings = { ...settings, [keyName]: input.checked };
          store.set("la:settings", JSON.stringify(settings));
          publishNow();
        };
        return h("label", { className: "toggle" }, label, input);
      };
      body.append(h("div", { style: "display:grid;gap:8px" }, h("h4", { textContent: "Pengaturan room" }),
        toggle("Tamu boleh mengontrol pemutaran", "guestControl"),
        toggle("Lagu dari tamu perlu disetujui", "approval"),
      ));
    }
    body.append(h("div", { className: "status", textContent: status }));
    for (const el of panelEl.querySelectorAll("input[data-keep]")) {
      const k = kept[el.dataset.keep];
      if (!k) continue;
      el.value = k.value;
      if (k.focused) { el.focus(); el.setSelectionRange(k.at, k.at); }
    }
    renderProgress();
  }

  const ICON = '<svg viewBox="0 0 16 16" fill="currentColor"><path d="M8 1a5 5 0 0 0-5 5v3H2v5h3V9H4V6a4 4 0 0 1 8 0v3h-1v5h3V9h-1V6a5 5 0 0 0-5-5z"/></svg>';
  new Spicetify.Topbar.Button("Listen Along", ICON, () => openPanel());

  // Resume after Spotify restarts.
  const savedMode = store.get("la:mode");
  const savedRoom = store.get("la:room");
  if (savedMode === "host" && savedRoom) guard(() => startHost(savedRoom))();
  if (savedMode === "listen" && savedRoom) startListen(savedRoom);

  globalThis.ListenAlong = { // devtools / tests
    startHost, startListen, endHost, stop, follow, publish, control, openPanel, pullRoomData, advanceCheck, contextAdd,
    get state() { return { mode, code, uid, status, serverOffset, room, members, queue, requests, settings }; },
  };
})();
