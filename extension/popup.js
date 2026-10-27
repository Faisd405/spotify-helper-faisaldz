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

chrome.storage.local.get("name").then(({ name }) => ($("#name").value = name ?? ""));
$("#name").oninput = () => chrome.storage.local.set({ name: $("#name").value.trim() });

render();
setInterval(render, 1000);
