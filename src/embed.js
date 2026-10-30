// Listener playback through the official Spotify Embed (iFrame API). Full tracks need the listener to be
// logged in to Spotify in this browser (Free is enough); otherwise Spotify only plays a 30 s preview.

let ctrl;
let onStatus = () => {};
let state = null; // last playback_update: { playingURI, isPaused, isBuffering, duration, position } + at
let joined = false;
let loadedTrack = null; // spotify track id we asked the embed to load
let lastSeek = 0;

export function createPlayer(element, statusCallback) {
  onStatus = statusCallback;
  return new Promise((resolve) => {
    window.onSpotifyIframeApiReady = (IFrameAPI) => {
      IFrameAPI.createController(element, { width: "100%", height: 152 }, (c) => {
        ctrl = c;
        ctrl.addListener("playback_update", ({ data }) => {
          state = { ...data, at: Date.now() };
          if (data.duration && data.duration <= 31000) {
            onStatus("Hanya preview 30 detik. Login dulu di open.spotify.com di browser ini, lalu muat ulang halaman.");
          }
        });
        resolve();
      });
    };
    const s = document.createElement("script");
    s.src = "https://open.spotify.com/embed/iframe-api/v1";
    document.head.append(s);
  });
}

const targetSec = (t) => (t.progressMs + (t.isPlaying ? Date.now() - t.fetchedAt : 0)) / 1000;
const embedSec = () => (state.position + (state.isPaused ? 0 : Date.now() - state.at)) / 1000;

function load(t) {
  loadedTrack = t.id;
  state = null;
  ctrl.loadUri(`spotify:track:${t.id}`);
  ctrl.play(); // position is corrected by sync() once playback_update reports the new track
}

// Call from a click handler: mobile browsers only allow the first playback inside a user gesture.
export function start(t) {
  joined = true;
  if (t) load(t);
}

// Keeps the embed within ~2 s of the host. Safe to call often.
export function sync(t) {
  if (!ctrl || !joined) return;
  if (!t) return state && !state.isPaused && ctrl.pause();
  if (t.id !== loadedTrack) return load(t);
  if (!state || state.playingURI !== `spotify:track:${t.id}`) return; // still loading

  if (!t.isPlaying) return state.isPaused || ctrl.pause();
  if (state.isPaused) return ctrl.resume();
  // seek() only takes whole seconds (±0.5 s), so correct beyond 1.2 s, and give each seek 2 s to settle.
  if (!state.isBuffering && Date.now() - lastSeek > 2000 && Math.abs(embedSec() - targetSec(t)) > 1.2) {
    lastSeek = Date.now();
    ctrl.seek(Math.round(targetSec(t)));
  }
}
