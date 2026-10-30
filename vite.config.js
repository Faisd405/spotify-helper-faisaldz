import fs from "node:fs";
import { loadEnv, build } from "vite";
import { zipSync, strToU8 } from "fflate";

const ZIP = "spotify-helper-extension.zip";
const SPICETIFY = "spicetify-listen-along.js";

// The QR generator for the Spicetify panel, bundled once into a self-contained IIFE (qrcode has no
// browser build of its own, and Spicetify extensions are a single plain file).
let qrBundle;
function qrIife() {
  qrBundle ??= build({
    configFile: false,
    logLevel: "silent",
    build: { write: false, minify: true, lib: { entry: "spicetify/qr-entry.js", formats: ["iife"], name: "LAQR", fileName: "qr" } },
  }).then((out) => [out].flat()[0].output[0].code);
  return qrBundle;
}

// The Spicetify extension is one file: QR helper + the same public config the web app ships + the code.
async function spicetifyFile(env) {
  const config = {
    dbUrl: (env.VITE_FIREBASE_DATABASE_URL ?? "").replace(/\/$/, ""),
    apiKey: env.VITE_FIREBASE_API_KEY ?? "",
    siteUrl: env.VITE_SITE_URL ?? "https://spotify-helper-faisaldz.vercel.app/",
  };
  return `${await qrIife()}\nglobalThis.LISTEN_ALONG_CONFIG = ${JSON.stringify(config)};\n` + fs.readFileSync("spicetify/listen-along.js", "utf8");
}
const SKIP = new Set(["config.js", "config.example.js", "check-search.mjs"]);

// Packs extension/ into a zip that is ready for "Load unpacked". config.js is git-ignored, so it is
// written here from the same public values the web app already ships (VITE_FIREBASE_*).
function extensionZip(env) {
  const files = { "spotify-helper-extension/config.js": strToU8(
    `const DB_URL = ${JSON.stringify((env.VITE_FIREBASE_DATABASE_URL ?? "").replace(/\/$/, ""))};\n` +
    `const API_KEY = ${JSON.stringify(env.VITE_FIREBASE_API_KEY ?? "")};\n`) };
  for (const name of fs.readdirSync("extension")) {
    if (!SKIP.has(name)) files[`spotify-helper-extension/${name}`] = fs.readFileSync(`extension/${name}`);
  }
  return zipSync(files);
}

export default ({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "VITE_");
  return {
    base: "./", // so the build works under a GitHub Pages subpath too
    build: { target: "es2022" },
    plugins: [
      {
        name: "extension-zip",
        // dev: build the zip on each download so it always matches the folder
        configureServer(server) {
          server.middlewares.use(`/${ZIP}`, (_req, res) => {
            res.setHeader("Content-Type", "application/zip");
            res.end(extensionZip(env));
          });
          server.middlewares.use(`/${SPICETIFY}`, async (_req, res) => {
            res.setHeader("Content-Type", "text/javascript");
            res.end(await spicetifyFile(env));
          });
        },
        async generateBundle() {
          this.emitFile({ type: "asset", fileName: ZIP, source: extensionZip(env) });
          this.emitFile({ type: "asset", fileName: SPICETIFY, source: await spicetifyFile(env) });
        },
      },
    ],
  };
};
