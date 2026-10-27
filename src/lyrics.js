export async function fetchLyrics(track) {
  const exact = new URLSearchParams({
    track_name: track.title,
    artist_name: track.artist,
    album_name: track.album,
    duration: String(track.durationSec),
  });
  let res = await fetch(`https://lrclib.net/api/get?${exact}`);
  let data = res.ok ? await res.json() : null;

  // Album names often differ between Spotify and LRCLIB -> fall back to search, closest duration wins.
  if (!data?.syncedLyrics) {
    const q = new URLSearchParams({ track_name: track.title, artist_name: track.artist });
    res = await fetch(`https://lrclib.net/api/search?${q}`);
    const hits = res.ok ? await res.json() : [];
    data = hits
      .filter((h) => h.syncedLyrics)
      .sort((a, b) => Math.abs(a.duration - track.durationSec) - Math.abs(b.duration - track.durationSec))[0];
  }
  return data?.syncedLyrics ? parseLrc(data.syncedLyrics) : null;
}

// "[01:23.45] text" -> { timeMs, text }. One line may carry several timestamps.
export function parseLrc(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const last = stamps.at(-1);
    const text = raw.slice(last.index + last[0].length).trim();
    for (const m of stamps) lines.push({ timeMs: (Number(m[1]) * 60 + Number(m[2])) * 1000, text });
  }
  return lines.sort((a, b) => a.timeMs - b.timeMs);
}
