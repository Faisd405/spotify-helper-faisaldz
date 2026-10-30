import { login, logout, handleRedirect, isLoggedIn, getNowPlaying, getQueue, getMe, player, isRateLimited, resolveTrack } from "./spotify.js";
import { fetchLyrics } from "./lyrics.js";
import { romanize, detectLang, fixSokuon } from "./romanize.js";
import { avatar, renderNowPlaying, renderMembers, renderQueue, renderPending, renderUpcoming, renderQR } from "./panel.js";

const $ = (s) => document.querySelector(s);
let track = null; // what's on screen: { id, title, artist, album, art, durationSec, progressMs, isPlaying, fetchedAt }
let lyrics = [];
let lastId = null;
let activeIdx = -1;
let offsetMs = 300; // sync calibration, set from the settings form
let keepAlive = true; // host keeps polling while its tab is hidden (settings toggle)
let fb = null; // firebase.js module, loaded only once a room is used

// Room state (host and listener alike); the panel renders from these.
let room = null; // host only: { code, uid, publish, end, off: [] }
let code = null; // room code, host or listener
let myUid = null;
let roomInfo = { hostUid: null, host: null, settings: {} }; // listener: from the room; host: its own
let members = {}; // listeners/{code}
let queueItems = {}; // queues/{code}
let requests = {}; // requests/{code}
let upcoming = []; // Spotify's own "up next" (host fetches it; listeners get it in the room)
let hostProfile = { name: "Host", avatar: null };
let settingsState = { guestControl: false, approval: false, ...JSON.parse(localStorage.getItem("room_settings") ?? "{}") };

const settings = $("#settings form");
const saved = JSON.parse(localStorage.getItem("style") ?? "{}");
for (const el of settings.elements) {
  if (el.name in saved) el[el.type === "checkbox" ? "checked" : "value"] = saved[el.name];
}

function applyStyle() {
  const values = {};
  for (const el of settings.elements) {
    if (!el.name) continue;
    values[el.name] = el.type === "checkbox" ? el.checked : el.value;
    const css = el.type === "checkbox" ? (el.checked ? "block" : "none") : el.value + (el.dataset.unit ?? "");
    document.documentElement.style.setProperty(`--${el.name}`, css);
  }
  document.querySelector('meta[name="theme-color"]').content = values.bg;
  offsetMs = Number(values.offset) || 0;
  keepAlive = values["keep-alive"];
  localStorage.setItem("style", JSON.stringify(values));
}
settings.oninput = applyStyle;
settings.onreset = () => setTimeout(applyStyle); // reset fires before the inputs revert
applyStyle();

$("#ext-btn").onclick = () => {
  $("#ext-room").textContent = code ? ` (${code})` : "";
  $("#ext-dialog").showModal();
};
// Spicetify install: download the file into Spicetify's Extensions folder, enable it, re-apply.
const spiceUrl = new URL("spicetify-listen-along.js", location.href).href;
$("#spice-cmd").textContent =
  `iwr "${spiceUrl}" -OutFile "$env:APPDATA\\spicetify\\Extensions\\spicetify-listen-along.js"; spicetify config extensions spicetify-listen-along.js; spicetify apply`;
$("#spice-copy").onclick = async () => {
  await navigator.clipboard.writeText($("#spice-cmd").textContent);
  $("#spice-copy").textContent = "Tersalin";
};
$("#ext-copy").onclick = async () => {
  await navigator.clipboard.writeText("chrome://extensions");
  $("#ext-copy").textContent = "Tersalin";
};

// ---------- Panel shell: open/close, hero, session header ----------

const panel = $("#room-panel");
function setPanelOpen(open) {
  panel.classList.toggle("open", open);
  document.body.classList.toggle("panel-open", open);
  $("#mini").setAttribute("aria-expanded", String(open));
  localStorage.setItem("panel_open", open ? "1" : "0");
}
$("#mini").onclick = () => setPanelOpen(!panel.classList.contains("open"));
// Desktop: open sidebar by default. Phone: start as the mini player so lyrics get the screen.
setPanelOpen(localStorage.getItem("panel_open") ? localStorage.getItem("panel_open") === "1" : innerWidth >= 900);

const roomLink = () => `${location.origin}${location.pathname}?room=${code}`;
const parseCode = (v) => (v.match(/room=([A-Za-z0-9]{6})/)?.[1] ?? v.trim()).toUpperCase();
$("#hero-join").onsubmit = (e) => {
  e.preventDefault();
  const c = parseCode($("#hero-code").value);
  if (!/^[A-Z0-9]{6}$/.test(c)) return status("Kode room harus 6 huruf/angka.");
  location.href = `${location.pathname}?room=${c}`;
};
$("#copy-link").onclick = async () => {
  await navigator.clipboard.writeText(roomLink());
  $("#copy-link").textContent = "Tersalin ✓";
  setTimeout(() => ($("#copy-link").textContent = "Salin link"), 1500);
};
$("#invite-btn").onclick = () => {
  $("#invite").hidden = !$("#invite").hidden;
  $("#invite-link").textContent = roomLink();
  if (!$("#invite").hidden) renderQR($("#qr"), roomLink());
};
$("#share-link").onclick = () =>
  navigator.share ? navigator.share({ title: "Karaoke bareng", url: roomLink() }) : navigator.clipboard.writeText(roomLink());

function showSession(isHost) {
  $("#hero").hidden = true;
  $("#session").hidden = false;
  $("#room-code").textContent = code;
  $("#join-desktop").href = `spotify:search:listenalong-${code}`;
  $("#end-room").hidden = false;
  $("#end-room").textContent = isHost ? "Akhiri" : "Keluar";
  $("#host-settings").hidden = !isHost;
  $("#me-name").hidden = isHost;
  $("#set-guest").checked = settingsState.guestControl;
  $("#set-approval").checked = settingsState.approval;
  renderRoom();
}
function showHero(message) {
  $("#session").hidden = true;
  $("#hero").hidden = false;
  if (message) $("#hero p").textContent = message;
  renderMini();
}

// ---------- Rendering the room ----------

const sortedQueue = () =>
  Object.entries(queueItems).map(([key, v]) => ({ key, ...v })).sort((a, b) => a.order - b.order || a.at - b.at);
const isHost = () => !!room;
const guestControl = () => !!roomInfo.settings?.guestControl;
const onError = (e) => status(e.message);

function liveMembers() {
  const now = fb?.serverNow() ?? Date.now();
  const host = { uid: roomInfo.hostUid, name: roomInfo.host?.name ?? "Host", avatar: roomInfo.host?.avatar ?? null, isHost: true };
  const others = Object.entries(members)
    .filter(([uid, l]) => uid !== roomInfo.hostUid && now - l.at < 45_000) // 3 missed heartbeats = gone
    .map(([uid, l]) => ({ uid, ...l }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return [host, ...others].map((m) => ({ ...m, isMe: m.uid === myUid }));
}

let npKey = "";
function renderRoom() {
  if (!code) return renderMini();
  const controls = isHost() || guestControl();
  // The card holds its own progress bar (updated by the clock tick); rebuild it only when it changes.
  // Up next: the room queue plays first, then Spotify's own list.
  const next = sortedQueue().find((it) => it.id !== track?.id) ?? upcoming.find((it) => it.id !== track?.id) ?? null;
  const key = `${track?.id}|${track?.isPlaying}|${controls}|${next?.id}`;
  if (key !== npKey) {
    npKey = key;
    renderNowPlaying($("#np"), track, { controls, onControl: control, onError, next, onSeek: controls ? (pos) => control("seek", { pos }) : null });
  }
  const list = liveMembers();
  $("#member-count").textContent = `(${list.length})`;
  renderMembers($("#members"), list, { onKick: isHost() ? (uid) => fb.kick(code, uid) : null, onError });

  renderQueue($("#queue"), sortedQueue(), {
    perms: (it) => ({ play: controls, remove: isHost() || guestControl() || it.by === myUid, move: controls }),
    onPlay: (key) => (isHost() ? playItem(key) : fb.sendCommand(code, "playItem", { key })),
    onRemove: (key) => fb.removeQueueItem(code, key),
    onMove: moveItem,
    onError,
  });
  const reqs = Object.entries(requests).map(([key, r]) => ({ key, ...r })).sort((a, b) => a.at - b.at);
  renderPending($("#pending"), reqs.map((r) => ({
    key: r.key,
    title: r.track ? `${r.track.title} — ${r.track.artist}` : r.text,
    name: r.name,
    state: r.status === "notfound" ? "tidak ketemu" : r.track ? "menunggu persetujuan" : "mencari…",
    canApprove: isHost() && !!r.track,
    canCancel: r.by === myUid || (isHost() && !r.track),
  })), {
    onApprove: (key) => approveRequest(key),
    onReject: (key) => fb.removeRequest(code, key),
    onCancel: (key) => fb.removeRequest(code, key),
    onError,
  });
  renderUpcoming($("#upcoming"), upcoming);
  renderMini();
}

function renderMini() {
  const art = $("#mini-art");
  if (track?.art) art.replaceWith(Object.assign(document.createElement("img"), { id: "mini-art", className: "art", src: track.art, alt: "" }));
  else if (art.tagName === "IMG") art.replaceWith(Object.assign(document.createElement("span"), { id: "mini-art", className: "art art-empty", textContent: "♪" }));
  const list = code ? liveMembers() : [];
  $("#mini-title").textContent = track ? track.title : code ? `Room ${code}` : "Dengar bareng";
  $("#mini-sub").textContent = code ? `${track ? `${track.artist} · ` : ""}${list.length} di room` : "Buat atau gabung room";
  $("#mini-members").replaceChildren(...list.slice(0, 3).map((m) => avatar(m.name, m.avatar, "xs")));
}

// Fractional ordering: moving an item only rewrites that item's `order`.
async function moveItem(key, toIndex) {
  const rest = sortedQueue().filter((it) => it.key !== key);
  const before = rest[toIndex - 1]?.order;
  const after = rest[toIndex]?.order;
  const order = before == null ? (after ?? 0) - 1 : after == null ? before + 1 : (before + after) / 2;
  await fb.setQueueOrder(code, key, order);
}
const nextOrder = () => Math.max(0, ...Object.values(queueItems).map((q) => q.order)) + 1;

// Playback controls: the host acts directly; guests send a command the host's app carries out.
async function control(a, extra = {}) {
  if (!isHost()) return fb.sendCommand(code, a, extra);
  const q = sortedQueue();
  if (a === "play") await player.play();
  else if (a === "pause") await player.pause();
  else if (a === "next") await (q[0] ? playItem(q[0].key) : player.next());
  else if (a === "prev") await player.prev();
  else if (a === "seek" && typeof extra.pos === "number") await player.seek(extra.pos);
  else if (a === "playItem" && extra.key) await playItem(extra.key);
  setTimeout(poll, 400); // show the result right away
}

let justPlayed = null; // track id playItem started (and removed), so poll() doesn't remove a second copy
let polledId = null; // track id seen by the previous poll

async function playItem(key) {
  const it = queueItems[key];
  if (!it) return;
  justPlayed = it.id;
  await player.playTrack(it.id);
  await fb.removeQueueItem(code, key);
  setTimeout(poll, 400);
}

$("#add-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#add-text").value.trim();
  if (!text || !code) return;
  const btn = $("#add-form button");
  btn.disabled = true;
  btn.textContent = "…";
  try {
    if (isHost()) {
      // The host can look songs up itself: straight into the queue.
      const t = await resolveTrack(text);
      if (!t) throw new Error(`"${text}" tidak ketemu di Spotify.`);
      await fb.addQueueItem(code, t, { uid: room.uid, name: hostProfile.name, avatar: hostProfile.avatar }, nextOrder());
    } else {
      await fb.requestSong(code, $("#listener-name").value.trim() || "Pendengar", text);
    }
    $("#add-text").value = "";
  } catch (err) {
    status(err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Tambah";
  }
};

// ---------- Host ----------

const roomParam = new URLSearchParams(location.search).get("room")?.toUpperCase();
if (roomParam) {
  listen(roomParam);
} else {
  await host();
}
requestAnimationFrame(tick);

async function host() {
  try {
    await handleRedirect();
  } catch (err) {
    status(`Login gagal: ${err.message}`);
  }
  if (!isLoggedIn()) {
    $("#login").hidden = false;
    $("#login").onclick = login;
    $("#hero-login").hidden = false;
    $("#hero-login").onclick = login;
    return showHero();
  }
  $("#logout").hidden = false;
  $("#logout").onclick = () => { logout(); location.reload(); };
  $("#hero-create").hidden = false;
  $("#hero-create").onclick = () => startRoom();
  $("#end-room").onclick = () => endRoom();
  for (const [id, keyName] of [["#set-guest", "guestControl"], ["#set-approval", "approval"]]) {
    $(id).onchange = () => {
      settingsState = { ...settingsState, [keyName]: $(id).checked };
      localStorage.setItem("room_settings", JSON.stringify(settingsState));
      roomInfo.settings = settingsState;
      renderRoom();
      poll(); // publish the new settings now
    };
  }
  getMe().then((p) => (hostProfile = p), () => {});
  const savedCode = localStorage.getItem("host_room");
  if (savedCode) startRoom(savedCode); // resume after reload; same anonymous uid still owns it
  else showHero();

  poll();
  // Chrome throttles a hidden tab's own timers to about once a minute, but not a worker's, so the
  // 3 s heartbeat lives in a tiny worker. (Phones freeze background tabs entirely; nothing to do there.)
  const ticker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 1000)"], { type: "text/javascript" })));
  // With a room open, poll every second so pauses/seeks reach listeners sooner; otherwise every 3 s.
  let ticks = 0;
  ticker.onmessage = () => (room || ++ticks % 3 === 0) && poll();
  document.addEventListener("visibilitychange", poll); // resync right away when reopened
}

async function startRoom(wanted) {
  fb ??= await import("./firebase.js");
  for (let attempt = 0; attempt < 5; attempt++) {
    const tryCode = wanted ?? randomCode();
    try {
      room = { code: tryCode, off: [], ...(await fb.hostRoom(tryCode)) };
      break;
    } catch (err) {
      console.warn(err);
      if (wanted) { wanted = undefined; localStorage.removeItem("host_room"); } // saved room lost, make a new one
    }
  }
  if (!room) return status("Gagal membuat room. Cek konfigurasi Firebase.");
  code = room.code;
  myUid = room.uid;
  localStorage.setItem("host_room", code);
  roomInfo = { hostUid: room.uid, host: hostProfile, settings: settingsState };
  room.off.push(
    fb.watchListeners(code, (l) => { members = l; renderRoom(); }),
    fb.watchQueue(code, (q) => { queueItems = q; renderRoom(); }),
    fb.watchRequests(code, (r) => { requests = r; hostRequests(r); renderRoom(); }),
    fb.watchCommands(code, onCommand),
  );
  if (lastId && lyrics.length) fb.saveSharedLyrics(lastId, lyrics).catch(() => {}); // song already on screen
  showSession(true);
  poll();
}

async function endRoom() {
  room.off.forEach((off) => off());
  await room.end();
  room = null;
  code = null;
  members = queueItems = requests = {};
  localStorage.removeItem("host_room");
  showHero();
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (v) => chars[v % chars.length]).join("");
}

// Guest commands (only honoured while guest control is on; the rules also refuse them otherwise).
const lastCommand = new Map(); // uid -> time, max one command per guest per 0.5 s
function onCommand(c) {
  if (!settingsState.guestControl || !c?.by) return;
  if (Date.now() - (lastCommand.get(c.by) ?? 0) < 500) return;
  lastCommand.set(c.by, Date.now());
  control(c.a, c).catch(onError);
}

// Listener requests are free text or links: look them up with the host's Spotify login, once each.
// Approval off: straight into the room queue. Approval on: wait for the host's "Setujui".
const resolving = new Set();
function hostRequests(reqs) {
  for (const [key, r] of Object.entries(reqs)) {
    if (r.track || r.status || resolving.has(key)) continue;
    resolving.add(key);
    resolveTrack(r.text)
      .then(async (t) => {
        if (!t) return fb.updateRequest(code, key, { status: "notfound" });
        if (settingsState.approval) return fb.updateRequest(code, key, { track: t });
        await fb.addQueueItem(code, t, { uid: r.by, name: r.name }, nextOrder());
        await fb.removeRequest(code, key);
      })
      .catch(onError)
      .finally(() => resolving.delete(key));
  }
}
async function approveRequest(key) {
  const r = requests[key];
  if (!r?.track) return;
  await fb.addQueueItem(code, r.track, { uid: r.by, name: r.name }, nextOrder());
  await fb.removeRequest(code, key);
}

let upcomingFor = null; // track id `upcoming` was fetched for
let upcomingAt = 0;
let endTimer;
let advanceTimer;
let advancedFrom = null; // track id we already scheduled a queue advance for

function refreshUpcoming() {
  upcomingAt = Date.now();
  getQueue().then((q) => { upcoming = q; renderRoom(); }, () => {});
}

async function poll() {
  if (isRateLimited()) return; // backing off after a 429
  if (document.hidden && !(room && keepAlive)) return; // nobody is watching: save API calls
  try {
    const t = await getNowPlaying();
    // Poll again right when this song should end, instead of up to 3 s later on the next tick.
    clearTimeout(endTimer);
    const left = t?.isPlaying ? t.durationSec * 1000 - t.progressMs : Infinity;
    if (left < 3500) endTimer = setTimeout(poll, Math.max(left, 0) + 300);
    if (room && t) {
      if (t.id !== upcomingFor || Date.now() - upcomingAt > 20_000) {
        upcomingFor = t.id;
        refreshUpcoming();
      }
      // Drop Spotify's stale answer that still lists the song now playing first.
      if (upcoming[0]?.id === t.id) upcoming = upcoming.slice(1);
      const q = sortedQueue();
      // A queued song the host started outside the room queue (e.g. in Spotify itself) is done. Only on a
      // song change, only one copy (others may have requested the same song), and not the one playItem
      // just played and removed itself.
      if (t.id !== polledId) {
        if (t.id !== justPlayed) {
          const dup = q.find((it) => it.id === t.id);
          if (dup) fb.removeQueueItem(code, dup.key).catch(() => {});
        }
        justPlayed = null;
      }
      polledId = t.id;
      const roomNext = q.find((it) => it.id !== t.id);
      // The room queue plays before Spotify's own "up next": start it right as this song ends.
      if (roomNext && left < 3500 && advancedFrom !== t.id) {
        advancedFrom = t.id;
        clearTimeout(advanceTimer);
        advanceTimer = setTimeout(() => playItem(roomNext.key).catch(onError), Math.max(left - 250, 0));
      }
      t.next = roomNext ?? upcoming[0] ?? null;
      t.upcoming = upcoming;
      prefetchLyrics(t.next);
    }
    if (room) room.publish(t, { host: hostProfile, settings: settingsState }).catch(console.error);
    showTrack(t);
    renderRoom();
  } catch (err) {
    console.error(err);
    status(err.message);
    if (!isLoggedIn()) location.reload();
  }
}

// ---------- Listener: follow a host's room through the Spotify Embed ----------

function predict(t) {
  if (!t?.next || !t.isPlaying) return t;
  const endAt = t.fetchedAt + t.durationSec * 1000 - t.progressMs;
  return Date.now() < endAt ? t : { ...t.next, progressMs: 0, isPlaying: true, fetchedAt: endAt, next: null };
}

async function listen(roomCode) {
  code = roomCode;
  status(`Room ${code}: menghubungkan…`);
  $("#hero").hidden = true;
  let embed;
  [fb, embed] = await Promise.all([import("./firebase.js"), import("./embed.js")]);
  $("#player").hidden = false;
  const ready = embed.createPlayer($("#embed"), status);

  const nameInput = $("#listener-name");
  nameInput.value = localStorage.getItem("listener_name") ?? "";
  nameInput.oninput = () => localStorage.setItem("listener_name", nameInput.value.trim());
  const getName = () => nameInput.value.trim() || "Pendengar";
  $("#end-room").onclick = () => (location.href = location.pathname);

  let kicked = false;
  // Follows the host, switching to the next song by itself the moment the current one should end
  // (the host's own update arrives a few seconds later and corrects it if the host did something else).
  let hostTrack = null;
  const follow = () => {
    const t = predict(hostTrack);
    if (t?.id !== track?.id) { showTrack(t); renderRoom(); }
    else track = t;
    embed.sync(t);
  };
  try {
    myUid = await fb.joinRoom(code, getName, {
      onRoom: (r) => {
        if (kicked) return;
        roomInfo = { hostUid: r.hostUid ?? null, host: r.host ?? null, settings: r.settings ?? {} };
        hostTrack = r.track;
        upcoming = r.track?.upcoming ?? [];
        prefetchLyrics(r.track?.next);
        follow();
        renderRoom();
        if (!r.track) status(r.hostUid ? `Room ${code}: host belum memutar lagu.` : `Room ${code} tidak ada atau sudah diakhiri.`);
      },
      onKicked: () => {
        kicked = true;
        embed.sync(null); // pause
        showTrack(null);
        $("#join").hidden = true;
        code = null;
        showHero("Anda dikeluarkan dari room oleh host.");
        status("Anda dikeluarkan dari room oleh host.");
      },
    });
  } catch (err) {
    return status(`Gagal masuk room: ${err.message}`);
  }
  showSession(false);
  setInterval(() => !kicked && follow(), 500);
  fb.watchListeners(code, (l) => { members = l; renderRoom(); });
  fb.watchQueue(code, (q) => { queueItems = q; renderRoom(); });
  fb.watchRequests(code, (r) => { requests = r; renderRoom(); });
  setInterval(() => code && renderRoom(), 10_000); // drop members whose heartbeats stopped

  await ready;
  if (kicked) return;
  $("#join").hidden = false;
  $("#join").onclick = () => {
    embed.start(track);
    $("#join").hidden = true;
  };
}

// ---------- Shared: lyrics for whatever track is current ----------

async function showTrack(t) {
  track = t;
  if (!t) return status("Tidak ada lagu yang diputar.");
  $("#title").textContent = `${t.title} — ${t.artist}`;
  if (t.id === lastId) return;

  const id = (lastId = t.id);
  lyrics = [];
  render();
  try {
    const { lines, noRomaji } = await getLyrics(t, (msg) => id === lastId && status(msg));
    if (id !== lastId) return; // song changed while loading
    if (!lines.length) return status("Lirik tersinkron tidak ditemukan di LRCLIB.");
    lyrics = lines;
    status(noRomaji ? "Romaji gagal dimuat, menampilkan lirik asli. Coba putar ulang lagunya nanti." : "");
    render();
  } catch (err) {
    console.error(err);
    status(err.message);
  }
}

// One load per song even if showTrack and a prefetch ask at the same time.
const inflight = new Map();
function getLyrics(t, say = () => {}) {
  if (!inflight.has(t.id)) inflight.set(t.id, loadLyrics(t, say).finally(() => inflight.delete(t.id)));
  return inflight.get(t.id);
}

// Prepare the next song's lyrics + romaji in the background so the switch is instant.
const prefetched = new Set();
function prefetchLyrics(t) {
  if (!t || prefetched.has(t.id) || localStorage.getItem(`lyrics:${t.id}`)) return;
  prefetched.add(t.id);
  getLyrics(t).catch(() => {});
}

// 1) this device  2) shared Firebase cache  3) LRCLIB + romanize here. Returns { lines, noRomaji }.
async function loadLyrics(t, say) {
  let lines = JSON.parse(localStorage.getItem(`lyrics:${t.id}`));
  if (!lines && fb) {
    say("Mengambil lirik…");
    // Listeners wait a bit: the host is likely romanizing this song right now.
    lines = await fb.getSharedLyrics(t.id, room ? 0 : 8000);
    if (lines) cacheLyrics(t.id, lines);
  }
  // Caches are write-once and may predate the small-tsu fix: apply it on read too.
  if (lines) for (const l of lines) l.roman = fixSokuon(l.roman ?? "", l.text);
  let noRomaji = false;
  if (!lines) {
    say("Mencari lirik…");
    lines = (await fetchLyrics(t)) ?? [];
    if (!lines.length) return { lines, noRomaji };
    const lang = detectLang(lines.map((l) => l.text).join("\n"));
    if (lang === "ja") say("Memuat kamus Jepang (pertama kali agak lama)…");
    try {
      for (const line of lines) line.roman = await romanize(line.text, lang);
    } catch (err) {
      // Show the original text now, but don't cache it: lyrics without romaji would stick
      // (the shared cache is write-once), and a later play should retry.
      console.error(err);
      for (const line of lines) line.roman = "";
      noRomaji = true;
    }
    if (!noRomaji) cacheLyrics(t.id, lines);
  }
  // Host shares every song it loads; write-once rules reject songs already cached.
  if (room && !noRomaji) fb.saveSharedLyrics(t.id, lines).catch(() => {});
  return { lines, noRomaji };
}

// ~5-10 KB per song, so localStorage (~5 MB) holds hundreds. When full, drop all cached lyrics and retry.
// ponytail: wipe-all eviction, switch to IndexedDB + LRU if the cache filling up becomes common.
function cacheLyrics(id, lines) {
  const save = () => localStorage.setItem(`lyrics:${id}`, JSON.stringify(lines));
  try {
    save();
  } catch {
    Object.keys(localStorage).filter((k) => k.startsWith("lyrics:")).forEach((k) => localStorage.removeItem(k));
    try { save(); } catch {}
  }
}

function render() {
  activeIdx = -1;
  $("#lyrics").replaceChildren(
    ...lyrics.map((l) => {
      const li = document.createElement("li");
      const roman = document.createElement("p");
      roman.className = "roman";
      roman.textContent = l.roman || l.text || "♪";
      const orig = document.createElement("p");
      orig.className = "orig";
      orig.textContent = l.roman ? l.text : "";
      li.append(roman, orig);
      return li;
    }),
  );
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;
let shown = ""; // "trackId:second" last drawn, so the clock only touches the DOM once a second

function tick() {
  $("#clock").hidden = !track;
  if (track) {
    // Song time as heard (no lyric offset), clamped so a late poll never shows 4:23 / 4:21.
    const sec = Math.min((track.progressMs + (track.isPlaying ? Date.now() - track.fetchedAt : 0)) / 1000, track.durationSec);
    if (`${track.id}:${Math.floor(sec)}` !== shown) {
      shown = `${track.id}:${Math.floor(sec)}`;
      $("#elapsed").textContent = mmss(sec);
      $("#length").textContent = mmss(track.durationSec);
      $("#progress").value = track.durationSec ? sec / track.durationSec : 0;
      // Same clock on the room panel's now playing card, when it's showing.
      const npBar = document.getElementById("np-bar");
      if (npBar) {
        document.getElementById("np-elapsed").textContent = mmss(sec);
        npBar.value = track.durationSec ? sec / track.durationSec : 0;
      }
    }
  }
  if (track && lyrics.length) {
    const elapsed = track.isPlaying ? Date.now() - track.fetchedAt : 0;
    const pos = track.progressMs + elapsed + offsetMs;
    const idx = lyrics.findLastIndex((l) => l.timeMs <= pos);
    if (idx !== activeIdx) {
      const items = $("#lyrics").children;
      items[activeIdx]?.classList.remove("active");
      items[idx]?.classList.add("active");
      items[idx]?.scrollIntoView({ behavior: "smooth", block: "center" });
      activeIdx = idx;
    }
  }
  requestAnimationFrame(tick);
}

function status(msg) {
  $("#status").textContent = msg;
}
