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
  let offsetKnown = false;
  let publishes = 0;
  const serverNow = () => Date.now() + serverOffset;
  async function writeTimed(path, value, method = "PUT") {
    const sent = Date.now();
    const r = await db(path, method, value);
    const at = typeof value?.at === "object" ? r.data?.at : undefined; // only server-resolved stamps
    if (typeof at === "number") { serverOffset = at - (sent + Date.now()) / 2; offsetKnown = true; }
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

  // Runs every 400 ms but only writes what changed, since every write is downloaded by every listener.
  // Listeners extrapolate progressMs + (now - at), so the position is only re-sent when the real one strays
  // more than 300 ms from that (seek, stall), on play/pause, or as a 5 s heartbeat.
  let sent = { track: null, meta: "" }; // what listeners currently have
  let publishing = false;
  async function publish() {
    if (!isHost() || publishing) return;
    publishing = true;
    try {
      const t = nowPlaying();
      const q = sortedQueue().filter((it) => it.id !== t?.id);
      const upcoming = spotifyUpcoming();
      const host = await myProfile();
      const now = serverNow();
      const track = t && { ...t, next: (q[0] && slimItem(q[0])) ?? upcoming[0] ?? null, upcoming };
      room = { hostUid: uid, host, settings, track: track && { ...track, at: now } };

      const meta = JSON.stringify({ host, settings });
      if (meta !== sent.meta) {
        const r = await db(`rooms/${code}`, "PATCH", { hostUid: uid, host, settings });
        if (r.status !== 200) return say(`Gagal mengirim ke room (HTTP ${r.status}).`);
        sent.meta = meta;
      }

      const prev = sent.track;
      let method = "PATCH";
      let body;
      if (!track) {
        if (prev === null) return;
        method = "PUT";
        body = null;
      } else if (prev?.id !== track.id) {
        method = "PUT";
        body = track;
      } else {
        body = {};
        for (const [k, v] of Object.entries(track)) if (k !== "progressMs" && JSON.stringify(v) !== JSON.stringify(prev[k])) body[k] = v;
        const predicted = prev.progressMs + (prev.isPlaying ? now - prev.at : 0);
        if ("isPlaying" in body || Math.abs(predicted - track.progressMs) > 300 || now - prev.at > 5000) body.progressMs = track.progressMs;
        if (!Object.keys(body).length) return;
      }
      if (body && "progressMs" in body) {
        // The server timestamp is when the write lands (~RTT/2 after the position was read); once the clock
        // offset is known, stamp the read moment itself. Every 20th still uses the server stamp, so the
        // offset keeps being re-measured.
        body.at = offsetKnown && ++publishes % 20 ? now : TS;
      }
      const r = await writeTimed(`rooms/${code}/track`, body, method);
      if (r.status !== 200) {
        sent.track = undefined; // unknown: send the whole track next time
        return say(`Gagal mengirim ke room (HTTP ${r.status}).`);
      }
      sent.track = body === null ? null : { ...(method === "PUT" ? {} : prev), ...body, at: now };
    } finally {
      publishing = false;
    }
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
        sent = { track: null, meta: "" };
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
    publishNow(); // writes only what changed: seeks, play/pause and song changes reach listeners within ~400 ms
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
      render(); // now playing card / mini player
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

  // Firebase REST streaming: the host's writes arrive within ~100-300 ms instead of on the next 1 s poll.
  // Falls back to polling while the stream is down.
  let stream = null;
  let streamed = null; // latest room object from the stream
  let streamUp = false;
  async function openStream() {
    closeStream();
    const c = code;
    const a = await getAuth();
    if (mode !== "listen" || code !== c) return;
    const es = new EventSource(`${CFG.dbUrl}/rooms/${c}.json?auth=${a.idToken}`);
    stream = es;
    const apply = (path, data, merge) => {
      if (path === "/") streamed = merge ? { ...(streamed ?? {}), ...data } : data;
      else {
        const keys = path.split("/").filter(Boolean);
        streamed = structuredClone(streamed ?? {});
        let o = streamed;
        for (const k of keys.slice(0, -1)) o = o[k] = o[k] ?? {};
        o[keys.at(-1)] = merge ? { ...(o[keys.at(-1)] ?? {}), ...data } : data;
      }
      streamUp = true;
      followLoop(); // react right away
    };
    es.addEventListener("put", (e) => { const { path, data } = JSON.parse(e.data); apply(path, data, false); });
    es.addEventListener("patch", (e) => { const { path, data } = JSON.parse(e.data); apply(path, data, true); });
    es.addEventListener("auth_revoked", () => openStream()); // ID token expired (hourly): reconnect with a fresh one
    es.addEventListener("cancel", () => { closeStream(); kicked(); }); // rules now deny the read
    es.onerror = () => { streamUp = false; }; // EventSource retries by itself; poll meanwhile
  }
  function closeStream() {
    stream?.close();
    stream = null;
    streamUp = false;
    streamed = null;
  }

  // Drift correction state (listener).
  let driftEma = null;
  let driftHits = 0;
  let lastCorrection = 0;
  function correctDrift(target) {
    if (Date.now() - lastCorrection < 1500) return 0; // let a seek settle before judging again
    const d = Player.getProgress() - target;
    driftEma = driftEma == null ? d : 0.6 * driftEma + 0.4 * d; // smooths out one-off jitter
    const big = Math.abs(d) > 800; // clearly off (host seeked, ad, stall): fix now
    const small = Math.abs(driftEma) > 250 && ++driftHits >= 2; // creeping drift: fix after 2 confirmations
    if (Math.abs(driftEma) <= 250) driftHits = 0;
    if (big || small) {
      // seek() treats values in 0..1 as a fraction of the track, so never pass less than 2 ms.
      Player.seek(Math.max(2, Math.round(target)));
      lastCorrection = Date.now();
      driftEma = null;
      driftHits = 0;
    }
    return d;
  }

  async function startListen(c) {
    // Sign in before switching modes: the 1 s follow loop would otherwise send a heartbeat for uid null,
    // get a 401 and treat it as a kick.
    uid = (await getAuth()).uid;
    mode = "listen";
    code = c;
    store.set("la:mode", "listen");
    store.set("la:room", c);
    lastBeat = 0;
    openStream().catch(() => {});
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
    let data = streamed;
    if (!streamUp) {
      const r = await db(`rooms/${code}`);
      if (r.status === 401) return kicked();
      data = r.data;
    }
    const before = `${room.track?.id}|${room.track?.isPlaying}|${room.settings?.guestControl}`;
    room = { hostUid: data?.hostUid ?? null, host: data?.host ?? null, settings: data?.settings ?? {}, track: data?.track ?? null };
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
      lastCorrection = Date.now(); // the new track needs a moment before its position means anything
      say(`Memutar ${t.title} — ${t.artist}…`);
      await Player.playUri(`spotify:track:${t.id}`);
      return;
    }
    if (!t.isPlaying) {
      if (Player.isPlaying()) Player.pause();
      return say(`⏸ ${t.title} — ${t.artist}`);
    }
    if (!Player.isPlaying()) Player.play();
    const drift = correctDrift(target);
    say(`Sinkron dengan host (selisih ${(drift / 1000).toFixed(2)} dtk${streamUp ? "" : ", polling"})`);
  }

  function kicked() {
    stop();
    say("Anda dikeluarkan dari room oleh host.");
    notify("Listen Along: Anda dikeluarkan dari room", true);
    render();
  }

  function stop() {
    closeStream();
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
  setInterval(guard(handleCommands), 1000);
  setInterval(guard(pullRoomData), 2000);
  setInterval(guard(async () => advanceCheck()), 400);
  setInterval(() => (panelEl?.isConnected && panelOpen ? renderProgress() : renderMini()), 1000);
  const publishNow = guard(publish);
  Player.addEventListener("onplaypause", () => { publishNow(); setTimeout(render, 150); }); // play/pause icon + mini player

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

  // ---------- UI: Jam-style side panel + mini player ----------
  // Colours follow the active Spicetify theme (--spice-*), with Spotify's defaults as fallback.

  const css = `
    #la-panel, #la-mini { --la-bg: var(--spice-main, #121212); --la-card: var(--spice-card, #1f1f1f); --la-hi: var(--spice-highlight, #2a2a2a);
      --la-text: var(--spice-text, #fff); --la-sub: var(--spice-subtext, #b3b3b3); --la-accent: var(--spice-button, #1ed760);
      --la-on-accent: var(--spice-main, #000); font-family: var(--font-family, CircularSp, system-ui), sans-serif; color: var(--la-text); }
    #la-panel { position: fixed; top: 64px; right: 8px; bottom: 96px; width: 360px; z-index: 1000; background: var(--la-bg);
      border: 1px solid #ffffff14; border-radius: 12px; box-shadow: 0 16px 48px #000b; display: flex; flex-direction: column;
      transition: transform .22s ease, opacity .22s ease; }
    #la-panel.la-hidden { transform: translateX(24px); opacity: 0; pointer-events: none; }
    .la-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px 10px; }
    .la-head .la-logo { width: 28px; height: 28px; border-radius: 50%; background: var(--la-accent); color: var(--la-on-accent); display: grid; place-items: center; flex: none; }
    .la-head .la-title { flex: 1; font-weight: 800; font-size: 15px; }
    .la-body { overflow-y: auto; padding: 4px 16px 16px; display: grid; gap: 18px; align-content: start; scrollbar-width: thin; }
    .la-h { margin: 0 0 8px; font-size: 11px; font-weight: 700; letter-spacing: .1em; text-transform: uppercase; color: var(--la-sub); display: flex; align-items: center; gap: 6px; }
    .la-h .la-count { background: var(--la-hi); color: var(--la-text); border-radius: 999px; padding: 1px 7px; letter-spacing: 0; }
    #la-panel button { font: inherit; border: 0; cursor: pointer; color: inherit; background: none; }
    #la-panel button:disabled { opacity: .5; cursor: progress; }
    .la-btn { border-radius: 999px !important; padding: 8px 16px !important; font-weight: 700 !important; font-size: 13px !important; background: var(--la-accent) !important; color: var(--la-on-accent) !important; transition: transform .1s; }
    .la-btn:hover { transform: scale(1.03); }
    .la-btn.sec { background: var(--la-hi) !important; color: var(--la-text) !important; }
    .la-btn.danger { background: transparent !important; color: #f3727f !important; border: 1px solid #f3727f55 !important; }
    .la-ico { width: 32px; height: 32px; border-radius: 50% !important; display: inline-grid !important; place-items: center; color: var(--la-sub) !important; flex: none; }
    .la-ico:hover { color: var(--la-text) !important; background: var(--la-hi) !important; }
    .la-ico svg, .la-btn svg { width: 16px; height: 16px; fill: currentColor; }
    #la-panel input[type=text] { width: 100%; box-sizing: border-box; padding: 9px 12px; border-radius: 8px; border: 1px solid transparent; background: var(--la-hi); color: var(--la-text); font: inherit; font-size: 13px; outline: none; }
    #la-panel input[type=text]:focus { border-color: var(--la-sub); }
    .la-row { display: flex; gap: 8px; align-items: center; }
    .la-row > .la-grow, .la-grow { flex: 1; min-width: 0; }
    .la-sub { color: var(--la-sub); }
    .la-ell { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .la-card { background: var(--la-card); border-radius: 10px; padding: 14px; }
    /* hero */
    .la-hero { text-align: center; display: grid; gap: 12px; padding: 20px 4px 8px; justify-items: center; }
    .la-hero .la-big { width: 64px; height: 64px; border-radius: 50%; background: var(--la-hi); color: var(--la-accent); display: grid; place-items: center; }
    .la-hero .la-big svg { width: 30px; height: 30px; fill: currentColor; }
    .la-hero h2 { margin: 0; font-size: 20px; font-weight: 800; }
    .la-or { display: flex; align-items: center; gap: 10px; width: 100%; color: var(--la-sub); font-size: 12px; }
    .la-or::before, .la-or::after { content: ""; flex: 1; height: 1px; background: #ffffff1a; }
    /* session */
    .la-live { color: var(--la-accent); font-size: 10px; font-weight: 800; letter-spacing: .12em; display: inline-flex; align-items: center; gap: 5px; }
    .la-live::before { content: ""; width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: la-pulse 1.6s infinite; }
    @keyframes la-pulse { 50% { opacity: .3; } }
    .la-code { font-family: ui-monospace, Consolas, monospace; font-size: 22px; font-weight: 800; letter-spacing: .14em; }
    .la-qr { display: grid; justify-items: center; gap: 8px; margin-top: 12px; }
    .la-qr img { width: 168px; height: 168px; border-radius: 10px; background: #fff; padding: 6px; }
    /* now playing */
    .la-np { display: flex; gap: 14px; align-items: center; }
    .la-np .la-art { width: 72px; height: 72px; border-radius: 8px; object-fit: cover; flex: none; background: var(--la-hi); box-shadow: 0 6px 16px #0007; }
    .la-np-t { flex: 1; min-width: 0; display: grid; gap: 3px; }
    .la-np-t b { font-size: 15px; }
    .la-bar { height: 4px; background: #ffffff26; border-radius: 2px; margin-top: 8px; overflow: hidden; }
    .la-bar.la-seek { cursor: pointer; height: 6px; }
    .la-bar.la-seek:hover > i { background: var(--la-accent); }
    .la-bar > i { display: block; height: 100%; background: var(--la-text); width: 0; transition: width 1s linear; }
    .la-times { display: flex; justify-content: space-between; font-size: 11px; color: var(--la-sub); margin-top: 4px; font-variant-numeric: tabular-nums; }
    .la-ctrls { display: flex; justify-content: center; align-items: center; gap: 18px; margin-top: 12px; }
    .la-ctrls .la-play { width: 40px; height: 40px; border-radius: 50% !important; background: var(--la-text) !important; color: var(--la-bg) !important; display: grid !important; place-items: center; }
    .la-ctrls .la-play:hover { transform: scale(1.06); }
    .la-ctrls .la-play svg { width: 18px; height: 18px; fill: currentColor; }
    .la-next { display: flex; align-items: center; gap: 10px; margin-top: 12px; padding-top: 12px; border-top: 1px solid #ffffff14; font-size: 12px; }
    .la-next img { width: 28px; height: 28px; border-radius: 4px; object-fit: cover; }
    .la-tag { font-size: 10px; font-weight: 800; letter-spacing: .08em; color: var(--la-sub); flex: none; }
    /* members */
    .la-stack { display: flex; align-items: center; }
    .la-stack .la-av { margin-right: -8px; border: 2px solid var(--la-bg); }
    .la-av { width: 30px; height: 30px; border-radius: 50%; flex: none; object-fit: cover; display: inline-grid; place-items: center; font-size: 11px; font-weight: 800; color: #fff; }
    .la-av.xs { width: 20px; height: 20px; font-size: 8px; }
    .la-members-btn { display: flex !important; align-items: center; gap: 14px; width: 100%; padding: 6px !important; border-radius: 8px !important; text-align: left; }
    .la-members-btn:hover { background: var(--la-hi) !important; }
    .la-list { list-style: none; margin: 6px 0 0; padding: 0; display: grid; gap: 2px; }
    .la-list li { display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: 6px; font-size: 13px; }
    .la-list li:hover { background: var(--la-hi); }
    .la-badge { font-size: 9px; font-weight: 800; letter-spacing: .08em; background: var(--la-accent); color: var(--la-on-accent); padding: 2px 6px; border-radius: 4px; }
    .la-chip { font-size: 11px; color: var(--la-sub); }
    /* tabs + queue */
    .la-tabs { display: flex; gap: 8px; margin-bottom: 10px; }
    .la-tab { padding: 6px 14px !important; border-radius: 999px !important; background: var(--la-hi) !important; font-size: 13px !important; font-weight: 600 !important; }
    .la-tab.on { background: var(--la-text) !important; color: var(--la-bg) !important; }
    .la-add { position: relative; margin-bottom: 8px; }
    .la-add svg { position: absolute; left: 10px; top: 50%; transform: translateY(-50%); width: 14px; height: 14px; fill: var(--la-sub); }
    .la-add input[type=text] { padding-left: 32px !important; }
    .la-q li { display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: 6px; }
    .la-q li:hover { background: var(--la-hi); }
    .la-q li.la-drag { opacity: .4; }
    .la-q li[draggable=true] { cursor: grab; }
    .la-q .la-n { width: 16px; text-align: center; font-size: 12px; color: var(--la-sub); flex: none; font-variant-numeric: tabular-nums; }
    .la-q .la-qa { width: 40px; height: 40px; border-radius: 4px; object-fit: cover; flex: none; background: var(--la-hi); }
    .la-q .la-qt { flex: 1; min-width: 0; display: grid; font-size: 13px; }
    .la-q .la-qt span { font-size: 12px; color: var(--la-sub); }
    .la-q .la-acts { display: flex; opacity: 0; transition: opacity .12s; }
    .la-q li:hover .la-acts, .la-q li:focus-within .la-acts { opacity: 1; }
    .la-q .la-acts .la-ico { width: 28px; height: 28px; }
    .la-empty { text-align: center; color: var(--la-sub); font-size: 12px; padding: 14px 8px; line-height: 1.5; }
    .la-pending { font-size: 12px; color: var(--la-sub); }
    /* settings */
    .la-set summary { cursor: pointer; list-style: none; }
    .la-set summary::-webkit-details-marker { display: none; }
    .la-switch { display: flex; justify-content: space-between; align-items: center; gap: 10px; font-size: 13px; padding: 8px 0; }
    .la-switch input { appearance: none; width: 36px; height: 20px; border-radius: 999px; background: #535353; position: relative; cursor: pointer; flex: none; transition: background .15s; margin: 0; }
    .la-switch input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: left .15s; }
    .la-switch input:checked { background: var(--la-accent); }
    .la-switch input:checked::after { left: 18px; }
    .la-status { font-size: 12px; color: var(--la-sub); min-height: 16px; }
    /* mini player */
    #la-mini { position: fixed; right: 16px; bottom: 104px; z-index: 1000; display: flex; align-items: center; gap: 10px; padding: 8px 14px 8px 8px;
      background: var(--la-card); border: 1px solid #ffffff14; border-radius: 999px; box-shadow: 0 8px 24px #000a; cursor: pointer; max-width: 320px; }
    #la-mini[hidden] { display: none; }
    #la-mini img, #la-mini .la-ph { width: 36px; height: 36px; border-radius: 50%; object-fit: cover; flex: none; background: var(--la-hi); }
    #la-mini .la-mt { min-width: 0; display: grid; font-size: 12px; }
  `;

  // Small inline icons (fill: currentColor).
  const SVG = {
    logo: '<path d="M8 1a5 5 0 0 0-5 5v3H2v5h3V9H4V6a4 4 0 0 1 8 0v3h-1v5h3V9h-1V6a5 5 0 0 0-5-5z"/>',
    close: '<path d="M2.5 2.5l11 11m0-11l-11 11" stroke="currentColor" stroke-width="1.6" fill="none"/>',
    min: '<path d="M3 8h10" stroke="currentColor" stroke-width="1.8"/>',
    copy: '<path d="M5 1h8a2 2 0 0 1 2 2v8h-2V3H5zM1 5a2 2 0 0 1 2-2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2z"/>',
    qr: '<path d="M1 1h6v6H1zm2 2v2h2V3zm6-2h6v6H9zm2 2v2h2V3zM1 9h6v6H1zm2 2v2h2v-2zm6-2h2v2H9zm4 0h2v2h-2zm-2 2h2v2h-2zm-2 2h2v2H9zm4 0h2v2h-2z"/>',
    play: '<path d="M4 2.5v11l10-5.5z"/>',
    pause: '<path d="M3.5 2h3v12h-3zm6 0h3v12h-3z"/>',
    prev: '<path d="M3 2h2v12H3zm2 6l9-6v12z"/>',
    next: '<path d="M11 2h2v12h-2zm0 6L2 2v12z"/>',
    up: '<path d="M8 3l5 6h-3v4H6V9H3z"/>',
    trash: '<path d="M5 1h6v2h4v2H1V3h4zM2 6h12l-1 9H3z"/>',
    search: '<path d="M7 1a6 6 0 1 1 0 12A6 6 0 0 1 7 1zm0 2a4 4 0 1 0 0 8 4 4 0 0 0 0-8zm4.3 8.9l1.4-1.4 3.3 3.3-1.4 1.4z"/>',
    kick: '<path d="M6 7a3 3 0 1 0 0-6 3 3 0 0 0 0 6zm-6 8c0-3.3 2.7-6 6-6s6 2.7 6 6zm10-9h6v2h-6z"/>',
  };
  const icon = (name) => {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 16 16");
    s.innerHTML = SVG[name]; // static, trusted markup
    return s;
  };

  const h = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids.filter((k) => k != null && k !== false));
    return e;
  };
  // Async-safe button: disabled while working, errors land in the status line.
  const btn = (content, fn, cls = "la-btn", title = "") => {
    const b = h("button", { type: "button", className: cls, title, ariaLabel: title || undefined });
    b.append(...(Array.isArray(content) ? content : [content]).map((c) => (typeof c === "string" && SVG[c] ? icon(c) : c)));
    b.onclick = async (e) => {
      e.stopPropagation();
      b.disabled = true;
      try { await fn(); } catch (err) { say(`Error: ${err.message}`); } finally { b.disabled = false; }
    };
    return b;
  };
  const iconBtn = (name, fn, title) => btn(name, fn, "la-ico", title);
  const COLORS = ["#e91e63", "#9c27b0", "#3f51b5", "#03a9f4", "#009688", "#8bc34a", "#ff9800", "#ff5722"];
  function av(name = "?", url = null, cls = "la-av") {
    if (url) {
      const img = h("img", { className: cls, src: url, alt: "", title: name });
      img.onerror = () => img.replaceWith(av(name, null, cls));
      return img;
    }
    const hash = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
    return h("span", { className: cls, textContent: name.trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase(), title: name, style: `background:${COLORS[hash % COLORS.length]}` });
  }
  const cover = (url, cls) => (url ? h("img", { className: cls, src: url, alt: "" }) : h("span", { className: cls }));
  const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const VIA = { web: "Web", youtube: "YouTube", spotify: "Spotify Web", spicetify: "Spotify" };

  // View state that survives re-renders.
  let panelEl = null;
  let miniEl = null;
  let panelOpen = false;
  let tab = "queue"; // "queue" | "next"
  let membersOpen = false;
  let inviteOpen = false;
  let dragKey = null;

  function ensurePanel() {
    if (panelEl?.isConnected) return panelEl;
    document.head.append(h("style", { textContent: css }));
    panelEl = h("div", { id: "la-panel", className: "la-hidden" });
    miniEl = h("div", { id: "la-mini", hidden: true, title: "Buka Listen Along" });
    miniEl.onclick = () => openPanel(true);
    document.body.append(panelEl, miniEl);
    return panelEl;
  }
  // open: show the panel. Closing while in a room leaves the mini player, like Jam's minimise.
  function openPanel(open = !panelOpen) {
    panelOpen = open;
    ensurePanel().classList.toggle("la-hidden", !open);
    renderMini();
    if (open) render();
  }

  function liveMembers() {
    const now = serverNow();
    const host = { uid: room.hostUid, name: room.host?.name ?? "Host", avatar: room.host?.avatar ?? null, isHost: true };
    const others = Object.entries(members).filter(([u, l]) => u !== room.hostUid && now - l.at < 45_000).map(([u, l]) => ({ uid: u, ...l }));
    return (room.hostUid ? [host] : []).concat(others).map((m) => ({ ...m, isMe: m.uid === uid }));
  }
  const currentTrack = () => (isHost() ? nowPlaying() : room.track);

  function renderStatus() {
    const el = panelEl?.querySelector(".la-status");
    if (el) el.textContent = status;
  }
  function renderProgress() {
    const t = currentTrack();
    const bar = panelEl?.querySelector(".la-bar > i");
    if (!bar || !t) return;
    const pos = isHost() ? t.progressMs : t.progressMs + (t.isPlaying ? serverNow() - t.at : 0);
    const sec = Math.min(pos / 1000, t.durationSec);
    bar.style.width = `${t.durationSec ? (sec / t.durationSec) * 100 : 0}%`;
    const times = panelEl.querySelector(".la-times");
    if (times) times.replaceChildren(h("span", { textContent: mmss(sec) }), h("span", { textContent: mmss(t.durationSec) }));
  }
  function renderMini() {
    if (!miniEl) return;
    const t = currentTrack();
    miniEl.hidden = panelOpen || !code;
    if (miniEl.hidden) return;
    miniEl.replaceChildren(
      t?.art ? h("img", { src: t.art, alt: "" }) : h("span", { className: "la-ph" }),
      h("div", { className: "la-mt" },
        h("b", { className: "la-ell", textContent: t ? t.title : `Room ${code}` }),
        h("span", { className: "la-sub la-ell", textContent: `${liveMembers().length} di room` })),
      h("span", { className: "la-live", textContent: "LIVE" }),
    );
  }

  function render() {
    renderMini();
    if (!panelOpen) return;
    // The panel is rebuilt on every data change: keep what the user is typing (and the caret) across it.
    const kept = {};
    for (const el of panelEl.querySelectorAll("input[data-keep]")) {
      kept[el.dataset.keep] = { value: el.value, focused: el === document.activeElement, at: el.selectionStart };
    }
    const scroll = panelEl.querySelector(".la-body")?.scrollTop ?? 0;
    const body = h("div", { className: "la-body" });
    panelEl.replaceChildren(
      h("div", { className: "la-head" },
        h("span", { className: "la-logo" }, icon("logo")),
        h("span", { className: "la-title" }, "Listen Along"),
        code ? h("span", { className: "la-live", textContent: "LIVE" }) : null,
        code ? iconBtn("min", () => openPanel(false), "Kecilkan ke mini player") : null,
        iconBtn("close", () => openPanel(false), "Tutup"),
      ),
      body,
    );
    if (!code) renderHero(body);
    else renderSession(body);
    for (const el of panelEl.querySelectorAll("input[data-keep]")) {
      const k = kept[el.dataset.keep];
      if (!k) continue;
      el.value = k.value;
      if (k.focused) { el.focus(); el.setSelectionRange(k.at, k.at); }
    }
    body.scrollTop = scroll;
    renderProgress();
  }

  function renderHero(body) {
    const codeIn = h("input", { type: "text", placeholder: "Kode room atau link" });
    codeIn.dataset.keep = "code";
    const nameIn = h("input", { type: "text", placeholder: "Nama tampilan (kosong = nama akun Spotify)", value: store.get("la:name") ?? "", maxLength: 40 });
    nameIn.oninput = () => store.set("la:name", nameIn.value.trim());
    const join = () => {
      const c = (codeIn.value.match(/room=([A-Za-z0-9]{6})/)?.[1] ?? codeIn.value.trim()).toUpperCase();
      if (!/^[A-Z0-9]{6}$/.test(c)) return say("Kode room harus 6 huruf/angka.");
      return startListen(c);
    };
    codeIn.onkeydown = (e) => e.key === "Enter" && join();
    body.append(
      h("div", { className: "la-hero" },
        h("div", { className: "la-big" }, icon("logo")),
        h("h2", { textContent: "Dengar bareng, tetap sinkron" }),
        h("span", { className: "la-sub", textContent: "Teman bisa ikut dari app Spotify, HP, web, atau YouTube, lengkap dengan lirik romaji." }),
        btn("Buat room", () => startHost()),
        h("div", { className: "la-or", textContent: "atau gabung" }),
        h("div", { className: "la-row", style: "width:100%" }, h("div", { className: "la-grow" }, codeIn), btn("Gabung", join, "la-btn sec")),
        h("div", { style: "width:100%" }, nameIn),
      ),
      h("div", { className: "la-status", textContent: status }),
    );
  }

  function renderSession(body) {
    const link = `${CFG.siteUrl ?? ""}?room=${code}`;
    const copy = async () => {
      await (Spicetify.Platform?.ClipboardAPI?.copy?.(link) ?? navigator.clipboard.writeText(link));
      notify("Link room disalin");
    };
    const t = currentTrack();
    const controls = isHost() || guestCtl();

    // Room card: code, copy, invite (QR), end/leave.
    const qr = inviteOpen ? h("div", { className: "la-qr" }, h("img", { alt: "QR untuk gabung room" }), h("span", { className: "la-sub la-ell", style: "max-width:100%;font-size:11px", textContent: link })) : null;
    if (qr && globalThis.LA_QR) globalThis.LA_QR(link).then((src) => (qr.querySelector("img").src = src), () => {});
    body.append(h("div", { className: "la-card" },
      h("div", { className: "la-row" },
        h("div", { className: "la-grow" }, h("div", { className: "la-sub", style: "font-size:11px", textContent: isHost() ? "Kode room Anda" : "Room" }), h("div", { className: "la-code", textContent: code })),
        iconBtn("copy", copy, "Salin link"),
        iconBtn("qr", () => { inviteOpen = !inviteOpen; render(); }, "Undang dengan QR"),
      ),
      qr,
      h("div", { className: "la-row", style: "margin-top:12px" },
        btn("Salin link undangan", copy, "la-btn sec la-grow"),
        btn(isHost() ? "Akhiri" : "Keluar", () => (isHost() ? endHost() : (stop(), say("Keluar dari room."), render())), "la-btn danger"),
      ),
    ));

    // Now playing.
    const nx = sortedQueue().find((it) => it.id !== t?.id) ?? upNext().find((it) => it.id !== t?.id);
    body.append(h("div", {}, h("div", { className: "la-h", textContent: "Sedang diputar" }), h("div", { className: "la-card" },
      t ? h("div", { className: "la-np" },
        cover(t.art, "la-art"),
        h("div", { className: "la-np-t" },
          h("b", { className: "la-ell", textContent: t.title }),
          h("span", { className: "la-sub la-ell", textContent: t.artist }),
          (() => {
            const bar = h("div", { className: `la-bar${controls ? " la-seek" : ""}`, title: controls ? "Klik untuk pindah posisi" : "" }, h("i"));
            if (controls) bar.onclick = (e) => {
              const r = bar.getBoundingClientRect();
              const pos = Math.round(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * t.durationSec * 1000);
              control("seek", { pos }).catch((err) => say(`Error: ${err.message}`));
            };
            return bar;
          })(),
          h("div", { className: "la-times" }),
        ),
      ) : h("div", { className: "la-empty", textContent: isHost() ? "Putar lagu di Spotify untuk memulai." : "Host belum memutar lagu." }),
      t && controls ? h("div", { className: "la-ctrls" },
        iconBtn("prev", () => control("prev"), "Sebelumnya"),
        btn(t.isPlaying ? "pause" : "play", () => control(t.isPlaying ? "pause" : "play"), "la-play", t.isPlaying ? "Jeda" : "Putar"),
        iconBtn("next", () => control("next"), "Berikutnya"),
      ) : null,
      t && nx ? h("div", { className: "la-next" }, h("span", { className: "la-tag", textContent: "BERIKUTNYA" }), cover(nx.art, ""), h("span", { className: "la-ell la-grow", textContent: `${nx.title} — ${nx.artist}` })) : null,
    )));

    // Members.
    const list = liveMembers();
    body.append(h("div", {},
      h("button", { type: "button", className: "la-members-btn", title: "Lihat siapa saja di room", onclick: () => { membersOpen = !membersOpen; render(); } },
        h("span", { className: "la-stack" }, ...list.slice(0, 5).map((m) => av(m.name, m.avatar))),
        h("span", { className: "la-grow" }, h("b", { textContent: `${list.length} di room` }), h("span", { className: "la-sub", textContent: membersOpen ? "  · sembunyikan" : "  · lihat" })),
      ),
      membersOpen ? h("ul", { className: "la-list" }, ...list.map((m) => h("li", {},
        av(m.name, m.avatar),
        h("span", { className: "la-grow la-ell", textContent: m.name + (m.isMe ? " (Anda)" : "") }),
        m.isHost ? h("span", { className: "la-badge", textContent: "HOST" }) : h("span", { className: "la-chip", textContent: VIA[m.via] ?? m.via }),
        isHost() && !m.isHost ? iconBtn("kick", async () => {
          if (!confirm(`Keluarkan ${m.name} dari room?`)) return;
          await db("", "PATCH", { [`kicked/${code}/${m.uid}`]: true, [`listeners/${code}/${m.uid}`]: null });
          await pullRoomData();
        }, `Keluarkan ${m.name}`) : null,
      ))) : null,
    ));

    // Queue / Up next tabs.
    const items = sortedQueue();
    const later = upNext().filter((it) => it.id !== t?.id).slice(0, 10);
    const tabBtn = (id, label) => h("button", { type: "button", className: `la-tab${tab === id ? " on" : ""}`, textContent: label, onclick: () => { tab = id; render(); } });
    const section = h("div", {}, h("div", { className: "la-tabs" }, tabBtn("queue", `Antrian room · ${items.length}`), tabBtn("next", "Up next")));
    if (tab === "queue") renderQueueTab(section, items, controls);
    else section.append(later.length
      ? h("ul", { className: "la-list la-q" }, ...later.map((it, i) => h("li", {},
          h("span", { className: "la-n", textContent: i + 1 }),
          cover(it.art, "la-qa"),
          h("div", { className: "la-qt" }, h("b", { className: "la-ell", textContent: it.title }), h("span", { className: "la-ell", textContent: it.artist })),
        )))
      : h("div", { className: "la-empty", textContent: "Spotify belum punya lagu berikutnya." }));
    body.append(section);

    if (isHost()) {
      const toggle = (label, keyName) => {
        const input = h("input", { type: "checkbox", checked: !!settings[keyName] });
        input.onchange = () => {
          settings = { ...settings, [keyName]: input.checked };
          store.set("la:settings", JSON.stringify(settings));
          publishNow();
        };
        return h("label", { className: "la-switch" }, h("span", { textContent: label }), input);
      };
      const set = h("details", { className: "la-set", open: !!store.get("la:set-open") },
        h("summary", { className: "la-h", textContent: "Pengaturan room ▾" }),
        toggle("Tamu boleh mengontrol pemutaran", "guestControl"),
        toggle("Lagu dari tamu perlu disetujui", "approval"),
      );
      set.ontoggle = () => (set.open ? store.set("la:set-open", "1") : store.remove("la:set-open"));
      body.append(set);
    }
    body.append(h("div", { className: "la-status", textContent: status }));
  }

  function renderQueueTab(section, items, controls) {
    const addIn = h("input", { type: "text", placeholder: "Cari lagu atau tempel link Spotify", maxLength: 200 });
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
      for (const el of [addIn, panelEl.querySelector('input[data-keep="add"]')]) if (el) el.value = "";
      notify(isHost() ? "Ditambahkan ke antrian room" : "Request dikirim ke host");
    };
    addIn.onkeydown = (e) => e.key === "Enter" && add().catch((err) => say(`Error: ${err.message}`));
    section.append(h("div", { className: "la-row la-add" }, icon("search"), h("div", { className: "la-grow" }, addIn), btn("Tambah", add)));

    const pend = Object.entries(requests).map(([key, r]) => ({ key, ...r })).sort((a, b) => a.at - b.at);
    if (pend.length) section.append(h("ul", { className: "la-list" }, ...pend.map((r) => h("li", { className: "la-pending" },
      av(r.name, null, "la-av xs"),
      h("span", { className: "la-grow la-ell", textContent: `${r.track ? `${r.track.title} — ${r.track.artist}` : r.text} · ${r.status === "notfound" ? "tidak ketemu" : r.track ? "menunggu persetujuan" : "mencari…"}` }),
      isHost() && r.track ? btn("Setujui", () => approve(r.key), "la-btn") : null,
      isHost() || r.by === uid ? iconBtn("trash", async () => { await db(`requests/${code}/${r.key}`, "DELETE"); await pullRoomData(); }, "Hapus") : null,
    ))));

    if (!items.length) {
      section.append(h("div", { className: "la-empty", textContent: "Antrian room kosong. Cari lagu di atas, atau klik kanan lagu mana pun di Spotify → Tambah ke antrian room." }));
      return;
    }
    const setOrder = async (key, toIndex) => {
      const rest = items.filter((x) => x.key !== key);
      const before = rest[toIndex - 1]?.order, after = rest[toIndex]?.order;
      const order = before == null ? (after ?? 0) - 1 : after == null ? before + 1 : (before + after) / 2;
      await db(`queues/${code}/${key}/order`, "PUT", order);
      await pullRoomData();
    };
    section.append(h("ul", { className: "la-list la-q" }, ...items.map((it, i) => {
      const li = h("li", { draggable: controls },
        h("span", { className: "la-n", textContent: i + 1 }),
        cover(it.art, "la-qa"),
        h("div", { className: "la-qt" }, h("b", { className: "la-ell", textContent: it.title }), h("span", { className: "la-ell", textContent: it.durationSec ? `${it.artist} · ${mmss(it.durationSec)}` : it.artist })),
        av(it.name, it.avatar, "la-av xs"),
        h("span", { className: "la-acts" },
          controls && i > 0 ? iconBtn("up", () => setOrder(it.key, i - 1), "Naikkan") : null,
          controls ? iconBtn("play", () => (isHost() ? playItem(it.key) : control("playItem", { key: it.key })), "Putar sekarang") : null,
          isHost() || guestCtl() || it.by === uid ? iconBtn("trash", async () => { await db(`queues/${code}/${it.key}`, "DELETE"); await pullRoomData(); }, "Hapus") : null,
        ),
      );
      if (controls) {
        li.ondragstart = (e) => { dragKey = it.key; e.dataTransfer.effectAllowed = "move"; li.classList.add("la-drag"); };
        li.ondragend = () => li.classList.remove("la-drag");
        li.ondragover = (e) => e.preventDefault();
        li.ondrop = (e) => { e.preventDefault(); if (dragKey && dragKey !== it.key) setOrder(dragKey, i).catch((err) => say(`Error: ${err.message}`)); dragKey = null; };
      }
      return li;
    })));
  }

  new Spicetify.Topbar.Button("Listen Along", `<svg viewBox="0 0 16 16" fill="currentColor">${SVG.logo}</svg>`, () => openPanel());

  // Resume after Spotify restarts.
  const savedMode = store.get("la:mode");
  const savedRoom = store.get("la:room");
  if (savedMode === "host" && savedRoom) guard(() => startHost(savedRoom))();
  if (savedMode === "listen" && savedRoom) startListen(savedRoom);

  // "Gabung lewat Spotify desktop" on the website opens spotify:search:listenalong-<CODE>. Extensions can't
  // register links of their own, but Spotify routes that to its search page, which we watch.
  // ponytail: Platform.History is Spotify's internal router, not a Spicetify API; may change in updates.
  const JOIN_ROUTE = /^\/search\/listenalong-([A-Za-z0-9]{6})(\/|$)/;
  async function onRoute(location) {
    const m = decodeURIComponent(location?.pathname ?? "").match(JOIN_ROUTE);
    if (!m) return;
    const c = m[1].toUpperCase();
    Spicetify.Platform.History.replace("/"); // leave the search page for that "query"
    if (isHost()) return notify(`Anda sedang host room ${code}. Akhiri dulu untuk gabung ke ${c}.`, true);
    if (code === c) return openPanel(true);
    if (code) stop();
    await startListen(c);
    notify(`Bergabung ke room ${c}`);
  }
  const router = Spicetify.Platform?.History;
  if (router?.listen) {
    router.listen((loc) => guard(() => onRoute(loc))());
    guard(() => onRoute(router.location))(); // Spotify may have been launched by the link itself
  }

  globalThis.ListenAlong = { // devtools / tests
    startHost, startListen, endHost, stop, follow, publish, control, openPanel, pullRoomData, advanceCheck, contextAdd, onRoute,
    get state() { return { mode, code, uid, status, serverOffset, room, members, queue, requests, settings }; },
  };
})();
