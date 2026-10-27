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

let kuroshiro;
function getKuroshiro() {
  // Lazy: the kuromoji dictionary is ~12 MB, only fetch it for Japanese songs.
  kuroshiro ??= (async () => {
    const [{ default: Kuroshiro }, { default: KuromojiAnalyzer }] = await Promise.all([
      import("@sglkc/kuroshiro"),
      import("@sglkc/kuroshiro-analyzer-kuromoji"),
    ]);
    const k = new Kuroshiro();
    await k.init(new KuromojiAnalyzer({ dictPath: "https://cdn.jsdelivr.net/npm/@sglkc/kuromoji@1.0.1/dict/" }));
    return k;
  })();
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
