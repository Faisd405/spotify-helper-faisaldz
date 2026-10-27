import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, set, get, remove, onValue, onDisconnect } from "firebase/database";

const env = import.meta.env;
const app = initializeApp({
  apiKey: env.VITE_FIREBASE_API_KEY,
  authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: env.VITE_FIREBASE_DATABASE_URL,
  projectId: env.VITE_FIREBASE_PROJECT_ID,
  appId: env.VITE_FIREBASE_APP_ID,
});
const db = getDatabase(app);

// Host and listener clocks differ; timestamps in the room are server time.
let serverOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), (s) => (serverOffset = s.val() ?? 0));

// Claims rooms/{code} for this (anonymous) host. Rules reject it if another host owns the code.
// Returns publish(track|null) and end().
export async function hostRoom(code) {
  const { user } = await signInAnonymously(getAuth(app));
  const room = ref(db, `rooms/${code}`);
  await set(room, { hostUid: user.uid, track: null });
  onDisconnect(ref(db, `rooms/${code}/track/isPlaying`)).set(false); // listeners pause if host drops
  return {
    publish: (t) =>
      set(room, {
        hostUid: user.uid,
        track: t && {
          id: t.id,
          title: t.title,
          artist: t.artist,
          album: t.album,
          durationSec: t.durationSec,
          progressMs: t.progressMs,
          isPlaying: t.isPlaying,
          at: t.fetchedAt + serverOffset,
        },
      }),
    end: () => remove(room),
  };
}

// Shared lyrics cache: lyrics/{spotifyTrackId}/lines = [{ timeMs, text, roman }].
// Lets listeners skip LRCLIB and the 12 MB Japanese dictionary. Write-once (see database.rules.json).
// waitMs > 0: if missing, wait that long for the host to publish it before giving up.
export async function getSharedLyrics(id, waitMs = 0) {
  const r = ref(db, `lyrics/${id}/lines`);
  const snap = await get(r).catch(() => null);
  if (snap?.exists() || !waitMs) return snap?.val() ?? null;
  let off;
  const published = new Promise((resolve) => (off = onValue(r, (s) => s.exists() && resolve(s.val()))));
  const lines = await Promise.race([published, new Promise((resolve) => setTimeout(resolve, waitMs, null))]);
  off();
  return lines;
}

// Needs the anonymous sign-in from hostRoom(). Rejects (harmlessly) if the song is already cached.
export const saveSharedLyrics = (id, lines) =>
  set(ref(db, `lyrics/${id}`), { lines: lines.map(({ timeMs, text, roman }) => ({ timeMs, text, roman: roman ?? "" })) });

// Calls onTrack with the host's track (fetchedAt converted to local time), or null.
export function joinRoom(code, onTrack) {
  return onValue(ref(db, `rooms/${code}/track`), (s) => {
    const t = s.val();
    onTrack(t?.id ? { ...t, fetchedAt: t.at - serverOffset } : null);
  });
}
