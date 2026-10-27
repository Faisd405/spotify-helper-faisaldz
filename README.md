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
Keep the app open on the host's phone; it stops sending updates while it's in the background.
