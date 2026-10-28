// Runs in YouTube's own page context (manifest "world": "MAIN"), where the player element exposes
// loadVideoById. content.js can't call it from its isolated world, so it asks via postMessage.
window.addEventListener("message", (e) => {
  if (e.source !== window || e.data?.type !== "ls-load") return;
  const { videoId, start, url } = e.data;
  const player = document.getElementById("movie_player");
  if (typeof player?.loadVideoById !== "function") return location.assign(url); // fall back to a reload
  player.loadVideoById({ videoId, startSeconds: start });
  // Keep the address bar in step, so content.js sees the right ?v= and a manual reload stays on this song.
  history.replaceState(history.state, "", url);
});
