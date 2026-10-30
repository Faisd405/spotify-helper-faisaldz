const $ = (s) => document.querySelector(s);
const SUPPORTED = /^https:\/\/(www\.youtube\.com|music\.youtube\.com|open\.spotify\.com)\//;

const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

// Accepts "ABC234" or a share link like https://…/?room=ABC234
const parseCode = (v) => (v.match(/room=([A-Za-z0-9]{6})/)?.[1] ?? v.trim()).toUpperCase();

async function render() {
  const { room, status } = await chrome.storage.local.get(["room", "status"]);
  if (room && document.activeElement !== $("#room")) $("#room").value = room;
  const age = status ? Math.round((Date.now() - status.at) / 1000) : null;
  const site = status?.site === "spotify" ? "Spotify" : "YouTube";
  $("#status").textContent = !room
    ? status ? `${site}: ${status.text}` : "Belum bergabung ke room." // e.g. why it stopped
    : status && age < 10
      ? `${site}: ${status.text}`
      : `Room ${room}: menunggu tab YouTube/Spotify…`;
  const pos = room && age < 10 ? status?.pos : null;
  $("#time").textContent = pos
    ? `Host ${mmss(pos.host)} · Anda ${mmss(pos.me)} / ${mmss(pos.dur)}  (selisih ${(pos.me - pos.host).toFixed(1)} dtk)`
    : "";
}

$("#join").onclick = async () => {
  const code = parseCode($("#room").value);
  if (!/^[A-Z0-9]{6}$/.test(code)) return ($("#status").textContent = "Kode room harus 6 huruf/angka.");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!SUPPORTED.test(tab?.url ?? "")) return ($("#status").textContent = "Buka YouTube, YouTube Music, atau open.spotify.com di tab ini dulu.");
  await chrome.storage.local.remove("status");
  await chrome.storage.local.set({ room: code, tabId: tab.id });
  render();
};

$("#leave").onclick = async () => {
  await chrome.storage.local.remove(["room", "tabId", "status"]);
  $("#room").value = "";
  render();
};

// ---------- Song requests (same data and rules as the web listener's request panel) ----------

const auth = () => chrome.runtime.sendMessage({ type: "auth" });
const STATE = (r) => (r.status === "queued" ? "di queue" : r.status === "notfound" ? "tidak ketemu" : r.track ? "menunggu host" : "mencari…");

async function loadRequests() {
  const { room } = await chrome.storage.local.get("room");
  $("#requests").hidden = !room;
  if (!room) return;
  const a = await auth();
  if (!a?.idToken) return;
  const res = await fetch(`${DB_URL}/requests/${room}.json?auth=${a.idToken}`);
  if (!res.ok) return; // e.g. kicked: the rules deny reads
  const reqs = Object.entries((await res.json()) ?? {}).sort(([, x], [, y]) => x.at - y.at);
  // Names and request text come from other people: textContent only.
  $("#req-list").replaceChildren(
    ...reqs.map(([id, r]) => {
      const li = document.createElement("li");
      const span = document.createElement("span");
      span.textContent = r.track ? `${r.track.title} — ${r.track.artist}` : r.text;
      span.append(Object.assign(document.createElement("small"), { textContent: ` · ${r.name} · ${STATE(r)}` }));
      li.append(span);
      if (r.by === a.uid && r.status !== "queued") {
        const cancel = Object.assign(document.createElement("button"), { type: "button", textContent: "Batal" });
        cancel.onclick = async () => {
          await fetch(`${DB_URL}/requests/${room}/${id}.json?auth=${a.idToken}`, { method: "DELETE" });
          loadRequests();
        };
        li.append(cancel);
      }
      return li;
    }),
  );
}

$("#req-form").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("#req-text").value.trim();
  const { room, name, displayName } = await chrome.storage.local.get(["room", "name", "displayName"]);
  const a = await auth();
  if (!text || !room) return;
  if (!a?.idToken) return ($("#status").textContent = `Request gagal: ${a?.error ?? "tidak bisa login ke Firebase"}`);
  const res = await fetch(`${DB_URL}/requests/${room}.json?auth=${a.idToken}`, {
    method: "POST", // REST POST = push(): Firebase picks the id
    body: JSON.stringify({ by: a.uid, name: (name || displayName || "Pendengar").slice(0, 40), text, at: { ".sv": "timestamp" } }),
  });
  if (!res.ok) return ($("#status").textContent = `Request gagal (HTTP ${res.status})`);
  $("#req-text").value = "";
  loadRequests();
};

loadRequests();
setInterval(loadRequests, 3000);

// ---------- Room view (Jam-style): now playing, members, shared queue, guest controls ----------

const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids.filter((k) => k != null));
  return e;
};
const COLORS = ["#e91e63", "#9c27b0", "#3f51b5", "#03a9f4", "#009688", "#8bc34a", "#ff9800", "#ff5722"];
function av(name = "?", url = null) {
  if (url) {
    const img = el("img", { className: "av", src: url, alt: "", title: name });
    img.onerror = () => img.replaceWith(av(name, null));
    return img;
  }
  const hash = [...name].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7);
  return el("span", { className: "av", title: name, textContent: name.trim().slice(0, 1).toUpperCase(), style: `background:${COLORS[hash % COLORS.length]}` });
}
const cover = (url) => (url ? el("img", { src: url, alt: "" }) : el("span", { className: "ph" }));

let roomCache = null;
async function loadRoom() {
  const { room } = await chrome.storage.local.get("room");
  $("#room-view").hidden = !room;
  if (!room) return;
  const a = await auth();
  if (!a?.idToken) return;
  const get = (p) => fetch(`${DB_URL}/${p}.json?auth=${a.idToken}`).then((r) => (r.ok ? r.json() : null));
  const [info, listeners, queue] = await Promise.all([get(`rooms/${room}`), get(`listeners/${room}`), get(`queues/${room}`)]);
  if (!info) return;
  roomCache = { room, info, uid: a.uid, token: a.idToken };
  const t = info.track;
  $("#np").replaceChildren(...(t
    ? [cover(t.art), el("div", { className: "np-t" }, el("b", { textContent: t.title }), el("span", { textContent: t.artist, style: "opacity:.65;font-size:12px" }))]
    : [el("span", { textContent: "Host belum memutar lagu.", style: "opacity:.65" })]));
  $("#ctrls").hidden = !(t && info.settings?.guestControl);

  const now = Date.now();
  const people = [{ name: info.host?.name ?? "Host", avatar: info.host?.avatar }]
    .concat(Object.entries(listeners ?? {}).filter(([u, l]) => u !== info.hostUid && now - l.at < 60_000).map(([, l]) => l));
  $("#members").replaceChildren(el("span", { className: "stack" }, ...people.slice(0, 6).map((m) => av(m.name, m.avatar))), el("span", { textContent: `${people.length} di room`, style: "margin-left:8px" }));

  const items = Object.entries(queue ?? {}).map(([key, v]) => ({ key, ...v })).sort((x, y) => x.order - y.order || x.at - y.at);
  $("#queue").replaceChildren(...(items.length
    ? items.map((it) => el("li", {}, cover(it.art), el("div", { className: "q-t" }, el("b", { textContent: it.title }), el("span", { textContent: it.artist })), av(it.name, it.avatar),
        it.by === a.uid || info.settings?.guestControl ? Object.assign(el("button", { type: "button", textContent: "✕", title: "Hapus" }), {
          onclick: async () => { await fetch(`${DB_URL}/queues/${room}/${it.key}.json?auth=${a.idToken}`, { method: "DELETE" }); loadRoom(); },
        }) : null))
    : [el("li", { textContent: "Antrian room kosong.", style: "opacity:.6" })]));
}

// Guest controls: commands the host's app carries out (only while the host allows it; rules enforce that too).
for (const b of document.querySelectorAll("#ctrls button")) {
  b.onclick = async () => {
    if (!roomCache) return;
    const a = b.dataset.a === "toggle" ? (roomCache.info.track?.isPlaying ? "pause" : "play") : b.dataset.a;
    b.disabled = true;
    const res = await fetch(`${DB_URL}/commands/${roomCache.room}.json?auth=${roomCache.token}`, {
      method: "POST",
      body: JSON.stringify({ by: roomCache.uid, a, at: { ".sv": "timestamp" } }),
    });
    b.disabled = false;
    if (!res.ok) $("#status").textContent = `Perintah ditolak (HTTP ${res.status}).`;
    setTimeout(loadRoom, 800);
  };
}

loadRoom();
setInterval(loadRoom, 2000);

chrome.storage.local.get("name").then(({ name }) => ($("#name").value = name ?? ""));
$("#name").oninput = () => chrome.storage.local.set({ name: $("#name").value.trim() });

render();
setInterval(render, 1000);
