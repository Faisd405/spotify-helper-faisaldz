// node extension/check-search.mjs [saved-youtube-results.html]
import assert from "node:assert";
import fs from "node:fs";

// background.js is a plain service-worker script; evaluate it with a stub chrome and pull out pickVideo.
const src = fs.readFileSync(new URL("./background.js", import.meta.url), "utf8");
const pickVideo = new Function("chrome", "importScripts", `${src}
return pickVideo;`)({ runtime: { onMessage: { addListener() {} } } }, () => {});

const r = (id, len) => `"videoRenderer":{"videoId":"${id}","x":1${len ? `,"lengthText":{"accessibility":{"accessibilityData":{"label":"…"}},"simpleText":"${len}"}` : ""}`;
const html = r("LIVESTREAM1") + r("MUSICVIDEO1", "5:40") + r("ALBUMAUDIO1", "4:22") + r("COVERVERSIO", "4:21");

assert.equal(pickVideo(html, 261), "ALBUMAUDIO1"); // both within 3 s of 4:21: the higher-ranked upload beats the exact-length cover
assert.equal(pickVideo(html, 340), "MUSICVIDEO1"); // duration decides
assert.equal(pickVideo(r("LIVESTREAM1"), 261), null); // no length -> skipped
assert.equal(pickVideo("", 261), null);

if (process.argv[2]) console.log("real page pick:", pickVideo(fs.readFileSync(process.argv[2], "utf8"), 261));
console.log("pickVideo ok");
