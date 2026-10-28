const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
// Must match the dashboard exactly; the dashboard strips the trailing "/" from a bare origin.
const REDIRECT_URI = location.pathname === "/" ? location.origin : location.origin + location.pathname;
// user-modify-playback-state: adding listener requests to the host's queue. Hosts who logged in before
// this scope existed get a 403 on queue calls and must log out and in once.
const SCOPES = "user-read-currently-playing user-modify-playback-state";

function randomString(len = 64) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from(crypto.getRandomValues(new Uint8Array(len)), (v) => chars[v % chars.length]).join("");
}

async function sha256Base64Url(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return btoa(String.fromCharCode(...new Uint8Array(hash)))
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function login() {
  const verifier = randomString();
  localStorage.setItem("code_verifier", verifier);
  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    response_type: "code",
    redirect_uri: REDIRECT_URI,
    scope: SCOPES,
    code_challenge_method: "S256",
    code_challenge: await sha256Base64Url(verifier),
  });
  location.href = `https://accounts.spotify.com/authorize?${params}`;
}

export function logout() {
  for (const k of ["code_verifier", "access_token", "refresh_token", "expires_at"]) localStorage.removeItem(k);
}

async function requestToken(body) {
  const res = await fetch("https://accounts.spotify.com/api/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: CLIENT_ID, ...body }),
  });
  if (!res.ok) {
    logout(); // refresh token expired/revoked -> force a fresh login
    throw new Error(`Token error ${res.status}`);
  }
  const data = await res.json();
  localStorage.setItem("access_token", data.access_token);
  if (data.refresh_token) localStorage.setItem("refresh_token", data.refresh_token);
  localStorage.setItem("expires_at", String(Date.now() + data.expires_in * 1000));
}

export async function handleRedirect() {
  const code = new URLSearchParams(location.search).get("code");
  if (!code) return;
  history.replaceState(null, "", location.pathname); // drop ?code even if the exchange fails
  await requestToken({
    grant_type: "authorization_code",
    code,
    redirect_uri: REDIRECT_URI,
    code_verifier: localStorage.getItem("code_verifier"),
  });
}

export const isLoggedIn = () => !!localStorage.getItem("refresh_token");

async function getToken() {
  if (Date.now() > Number(localStorage.getItem("expires_at")) - 60_000) {
    await requestToken({ grant_type: "refresh_token", refresh_token: localStorage.getItem("refresh_token") });
  }
  return localStorage.getItem("access_token");
}

let pausedUntil = 0; // set by a 429; no Spotify calls until then
export const isRateLimited = () => Date.now() < pausedUntil;

// Spotify explains 403s in the body ("User not registered in the Developer Dashboard", "Premium required",
// missing scope…); surface that text, since the status alone doesn't say what to fix.
async function spotifyError(res) {
  const msg = await res.json().then((j) => j.error?.message ?? j.error_description ?? "", () => "");
  if (res.status === 403) {
    pausedUntil = Date.now() + 60_000; // retrying every 3 s won't change the answer
    if (/not registered/i.test(msg)) return new Error("Spotify 403: akun ini belum didaftarkan di Developer Dashboard (User Management).");
    if (/premium/i.test(msg)) return new Error("Spotify 403: butuh Spotify Premium (pemilik app dan akun ini).");
    if (/scope/i.test(msg)) return new Error("Spotify 403: izin kurang. Logout lalu login lagi.");
  }
  return new Error(`Spotify error ${res.status}${msg ? `: ${msg}` : ""}`);
}

export async function getNowPlaying() {
  const res = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
    headers: { Authorization: `Bearer ${await getToken()}` },
  });
  if (res.status === 204) return null;
  if (res.status === 429) {
    const wait = Number(res.headers.get("Retry-After")) || 30;
    pausedUntil = Date.now() + wait * 1000;
    throw new Error(`Rate limit Spotify, jeda ${wait} detik`);
  }
  if (res.status === 401) localStorage.setItem("expires_at", "0"); // force refresh on next poll
  if (!res.ok) throw await spotifyError(res);
  const data = await res.json();
  if (!data.item || data.currently_playing_type !== "track") return null;
  return {
    id: data.item.id,
    title: data.item.name,
    artist: data.item.artists[0].name,
    album: data.item.album.name,
    durationSec: Math.round(data.item.duration_ms / 1000),
    progressMs: data.progress_ms,
    isPlaying: data.is_playing,
    fetchedAt: Date.now(),
  };
}

async function api(path, init = {}) {
  const res = await fetch(`https://api.spotify.com/v1${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${await getToken()}` },
  });
  if (res.status === 429) throw new Error("Rate limit Spotify, coba lagi sebentar.");
  if (res.status === 404 && path.startsWith("/me/player")) throw new Error("Tidak ada device Spotify yang aktif. Putar sesuatu dulu.");
  if (!res.ok) throw await spotifyError(res);
  const text = await res.text(); // queue answers 200/204 with an empty body
  return text ? JSON.parse(text) : null;
}

const toTrack = (t) => ({ id: t.id, title: t.name, artist: t.artists[0].name });

// A listener request is free text or a Spotify track link/URI.
export async function resolveTrack(text) {
  const id = text.match(/track[/:]([A-Za-z0-9]{22})/)?.[1];
  if (id) return toTrack(await api(`/tracks/${id}`));
  const found = await api(`/search?${new URLSearchParams({ q: text, type: "track", limit: "1" })}`);
  const t = found?.tracks?.items?.[0];
  return t ? toTrack(t) : null;
}

export const addToQueue = (id) => api(`/me/player/queue?${new URLSearchParams({ uri: `spotify:track:${id}` })}`, { method: "POST" });

// First upcoming track in the host's queue (respects shuffle/requests), so listeners can prepare it.
export async function getNextTrack() {
  const q = await api("/me/player/queue");
  const n = q?.queue?.find((item) => item.type === "track");
  return n ? { id: n.id, title: n.name, artist: n.artists[0].name, album: n.album.name, durationSec: Math.round(n.duration_ms / 1000) } : null;
}
