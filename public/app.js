// ClientLuma dashboard.
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { "Content-Type": "application/json" }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(json.error || res.statusText), { status: res.status });
  return json;
};
const LABEL = { pain_point: "Pain point", objection: "Objection", buying_signal: "Buying signal", requirement: "Requirement", question: "Question", risk: "Risk" };
const SOURCES = { demo: "Simulated call", agent_test: "Two-agent test", agent_meet: "Two-agent test in Meet", browser: "Microphone", meetstream: "MeetStream bot", mia: "MIA agent", practice: "Practice call", replay: "Recording replay" };
const OWNERS = { us: "Our team", client: "Client", both: "Both" };

const state = { clients: [], client: null, session: null, ws: null, signals: [], filters: new Set(), recog: null };

// ---------------- navigation
function show(view) {
  $$(".steps button").forEach((b) => b.classList.toggle("active", b.dataset.view === view));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${view}`));
  if (view === "settings") loadSettings().catch(showError);
  if (view === "home") {
    history.replaceState(null, "", location.pathname);
    refreshWorkspace().catch(showError);
  }
}
$$(".steps button").forEach((b) => b.addEventListener("click", () => show(b.dataset.view)));
$("#prepareCall").onclick = () => show("prep");
$("#refreshWorkspace").onclick = () => refreshWorkspace().catch(showError);

const showError = (error) => toast({ kind: "error", title: "Could not complete that action", text: error.message });
const dateLabel = (date) => new Date(date).toLocaleString();

async function openSavedSession(id) {
  if (state.session?.id === id) {
    show("live");
    window.clientLuma?.showOverlay(id).catch(showError);
    return;
  }
  let session;
  try { session = await api(`/api/sessions/${encodeURIComponent(id)}`); }
  catch (error) { if (error.status !== 404) throw error; }
  if (session) {
    await selectClient(session.clientId);
    beginLive(session, session.source);
  } else {
    const meeting = await api(`/api/meetings/${encodeURIComponent(id)}`);
    await selectClient(meeting.client_id);
    showReport(meeting);
  }
}

async function refreshWorkspace() {
  const { active, recent, followUps, demoClientId } = await api("/api/workspace");
  const empty = (text) => `<li class="muted">${text}</li>`;
  const links = (items, action) => items.map((item) => `<li><div><b>${esc(item.client)}</b><span>${esc(SOURCES[item.source] || item.source)} · ${esc(dateLabel(item.started_at))}</span></div><a class="btn sm" href="?session=${encodeURIComponent(item.id)}" data-session="${esc(item.id)}">${action}</a></li>`).join("");
  $("#workspaceCalls").innerHTML = links(active, "Resume") || empty("No calls in progress.");
  $("#workspaceReports").innerHTML = links(recent, "Open report") || empty("Completed calls will appear here.");
  $("#workspaceFollowUps").innerHTML = followUps.map((item) => `<li><div><b>${esc(item.text)}</b><span>${esc(item.client)} · ${esc(OWNERS[item.owner] || item.owner)}${item.due ? ` · ${esc(item.due)}` : ""}</span></div><button class="btn sm" data-client="${esc(item.clientId)}">Review</button></li>`).join("") || empty("No open follow-ups.");
  $$("#view-home [data-session]").forEach((link) => link.onclick = (event) => { event.preventDefault(); openSavedSession(link.dataset.session).catch(showError); });
  $$("#workspaceFollowUps [data-client]").forEach((button) => button.onclick = () => selectClient(button.dataset.client).then(() => show("prep")).catch(showError));
  $("#demoCall").onclick = $("#welcomeDemo").onclick = async (event) => {
    const button = event.currentTarget; button.disabled = true;
    try {
      if (!state.settings?.ready) await updateSettings({ MIA_PROVIDER: "offline" });
      await selectClient(demoClientId);
      await launchCall("demo");
    }
    catch (error) { showError(error); }
    finally { button.disabled = false; }
  };
}

const settingsForm = $("#settingsForm");
const secretNames = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "MEETSTREAM_API_KEY"];
for (const key of secretNames) {
  const button = Object.assign(document.createElement("button"), { type: "button", className: "btn sm", textContent: "Remove saved key", hidden: true });
  button.dataset.removeKey = key;
  settingsForm.elements[key].parentElement.append(button);
  button.onclick = async () => {
    try { await updateSettings({ clear: [key] }); $("#settingsStatus").textContent = "Key removed."; }
    catch (error) { $("#settingsStatus").textContent = error.message; }
  };
}
$("#welcomeSetup").onclick = () => show("settings");
$("#settingsBack").onclick = () => show("home");

function renderSettings(settings) {
  state.settings = settings;
  $("#welcome").hidden = settings.ready;
  $("#callbackHelp").textContent = settings.desktop
    ? `Point your HTTPS tunnel at ${settings.callbackTarget}. Paste its public origin here.`
    : "Use a public HTTPS tunnel to reach your local server.";
  settingsForm.elements.MIA_PROVIDER.value = settings.ready ? settings.provider : "offline";
  settingsForm.elements.PUBLIC_URL.value = settings.callbackUrl;
  for (const key of ["MIA_PROVIDER", "PUBLIC_URL", ...secretNames]) {
    const field = settingsForm.elements[key];
    field.disabled = settings.managed.includes(key);
    field.title = field.disabled ? "Managed by the server environment" : "";
    if (secretNames.includes(key)) {
      field.value = "";
      field.placeholder = settings.configured[key] ? "Configured" : "Optional";
      $(`[data-remove-key="${key}"]`).hidden = !settings.configured[key] || field.disabled;
    }
  }
}
async function loadSettings() { renderSettings(await api("/api/settings")); }
async function updateSettings(body) {
  renderSettings(await api("/api/settings", { method: "PUT", body }));
  await loadStatus();
}
settingsForm.onsubmit = async (event) => {
  event.preventDefault();
  const button = event.submitter;
  button.disabled = true;
  $("#settingsStatus").textContent = "Saving…";
  try {
    const body = Object.fromEntries(new FormData(settingsForm));
    const required = { gemini: "GEMINI_API_KEY", claude: "ANTHROPIC_API_KEY" }[body.MIA_PROVIDER];
    if (required && !body[required]?.trim() && !state.settings?.configured[required]) throw new Error("Enter an API key for the selected engine.");
    await updateSettings(body);
    $("#settingsStatus").textContent = "Settings saved.";
    show("home");
  } catch (error) { $("#settingsStatus").textContent = error.message; }
  finally { button.disabled = false; }
};

$("#importReplay").hidden = !window.clientLuma;
$("#importReplay").onclick = async (event) => {
  if (!state.client) return toast({ title: "Save a client first", text: "The recording will be linked to that client." });
  const clientId = state.client.id;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const replay = await window.clientLuma.chooseReplay();
    if (!replay) return;
    const { segments } = await api(`/api/clients/${encodeURIComponent(clientId)}/replay`, { method: "POST", body: replay });
    if (state.client?.id === clientId) {
      await selectClient(clientId);
      $("#replaySource input").checked = true;
      $("#replaySource input").dispatchEvent(new Event("change"));
    }
    toast({ kind: "saved", title: "Replay imported", text: `${segments} transcript segments are ready to play.` });
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
};

// ---------------- status
const sourceText = new Map(["#agentTestSource", "#agentMeetSource", "#msSource", "#miaSource", "#practiceSource"].map((id) => [id, $(`${id} span`).textContent]));
if (window.clientLuma) $("#browserSourceText").textContent = "Type lines as they are spoken to test coaching without a bot.";
async function loadStatus() {
  const s = await api("/api/status");
  const el = $("#engine");
  el.textContent = s.engine === "offline" ? "Local coaching" : `AI: ${s.engine}`;
  el.classList.toggle("off", s.engine === "offline");
  $("#workspaceSetup").innerHTML = `<div><dt>Coaching engine</dt><dd>${esc(s.engine === "offline" ? "Local rules" : s.engine)}</dd></div><div><dt>MeetStream key</dt><dd>${s.meetstream ? "Configured" : "Add in Settings"}</dd></div><div><dt>Callback URL</dt><dd>${s.webhook ? "Configured" : "Add in Settings"}</dd></div>`;
  const ai = s.engine !== "offline";
  const meeting = s.meetstream && s.webhook;
  const disabled = {
    "#agentTestSource": ai ? "" : "Choose an AI engine and add its key in Settings.",
    "#agentMeetSource": ai && meeting ? "" : "Configure an AI engine, MeetStream key and callback URL in Settings.",
    ...Object.fromEntries(["#msSource", "#miaSource", "#practiceSource"].map((id) => [id, meeting ? "" : "Add a MeetStream key and callback URL in Settings."])),
  };
  for (const [id, reason] of Object.entries(disabled)) {
    $(id).classList.toggle("disabled", Boolean(reason));
    $(`${id} input`).disabled = Boolean(reason);
    $(`${id} span`).textContent = reason || sourceText.get(id);
  }
  if ($('input[name="source"]:checked')?.disabled) {
    const local = $('input[value="demo"]');
    local.checked = true;
    local.dispatchEvent(new Event("change"));
  }
  if (meeting && s.mia_agent) {
    const a = s.mia_agent;
    $("#miaSourceText").textContent = `Hosted MeetStream agent (${a.llm}, ${a.mode}). Silent until someone says "${a.wake_words[0] || "MIA"}", then answers from this client's memory.`
      + (a.last_error ? ` Last setup error: ${a.last_error}` : "");
  }
}

// ---------------- clients
async function loadClients(selectId) {
  state.clients = await api("/api/clients");
  const list = $("#clientList");
  list.innerHTML = state.clients.map((c) => `
    <li data-id="${c.id}" class="${c.id === (selectId || state.client?.id) ? "active" : ""}">
      <b>${esc(c.company || c.name)}${c.profile?.deal_stage ? `<span class="stage">${esc(c.profile.deal_stage.replace("_", " "))}</span>` : ""}</b>
      <span>${esc(c.name)} · ${(c.meetings || []).length} meeting${(c.meetings || []).length === 1 ? "" : "s"}</span>
    </li>`).join("") || `<li class="muted">No clients yet</li>`;
  $$("li[data-id]", list).forEach((li) => li.addEventListener("click", () => selectClient(li.dataset.id)));
  const id = selectId || state.client?.id || state.clients[0]?.id;
  if (id) await selectClient(id);
}

async function selectClient(id) {
  const c = await api(`/api/clients/${id}`);
  state.client = c;
  $$("#clientList li").forEach((li) => li.classList.toggle("active", li.dataset.id === id));
  const f = $("#clientForm");
  for (const k of ["id", "name", "company", "industry", "deal", "offering", "notes"]) f.elements[k].value = c[k] || "";
  f.elements.local_only.checked = Boolean(c.local_only);
  f.elements.contacts.value = (c.contacts || []).map((x) => `${x.name}${x.role ? " - " + x.role : ""}`).join("\n");
  showReplaySource(c.recording_available);
  renderDocs(); renderProfile(); renderKb(c.kb, c.kb_engine); renderHistory();
}

$("#newClient").addEventListener("click", () => {
  state.client = null;
  showReplaySource(false);
  $("#clientForm").reset(); $("#clientForm").elements.id.value = "";
  $$("#clientList li").forEach((li) => li.classList.remove("active"));
  renderDocs(); renderProfile(); renderKb(null); renderHistory(); show("prep");
  $("#clientForm").elements.name.focus();
});

$("#clientForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    id: f.id.value || undefined, name: f.name.value, company: f.company.value, industry: f.industry.value,
    deal: f.deal.value, offering: f.offering.value, notes: f.notes.value, local_only: f.local_only.checked,
    contacts: f.contacts.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, ...role] = l.split(/\s+-\s+|,\s*/); return { name: name.trim(), role: role.join(" ").trim() };
    }),
  };
  const c = await api("/api/clients", { method: "POST", body });
  toast({ kind: "saved", title: "Client saved", text: c.company || c.name });
  await loadClients(c.id);
});

$("#deleteClient").addEventListener("click", async () => {
  if (!state.client || !confirm(`Delete ${state.client.name}? This removes the profile.`)) return;
  await api(`/api/clients/${state.client.id}`, { method: "DELETE" });
  state.client = null; await loadClients();
});

// ---------------- documents
function renderDocs() {
  const docs = state.client?.documents || [];
  $("#docList").innerHTML = docs.map((d, i) => `<li><span>📄 ${esc(d.name)} <span class="hint">${d.text.length < 1000 ? d.text.length : Math.round(d.text.length / 1000) + "k"} chars</span></span><button data-i="${i}" title="Remove">✕</button></li>`).join("");
  $$("#docList button").forEach((b) => b.addEventListener("click", async () => {
    state.client = await api(`/api/clients/${state.client.id}/documents/${b.dataset.i}`, { method: "DELETE" }); renderDocs();
  }));
}
async function uploadFiles(files) {
  if (!state.client) return toast({ kind: "note", title: "Save the client first", text: "Then add documents to it." });
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) { toast({ kind: "error", title: "File too large", text: `${file.name} is over 20 MB.` }); continue; }
    drop.classList.add("busy");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      state.client = await api(`/api/clients/${state.client.id}/documents`, { method: "POST", body: { name: file.name, data: btoa(bin) } });
      toast({ kind: "document added", title: file.name, text: "Regenerate the knowledge base to include it." });
    } catch (err) { toast({ kind: "error", title: `Could not read ${file.name}`, text: err.message }); }
    finally { drop.classList.remove("busy"); }
  }
  renderDocs();
  $("#fileInput").value = "";
}
$("#fileInput").addEventListener("change", (e) => uploadFiles(e.target.files));
const drop = $("#drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); uploadFiles(e.dataTransfer.files); });

// ---------------- knowledge base
function renderProfile() {
  const p = state.client?.profile;
  const html = !p ? `<p class="empty">Client insights appear here after a completed call.</p>` : `
    <div class="profile">
      <h4>From ${state.client.meetings?.length || 0} past meeting(s) <span class="stage">${esc(p.deal_stage.replace("_", " "))}</span></h4>
      <p>${esc(p.summary)}</p>
      ${p.known_pain_points?.length ? `<div class="chips">${p.known_pain_points.map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div>` : ""}
      ${p.open_objections?.length ? `<p class="small muted" style="margin-top:8px">Open objections: ${p.open_objections.map(esc).join(" · ")}</p>` : ""}
    </div>`;
  $("#profileBox").innerHTML = html;
  const followUps = $("#clientFollowUps");
  const client = state.client;
  const items = client?.commitments || [];
  followUps.hidden = !client;
  followUps.innerHTML = `<h4>Follow-ups</h4><ul class="workflow-list">${items.map((item) => `<li><div><b>${esc(item.text)}</b><span>${esc(OWNERS[item.owner] || item.owner)}${item.due ? ` · ${esc(item.due)}` : ""}</span></div><button class="btn sm" data-id="${esc(item.id)}" data-status="${item.status === "done" ? "open" : "done"}">${item.status === "done" ? "Reopen" : "Mark done"}</button></li>`).join("") || '<li class="muted">Track a next step from a completed call report.</li>'}</ul>`;
  $$("button[data-id]", followUps).forEach((button) => button.onclick = async () => {
    button.disabled = true;
    try {
      const value = await api(`/api/clients/${client.id}/follow-ups/${button.dataset.id}`, { method: "PATCH", body: { status: button.dataset.status } });
      if (state.client?.id === client.id) {
        const item = state.client.commitments.find((x) => x.id === value.id);
        if (item) Object.assign(item, value);
        renderProfile();
      }
    } catch (error) { showError(error); button.disabled = false; }
  });
}

const initials = (n) => String(n || "?").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase();
const KB_TILES = ["#kbGoals", "#kbPains", "#kbObjections", "#kbAsk", "#kbTheirQs", "#kbStake", "#kbExpect"];

function renderKb(kb, engine) {
  const sum = $("#kbSummary");
  if (!kb) {
    sum.className = "kb-summary empty";
    sum.textContent = "Save the client, then generate a knowledge base of likely pain points, expectations, objections and questions.";
    for (const id of KB_TILES) $(id).innerHTML = "";
    for (const id of ["#kbPains", "#kbObjections", "#kbTheirQs"]) $(id).innerHTML = `<p class="empty">Appears after you generate the knowledge base.</p>`;
    $("#kbMini").innerHTML = "";
    return;
  }
  sum.className = "kb-summary";
  sum.innerHTML = `${esc(kb.summary)}${engine ? `<span class="hint">Generated by ${esc(engine)}</span>` : ""}`;
  $("#kbGoals").innerHTML = kb.goals_for_call.map((g, i) => `<div class="goal"><span class="label">Goal ${i + 1}</span>${esc(g)}</div>`).join("");
  $("#kbPains").innerHTML = kb.pain_points.map((p) => `<div class="kb-item"><b>${esc(p.title)}</b><p>${esc(p.detail)}</p><i>Ask: ${esc(p.probe_question)}</i></div>`).join("");
  $("#kbObjections").innerHTML = kb.likely_objections.map((o) => `<div class="kb-item"><b>${esc(o.objection)}</b><i>${esc(o.response)}</i></div>`).join("");
  $("#kbAsk").innerHTML = kb.questions_to_ask.map((x) => `<li>${esc(x)}</li>`).join("");
  $("#kbTheirQs").innerHTML = kb.questions_they_may_ask.map((q) => `<div class="kb-item"><b>${esc(q.question)}</b><i>${esc(q.suggested_answer)}</i></div>`).join("");
  $("#kbStake").innerHTML = (kb.stakeholders || []).map((s) => `<div class="person"><span class="avatar">${esc(initials(s.name))}</span><div><b>${esc(s.name)}</b><span>${esc(s.role)} · ${esc(s.likely_priorities)}</span></div></div>`).join("") || `<p class="empty">No stakeholders listed.</p>`;
  $("#kbExpect").innerHTML = kb.expectations.length ? `<span class="label">They expect</span><ul class="plain-list" style="margin-top:6px">${kb.expectations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  $("#kbMini").innerHTML = `
    <h4>Goals</h4><ul>${kb.goals_for_call.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <details><summary>Questions to ask</summary><ul>${kb.questions_to_ask.map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>
    <details><summary>Objection handling</summary><ul>${kb.likely_objections.map((o) => `<li><b>${esc(o.objection)}:</b> ${esc(o.response)}</li>`).join("")}</ul></details>`;
}

$("#genKb").addEventListener("click", async (e) => {
  if (!state.client) return toast({ kind: "note", title: "Save the client first", text: "Fill in client information and save." });
  const b = e.target; b.disabled = true; b.textContent = "Generating…";
  try { const c = await api(`/api/clients/${state.client.id}/kb`, { method: "POST" }); state.client = { ...state.client, ...c }; renderKb(c.kb, c.kb_engine); }
  catch (err) { toast({ kind: "error", title: "Could not generate", text: err.message }); }
  finally { b.disabled = false; b.textContent = "Regenerate knowledge base"; }
});

// ---------------- start call
function showReplaySource(available) {
  $("#replaySource").hidden = !available;
  if (!available && $("#replaySource input").checked) {
    $('input[value="demo"]').checked = true;
    $('input[value="demo"]').dispatchEvent(new Event("change"));
  }
}

$$('input[name="source"]').forEach((r) => r.addEventListener("change", () => {
  const v = $('input[name="source"]:checked').value;
  $("#repNameWrap").hidden = ["agent_test", "agent_meet", "replay"].includes(v);
  $("#linkWrap").hidden = !["meetstream", "mia", "practice", "agent_meet"].includes(v);
  $("#speedWrap").hidden = v !== "demo";
}));

$("#startCall").addEventListener("click", async (e) => {
  if (!state.client) return toast({ kind: "note", title: "Pick a client first", text: "Select or create a client." });
  const source = $('input[name="source"]:checked').value;
  const b = e.target; b.disabled = true; b.textContent = state.client.kb ? "Starting…" : "Building knowledge base…";
  try { await launchCall(source); }
  catch (err) { toast({ kind: "error", title: "Could not start", text: err.message }); }
  finally { b.disabled = false; b.textContent = "Start live analysis →"; }
});

async function launchCall(source) {
  const s = await api("/api/sessions", { method: "POST", body: { clientId: state.client.id, source, repName: $("#repName").value, meetingLink: $("#meetingLink").value, speedMs: Number($("#demoSpeed").value) } });
  if (state.client?.id !== s.clientId) await selectClient(s.clientId);
  state.client.kb = s.kb;
  renderKb(s.kb);
  beginLive(s, source, true);
}

// ---------------- live
function beginLive(s, source, fresh = false) {
  state.replay?.stop();
  stopMic();
  state.ws?.close();
  state.session = { id: s.id, source };
  window.clientLuma?.showOverlay(s.id).catch(showError);
  history.replaceState(null, "", `?session=${encodeURIComponent(s.id)}`);
  state.signals = []; state.filters.clear();
  $("#transcript").innerHTML = ""; $("#signals").innerHTML = "";
  $("#suggestions").innerHTML = `<p class="muted small">Suggestions appear here and as pop-ups as the client speaks.</p>`;
  $("#liveClient").textContent = state.client.company || state.client.name;
  $("#liveSource").textContent = ` · ${SOURCES[source] || source}`;
  $("#micBtn").hidden = source !== "browser" || Boolean(window.clientLuma);
  $("#botStatus").hidden = true;
  $("#endCall").disabled = false; $(".dot.rec").style.display = "";
  setPulse({ sentiment: "neutral", deal_temperature: 50 });
  renderFilters(); show("live");

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?session=${s.id}`);
  state.ws = ws;
  ws.onmessage = (ev) => {
    const { type, data } = JSON.parse(ev.data);
    if (type === "hello") {
      data.transcript.forEach((u) => addUtt(u)); data.signals.forEach(addSignal); data.suggestions.forEach((x) => addSuggestion(x, false));
      if (data.bot) setBot(data.bot);
      if (data.status === "ending") { $("#endCall").disabled = true; $("#endCall").textContent = "Building report…"; }
    }
    if (type === "bot") { setBot(data); if (data.failed) toast({ kind: source === "agent_test" ? "AI test" : "MeetStream", title: data.label, text: data.message || "", priority: "high" }); }
    if (type === "commitment") toast({ kind: "commitment logged", title: data.commitment, text: `Owner: ${data.owner === "us" ? "our team" : "client"} · due ${data.due}` });
    if (type === "agent_tool" && data.name !== "log_commitment") toast({ kind: "MIA agent", title: data.name === "search_client_history" ? `Searched history: ${data.args.query || ""}` : "Looked up client context", text: data.ok ? "Answering from client memory" : "Lookup failed" });
    if (type === "status" && data === "ending") { $("#endCall").disabled = true; $("#endCall").textContent = "Building report…"; }
    if (type === "utterance") addUtt(data, true);
    if (type === "signal") addSignal(data);
    if (type === "suggestion") addSuggestion(data, true);
    if (type === "pulse") setPulse(data);
    if (type === "analyzing") $("#thinking").hidden = !data;
    if (type === "ended") showReport(data);
    if (type === "cancelled") {
      $("#endCall").disabled = true;
      $(".dot.rec").style.display = "none";
      setBot({ label: data?.label || "Call ended", message: data?.message });
    }
  };
  if (source === "browser" && fresh) startMic();
  if (source === "replay") setupReplay(s);
}

function setupReplay(session) {
  const video = $("#replayVideo");
  const play = $("#replayPlay");
  const clock = $("#replayTime");
  let position = session.replayPosition || 0;
  let sending = null;
  const formatTime = (time) => `${Math.floor(time / 60)}:${String(Math.floor(time % 60)).padStart(2, "0")}`;
  const showTime = () => {
    clock.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration || 0)}`;
  };
  const flush = async () => {
    if (sending) await sending;
    if (video.currentTime <= position) return;
    sending = api(`/api/sessions/${session.id}/replay/progress`, { method: "POST", body: { time: video.currentTime } });
    try { position = (await sending).position; }
    finally { sending = null; }
  };
  const onError = (error) => {
    video.pause();
    toast({ kind: "error", title: "Recording replay paused", text: error.message });
  };
  const updatePlay = () => { play.textContent = video.paused ? "Play recording" : "Pause recording"; };
  play.onclick = async () => {
    try { if (video.paused) await video.play(); else video.pause(); }
    catch (error) { onError(error); }
  };
  video.onloadedmetadata = () => { video.currentTime = Math.min(position, video.duration); showTime(); };
  video.onplay = updatePlay;
  video.onpause = updatePlay;
  video.ontimeupdate = () => {
    showTime();
    if (!sending && video.currentTime - position >= 0.5) flush().catch(onError);
  };
  video.onended = () => $("#endCall").click();
  video.onerror = () => onError(new Error("The local recording could not be loaded."));
  state.replay = {
    flush: async () => { video.pause(); await flush(); },
    stop: () => {
      video.onloadedmetadata = video.ontimeupdate = video.onended = video.onerror = null;
      video.pause(); video.removeAttribute("src"); video.load();
      $("#replayPlayer").hidden = true;
      state.replay = null;
    },
  };
  $("#replayPlayer").hidden = false;
  updatePlay();
  video.src = `/api/sessions/${session.id}/recording`;
}

function setBot(b) {
  const el = $("#botStatus");
  el.hidden = false;
  el.textContent = ` · ${b.label}`;
  el.title = b.message || "";
  el.classList.toggle("failed", Boolean(b.failed));
}

function addUtt(u, animate) {
  const el = document.createElement("div");
  el.className = `utt ${u.role}${animate ? " new" : ""}`; el.id = `u${u.id}`;
  const at = u.recording_time === undefined ? "" : ` · ${Math.floor(u.recording_time / 60)}:${String(Math.floor(u.recording_time % 60)).padStart(2, "0")}`;
  el.innerHTML = `<div class="who">${esc(u.speaker)}${at}</div><div class="bubble">${esc(u.text)}</div><div class="tags"></div>`;
  const box = $("#transcript");
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.appendChild(el);
  if (stick) box.scrollTop = box.scrollHeight;
}

function addSignal(s) {
  state.signals.push(s);
  // tag the utterance that contains the quote
  const utt = $$(".utt").reverse().find((u) => s.quote && $(".bubble", u).textContent.includes(s.quote.slice(0, 40)));
  if (utt && $$(".tag", utt).length < 3) $(".tags", utt).insertAdjacentHTML("beforeend", `<span class="tag t-${s.type}">${LABEL[s.type]}</span>`);
  renderFilters(); renderSignals();
}

function renderFilters() {
  const counts = {}; state.signals.forEach((s) => (counts[s.type] = (counts[s.type] || 0) + 1));
  $("#sigFilters").innerHTML = Object.keys(LABEL).map((t) => `<span class="tag t-${t}${state.filters.has(t) ? " off" : ""}" data-t="${t}">${LABEL[t]} ${counts[t] || 0}</span>`).join("");
  $$("#sigFilters .tag").forEach((el) => el.addEventListener("click", () => { const t = el.dataset.t; state.filters.has(t) ? state.filters.delete(t) : state.filters.add(t); renderFilters(); renderSignals(); }));
  $("#counts").innerHTML = ["pain_point", "objection", "buying_signal"].map((t) => `<span class="tag t-${t}" title="${LABEL[t]}">${LABEL[t]} ${counts[t] || 0}</span>`).join("");
}
function renderSignals() {
  $("#signals").innerHTML = state.signals.filter((s) => !state.filters.has(s.type)).slice().reverse().map((s) =>
    `<li><span class="tag t-${s.type}">${LABEL[s.type]}</span> <b>${esc(s.summary)}</b><q>${esc(s.speaker)}: ${esc(s.quote)}</q></li>`).join("");
}

function addSuggestion(s, popup) {
  const box = $("#suggestions");
  if (box.querySelector("p.muted")) box.innerHTML = "";
  const el = document.createElement("div");
  el.className = `sug ${s.priority} ${s.status || ""}`; el.id = s.id;
  el.innerHTML = `<div class="k">${esc(s.kind.replace("_", " "))}</div><b>${esc(s.title)}</b><p>${esc(s.text)}</p><div class="why">${esc(s.why)}</div>
    <div class="btns"><button class="btn sm" data-a="used">✓ Used it</button><button class="btn sm" data-a="dismissed">Dismiss</button></div>`;
  $$("button", el).forEach((b) => b.addEventListener("click", () => {
    el.classList.add(b.dataset.a);
    api(`/api/sessions/${state.session.id}/suggestions/${s.id}`, { method: "POST", body: { status: b.dataset.a } }).catch(() => {});
  }));
  box.prepend(el);
  if (popup) toast(s);
}

function setPulse({ sentiment, deal_temperature }) {
  $("#sentiment").textContent = sentiment;
  $("#tempVal").textContent = Math.round(deal_temperature);
  $("#tempBar").style.width = `${deal_temperature}%`;
}

$("#manualForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("#manualText").value.trim();
  if (!text || !state.session) return;
  const role = $("#manualRole").value;
  sendUtt({ speaker: role === "rep" ? ($("#repName").value || "Me") : (state.client?.name || "Client"), role, text });
  $("#manualText").value = "";
});
const sendUtt = (u) => api(`/api/sessions/${state.session.id}/utterances`, { method: "POST", body: u }).catch(() => {});

// Browser microphone via the Web Speech API. Who is speaking comes from the Client/Me selector.
function startMic() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) { toast({ kind: "note", title: "Speech recognition unavailable", text: "Use Chrome or Edge, or type utterances manually." }); return; }
  const r = new SR(); r.continuous = true; r.interimResults = false; r.lang = "en-US";
  r.onresult = (ev) => {
    for (let i = ev.resultIndex; i < ev.results.length; i++) if (ev.results[i].isFinal) {
      const role = $("#manualRole").value;
      sendUtt({ speaker: role === "rep" ? ($("#repName").value || "Me") : (state.client?.name || "Client"), role, text: ev.results[i][0].transcript });
    }
  };
  r.onend = () => { if (state.recog === r) r.start(); }; // keep listening
  r.start(); state.recog = r;
  $("#micBtn").textContent = "Stop mic"; $("#micBtn").classList.add("on");
}
function stopMic() { const r = state.recog; state.recog = null; r?.stop(); $("#micBtn").textContent = "Start mic"; $("#micBtn").classList.remove("on"); }
$("#micBtn").addEventListener("click", () => (state.recog ? stopMic() : startMic()));

$("#endCall").addEventListener("click", async (e) => {
  if (!state.session) return;
  stopMic();
  const b = e.target; b.disabled = true; b.textContent = "Building report…";
  $(".dot.rec").style.display = "none";
  try {
    await state.replay?.flush();
    const m = await api(`/api/sessions/${state.session.id}/end`, { method: "POST" });
    showReport(m);
  }
  catch (err) { toast({ kind: "error", title: "Could not end call", text: err.message }); b.disabled = false; }
  finally { b.textContent = "End call & build report"; }
});

// ---------------- report
function showReport(m) {
  state.replay?.stop();
  stopMic();
  if (state.ws) { state.ws.close(); state.ws = null; }
  state.session = null;
  history.replaceState(null, "", `?session=${encodeURIComponent(m.id)}`);
  $("#endCall").textContent = "End call & build report";
  const r = m.report;
  const used = (m.suggestions || []).filter((s) => s.status === "used").length;
  const none = `<li class="muted">None captured</li>`;
  const list = (items, fn) => `<ul>${items.map(fn).join("") || none}</ul>`;
  $("#report").className = "bento bento-report report";
  $("#report").innerHTML = `
    <div class="tile s3 score">
      <span class="label">Conversion likelihood</span>
      <div class="big">${Math.round(r.conversion_likelihood)}<small>%</small></div>
      ${r.transcript_quality ? `<span class="pill q-${r.transcript_quality}">Transcript: ${r.transcript_quality}</span>` : ""}
    </div>
    <div class="tile s9">
      <div class="tile-head"><h2>${esc(state.client?.company || "Summary")}</h2><div class="actions"><button class="btn sm" id="reportBack">Back to workspace</button><button class="btn sm" id="dlReport">Download .md</button></div></div>
      <p>${esc(r.executive_summary)}</p>
      <div class="report-meta"><span>${new Date(m.started_at).toLocaleString()}</span><span>${m.transcript.length} lines</span><span>${m.signals.length} signals</span>
        <span>${used}/${m.suggestions.length} suggestions used${m.suppressed_suggestions ? ` · ${m.suppressed_suggestions} held back` : ""}</span><span>${esc(m.report_engine)}</span></div>
    </div>
    <div class="tile s12"><div class="tile-head"><h2>Client requirements</h2></div><div class="table-scroll"><table><tr><th>Requirement</th><th>Priority</th><th>Evidence</th></tr>
      ${r.client_requirements.map((x) => `<tr><td>${esc(x.requirement)}</td><td><span class="pill ${x.priority}">${x.priority}</span></td><td class="muted">${esc(x.evidence)}</td></tr>`).join("") || `<tr><td colspan="3" class="muted">None captured</td></tr>`}</table></div></div>
    <div class="tile s4"><div class="tile-head"><h2>Pain points</h2><span class="tag t-pain_point">${r.pain_points.length}</span></div>${list(r.pain_points, (p) => `<li><b>${esc(p.title)}</b> · ${esc(p.detail)}</li>`)}</div>
    <div class="tile s4"><div class="tile-head"><h2>Objections</h2><span class="tag t-objection">${r.objections.length}</span></div>${list(r.objections, (o) => `<li><span class="pill ${o.status}">${o.status.replace("_", " ")}</span> <b>${esc(o.objection)}</b> · ${esc(o.notes)}</li>`)}</div>
    <div class="tile s4"><div class="tile-head"><h2>Buying signals</h2><span class="tag t-buying_signal">${r.buying_signals.length}</span></div>${list(r.buying_signals, (x) => `<li>${esc(x)}</li>`)}</div>
    <div class="tile s7"><div class="tile-head"><h2>Review next steps</h2></div><div id="reviewNextSteps"></div></div>
    <div class="tile s5"><div class="tile-head"><h2>Risks</h2><span class="tag t-risk">${r.risks.length}</span></div>${list(r.risks, (x) => `<li>${esc(x)}</li>`)}</div>
    <div class="tile s7"><div class="tile-head"><h2>Follow-up email</h2></div><pre>${esc(r.follow_up_email)}</pre></div>
    <div class="tile s5"><div class="tile-head"><h2>Insights & coaching</h2></div>${list([...r.insights, ...r.coaching_notes], (x) => `<li>${esc(x)}</li>`)}</div>
    ${["demo", "practice", "agent_test", "agent_meet", "replay"].includes(m.source) ? "" : `<div class="tile s12 accent-tile"><span class="label">Client memory updated</span><p style="margin-top:6px">${esc(m.profile_after?.summary || "")}</p>
      <div class="chips">${(m.profile_after?.known_pain_points || []).map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div></div>`}`;
  $("#dlReport").addEventListener("click", () => download(`report-${m.id}.md`, toMarkdown(m)));
  $("#reportBack").onclick = () => show("home");
  show("report");
  loadClients(m.client_id).then(() => {
    if (new URLSearchParams(location.search).get("session") === m.id) renderNextSteps(m);
  }).catch(showError);
}

function renderNextSteps(meeting) {
  const container = $("#reviewNextSteps");
  const steps = meeting.report.next_steps || [];
  const client = state.client;
  const demo = meeting.source === "demo" && client?.id === "cli_demo_northwind";
  const canTrack = demo || !["demo", "practice", "agent_test", "agent_meet", "replay"].includes(meeting.source);
  const tracked = new Map((client?.commitments || []).filter((item) => item.meeting_id === meeting.id).map((item) => [item.next_step_index, item]));
  container.innerHTML = steps.length ? steps.map((step, index) => {
    const existing = tracked.get(index);
    if (!canTrack || existing) {
      const text = existing?.text || step.action;
      const owner = existing?.owner || step.owner;
      const due = existing?.due ?? step.due;
      return `<div class="review-item"><b>${esc(text)}</b><p class="muted">${esc(OWNERS[owner])}${due ? ` · ${esc(due)}` : ""}${existing ? ` · ${existing.status === "done" ? "Completed" : "Tracked"}` : ""}</p></div>`;
    }
    return `<form class="review-item form" data-index="${index}">
      <label>Action<input name="action" maxlength="300" value="${esc(step.action)}" required /></label>
      <div class="row"><label>Owner<select name="owner">${Object.entries(OWNERS).map(([value, label]) => `<option value="${value}"${value === step.owner ? " selected" : ""}>${label}</option>`).join("")}</select></label><label>Due<input name="due" maxlength="120" value="${esc(step.due)}" /></label></div>
      <button class="btn sm" type="submit">Track follow-up</button>
    </form>`;
  }).join("") : '<p class="empty">No next steps were captured.</p>';
  $$("form", container).forEach((form) => form.onsubmit = async (event) => {
    event.preventDefault();
    const button = $("button", form);
    const { action, owner, due } = form.elements;
    button.disabled = true;
    try {
      const item = await api(`/api/meetings/${meeting.id}/follow-ups`, { method: "POST", body: { index: Number(form.dataset.index), action: action.value, owner: owner.value, due: due.value } });
      if (state.client?.id === meeting.client_id && new URLSearchParams(location.search).get("session") === meeting.id) {
        state.client.commitments ||= [];
        if (!state.client.commitments.some((value) => value.id === item.id)) state.client.commitments.push(item);
        renderNextSteps(meeting);
        renderProfile();
      }
    } catch (error) { showError(error); button.disabled = false; }
  });
}

function toMarkdown(m) {
  const r = m.report, c = state.client || {};
  return `# Post-call report: ${c.company || c.name || ""}\n\n_${new Date(m.started_at).toLocaleString()} · conversion likelihood ${r.conversion_likelihood}%${r.transcript_quality ? ` · transcript quality: ${r.transcript_quality}` : ""}_\n\n${r.executive_summary}\n
## Client requirements\n${r.client_requirements.map((x) => `- **[${x.priority}]** ${x.requirement} — ${x.evidence}`).join("\n")}\n
## Pain points\n${r.pain_points.map((p) => `- **${p.title}**: ${p.detail}`).join("\n")}\n
## Objections\n${r.objections.map((o) => `- (${o.status}) **${o.objection}**: ${o.notes}`).join("\n")}\n
## Buying signals\n${r.buying_signals.map((x) => `- ${x}`).join("\n")}\n
## Insights\n${r.insights.map((x) => `- ${x}`).join("\n")}\n\n## Risks\n${r.risks.map((x) => `- ${x}`).join("\n")}\n
## Next steps\n${r.next_steps.map((n) => `- [ ] ${n.action} (${n.owner}, ${n.due})`).join("\n")}\n
## Follow-up email\n\n${r.follow_up_email}\n\n## Coaching notes\n${r.coaching_notes.map((x) => `- ${x}`).join("\n")}\n
## Transcript\n${m.transcript.map((u) => `**${u.speaker}:** ${u.text}`).join("\n\n")}\n`;
}
function download(name, text) {
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([text], { type: "text/markdown" })), download: name });
  a.click(); URL.revokeObjectURL(a.href);
}

function renderHistory() {
  const list = state.client?.meeting_list || [];
  $("#history").innerHTML = list.map((m) => `<li data-id="${m.id}"><div><b>${new Date(m.started_at).toLocaleString()}</b> <span class="muted">· ${esc(m.source)}</span><div class="small muted">${esc(m.report?.executive_summary?.slice(0, 160) || "")}…</div></div><span class="pill">${Math.round(m.report?.conversion_likelihood ?? 0)}%</span></li>`).join("") || `<li class="muted">No meetings yet</li>`;
  $$("#history li[data-id]").forEach((li) => li.addEventListener("click", async () => showReport(await api(`/api/meetings/${li.dataset.id}`))));
}

// ---------------- toasts (real-time pop-ups)
function toast(s) {
  const el = document.createElement("div");
  el.className = `toast ${s.priority || ""}`;
  el.innerHTML = `<div class="k">${esc((s.kind || "").replace("_", " "))}</div><b>${esc(s.title)}</b><p>${esc(s.text)}</p>`;
  $("#toasts").prepend(el);
  while ($("#toasts").children.length > 3) $("#toasts").lastChild.remove();
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, s.priority === "high" ? 11000 : 8000);
  el.addEventListener("click", () => el.remove());
}

loadStatus().catch(showError);
loadSettings().catch(showError);
const pageParams = new URLSearchParams(location.search);
loadClients(pageParams.get("replay")).then(async () => {
  if (pageParams.has("replay") && state.client?.recording_available) {
    const choice = $("#replaySource input");
    choice.checked = true;
    choice.dispatchEvent(new Event("change"));
    show("prep");
  }
  const id = pageParams.get("session");
  if (id) await openSavedSession(id);
  else if (!pageParams.has("replay")) await refreshWorkspace();
}).catch((err) => toast({ kind: "error", title: "Could not load ClientLuma", text: err.message }));
