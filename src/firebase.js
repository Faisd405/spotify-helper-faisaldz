import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, set, get, update, push, remove, onValue, onDisconnect, serverTimestamp } from "firebase/database";

// Name each variable explicitly: referencing import.meta.env as a whole makes Vite inline *every*
// VITE_* variable into the bundle, including ones this app doesn't use.
const app = initializeApp({
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
});
const db = getDatabase(app);

// Host and listener clocks differ; timestamps in the room are server time.
let serverOffset = 0;
onValue(ref(db, ".info/serverTimeOffset"), (s) => (serverOffset = s.val() ?? 0));
export const serverNow = () => Date.now() + serverOffset;

// Everyone signs in anonymously: the rules use the uid for host ownership, presence, requests and kicks.
let signedIn;
const signIn = () => (signedIn ??= signInAnonymously(getAuth(app)).then((c) => c.user));

// ---------- Host ----------

// Claims rooms/{code} for this host. Rules reject it if another host owns the code.
export async function hostRoom(code) {
  const user = await signIn();
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
          // Next song in the host's queue: listeners pre-load it and switch at the expected end.
          next: t.next ? { id: t.next.id, title: t.next.title, artist: t.next.artist, album: t.next.album, durationSec: t.next.durationSec } : null,
        },
      }),
    // Children first: the rules check hostUid on the room, which is gone once the room is removed.
    end: async () => {
      await update(ref(db), { [`requests/${code}`]: null, [`listeners/${code}`]: null, [`kicked/${code}`]: null });
      await remove(room);
    },
  };
}

// listeners/{code}/{uid} = { name, via, at }. Entries go stale when a listener stops sending heartbeats.
export const watchListeners = (code, onChange) => onValue(ref(db, `listeners/${code}`), (s) => onChange(s.val() ?? {}));

// Kicked uids can no longer read the room, send heartbeats or request songs (enforced by the rules).
export const kick = (code, uid) => update(ref(db), { [`kicked/${code}/${uid}`]: true, [`listeners/${code}/${uid}`]: null });

export const updateRequest = (code, id, fields) => update(ref(db, `requests/${code}/${id}`), fields);
export const removeRequest = (code, id) => remove(ref(db, `requests/${code}/${id}`));

// ---------- Listener ----------

// Starts presence and follows the room. getName() is read on every heartbeat so renames show up.
// Returns the listener's uid.
export async function joinRoom(code, getName, { onTrack, onKicked }) {
  const user = await signIn();
  const me = ref(db, `listeners/${code}/${user.uid}`);
  const beat = () => set(me, { name: getName(), via: "web", at: serverTimestamp() }).catch(() => {});
  onDisconnect(me).remove();
  beat();
  const timer = setInterval(beat, 15_000);

  let kicked = false;
  const stop = () => {
    if (kicked) return;
    kicked = true;
    clearInterval(timer);
    onKicked();
  };
  onValue(ref(db, `kicked/${code}/${user.uid}`), (s) => s.val() && stop());
  onValue(
    ref(db, `rooms/${code}/track`),
    (s) => {
      const t = s.val();
      onTrack(t?.id ? { ...t, fetchedAt: t.at - serverOffset } : null);
    },
    stop, // permission denied: we were kicked
  );
  return user.uid;
}

export async function requestSong(code, name, text) {
  const user = await signIn();
  return push(ref(db, `requests/${code}`), { by: user.uid, name, text, at: serverTimestamp() });
}

// ---------- Both ----------

// requests/{code}/{id} = { by, name, text, at, track?: { id, title, artist }, status?: "queued" | "notfound" }
export const watchRequests = (code, onChange) => onValue(ref(db, `requests/${code}`), (s) => onChange(s.val() ?? {}));

// ---------- Shared lyrics cache ----------

// lyrics/{spotifyTrackId}/lines = [{ timeMs, text, roman }]. Lets listeners skip LRCLIB and the 12 MB
// Japanese dictionary. Write-once (see database.rules.json).
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

// Rejects (harmlessly) if the song is already cached.
export const saveSharedLyrics = (id, lines) =>
  set(ref(db, `lyrics/${id}`), { lines: lines.map(({ timeMs, text, roman }) => ({ timeMs, text, roman: roman ?? "" })) });
