const CLIENT_ID = import.meta.env.VITE_SPOTIFY_CLIENT_ID;
// Must match the dashboard exactly; the dashboard strips the trailing "/" from a bare origin.
const REDIRECT_URI = location.pathname === "/" ? location.origin : location.origin + location.pathname;
const SCOPES = "user-read-currently-playing";

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
export const isPaused = () => document.hidden || Date.now() < pausedUntil;

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
  if (!res.ok) throw new Error(`Spotify error ${res.status}`);
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
