importScripts("config.js");

// Finds a YouTube video for a Spotify track by reading YouTube's own search page: no API key or quota.
// Playback then happens on youtube.com itself, so the "embedding disabled" blocks (error 150) don't apply.

const toSec = (s) => s.split(":").reduce((a, b) => a * 60 + Number(b), 0); // "4:22" -> 262

// Pure, so it can be checked outside the extension (see check-search.mjs).
function pickVideo(html, durationSec) {
  const hits = html
    .split('"videoRenderer":{"videoId":"')
    .slice(1, 11)
    .map((chunk) => ({
      id: chunk.slice(0, 11),
      sec: toSec(chunk.match(/"lengthText":.*?"simpleText":"([\d:]+)"/)?.[1] ?? "0"),
    }))
    .filter((h) => h.sec > 0); // live streams have no length
  // Within ±3 s counts as the same recording: take YouTube's highest-ranked one (official uploads rank
  // first; a cover can match the length to the second). Otherwise fall back to the closest length.
  const sameVersion = hits.find((h) => Math.abs(h.sec - durationSec) <= 3);
  if (sameVersion) return sameVersion.id;
  hits.sort((a, b) => Math.abs(a.sec - durationSec) - Math.abs(b.sec - durationSec));
  return hits[0]?.id ?? null;
}

async function findVideo(track) {
  const key = `yt:${track.id}`;
  const cached = (await chrome.storage.local.get(key))[key];
  if (cached) return cached;
  const q = encodeURIComponent(`${track.artist} ${track.title}`);
  const html = await (await fetch(`https://www.youtube.com/results?search_query=${q}`)).text();
  const id = pickVideo(html, track.durationSec);
  if (id) await chrome.storage.local.set({ [key]: id });
  return id;
}

// Anonymous Firebase sign-in over REST (no SDK in the extension). The rules need a uid to read rooms,
// send presence and be kickable. ID tokens last an hour; refresh with the stored refresh token.
async function getAuth() {
  const { auth } = await chrome.storage.local.get("auth");
  if (auth && Date.now() < auth.expiresAt - 60_000) return auth;
  let next;
  if (auth) {
    const res = await fetch(`https://securetoken.googleapis.com/v1/token?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: auth.refreshToken }),
    });
    const j = await res.json();
    if (j.id_token) next = { idToken: j.id_token, refreshToken: j.refresh_token, uid: j.user_id, expiresAt: Date.now() + j.expires_in * 1000 };
  }
  if (!next) {
    const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=${API_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ returnSecureToken: true }),
    });
    const j = await res.json().catch(() => ({}));
    if (!j.idToken) throw new Error(j.error?.message ?? `sign-in HTTP ${res.status}`);
    next = { idToken: j.idToken, refreshToken: j.refreshToken, uid: j.localId, expiresAt: Date.now() + Number(j.expiresIn) * 1000 };
  }
  await chrome.storage.local.set({ auth: next });
  return next;
}

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (msg.type === "whoami") reply(sender.tab?.id ?? null);
  if (msg.type === "auth") {
    getAuth().then(reply, (err) => reply({ error: err.message || String(err) })); // shown in the popup
    return true;
  }
  if (msg.type === "findVideo") {
    findVideo(msg.track).then(reply, () => reply(null));
    return true; // async reply
  }
});

