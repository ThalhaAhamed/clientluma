const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const LABEL = { pain_point: "Pain", objection: "Objection", buying_signal: "Buying", requirement: "Requirement", question: "Question", risk: "Risk" };
const bridge = window.miaOverlay; // present inside the Electron overlay, absent in a normal browser tab

let sessionId = null, ws = null, current = null;
let finishing = false;
let lensEnabled = true;
let callStatus = "";

// ---- window controls
if (bridge) {
  $("#controls").hidden = false;
  bridge.info().then((i) => { if (!i?.protected) { $("#shield").textContent = "Visible to screen sharing"; $("#shield").classList.add("off"); } });
  bridge.onClickThrough((on) => $("#ctBtn").classList.toggle("on", on));
} else {
  $("#shield").hidden = true;
}
$("#hideBtn").onclick = () => bridge?.hide();
$("#ctBtn").onclick = () => bridge?.setClickThrough(!$("#ctBtn").classList.contains("on"));
const OPACITY = [1, 0.85, 0.65];
let op = 0;
$("#opBtn").onclick = () => { op = (op + 1) % OPACITY.length; bridge?.setOpacity(OPACITY[op]); };

// Follow the selected desktop call, or the newest call in a browser preview.
const pinned = new URLSearchParams(location.search).get("session");
async function poll() {
  try {
    const live = await fetch("/api/live").then((r) => r.json());
    const call = live.find((item) => item.source === "meetstream" && (!pinned || item.id === pinned));
    const next = call?.id || null;
    if (next !== sessionId && (next || !finishing)) connect(next, call);
  } catch { /* server restarting */ }
}
setInterval(poll, 2000);
poll();

function reset() {
  current = null;
  for (const id of ["#say", "#heardTile", "#signal"]) $(id).hidden = true;
}

async function connect(id, info) {
  ws?.close(); ws = null; sessionId = id; reset();
  finishing = false;
  $("#finishedReport").hidden = true;
  $("#dot").classList.toggle("live", Boolean(id));
  if (!id) { $("#client").textContent = "Client Lens"; $("#status").textContent = "Waiting for a Meeting bot call…"; return; }
  $("#client").textContent = info.client;
  callStatus = "Meeting bot";
  setLens(info.lensEnabled);
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws?session=${id}`);
  ws.onmessage = (ev) => {
    if (id !== sessionId) return;
    const { type, data } = JSON.parse(ev.data);
    if (type === "hello") {
      setLens(data.lensEnabled);
      const suggestion = data.suggestions.find((item) => item.id === data.lensCue);
      if (lensEnabled && suggestion?.status === "new") showSuggestion(suggestion);
      if (data.bot) setBot(data.bot);
    }
    if (type === "lens") setLens(data);
    if (lensEnabled && type === "utterance" && data.role === "client" && data.substantive !== false) heard(data);
    if (lensEnabled && type === "signal") showSignal(data);
    if (lensEnabled && type === "suggestion") showSuggestion(data, true);
    if (type === "bot") setBot(data);
    if (type === "status" && data === "ending") {
      finishing = true;
      reset();
      $("#status").textContent = "Building report…";
      $("#dot").classList.remove("live");
    }
    if (type === "ended" || type === "cancelled") {
      finishing = true;
      reset();
      $("#status").textContent = type === "ended" ? "Call ended · report ready" : data?.label || "Call ended";
      $("#dot").classList.remove("live");
      if (type === "ended" && !bridge) {
        $("#finishedReport").href = `/?session=${encodeURIComponent(id)}`;
        $("#finishedReport").hidden = false;
      }
    }
  };
}

function setLens(enabled) {
  lensEnabled = enabled;
  if (!enabled) reset();
  $("#status").textContent = enabled ? callStatus : "Client Lens off";
}
function setBot(b) {
  callStatus = b.label;
  $("#status").title = b.label;
  if (lensEnabled) $("#status").textContent = callStatus;
}
function heard(u) { $("#heardTile").hidden = false; $("#heard").innerHTML = `<q>${esc(u.text)}</q>`; }

function showSignal(s) {
  const el = $("#signal");
  $("#heardTile").hidden = false;
  el.hidden = false;
  el.innerHTML = `<span class="tag t-${esc(s.type)}">${esc(LABEL[s.type])}</span><span>${esc(s.summary)}</span>`;
}

function showSuggestion(s, fresh) {
  current = s;
  const say = $("#say");
  say.hidden = false;
  say.className = `tile say ${s.priority === "high" ? "high" : ""} ${fresh ? "fresh" : ""}`;
  $("#sayTitle").textContent = s.title;
  const sourced = Boolean(s.sources?.length);
  $("#sayText").hidden = sourced;
  $("#sayText").textContent = sourced ? "" : s.text;
  $("#sourceBtn").hidden = !sourced;
  if (sourced) $("#sourceBtn").href = `/?session=${encodeURIComponent(sessionId)}&cue=${encodeURIComponent(s.id)}`;
}

$("#sourceBtn").onclick = event => {
  if (!bridge || !current || !sessionId) return;
  event.preventDefault();
  bridge.openCue(sessionId, current.id).catch(() => {});
};

function mark(status) {
  if (!current || !sessionId) return;
  fetch(`/api/sessions/${sessionId}/suggestions/${current.id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }) }).catch(() => {});
  current = null;
  $("#say").hidden = true;
}
$("#usedBtn").onclick = () => mark("used");
$("#skipBtn").onclick = () => mark("dismissed");
