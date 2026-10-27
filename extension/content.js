// Runs on YouTube, YouTube Music and the Spotify web player. In the tab where the user pressed
// "Gabung", it follows the host's room: loads the same song and keeps play/pause/position in sync.
const SITE = location.hostname === "open.spotify.com" ? "spotify" : "youtube";

let room = null;
let followerTab = null;
let myTab = null;
chrome.runtime.sendMessage({ type: "whoami" }).then((id) => (myTab = id));
let nameSetting = "";
chrome.storage.local.get(["room", "tabId", "name"]).then((s) => {
  room = s.room ?? null;
  followerTab = s.tabId ?? null;
  nameSetting = s.name ?? "";
});
chrome.storage.onChanged.addListener((c) => {
  if (c.room) room = c.room.newValue ?? null;
  if (c.tabId) followerTab = c.tabId.newValue ?? null;
  if (c.name) nameSetting = c.name.newValue ?? "";
});

// Name shown to the host: the popup setting, else the account name this platform shows, else a default.
// Spotify's user button carries the display name as its label; YouTube doesn't expose one without
// opening the account menu, so YouTube users set it in the popup.
const platformName = () =>
  SITE === "spotify" ? document.querySelector('[data-testid="user-widget-link"]')?.getAttribute("aria-label")?.trim() : null;
const displayName = () => (nameSetting || platformName() || `Pendengar (${SITE === "spotify" ? "Spotify" : "YouTube"})`).slice(0, 40);

// pos: { host, me, dur } in seconds, shown as timestamps in the popup.
const report = (text, pos = null) => chrome.storage.local.set({ status: { site: SITE, text, pos, at: Date.now() } });
// Survives our own navigations within this tab (we reload the page to change songs).
const loaded = {
  get: () => JSON.parse(sessionStorage.getItem("ls:loaded") ?? "null"),
  set: (v) => sessionStorage.setItem("ls:loaded", JSON.stringify(v)),
};

// Every song change is a page load. If the page we land on never matches what we asked for
// (e.g. Spotify redirects /track/x to /intl-id/track/x), stop instead of reloading forever.
function navigate(url, key = url) {
  const recent = JSON.parse(sessionStorage.getItem("ls:navs") ?? "[]").filter((n) => Date.now() - n.at < 60_000);
  if (recent.filter((n) => n.key === key).length >= 3) {
    report("Berhenti: halaman terus dimuat ulang tanpa hasil. Buka lagunya manual, lalu tekan Gabung lagi.");
    sessionStorage.removeItem("ls:navs");
    chrome.storage.local.remove(["room", "tabId"]); // leave the room; the popup shows the reason
    return;
  }
  sessionStorage.setItem("ls:navs", JSON.stringify([...recent, { key, at: Date.now() }]));
  location.assign(url);
}

let busy = false;
setInterval(async () => {
  if (busy || !room || myTab === null || myTab !== followerTab) return;
  busy = true;
  try {
    await tick();
  } catch (err) {
    report(`Error: ${err.message}`);
  } finally {
    busy = false;
  }
}, 1500);

let lastBeat = 0;

// The rules deny a kicked uid; the host also deletes its presence entry.
function leaveKicked() {
  report("Anda dikeluarkan dari room oleh host.");
  document.querySelector("#movie_player video, video")?.pause();
  chrome.storage.local.remove(["room", "tabId"]);
}

async function tick() {
  const auth = await chrome.runtime.sendMessage({ type: "auth" });
  if (!auth) return report("Tidak bisa login ke Firebase");
  if (Date.now() - lastBeat > 15_000) {
    lastBeat = Date.now();
    const beat = await fetch(`${DB_URL}/listeners/${room}/${auth.uid}.json?auth=${auth.idToken}`, {
      method: "PUT",
      body: JSON.stringify({ name: displayName(), via: SITE, at: { ".sv": "timestamp" } }),
    });
    if (beat.status === 401 || beat.status === 403) return leaveKicked();
  }
  const res = await fetch(`${DB_URL}/rooms/${room}/track.json?auth=${auth.idToken}`);
  if (res.status === 401 || res.status === 403) return leaveKicked();
  const t = await res.json();
  if (!t?.id) return report(`Room ${room}: host belum memutar lagu`);
  // ponytail: assumes this computer's clock is close to Firebase server time (NTP keeps it within
  // a few hundred ms). Read /.info/serverTimeOffset through the SDK if drift shows up.
  const target = (t.progressMs + (t.isPlaying ? Date.now() - t.at : 0)) / 1000;
  await (SITE === "spotify" ? syncSpotify(t, target) : syncYouTube(t, target));
}

// ---------- YouTube / YouTube Music: drive the page's <video> element ----------

async function syncYouTube(t, target) {
  let l = loaded.get();
  if (l?.trackId !== t.id) {
    report(`Mencari "${t.title}" di YouTube…`);
    const videoId = await chrome.runtime.sendMessage({ type: "findVideo", track: t });
    if (!videoId) return report(`"${t.title}" tidak ditemukan di YouTube`);
    l = { trackId: t.id, videoId };
    loaded.set(l);
  }
  if (new URLSearchParams(location.search).get("v") !== l.videoId) {
    return navigate(`${location.origin}/watch?v=${l.videoId}&t=${Math.floor(target)}s`, l.videoId);
  }
  if (document.querySelector("#movie_player.ad-showing")) return report("Iklan YouTube, menunggu…");
  const v = document.querySelector("#movie_player video") ?? document.querySelector("video");
  if (!v) return;

  if (!t.isPlaying) {
    if (!v.paused) v.pause();
    return report(`⏸ ${t.title} — ${t.artist}`, { host: target, me: v.currentTime, dur: t.durationSec });
  }
  if (v.paused) v.play().catch(() => report("Klik video sekali supaya browser mengizinkan pemutaran"));
  if (Math.abs(v.currentTime - target) > 2) v.currentTime = target;
  report(`▶ ${t.title} — ${t.artist}`, { host: target, me: v.currentTime, dur: t.durationSec });
}

// ---------- Spotify web player: drive its controls (EXPERIMENTAL, depends on Spotify's markup) ----------

const toSec = (s) => s.split(":").reduce((a, b) => a * 60 + Number(b), 0);
let lastPos = null;
let cooldownUntil = 0; // give the player time to react before judging state again

function syncSpotify(t, target) {
  let l = loaded.get();
  if (l?.trackId !== t.id) {
    l = { trackId: t.id, clicked: false };
    loaded.set(l);
  }
  if (!l.clicked) {
    // Spotify localizes paths (/intl-id/track/…), so match the end only.
    if (!location.pathname.endsWith(`/track/${t.id}`)) return navigate(`${location.origin}/track/${t.id}`);
    const play = document.querySelector('[data-testid="action-bar-row"] [data-testid="play-button"]');
    if (!play) return report("Menunggu halaman lagu…");
    play.click();
    loaded.set({ ...l, clicked: true });
    cooldownUntil = Date.now() + 3000;
    return report(`Memutar "${t.title}"…`);
  }
  if (Date.now() < cooldownUntil) return;

  const posText = document.querySelector('[data-testid="playback-position"]')?.textContent ?? "";
  if (!/^\d+:\d{2}/.test(posText)) return report("Menunggu Spotify…");
  const pos = toSec(posText);
  // The position text only has 1 s resolution, so "playing" = it moved since the last 1.5 s tick.
  const playing = lastPos !== null && pos !== lastPos;
  lastPos = pos;

  if (playing !== t.isPlaying) {
    document.querySelector('[data-testid="control-button-playpause"]')?.click();
    cooldownUntil = Date.now() + 3000;
    return report(t.isPlaying ? "Melanjutkan…" : "Menjeda…");
  }
  if (playing && Math.abs(pos - target) > 3) {
    seekSpotify(target, t.durationSec);
    cooldownUntil = Date.now() + 3000;
  }
  report(`${playing ? "▶" : "⏸"} ${t.title} — ${t.artist}`, { host: target, me: pos, dur: t.durationSec });
}

function seekSpotify(sec, durationSec) {
  const range = document.querySelector('[data-testid="playback-progressbar"] input[type="range"]');
  if (!range || !Number(range.max)) return;
  // Scale to whatever unit the slider uses (its max is the track length in that unit).
  const value = Math.round((sec / durationSec) * Number(range.max));
  // React ignores plain .value assignment; go through the native setter and fire the events it listens to.
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(range, value);
  range.dispatchEvent(new Event("input", { bubbles: true }));
  range.dispatchEvent(new Event("change", { bubbles: true }));
}
