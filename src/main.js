import { login, logout, handleRedirect, isLoggedIn, getNowPlaying, isPaused } from "./spotify.js";
import { fetchLyrics } from "./lyrics.js";
import { romanize, detectLang } from "./romanize.js";

const $ = (s) => document.querySelector(s);
let track = null;
let lyrics = [];
let lastId = null;
let activeIdx = -1;
let offsetMs = 300; // sync calibration, set from the settings form

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

try {
  await handleRedirect();
} catch (err) {
  status(`Login gagal: ${err.message}`);
}

if (!isLoggedIn()) {
  $("#login").hidden = false;
  $("#login").onclick = login;
} else {
  $("#logout").hidden = false;
  $("#logout").onclick = () => { logout(); location.reload(); };
  poll();
  setInterval(poll, 3000);
  document.addEventListener("visibilitychange", poll); // resync right away when reopened
  requestAnimationFrame(tick);
}

async function poll() {
  if (isPaused()) return; // tab hidden or backing off after a 429
  try {
    track = await getNowPlaying();
    if (!track) return status("Tidak ada lagu yang diputar di Spotify.");
    $("#title").textContent = `${track.title} — ${track.artist}`;
    if (track.id === lastId) return;

    const id = (lastId = track.id);
    lyrics = [];
    render();
    const cached = JSON.parse(localStorage.getItem(`lyrics:${id}`));
    if (cached) {
      lyrics = cached;
      status("");
      return render();
    }

    status("Mencari lirik…");
    const found = (await fetchLyrics(track)) ?? [];
    if (id !== lastId) return; // song changed while loading
    if (!found.length) return status("Lirik tersinkron tidak ditemukan di LRCLIB.");

    const lang = detectLang(found.map((l) => l.text).join("\n"));
    if (lang === "ja") status("Memuat kamus Jepang (pertama kali agak lama)…");
    for (const line of found) line.roman = await romanize(line.text, lang);
    if (id !== lastId) return;

    cacheLyrics(id, found);
    lyrics = found;
    status("");
    render();
  } catch (err) {
    console.error(err);
    status(err.message);
    if (!isLoggedIn()) location.reload();
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
