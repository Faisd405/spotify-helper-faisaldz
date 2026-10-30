// Room panel building blocks (Jam-style): now playing card, member avatars, shared queue, invite QR.
// Names, titles and request text come from other people: they are only ever set via textContent.

const h = (tag, props = {}, ...kids) => {
  const el = Object.assign(document.createElement(tag), props);
  el.append(...kids.filter((k) => k != null && k !== false));
  return el;
};
export const mmss = (sec) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, "0")}`;

// action may be async: the button is disabled and relabelled until it finishes, so a click is visible.
export function button(label, action, { cls = "", busy = "…", title = "", onError } = {}) {
  const b = h("button", { type: "button", textContent: label, className: cls, title });
  b.onclick = async (e) => {
    e.stopPropagation();
    b.disabled = true;
    b.textContent = busy;
    try {
      await action();
    } catch (err) {
      onError?.(err);
    } finally {
      b.disabled = false; // usually gone already: lists re-render from Firebase
      b.textContent = label;
    }
  };
  return b;
}

// Profile picture, or coloured initials when there is none (web listeners).
const COLORS = ["#e91e63", "#9c27b0", "#3f51b5", "#03a9f4", "#009688", "#8bc34a", "#ff9800", "#ff5722"];
export function avatar(name = "?", url = null, cls = "") {
  if (url) {
    // A dead profile picture falls back to initials instead of a broken-image icon.
    const img = h("img", { className: `avatar ${cls}`, src: url, alt: "", title: name, referrerPolicy: "no-referrer" });
    img.onerror = () => img.replaceWith(avatar(name, null, cls));
    return img;
  }
  const hash = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  const initials = name.trim().split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "?";
  return h("span", { className: `avatar ${cls}`, textContent: initials, title: name, style: `background:${COLORS[hash % COLORS.length]}` });
}

function art(url, cls = "art") {
  if (!url) return h("span", { className: `${cls} art-empty`, textContent: "♪" });
  const img = h("img", { className: cls, src: url, alt: "", loading: "lazy" });
  img.onerror = () => img.replaceWith(art(null, cls));
  return img;
}

// Now playing: art, title/artist, progress (filled in by the clock tick), optional playback controls.
export function renderNowPlaying(el, track, { controls, onControl, onError }) {
  if (!track) return el.replaceChildren(h("p", { className: "muted", textContent: "Belum ada lagu yang diputar." }));
  const ctrl = (label, a, title) => button(label, () => onControl(a), { cls: "ctrl", title, onError });
  el.replaceChildren(
    h("div", { className: "np-row" },
      art(track.art, "np-art"),
      h("div", { className: "np-text" },
        h("b", { textContent: track.title }),
        h("span", { className: "muted", textContent: track.artist }),
        h("div", { className: "np-progress" }, h("span", { id: "np-elapsed", textContent: "0:00" }), h("progress", { id: "np-bar", max: 1, value: 0 }), h("span", { textContent: mmss(track.durationSec) })),
      ),
    ),
    controls ? h("div", { className: "np-controls" },
      ctrl("⏮", "prev", "Sebelumnya"),
      ctrl(track.isPlaying ? "⏸" : "▶", track.isPlaying ? "pause" : "play", track.isPlaying ? "Jeda" : "Putar"),
      ctrl("⏭", "next", "Berikutnya"),
    ) : "", // replaceChildren would print false/null as text
  );
}

const VIA = { web: "Web", youtube: "YouTube", spotify: "Spotify Web", spicetify: "Spotify" };

// members: [{ uid, name, via, avatar, isHost, isMe }], host first.
export function renderMembers(el, members, { onKick, onError }) {
  el.replaceChildren(
    h("div", { className: "member-stack" }, ...members.slice(0, 8).map((m) => avatar(m.name, m.avatar))),
    h("ul", { className: "member-list" },
      ...members.map((m) =>
        h("li", {},
          avatar(m.name, m.avatar, "sm"),
          h("span", { className: "grow" }, m.name, m.isMe ? h("small", { textContent: " (Anda)" }) : null),
          m.isHost ? h("span", { className: "badge", textContent: "HOST" }) : h("small", { className: "muted", textContent: VIA[m.via] ?? m.via }),
          onKick && !m.isHost ? button("Kick", () => confirm(`Keluarkan ${m.name} dari room?`) && onKick(m.uid), { cls: "small secondary", busy: "Kick…", onError }) : null,
        ),
      ),
    ),
  );
}

// items: sorted [{ key, id, title, artist, art, durationSec, name, avatar, by }]
// perms(item) -> { play, remove, move }
export function renderQueue(el, items, { perms, onPlay, onRemove, onMove, onError }) {
  if (!items.length) return el.replaceChildren(h("li", { className: "muted empty", textContent: "Antrian room kosong. Tambahkan lagu di atas." }));
  el.replaceChildren(
    ...items.map((it, i) => {
      const p = perms(it);
      const li = h("li", { className: "q-item", draggable: p.move },
        h("span", { className: "q-num muted", textContent: i + 1 }),
        art(it.art),
        h("div", { className: "q-text" }, h("b", { textContent: it.title }), h("span", { className: "muted", textContent: `${it.artist} · ${mmss(it.durationSec ?? 0)}` })),
        avatar(it.name, it.avatar, "xs added-by"),
        p.move && i > 0 ? button("↑", () => onMove(it.key, i - 1), { cls: "icon", title: "Naikkan", onError }) : null,
        p.play ? button("▶", () => onPlay(it.key), { cls: "icon", title: "Putar sekarang", onError }) : null,
        p.remove ? button("✕", () => onRemove(it.key), { cls: "icon", title: "Hapus", onError }) : null,
      );
      // Drag to reorder (desktop). Touch screens use the ↑ button.
      if (p.move) {
        li.ondragstart = (e) => { e.dataTransfer.setData("text/plain", it.key); li.classList.add("dragging"); };
        li.ondragend = () => li.classList.remove("dragging");
        li.ondragover = (e) => e.preventDefault();
        li.ondrop = (e) => {
          e.preventDefault();
          const key = e.dataTransfer.getData("text/plain");
          if (key && key !== it.key) Promise.resolve(onMove(key, i)).catch(onError);
        };
      }
      return li;
    }),
  );
}

// Requests still being looked up / waiting for approval.
// items: [{ key, title, name, state, canCancel, canApprove }]
export function renderPending(el, items, { onApprove, onReject, onCancel, onError }) {
  el.replaceChildren(
    ...items.map((r) =>
      h("li", { className: "pending" },
        h("span", { className: "grow" }, r.title, h("small", { className: "muted", textContent: ` · ${r.name} · ${r.state}` })),
        r.canApprove ? button("Setujui", () => onApprove(r.key), { cls: "small", busy: "…", onError }) : null,
        r.canApprove ? button("Tolak", () => onReject(r.key), { cls: "small secondary", onError }) : null,
        r.canCancel ? button("Batal", () => onCancel(r.key), { cls: "small secondary", onError }) : null,
      ),
    ),
  );
}

export function renderUpcoming(el, list) {
  el.replaceChildren(
    ...(list.length
      ? list.map((t, i) => h("li", {}, h("span", { className: "q-num muted", textContent: i + 1 }), art(t.art), h("div", { className: "q-text" }, h("b", { textContent: t.title }), h("span", { className: "muted", textContent: t.artist }))))
      : [h("li", { className: "muted empty", textContent: "Tidak ada." })]),
  );
}

let qrFor = "";
export async function renderQR(img, link) {
  if (qrFor === link) return;
  qrFor = link;
  const QR = await import("qrcode");
  img.src = await QR.toDataURL(link, { margin: 1, width: 220, color: { dark: "#000000", light: "#ffffff" } });
}
