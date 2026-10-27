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
