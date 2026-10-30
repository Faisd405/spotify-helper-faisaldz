// Bundled into spicetify-listen-along.js by vite.config.js: Spicetify extensions are a single plain file.
import QRCode from "qrcode";
import { fetchLyrics } from "../src/lyrics.js";
import { romanize, detectLang } from "../src/romanize.js";

globalThis.LA_QR = (text) => QRCode.toDataURL(text, { margin: 1, width: 300, color: { dark: "#000000", light: "#ffffff" } });
// Same LRCLIB lookup and romanisation as the web app, so both produce the same shared cache.
globalThis.LA_LYRICS = { fetchLyrics, romanize, detectLang };
