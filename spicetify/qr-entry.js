// Bundled into spicetify-listen-along.js by vite.config.js: Spicetify extensions are a single plain file.
import QRCode from "qrcode";
globalThis.LA_QR = (text) => QRCode.toDataURL(text, { margin: 1, width: 300, color: { dark: "#000000", light: "#ffffff" } });
