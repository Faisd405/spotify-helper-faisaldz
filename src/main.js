import { login, logout, handleRedirect, isLoggedIn, getNowPlaying, isPaused } from "./spotify.js";
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
  localStorage.setItem("style", JSON.stringify(values));
}
settings.oninput = applyStyle;
settings.onreset = () => setTimeout(applyStyle); // reset fires before the inputs revert
applyStyle();

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
  setInterval(poll, 3000);
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
  await room.end();
  room = null;
  localStorage.removeItem("host_room");
  $("#room").textContent = "Buat Room";
  $("#room-info").hidden = true;
}

function randomCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
  return Array.from(crypto.getRandomValues(new Uint8Array(6)), (v) => chars[v % chars.length]).join("");
}

async function poll() {
  if (isPaused()) return; // tab hidden or backing off after a 429
  try {
    const t = await getNowPlaying();
    if (room) room.publish(t).catch(console.error);
    showTrack(t);
  } catch (err) {
    console.error(err);
    status(err.message);
    if (!isLoggedIn()) location.reload();
  }
}

// ---------- Listener: follow a host's room through the Spotify Embed ----------

async function listen(code) {
  status(`Room ${code}: menghubungkan…`);
  let player;
  [fb, player] = await Promise.all([import("./firebase.js"), import("./embed.js")]);
  $("#player").hidden = false;
  const ready = player.createPlayer($("#embed"), status);

  fb.joinRoom(code, (t) => {
    showTrack(t);
    player.sync(t);
    if (!t) status(`Room ${code}: host belum memutar lagu (atau room tidak ada).`);
  });
  setInterval(() => player.sync(track), 1000); // keeps correcting drift between host updates

  await ready;
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
    // 1) this device  2) shared Firebase cache  3) LRCLIB + romanize here
    let found = JSON.parse(localStorage.getItem(`lyrics:${id}`));
    if (!found && fb) {
      status("Mengambil lirik…");
      // Listeners wait a bit: the host is likely romanizing this song right now.
      found = await fb.getSharedLyrics(id, room ? 0 : 8000);
      if (id !== lastId) return; // song changed while loading
      if (found) cacheLyrics(id, found);
    }
    if (!found) {
      status("Mencari lirik…");
      found = (await fetchLyrics(t)) ?? [];
      if (id !== lastId) return;
      if (!found.length) return status("Lirik tersinkron tidak ditemukan di LRCLIB.");

      const lang = detectLang(found.map((l) => l.text).join("\n"));
      if (lang === "ja") status("Memuat kamus Jepang (pertama kali agak lama)…");
      for (const line of found) line.roman = await romanize(line.text, lang);
      if (id !== lastId) return;
      cacheLyrics(id, found);
    }
    // Host shares every song it shows; write-once rules reject songs already cached.
    if (room) fb.saveSharedLyrics(id, found).catch(() => {});

    lyrics = found;
    status("");
    render();
  } catch (err) {
    console.error(err);
    status(err.message);
  }
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

function tick() {
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
