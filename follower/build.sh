#!/bin/sh
# Builds ListenAlong.exe with the same public config the web app ships (read from ../.env).
cd "$(dirname "$0")"
get() { grep "^$1=" ../.env | cut -d= -f2- | tr -d "\"'\r"; }
go build -trimpath -ldflags "-s -w -H windowsgui \
  -X main.clientID=$(get VITE_SPOTIFY_CLIENT_ID) \
  -X main.dbURL=$(get VITE_FIREBASE_DATABASE_URL) \
  -X main.apiKey=$(get VITE_FIREBASE_API_KEY)" -o ListenAlong.exe .
