import { login, logout, handleRedirect, isLoggedIn, getNowPlaying, getNextTrack, isRateLimited, resolveTrack, addToQueue } from "./spotify.js";
import { fetchLyrics } from "./lyrics.js";
import { romanize, detectLang } from "./romanize.js";

const $ = (s) => document.querySelector(s);
let track = null; // { id, title, artist, album, durationSec, progressMs, isPlaying, fetchedAt }
let lyrics = [];
let lastId = null;
let activeIdx = -1;
let offsetMs = 300; // sync calibration, set from the settings form
let fb = null; // firebase.js module, loaded only once a room is used
let room = null; // host only: { code, publish, end }
let keepAlive = true; // host keeps polling while its tab is hidden (settings toggle)
let requests = {}; // requests/{code}: { id: { by, name, text, at, track?, status? } }
let listenerData = {}; // host only: listeners/{code}

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
  const code = new URLSearchParams(location.search).get("room")?.toUpperCase() ?? room?.code;
  $("#ext-room").textContent = code ? ` (${code})` : "";
  $("#ext-dialog").showModal();
};
$("#ext-copy").onclick = async () => {
  await navigator.clipboard.writeText("chrome://extensions");
  $("#ext-copy").textContent = "Tersalin";
};

const roomParam = new URLSearchParams(location.search).get("room")?.toUpperCase();
if (roomParam) {
  listen(roomParam);
} else {
  await host();
}
requestAnimationFrame(tick);

// ---------- Host: Spotify login, optional room ----------

async function host() {
  try {
    await handleRedirect();
  } catch (err) {
    status(`Login gagal: ${err.message}`);
  }
  if (!isLoggedIn()) {
    $("#login").hidden = false;
    $("#login").onclick = login;
    return;
  }
  $("#logout").hidden = false;
  $("#logout").onclick = () => { logout(); location.reload(); };
  $("#room").hidden = false;
  $("#room").onclick = () => (room ? endRoom() : startRoom());
  const savedCode = localStorage.getItem("host_room");
  if (savedCode) startRoom(savedCode); // resume after reload; same anonymous uid still owns it

  poll();
  // Chrome throttles a hidden tab's own timers to about once a minute, but not a worker's, so the
  // 3 s heartbeat lives in a tiny worker. (Phones freeze background tabs entirely; nothing to do there.)
  const ticker = new Worker(URL.createObjectURL(new Blob(["setInterval(() => postMessage(0), 3000)"], { type: "text/javascript" })));
  ticker.onmessage = poll;
  document.addEventListener("visibilitychange", poll); // resync right away when reopened
}

async function startRoom(code) {
  fb ??= await import("./firebase.js");
  for (let attempt = 0; attempt < 5; attempt++) {
    const tryCode = code ?? randomCode();
    try {
      room = { code: tryCode, ...(await fb.hostRoom(tryCode)) };
      break;
    } catch (err) {
      console.warn(err);
      if (code) { code = undefined; localStorage.removeItem("host_room"); } // saved room lost, make a new one
    }
  }
  if (!room) return status("Gagal membuat room. Cek konfigurasi Firebase.");
  localStorage.setItem("host_room", room.code);
  code = room.code; // the claimed code (may differ from a saved one that was lost)
  $("#host-panel").hidden = false;
  room.offListeners = fb.watchListeners(code, (l) => renderListeners(code, (listenerData = l)));
  room.offRequests = fb.watchRequests(code, (r) => hostRequests(code, (requests = r)));
  if (lastId && lyrics.length) fb.saveSharedLyrics(lastId, lyrics).catch(() => {}); // song already on screen
  const link = `${location.origin}${location.pathname}?room=${room.code}`;
  $("#room").textContent = "Akhiri Room";
  $("#room-info").hidden = false;
  $("#room-code").textContent = room.code;
  $("#room-share").onclick = () =>
    navigator.share ? navigator.share({ title: "Karaoke bareng", url: link }) : navigator.clipboard.writeText(link);
  poll();
}

async function endRoom() {
  room.offListeners();
  room.offRequests();
  await room.end();
  room = null;
  $("#host-panel").hidden = true;
  localStorage.removeItem("host_room");
  $("#room").textContent = "Buat Room";
  $("#room-info").hidden = true;
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (v) => chars[v % chars.length]).join("");
}

// ---------- Room panels (host + listener) ----------

// Names and request text come from other people: only ever set them via textContent.
function item(main, sub, ...buttons) {
  const li = document.createElement("li");
  const span = document.createElement("span");
  span.textContent = main;
  if (sub) span.append(Object.assign(document.createElement("small"), { textContent: ` · ${sub}` }));
  li.append(span, ...buttons);
  return li;
}
function button(label, onclick, secondary = false) {
  return Object.assign(document.createElement("button"), { type: "button", textContent: label, onclick, className: secondary ? "secondary" : "" });
}
const empty = (text) => item(text);
const VIA = { web: "Web", youtube: "YouTube", spotify: "Spotify Web" };
const requestTitle = (r) => (r.track ? `${r.track.title} — ${r.track.artist}` : r.text);
const requestState = (r) => (r.status === "queued" ? "di queue" : r.status === "notfound" ? "tidak ketemu" : r.track ? "menunggu host" : "mencari…");
const sortedRequests = (reqs) => Object.entries(reqs).sort(([, a], [, b]) => a.at - b.at);

let liveListeners = 0;
const updateHostSummary = () =>
  ($("#host-summary").textContent = `Room · ${liveListeners} pendengar · ${Object.keys(requests).length} request`);

function renderListeners(code, data) {
  // No heartbeat for 45 s (3 missed) = gone, e.g. a closed extension tab that never said goodbye.
  const live = Object.entries(data).filter(([, l]) => fb.serverNow() - l.at < 45_000);
  liveListeners = live.length;
  $("#listener-list").replaceChildren(
    ...(live.length
      ? live.map(([uid, l]) =>
          item(l.name, VIA[l.via] ?? l.via, button("Kick", () => confirm(`Keluarkan ${l.name} dari room?`) && fb.kick(code, uid).catch((e) => status(e.message)), true)))
      : [empty("Belum ada pendengar")]),
  );
  updateHostSummary();
}
setInterval(() => room && renderListeners(room.code, listenerData), 10_000); // drop stale entries

const resolving = new Set();
function hostRequests(code, reqs) {
  // New requests are free text or links: look them up with the host's Spotify login, once each.
  for (const [id, r] of Object.entries(reqs)) {
    if (r.track || r.status || resolving.has(id)) continue;
    resolving.add(id);
    resolveTrack(r.text)
      .then((t) => fb.updateRequest(code, id, t ? { track: t } : { status: "notfound" }))
      .catch((e) => status(e.message))
      .finally(() => resolving.delete(id));
  }
  const entries = sortedRequests(reqs);
  $("#host-requests").replaceChildren(
    ...(entries.length
      ? entries.map(([id, r]) => {
          const remove = () => fb.removeRequest(code, id).catch((e) => status(e.message));
          const queue = () =>
            addToQueue(r.track.id)
              .then(() => fb.updateRequest(code, id, { status: "queued" }))
              .then(() => (nextAt = 0)) // re-read the queue on the next poll: this may now be next
              .catch((e) => status(e.message));
          const buttons = r.track && r.status !== "queued" ? [button("+ Queue", queue), button("Tolak", remove, true)] : [button("Hapus", remove, true)];
          return item(requestTitle(r), `${r.name} · ${requestState(r)}`, ...buttons);
        })
      : [empty("Belum ada request")]),
  );
  updateHostSummary();
}

function renderListenerRequests(code, reqs, myUid) {
  const entries = sortedRequests(reqs);
  $("#listener-summary").textContent = `Request lagu (${entries.length})`;
  $("#listener-requests").replaceChildren(
    ...entries.map(([id, r]) =>
      item(
        requestTitle(r),
        `${r.name} · ${requestState(r)}`,
        ...(r.by === myUid && r.status !== "queued" ? [button("Batal", () => fb.removeRequest(code, id).catch((e) => status(e.message)), true)] : []),
      ),
    ),
  );
}

let next = null; // host: first upcoming track in the Spotify queue
let nextFor = null; // track id `next` was fetched for
let nextAt = 0;
let endTimer;

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
      // The queue changes rarely (song change, a request was added): refresh it on change or every 20 s.
      if (t.id !== nextFor || Date.now() - nextAt > 20_000) {
        nextFor = t.id;
        nextAt = Date.now();
        getNextTrack().then((n) => { next = n; prefetchLyrics(n); }, () => {});
      }
      t.next = next?.id === t.id ? null : next; // stale answer from the previous song
    }
    if (room) {
      room.publish(t).catch(console.error);
      // A requested song that is now playing is done.
      for (const [id, r] of Object.entries(requests)) {
        if (t && r.track?.id === t.id) fb.removeRequest(room.code, id).catch(console.error);
      }
    }
    showTrack(t);
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

async function listen(code) {
  status(`Room ${code}: menghubungkan…`);
  let player;
  [fb, player] = await Promise.all([import("./firebase.js"), import("./embed.js")]);
  $("#player").hidden = false;
  $("#listener-panel").hidden = false;
  const ready = player.createPlayer($("#embed"), status);

  const nameInput = $("#listener-name");
  nameInput.value = localStorage.getItem("listener_name") ?? "";
  nameInput.oninput = () => localStorage.setItem("listener_name", nameInput.value.trim());
  const getName = () => nameInput.value.trim() || "Pendengar";

  let kicked = false;
  let myUid;
  // Follows the host, switching to the queued next song by itself the moment the current one should end
  // (the host's own update arrives a few seconds later and corrects it if the host did something else).
  let hostTrack = null;
  const follow = () => {
    const t = predict(hostTrack);
    if (t?.id !== track?.id) showTrack(t);
    else track = t;
    player.sync(t);
  };
  try {
    myUid = await fb.joinRoom(code, getName, {
      onTrack: (t) => {
        if (kicked) return;
        hostTrack = t;
        prefetchLyrics(t?.next);
        follow();
        if (!t) status(`Room ${code}: host belum memutar lagu (atau room tidak ada).`);
      },
      onKicked: () => {
        kicked = true;
        player.sync(null); // pause
        showTrack(null);
        $("#join").hidden = true;
        $("#listener-panel").hidden = true;
        status("Anda dikeluarkan dari room oleh host.");
      },
    });
  } catch (err) {
    return status(`Gagal masuk room: ${err.message}`);
  }
  setInterval(() => !kicked && follow(), 500);

  fb.watchRequests(code, (r) => renderListenerRequests(code, r, myUid));
  $("#request-form").onsubmit = async (e) => {
    e.preventDefault();
    const text = $("#request-text").value.trim();
    if (!text) return;
    try {
      await fb.requestSong(code, getName(), text);
      $("#request-text").value = "";
    } catch (err) {
      status(`Request gagal: ${err.message}`);
    }
  };

  await ready;
  if (kicked) return;
  $("#join").hidden = false;
  $("#join").onclick = () => {
    player.start(track);
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
