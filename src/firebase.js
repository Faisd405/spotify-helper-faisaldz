import { initializeApp } from "firebase/app";
import { getAuth, signInAnonymously } from "firebase/auth";
import { getDatabase, ref, set, get, update, push, remove, onValue, onChildAdded, onDisconnect, serverTimestamp } from "firebase/database";

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

// Everyone signs in anonymously: the rules use the uid for host ownership, presence, queue, commands, kicks.
let signedIn;
const signIn = () => (signedIn ??= signInAnonymously(getAuth(app)).then((c) => c.user));
export const myUid = async () => (await signIn()).uid;

const slim = ({ id, title, artist, album, art, durationSec }) => ({ id, title, artist, album: album ?? "", art: art ?? null, durationSec });

// ---------- Host ----------

// Claims rooms/{code} for this host. Rules reject it if another host owns the code.
// rooms/{code} = { hostUid, host: { name, avatar }, settings: { guestControl, approval }, track }
export async function hostRoom(code) {
  const user = await signIn();
  const room = ref(db, `rooms/${code}`);
  await set(room, { hostUid: user.uid, track: null });
  onDisconnect(ref(db, `rooms/${code}/track/isPlaying`)).set(false); // listeners pause if host drops
  return {
    uid: user.uid,
    publish: (t, { host, settings }) =>
      set(room, {
        hostUid: user.uid,
        host,
        settings,
        track: t && {
          ...slim(t),
          progressMs: t.progressMs,
          isPlaying: t.isPlaying,
          at: t.fetchedAt + serverOffset,
          // What plays next (room queue first, then Spotify): listeners pre-load it and switch at the end.
          next: t.next ? slim(t.next) : null,
          upcoming: (t.upcoming ?? []).map(slim), // Spotify's own "up next" after the room queue
        },
      }),
    // Children first: the rules check hostUid on the room, which is gone once the room is removed.
    end: async () => {
      await update(ref(db), Object.fromEntries(["requests", "listeners", "kicked", "queues", "commands"].map((p) => [`${p}/${code}`, null])));
      await remove(room);
    },
  };
}

// Kicked uids can no longer read the room, send heartbeats, edit the queue or send commands (rules).
export const kick = (code, uid) => update(ref(db), { [`kicked/${code}/${uid}`]: true, [`listeners/${code}/${uid}`]: null });

export const updateRequest = (code, id, fields) => update(ref(db, `requests/${code}/${id}`), fields);
export const removeRequest = (code, id) => remove(ref(db, `requests/${code}/${id}`));

// queues/{code}/{key} = { id, title, artist, album, art, durationSec, by, name, avatar?, order, at }
export function addQueueItem(code, track, by, order) {
  return push(ref(db, `queues/${code}`), { ...slim(track), by: by.uid, name: by.name, avatar: by.avatar ?? null, order, at: serverTimestamp() });
}

// Guest commands: { by, a: play|pause|next|prev|seek|playItem, pos?, key?, at }. Each is handled once.
export function watchCommands(code, handle) {
  return onChildAdded(ref(db, `commands/${code}`), (s) => {
    remove(s.ref).catch(() => {});
    handle(s.val());
  });
}

// ---------- Listener ----------

// Starts presence and follows the whole room (track, host, settings). getName() is read on every
// heartbeat so renames show up. Returns the listener's uid.
export async function joinRoom(code, getName, { onRoom, onKicked }) {
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
    ref(db, `rooms/${code}`),
    (s) => {
      const r = s.val() ?? {};
      const t = r.track;
      onRoom({ ...r, track: t?.id ? { ...t, fetchedAt: t.at - serverOffset } : null });
    },
    stop, // permission denied: we were kicked
  );
  return user.uid;
}

export async function requestSong(code, name, text) {
  const user = await signIn();
  return push(ref(db, `requests/${code}`), { by: user.uid, name, text, at: serverTimestamp() });
}

export async function sendCommand(code, a, extra = {}) {
  const user = await signIn();
  return push(ref(db, `commands/${code}`), { by: user.uid, a, ...extra, at: serverTimestamp() });
}

// ---------- Both ----------

const watch = (path) => (code, onChange) => onValue(ref(db, `${path}/${code}`), (s) => onChange(s.val() ?? {}), () => {});
// listeners/{code}/{uid} = { name, via, avatar?, at }. Entries go stale when heartbeats stop.
export const watchListeners = watch("listeners");
// requests/{code}/{id} = { by, name, text, at, track?: { id, title, artist, art }, status?: "notfound" }
export const watchRequests = watch("requests");
export const watchQueue = watch("queues");

export const removeQueueItem = (code, key) => remove(ref(db, `queues/${code}/${key}`));
export const setQueueOrder = (code, key, order) => set(ref(db, `queues/${code}/${key}/order`), order);

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
