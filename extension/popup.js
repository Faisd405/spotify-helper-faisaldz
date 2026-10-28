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

chrome.storage.local.get("name").then(({ name }) => ($("#name").value = name ?? ""));
$("#name").oninput = () => chrome.storage.local.set({ name: $("#name").value.trim() });

render();
setInterval(render, 1000);
