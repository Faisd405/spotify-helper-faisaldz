// Spicetify: full-page romaji lyrics in the style of lyrics-plus, but with the original line under the romaji
// (or romaja / pinyin), and the same display settings as the web app.
// Sources, in order: this device, the room's shared Firebase cache, Spotify's own lyrics (Musixmatch data,
// as lyrics-plus does), LRCLIB, then Genius (not synced). Synced lyrics are shared back to the Firebase cache
// so web listeners get them without the 12 MB Japanese dictionary.
// Needs LA_LYRICS + LISTEN_ALONG_CONFIG (prepended by the build) and listen-along.js for saving.

(async function romajiLyrics() {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  while (!globalThis.Spicetify?.Player?.addEventListener || !Spicetify.Playbar?.Button || !Spicetify.LocalStorage || !Spicetify.CosmosAsync) await sleep(300);
  const { Player, LocalStorage: store } = Spicetify;
  const CFG = globalThis.LISTEN_ALONG_CONFIG ?? {};
  const L = globalThis.LA_LYRICS;

  // ---------- Sources ----------

  const trackId = (uri) => (uri?.startsWith("spotify:track:") ? uri.split(":")[2] : null);
  const info = (item) => ({
    id: trackId(item?.uri),
    title: item?.name ?? "",
    artist: item?.artists?.[0]?.name ?? "",
    album: item?.album?.name ?? "",
    durationSec: Math.round((item?.duration?.milliseconds ?? Player.getDuration()) / 1000),
  });

  // Each returns { synced, lines: [{ timeMs, text, roman? }] } or null.
  const SOURCES = {
    "Cache room": async (t) => {
      if (!CFG.dbUrl) return null;
      const lines = await (await fetch(`${CFG.dbUrl}/lyrics/${t.id}/lines.json`)).json();
      return Array.isArray(lines) && lines.length ? { synced: true, lines, romanized: true } : null;
    },
    Spotify: async (t) => {
      const b = await Spicetify.CosmosAsync.get(`https://spclient.wg.spotify.com/color-lyrics/v2/track/${t.id}?format=json&vocalRemoval=false&market=from_token`);
      const l = b?.lyrics;
      if (!l?.lines?.length) return null;
      const synced = l.syncType === "LINE_SYNCED";
      return { synced, lines: l.lines.map((x) => ({ timeMs: synced ? Number(x.startTimeMs) : 0, text: x.words === "♪" ? "" : (x.words ?? "") })) };
    },
    LRCLIB: async (t) => {
      const lines = await L.fetchLyrics(t);
      return lines?.length ? { synced: true, lines } : null;
    },
    Genius: async (t) => {
      const q = new URLSearchParams({ per_page: 10, q: `${t.artist} ${t.title.replace(/\s*[([-].*$/, "")}` });
      const hits = (await Spicetify.CosmosAsync.get(`https://genius.com/api/search/song?${q}`))?.response?.sections?.[0]?.hits ?? [];
      // Only trust a hit by the same artist: a wrong song is worse than none.
      const hit = hits.map((x) => x.result).find((r) => r?.primary_artist?.name?.toLowerCase().includes(t.artist.toLowerCase()) || t.artist.toLowerCase().includes(r?.primary_artist?.name?.toLowerCase() ?? "\0"));
      if (!hit?.url) return null;
      // Genius pages are HTML; CosmosAsync only does JSON, so use the raw request lyrics-plus uses.
      const page = await new Promise((resolve, reject) =>
        window.sendCosmosRequest({ request: JSON.stringify({ method: "GET", uri: hit.url }), persistent: false, onSuccess: resolve, onFailure: reject }));
      const doc = new DOMParser().parseFromString(JSON.parse(page)?.body ?? "", "text/html");
      const text = [...doc.querySelectorAll('[data-lyrics-container="true"]')].map((c) => {
        c.querySelectorAll('[data-exclude-from-selection="true"]').forEach((x) => x.remove()); // "N Contributors…" header
        c.querySelectorAll("br").forEach((br) => br.replaceWith("\n"));
        return c.textContent;
      }).join("\n");
      const lines = text.split("\n").map((s) => s.trim()).filter((s, i, a) => s || a[i - 1]).map((text) => ({ timeMs: 0, text }));
      return lines.some((l) => l.text) ? { synced: false, lines } : null;
    },
  };
  const ORDER = Object.keys(SOURCES);

  // ~5-10 KB per song in localStorage. When full, drop all cached lyrics and retry.
  // ponytail: wipe-all eviction, same as the web app; IndexedDB + LRU if it fills up often.
  const KEY = (id) => `la:lyrics:${id}`;
  function cache(id, v) {
    const save = () => localStorage.setItem(KEY(id), JSON.stringify(v));
    try { save(); } catch {
      Object.keys(localStorage).filter((k) => k.startsWith("la:lyrics:")).forEach((k) => localStorage.removeItem(k));
      try { save(); } catch {}
    }
  }

  // Tries ORDER from index `from`; -1 = this device first. Returns { source, synced, lines, noRoman }.
  async function load(t, say, from = -1) {
    if (from < 0) {
      const saved = JSON.parse(localStorage.getItem(KEY(t.id)) ?? "null");
      if (saved) return saved;
    }
    for (const source of ORDER.slice(Math.max(from, 0))) {
      say(`Mencari lirik (${source})…`);
      const found = await SOURCES[source](t).catch((e) => (console.warn("[lyrics]", source, e), null));
      if (!found) continue;
      const res = { source, synced: found.synced, lines: found.lines, noRoman: false };
      if (!found.romanized) {
        const lang = L.detectLang(res.lines.map((l) => l.text).join("\n"));
        if (lang === "ja") say("Memuat kamus Jepang (pertama kali agak lama)…");
        try {
          for (const line of res.lines) line.roman = await L.romanize(line.text, lang);
        } catch (e) {
          // Show the original now, but don't cache: lyrics without romaji would stick.
          console.error(e);
          for (const line of res.lines) line.roman = "";
          res.noRoman = true;
        }
      }
      if (!res.noRoman) {
        cache(t.id, res);
        if (res.synced && source !== "Cache room") globalThis.ListenAlong?.saveLyrics?.(t.id, res.lines).catch?.(() => {});
      }
      return res;
    }
    return { source: null, synced: false, lines: [], noRoman: false };
  }
  const inflight = new Map(); // one load per song even when the page and the prefetch ask together
  const get = (t, say = () => {}) => {
    if (!inflight.has(t.id)) inflight.set(t.id, load(t, say).finally(() => inflight.delete(t.id)));
    return inflight.get(t.id);
  };

  // ---------- Settings (same set as the web app's ⚙) ----------

  const DEFAULTS = { romanSize: 2, origSize: 1.1, showOrig: true, active: "#1db954", text: "#ffffff", offset: 0, align: "left" };
  let opts = { ...DEFAULTS, ...JSON.parse(store.get("la:lyrics-style") ?? "{}") };
  function applyOpts() {
    if (!page) return;
    const s = page.style;
    s.setProperty("--lr-roman", `${opts.romanSize}rem`);
    s.setProperty("--lr-orig", `${opts.origSize}rem`);
    s.setProperty("--lr-active", opts.active);
    s.setProperty("--lr-text", opts.text);
    s.setProperty("--lr-align", opts.align);
    page.classList.toggle("lr-no-orig", !opts.showOrig);
  }

  // ---------- Page ----------

  const h = (tag, props = {}, ...kids) => {
    const e = Object.assign(document.createElement(tag), props);
    e.append(...kids.filter((k) => k != null && k !== false));
    return e;
  };
  document.head.append(h("style", { textContent: `
    .lr-page { position: absolute; inset: 0; z-index: 20; display: flex; flex-direction: column; background: var(--spice-main, #121212); color: var(--lr-text); }
    .lr-head { display: flex; align-items: center; gap: 8px; padding: 12px 24px; border-bottom: 1px solid rgba(var(--spice-rgb-text, 255,255,255), .1); }
    .lr-title { flex: 1; min-width: 0; }
    .lr-title b, .lr-title small { display: block; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .lr-title small { opacity: .6; }
    .lr-head button { background: rgba(var(--spice-rgb-text, 255,255,255), .08); color: inherit; border: 0; border-radius: 999px; padding: 6px 12px; cursor: pointer; font: inherit; font-size: 13px; }
    .lr-head button:hover { background: rgba(var(--spice-rgb-text, 255,255,255), .16); }
    .lr-opts { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 10px 20px; padding: 12px 24px; font-size: 13px; border-bottom: 1px solid rgba(var(--spice-rgb-text, 255,255,255), .1); }
    .lr-opts label { display: flex; flex-direction: column; gap: 4px; }
    .lr-opts label.row { flex-direction: row; align-items: center; }
    .lr-opts input[type=number], .lr-opts select { background: rgba(var(--spice-rgb-text, 255,255,255), .08); color: inherit; border: 0; border-radius: 4px; padding: 4px 6px; }
    .lr-scroll { flex: 1; overflow-y: auto; }
    .lr-status { padding: 24px; opacity: .7; text-align: var(--lr-align); }
    .lr-lines { list-style: none; margin: 0; padding: 35vh 48px 45vh; text-align: var(--lr-align); }
    .lr-lines li { padding: 8px 0; opacity: .35; transition: opacity .2s, color .2s, filter .2s; cursor: pointer; }
    .lr-lines li:hover { opacity: .7; }
    .lr-lines li.lr-active { opacity: 1; color: var(--lr-active); }
    .lr-lines li.lr-past { opacity: .5; }
    .lr-lines.lr-unsynced li { opacity: 1; cursor: default; }
    .lr-roman { font-size: var(--lr-roman); font-weight: 700; line-height: 1.25; margin: 0; }
    .lr-orig { font-size: var(--lr-orig); opacity: .75; margin: 4px 0 0; }
    .lr-no-orig .lr-orig { display: none; }
  ` }));

  let page = null; // the page element while open
  let lines = [];
  let synced = false;
  let shownId = null;
  let activeIdx = -1;
  let userScrolledAt = 0;

  function optsPanel() {
    const save = () => { store.set("la:lyrics-style", JSON.stringify(opts)); applyOpts(); };
    const input = (label, key, attrs) => {
      const i = h("input", { ...attrs, [attrs.type === "checkbox" ? "checked" : "value"]: opts[key] });
      i.oninput = () => { opts[key] = attrs.type === "checkbox" ? i.checked : attrs.type === "color" ? i.value : Number(i.value); save(); };
      return h("label", { className: attrs.type === "checkbox" ? "row" : "" }, ...(attrs.type === "checkbox" ? [i, ` ${label}`] : [label, i]));
    };
    const align = h("select", {}, h("option", { value: "left", textContent: "Kiri" }), h("option", { value: "center", textContent: "Tengah" }));
    align.value = opts.align;
    align.onchange = () => { opts.align = align.value; save(); };
    return h("div", { className: "lr-opts", hidden: true },
      input("Ukuran romaji", "romanSize", { type: "range", min: 1, max: 4, step: 0.1 }),
      input("Ukuran teks asli", "origSize", { type: "range", min: 0.6, max: 3, step: 0.1 }),
      input("Warna baris aktif", "active", { type: "color" }),
      input("Warna teks", "text", { type: "color" }),
      input("Offset sinkron (ms, lebih besar = lebih awal)", "offset", { type: "number", step: 50 }),
      h("label", {}, "Rata", align),
      input("Tampilkan teks asli", "showOrig", { type: "checkbox" }),
      h("label", { className: "row" }, h("button", { type: "button", textContent: "Reset", onclick: () => { opts = { ...DEFAULTS }; save(); const o = optsPanel(); o.hidden = false; page.querySelector(".lr-opts").replaceWith(o); } })),
    );
  }

  function open() {
    if (page) return;
    const host = document.querySelector(".Root__main-view") ?? document.body;
    if (getComputedStyle(host).position === "static") host.style.position = "relative";
    page = h("div", { className: "lr-page" },
      h("div", { className: "lr-head" },
        h("div", { className: "lr-title" }, h("b"), h("small")),
        h("button", { type: "button", textContent: "Sumber lain", title: "Coba sumber lirik berikutnya", onclick: () => show(true) }),
        h("button", { type: "button", textContent: "⚙ Tampilan", onclick: () => { const o = page.querySelector(".lr-opts"); o.hidden = !o.hidden; } }),
        h("button", { type: "button", textContent: "✕", title: "Tutup", onclick: close }),
      ),
      optsPanel(),
      h("div", { className: "lr-scroll" }, h("div", { className: "lr-status" }), h("ul", { className: "lr-lines" })),
    );
    const scroller = page.querySelector(".lr-scroll");
    for (const ev of ["wheel", "touchmove", "keydown"]) scroller.addEventListener(ev, () => (userScrolledAt = Date.now()), { passive: true });
    host.append(page);
    applyOpts();
    btn.active = true;
    shownId = null;
    show();
    requestAnimationFrame(tick);
  }
  function close() {
    page?.remove();
    page = null;
    btn.active = false;
  }

  let source = null;
  async function show(nextSource = false) {
    if (!page) return;
    const t = info(Player.data?.item);
    const head = page.querySelector(".lr-title");
    head.querySelector("b").textContent = t.title || "Tidak ada lagu";
    head.querySelector("small").textContent = t.artist;
    const say = (msg) => { if (page && shownId === t.id) page.querySelector(".lr-status").textContent = msg; };
    shownId = t.id;
    lines = [];
    draw();
    if (!t.id) return say("Lirik hanya untuk lagu Spotify (bukan podcast atau file lokal).");
    const res = nextSource ? await load(t, say, source ? ORDER.indexOf(source) + 1 : 0) : await get(t, say);
    if (!page || shownId !== t.id) return; // song changed or page closed meanwhile
    source = res.source;
    lines = res.lines;
    synced = res.synced;
    head.querySelector("small").textContent = [t.artist, res.source && `Lirik: ${res.source}${res.synced ? "" : " (tidak tersinkron)"}`].filter(Boolean).join(" · ");
    say(!lines.length ? (nextSource ? "Tidak ada sumber lain. Tekan lagi untuk mulai dari awal." : "Lirik tidak ditemukan.") : res.noRoman ? "Romaji gagal dibuat (kamus tidak termuat). Teks asli ditampilkan." : "");
    if (!lines.length && nextSource) source = null;
    draw();
    prefetchNext();
  }

  function draw() {
    activeIdx = -1;
    const ul = page.querySelector(".lr-lines");
    ul.classList.toggle("lr-unsynced", !synced);
    ul.replaceChildren(...lines.map((l) => {
      const li = h("li", {},
        h("p", { className: "lr-roman", textContent: l.roman || l.text || "♪" }),
        l.roman ? h("p", { className: "lr-orig", textContent: l.text }) : null);
      if (synced) li.onclick = () => { Player.seek(l.timeMs); userScrolledAt = 0; };
      return li;
    }));
  }

  function tick() {
    if (!page) return;
    if (synced && lines.length) {
      const pos = Player.getProgress() + opts.offset;
      const idx = lines.findLastIndex((l) => l.timeMs <= pos);
      if (idx !== activeIdx) {
        const items = page.querySelector(".lr-lines").children;
        for (let i = 0; i < items.length; i++) {
          items[i].classList.toggle("lr-active", i === idx);
          items[i].classList.toggle("lr-past", i < idx);
        }
        // Follow the song unless the user scrolled in the last 3 s (like lyrics-plus).
        if (Date.now() - userScrolledAt > 3000) items[idx]?.scrollIntoView({ behavior: "smooth", block: "center" });
        activeIdx = idx;
      }
    }
    requestAnimationFrame(tick);
  }

  // Get the next song ready (lyrics + romaji) so the switch is instant.
  function prefetchNext() {
    const next = info((Player.data?.nextItems ?? []).find((i) => trackId(i.uri)));
    if (next.id && !localStorage.getItem(KEY(next.id))) get(next).catch(() => {});
  }

  Player.addEventListener("songchange", () => {
    source = null;
    if (page) show();
  });
  Spicetify.Platform?.History?.listen?.(() => close()); // navigating elsewhere leaves the lyrics page

  const ICON = `<svg viewBox="0 0 16 16" fill="currentColor"><path d="M2 3h12v1.5H2zm0 4h8v1.5H2zm0 4h10v1.5H2z"/><text x="11.2" y="10" font-size="6" font-weight="700">あ</text></svg>`;
  const btn = new Spicetify.Playbar.Button("Lirik Romaji", ICON, () => (page ? close() : open()), false, false);

  globalThis.RomajiLyrics = { open, close, load, SOURCES }; // devtools / tests
})();
