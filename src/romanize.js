import { pinyin } from "pinyin-pro";
import { romanize as romanizeKorean } from "@romanize/korean";

const KANA = /[぀-ヿ]/;
const HANGUL = /[가-힯ᄀ-ᇿ㄰-㆏]/;
const HAN = /[一-鿿]/;

// Han-only lines are ambiguous, so decide per song: any kana anywhere -> Japanese.
export function detectLang(text) {
  if (KANA.test(text)) return "ja";
  if (HANGUL.test(text)) return "ko";
  if (HAN.test(text)) return "zh";
  return null;
}

const DICT_URL = "https://cdn.jsdelivr.net/npm/@sglkc/kuromoji@1.0.1/dict/";
// kuromoji path.join()s dictPath + file name, which collapses "https://cdn…" into "https:/cdn…".
// On an https page the browser reads that as a same-origin path (404 on Vercel); http pages happened to work.
// Restore the slash. Only the malformed "https:/x" form is touched, which nothing else produces.
// (Self-hosting the dictionary instead breaks: dev servers add Content-Encoding: gzip to .gz files,
// and kuromoji gunzips them a second time.)
const realFetch = window.fetch;
window.fetch = (url, ...rest) =>
  realFetch(typeof url === "string" ? url.replace(/^https:\/(?!\/)/, "https://") : url, ...rest);
let kuroshiro;
function getKuroshiro() {
  // Lazy: the kuromoji dictionary is ~12 MB, only fetch it for Japanese songs.
  kuroshiro ??= (async () => {
    const [{ default: Kuroshiro }, { default: KuromojiAnalyzer }] = await Promise.all([
      import("@sglkc/kuroshiro"),
      import("@sglkc/kuroshiro-analyzer-kuromoji"),
    ]);
    const k = new Kuroshiro();
    // kuromoji never calls back if a file fails to load, hence the timeout.
    await Promise.race([
      k.init(new KuromojiAnalyzer({ dictPath: DICT_URL })),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Kamus Jepang gagal dimuat")), 60_000)),
    ]);
    return k;
  })();
  kuroshiro.catch(() => (kuroshiro = null)); // let the next song retry
  return kuroshiro;
}

export async function romanize(text, lang) {
  if (lang === "ja" && (KANA.test(text) || HAN.test(text))) {
    return (await getKuroshiro()).convert(text, { to: "romaji", mode: "spaced", romajiSystem: "hepburn" });
  }
  // @romanize/korean throws on anything outside Hangul/ASCII (e.g. "…", "’"), so feed it Hangul runs only.
  if (lang === "ko" && HANGUL.test(text)) return text.replace(/[가-힯ᄀ-ᇿ㄰-㆏]+/g, (run) => romanizeKorean(run));
  if (lang === "zh" && HAN.test(text)) return pinyin(text, { toneType: "symbol", nonZh: "consecutive" });
  return "";
}
