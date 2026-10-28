# Spotify Helper

Personal helper tools for Spotify. Current feature:

## Romaji Karaoke

Shows romanized, time-synced lyrics (Japanese/Korean/Chinese) for whatever is playing on your Spotify.

## Setup

1. At https://developer.spotify.com/dashboard, click **Create app** and tick **Web API**.
   Redirect URIs: `http://127.0.0.1:5173` (dev, no trailing slash) plus your HTTPS deploy URL, e.g. `https://faisd405.github.io/spotify-helper-faisaldz/`.
2. Under **User Management**, add your Spotify email.
3. `cp .env.example .env` and fill in `VITE_SPOTIFY_CLIENT_ID`.
4. `npm install && npm run dev`, then open http://127.0.0.1:5173/ (use `127.0.0.1`, not `localhost`).

## Using it on your phone

Run `npm run build` and upload `dist/` to GitHub Pages, Netlify, or Vercel.
Open the URL in Chrome on your phone, log in, then choose **Add to Home screen**.
Play a song in the Spotify app and open Karaoke.

Tap ⚙ to change font size, colors, show/hide the original text, and the sync offset
(default 300 ms; a higher number shows lyrics earlier). Settings are saved in the browser.

## Listen Along (room)

The host plays on Spotify (Premium). Listeners open a link and hear the same track at the same second
through the official Spotify Embed, with romaji lyrics. Listeners need a Spotify account (Free is fine)
and must be **logged in at open.spotify.com in that browser**; otherwise Spotify only plays 30 s previews.

Setup (once, host only), at https://console.firebase.google.com:

1. Create a project.
2. Build → Realtime Database → Create database (locked mode), and paste `database.rules.json` into the Rules tab.
3. Build → Authentication → Get started → enable **Anonymous**, and add your deploy domain under Settings → Authorized domains.
4. Project settings → Your apps → add a Web app, then copy its config into the `VITE_FIREBASE_*` values in `.env`.

Usage: tap **Buat Room** → **Bagikan link**. Friends open the link and tap **Gabung & putar**.

- **Background:** ⚙ → "Host: tetap kirim update saat tab di background" (on by default) keeps a desktop host
  publishing while its tab is hidden. Phones freeze background tabs, so keep the app open there.
- **Requests:** listeners request a song by title or Spotify link. The host's app looks it up, the host taps
  **+ Queue** to add it to their Spotify queue, and the request disappears once the song plays. Hosts who
  logged in before this feature must log out and in once (new `user-modify-playback-state` permission).
- **Listeners:** the room panel lists everyone connected (name + web/YouTube/Spotify) and lets the host
  **Kick** someone. Kicks are enforced by the database rules (no more room reads, heartbeats or requests).
  After changing `database.rules.json`, paste it into the Firebase Rules tab again.

## Browser extension (Chrome/Edge, desktop)

`extension/` lets a listener follow a room on **YouTube / YouTube Music** or the **Spotify web player**
instead of the in-page embed. No API key: it reads YouTube's own search page to find the video.

1. On the site, click **🧩 Extension** → **Download extension (.zip)** and extract it. The build packs `extension/`
   into `spotify-helper-extension.zip` with `config.js` filled in from the `VITE_FIREBASE_*` variables.
   (Developing locally instead: copy `extension/config.example.js` to `extension/config.js` and load that folder.)
   Then open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and pick the extracted folder.
2. Open youtube.com, music.youtube.com or open.spotify.com in a tab.
3. Click the extension icon, paste the room code or link, and press **Gabung di tab ini**.
   The popup also lets you request songs, the same as the web listener panel.

The YouTube side drives the page's `<video>` element and waits out ads. The Spotify web player side clicks
Spotify's own controls, so it is experimental and breaks if Spotify changes its markup.
Check the search picker with `node extension/check-search.mjs`.
