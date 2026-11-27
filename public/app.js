// Cuelensa dashboard.
import { installLensLanguage, lensAvailability, startLocalLens } from "./local-lens.js";

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
const SOURCES = { meetstream: "Meeting bot", mia: "Meeting assistant" };
const OWNERS = { us: "Our team", client: "Client", both: "Both" };

const state = { clients: [], client: null, session: null, ws: null, signals: [], filters: new Set() };
let requestedCue;

// ---------------- navigation
const navigation = $("#primaryNavigation");
const navigationTiles = $$("[data-view]", navigation);
let navigationRevision = 0;

function renderLiveView() {
  const local = Boolean(state.localLens?.active);
  $("#liveEmpty").hidden = local || Boolean(state.session);
  $("#liveContent").hidden = local || !state.session;
  $("#localLensContent").hidden = !local;
}

function show(view, { historyMode = "push", sessionId = view === "live" ? state.session?.id : null, focus = false } = {}) {
  const destination = $("#view-" + view);
  const reportChanged = view === "report" && $("#report").hidden === Boolean(sessionId);
  const changed = !destination.classList.contains("active") || reportChanged;
  navigationRevision++;
  if (view !== "live") state.localLens?.controller.abort();
  navigationTiles.forEach(tile => {
    if (tile.dataset.view === view) tile.setAttribute("aria-current", "page");
    else tile.removeAttribute("aria-current");
  });
  $$(".view").forEach(section => {
    section.classList.toggle("active", section === destination);
    section.classList.toggle("entering", changed && section === destination && historyMode === "push");
  });
  if (view === "live") renderLiveView();
  if (view === "report") {
    $("#reportOverview").hidden = Boolean(sessionId);
    $("#report").hidden = !sessionId;
    if (!sessionId) $("#meetingHistory").open = true;
  }
  if (historyMode !== "none") {
    const suffix = sessionId ? "?session=" + encodeURIComponent(sessionId) : view === "home" ? "" : "#" + destination.id;
    const target = location.pathname + suffix;
    if (target !== location.pathname + location.search + location.hash) {
      if (historyMode === "replace") history.replaceState(null, "", target);
      else history.pushState(null, "", target);
    }
    if (historyMode === "push" && (changed || focus)) window.scrollTo(0, 0);
  }
  if (focus) $("#content").focus({ preventScroll: true });
  if (view === "settings") loadSettings().catch(showError);
  if (view === "home") refreshWorkspace().catch(showError);
}

function restoreLocation() {
  const params = new URLSearchParams(location.search);
  const id = params.get("session");
  requestedCue = params.get("cue");
  if (id) return openSavedSession(id, "none");
  const tile = navigationTiles.find(link => link.hash && link.hash === location.hash);
  if (tile?.dataset.view === "live") return openLiveDestination({ historyMode: "none" });
  show(tile?.dataset.view || "home", { historyMode: "none" });
}

async function openLiveDestination({ historyMode = "push", focus = false } = {}) {
  show("live", { historyMode, focus });
  if (state.session || state.localLens) return;
  const revision = navigationRevision;
  const [live] = await api("/api/live");
  if (live && revision === navigationRevision) await openSavedSession(live.id, historyMode === "push" ? "replace" : "none");
}

navigationTiles.forEach(tile => tile.addEventListener("click", event => {
  if (event.button !== 0 || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
  event.preventDefault();
  if (tile.dataset.view === "live") openLiveDestination({ focus: true }).catch(showError);
  else show(tile.dataset.view, { focus: true });
}));
window.addEventListener("popstate", () => Promise.resolve(restoreLocation()).catch(showError));
$(".skip-content").onclick = event => {
  event.preventDefault();
  $("#content").focus();
};
$("#prepareCall").onclick = () => show("prep");
$("#openWorkspaceLive").onclick = () => {
  const id = $("#workspaceCalls a")?.dataset.session;
  if (id) openSavedSession(id).catch(showError);
  else openLiveDestination().catch(showError);
};
$("#openWorkspaceFollowUps").onclick = () => $("#workspaceFollowUpDialog").showModal();
$("#prepareFromLive").onclick = () => show("prep");
$("#editPrep").onclick = () => {
  $("#clientEditor").open = true;
  $("#clientForm").elements.name.focus();
};
$("#jumpStart").onclick = () => {
  $("#startOptions").scrollIntoView({ block: "start" });
  $('input[name="source"]:checked')?.focus({ preventScroll: true });
};
$("#workspaceClients").onclick = () => {
  show("prep");
  ($("#clientList button[aria-current]") || $("#newClient")).focus();
};
$("#refreshWorkspace").onclick = () => refreshWorkspace().catch(showError);
const showError = (error) => toast({ kind: "error", title: "Could not complete that action", text: error.message });
const dateLabel = (date) => new Date(date).toLocaleString();
const workspaceDate = (date) => new Date(date).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const initials = (name) => String(name || "").trim().split(/\s+/).slice(0, 2).map(word => word[0] || "").join("").toUpperCase();
const elapsed = (seconds) => `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
function countWords(counts, line) {
  if (line.substantive !== false && (line.role === "rep" || line.role === "client")) {
    counts[line.role] += line.text.trim().split(/\s+/).filter(Boolean).length;
  }
  return counts;
}
function renderTalkRatio(counts) {
  const total = counts.rep + counts.client;
  if (!total) return '<p class="muted small">Speaker balance appears once someone speaks.</p>';
  const rep = Math.round(counts.rep * 100 / total);
  return [["Presenter", rep], ["Client", 100 - rep]].map(([label, value]) => `<div class="ratio-row"><span>${label}</span><span class="ratio-track" aria-hidden="true"><span style="width:${value}%"></span></span><b>${value}%</b></div>`).join("");
}

async function openSavedSession(id, historyMode = "push") {
  const revision = ++navigationRevision;
  if (state.session?.id === id) {
    show("live", { historyMode });
    return;
  }
  let session;
  try { session = await api(`/api/sessions/${encodeURIComponent(id)}`); }
  catch (error) { if (error.status !== 404) throw error; }
  if (revision !== navigationRevision) return;
  if (session) {
    await selectClient(session.clientId);
    if (revision === navigationRevision) beginLive(session, historyMode);
  } else {
    const meeting = await api(`/api/meetings/${encodeURIComponent(id)}`);
    if (revision !== navigationRevision) return;
    await selectClient(meeting.client_id);
    if (revision === navigationRevision) showReport(meeting, historyMode);
  }
}

const workspaceEmpty = (text) => `<li class="feed-message muted">${esc(text)}</li>`;
let workspaceRevision = 0;

async function renderWorkspaceCues(reports, revision) {
  const list = $("#workspaceCues");
  list.setAttribute("aria-busy", "true");
  list.innerHTML = workspaceEmpty("Loading cues…");
  const entries = [];
  let failed = false;
  for (const meeting of reports) {
    try {
      const { suggestions = [] } = await api(`/api/meetings/${encodeURIComponent(meeting.id)}`);
      if (revision !== workspaceRevision) return;
      for (const cue of suggestions.slice(-3).reverse()) entries.push({ cue, meeting });
      if (entries.length >= 3) break;
    } catch { failed = true; }
  }
  if (revision !== workspaceRevision) return;
  list.innerHTML = entries.slice(0, 3).map(({ cue, meeting }, index) =>
    `<li><button type="button" class="workspace-item cue-row" data-cue-index="${index}" aria-haspopup="dialog">
      <span class="cue-icon" aria-hidden="true">↗</span>
      <span class="workspace-item-text"><b>${esc(cue.title)}</b><small>${esc(meeting.client)}</small></span>
      <span class="feed-chevron" aria-hidden="true"></span>
    </button></li>`
  ).join("") || workspaceEmpty(failed ? "Could not load coaching cues. Refresh to try again." : "Coaching cues appear here after a completed call.");
  $$("[data-cue-index]", list).forEach(button => {
    const { cue, meeting } = entries[Number(button.dataset.cueIndex)];
    button.onclick = () => showCueDetails(cue, meeting);
  });
  list.setAttribute("aria-busy", "false");
}

async function refreshWorkspace() {
  const revision = ++workspaceRevision;
  const refresh = $("#refreshWorkspace");
  const reports = $("#workspaceReports");
  refresh.disabled = true;
  reports.setAttribute("aria-busy", "true");
  try {
    const finding = await api("/api/workspace");
    if (revision !== workspaceRevision) return;
    renderWorkspace(finding);
    reports.setAttribute("aria-busy", "false");
    await renderWorkspaceCues(finding.recent.slice(0, 4), revision);
  } catch (error) {
    if (revision !== workspaceRevision) return;
    if (!reports.querySelector("a")) reports.innerHTML = workspaceEmpty("Could not load reports. Refresh to try again.");
    if (!$("#workspaceCues button")) $("#workspaceCues").innerHTML = workspaceEmpty("Could not load coaching cues. Refresh to try again.");
    $("#workspaceCues").setAttribute("aria-busy", "false");
    $("#workspaceLiveStatus").textContent = "Live status unavailable";
    throw error;
  } finally {
    if (revision === workspaceRevision) {
      reports.setAttribute("aria-busy", "false");
      refresh.disabled = false;
    }
  }
}

function renderWorkspace({ active, recent, followUps, totals }) {
  $("#countCalls").textContent = String(active.length);
  $("#workspaceCalls").hidden = !active.length;
  $("#workspaceLive").classList.toggle("has-live", Boolean(active.length));
  $("#workspaceCallTitle").textContent = active.length ? "Calls in progress" : "Ready for your next call";
  $("#workspaceCallDescription").hidden = Boolean(active.length);
  $("#openWorkspaceLive").hidden = Boolean(active.length);
  $("#workspaceLiveStatus").textContent = active.length ? "Live now" : "No live calls";
  $("#workspaceLiveStatus").classList.toggle("on-air", Boolean(active.length));
  $("#countReports").textContent = String(totals?.reports ?? recent.length);
  $("#countFollowUps").textContent = String(totals?.followUps ?? followUps.length);
  const links = (items, action) => items.map((item) => `<li><a class="workspace-item" href="?session=${encodeURIComponent(item.id)}" data-session="${esc(item.id)}">
    <span class="client-initials" aria-hidden="true">${esc(initials(item.client))}</span>
    <span class="workspace-item-text"><b>${esc(item.client)}</b><small>${esc(workspaceDate(item.started_at))}</small></span>
    <span class="workspace-action">${action} <span aria-hidden="true">↗</span></span>
  </a></li>`).join("");
  $("#workspaceCalls").innerHTML = links(active, "Resume");
  $("#workspaceReports").innerHTML = links(recent.slice(0, 4), "Open report") || workspaceEmpty("Completed calls will appear here.");
  $("#workspaceFollowUps").innerHTML = followUps.map((item) => `<li><div><b>${esc(item.text)}</b><span>${esc(item.client)} · ${esc(OWNERS[item.owner] || item.owner)}${item.due ? ` · ${esc(item.due)}` : ""}</span></div><button class="btn sm" data-client="${esc(item.clientId)}">Review</button></li>`).join("") || workspaceEmpty("No open follow-ups.");
  $$("#view-home [data-session]").forEach((link) => link.onclick = (event) => {
    if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    openSavedSession(link.dataset.session).catch(showError);
  });
  $$("#workspaceFollowUps [data-client]").forEach((button) => button.onclick = () => selectClient(button.dataset.client).then(() => {
    $("#workspaceFollowUpDialog").close();
    show("prep");
  }).catch(showError));

}

const settingsForm = $("#settingsForm");
const secretNames = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "MEETSTREAM_API_KEY", "MIA_DOCS_MCP_TOKEN", "MIA_DATABASE_URL"];
const settingsDefaults = { MIA_AGENT_LLM_PROVIDER: "google", MIA_AGENT_LLM_MODEL: "gemini-2.5-flash",
  MIA_AGENT_LLM_KEY_SOURCE: "user", MIA_DATABASE_PROVIDER: "sqlite" };
for (const key of secretNames) {
  const database = key === "MIA_DATABASE_URL";
  const button = Object.assign(document.createElement("button"), { type: "button", className: "btn sm",
    textContent: database ? "Remove saved connection URL" : "Remove saved key", hidden: true });
  button.dataset.removeKey = key;
  const label = settingsForm.elements[key].parentElement;
  const field = document.createElement("div");
  field.className = "settings-secret";
  label.before(field);
  field.append(label, button);
  button.onclick = async () => {
    try { await updateSettings({ clear: [key] }); $("#settingsStatus").textContent = database ? "Connection URL removed." : "Key removed."; }
    catch (error) { $("#settingsStatus").textContent = error.message; }
  };
}
$("#welcomeSetup").onclick = () => show("settings");
$("#settingsBack").onclick = () => show("home");

function renderSettings(settings) {
  state.settings = settings;
  $("#callbackHelp").textContent = settings.callbackTarget
    ? `Point your HTTPS tunnel at ${settings.callbackTarget}. Paste its public origin here.`
    : settings.hosted ? "Leave blank to use this app’s HTTPS address." : "Use an approved public HTTPS callback for local testing.";
  const { active, next } = settings.databaseSelection;
  const activeName = active || (settings.database.configuredPath ? "Host-configured SQLite file" : settings.database.engine);
  const nextName = settings.options.MIA_DATABASE_PROVIDER === "postgresql" ? "PostgreSQL" : next || "Host-configured SQLite file";
  $("#databaseStatus").textContent = settings.databaseRestartRequired
    ? `Active: ${activeName} · After restart: ${nextName}` : `Active database: ${activeName}`;
  settingsForm.elements.MIA_PROVIDER.value = settings.ready ? settings.provider : "offline";
  for (const [key, value] of Object.entries(settings.options)) {
    if (key !== "MIA_PROVIDER") settingsForm.elements[key].value = value || settingsDefaults[key] || "";
  }
  for (const key of [...Object.keys(settings.options), ...secretNames]) {
    const field = settingsForm.elements[key];
    field.disabled = settings.managed.includes(key);
    field.title = field.disabled ? "Managed by the server environment" : "";
    if (secretNames.includes(key)) {
      field.value = "";
      field.placeholder = settings.configured[key] ? "Configured" : "Optional";
      $(`[data-remove-key="${key}"]`).hidden = !settings.configured[key] || field.disabled;
    }
  }
  renderMiaKeySource();
  renderDatabaseFields();
  $("#docsStatus").textContent = "";
}
function renderMiaKeySource() {
  const openai = settingsForm.elements.MIA_AGENT_LLM_PROVIDER.value === "openai";
  const key = settingsForm.elements.MIA_AGENT_LLM_KEY_SOURCE;
  $("#miaKeySource").hidden = !openai;
  if (!openai && !key.disabled) key.value = "user";
  $("#miaKeySourceHelp").textContent = openai
    ? "Add your OpenAI API key in MeetStream → Integrations, or use the built-in key if your MeetStream account supports it."
    : "Add your provider’s API key in MeetStream → Integrations.";
}
settingsForm.elements.MIA_AGENT_LLM_PROVIDER.onchange = renderMiaKeySource;
function renderDatabaseFields() {
  const postgres = settingsForm.elements.MIA_DATABASE_PROVIDER.value === "postgresql";
  $("#sqliteFields").hidden = postgres;
  $("#postgresFields").hidden = !postgres && !state.settings?.configured.MIA_DATABASE_URL;
  $("#databaseTestStatus").textContent = "";
}
settingsForm.elements.MIA_DATABASE_PROVIDER.onchange = renderDatabaseFields;
$("#testDatabase").onclick = async ({ currentTarget: button }) => {
  button.disabled = true;
  $("#databaseTestStatus").textContent = "Connecting…";
  try {
    await api("/api/settings/test-database", { method: "POST", body: { url: settingsForm.elements.MIA_DATABASE_URL.value } });
    $("#databaseTestStatus").textContent = "PostgreSQL connection successful.";
  } catch (error) { $("#databaseTestStatus").textContent = error.message; }
  finally { button.disabled = false; }
};
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
    $("#settingsStatus").textContent = state.settings.databaseRestartRequired ? "Settings saved. Restart Cuelensa to apply the database change." : "Settings saved.";
  } catch (error) { $("#settingsStatus").textContent = error.message; }
  finally { button.disabled = false; }
};
$("#testDocs").onclick = async ({ currentTarget: button }) => {
  button.disabled = true;
  $("#docsStatus").textContent = "Connecting…";
  try {
    const { tool } = await api("/api/settings/test-docs", { method: "POST", body: {} });
    $("#docsStatus").textContent = `Connected · ${tool}`;
  } catch (error) { $("#docsStatus").textContent = error.message; }
  finally { button.disabled = false; }
};

async function loadStatus() {
  const status = await api("/api/status");
  $("#welcome").hidden = status.meetstream && status.webhook;
  const wakeWord = status.mia_agent?.wake_words?.[0];
  if (wakeWord) {
    $("#miaSourceText").textContent = 'Say “' + wakeWord + '” to ask about the selected client or log a follow-up.';
    renderMeetingMode();
  }
}

// ---------------- clients
let clientSelection = 0;

async function loadClients(selectId) {
  state.clients = await api("/api/clients");
  $("#countClients").textContent = String(state.clients.length);
  const list = $("#clientList");
  list.innerHTML = state.clients.map((c) => `
    <li><button type="button" data-id="${esc(c.id)}">
      <b>${esc(c.company || c.name)}${c.profile?.deal_stage ? `<span class="stage">${esc(c.profile.deal_stage.replace("_", " "))}</span>` : ""}</b>
      ${c.company ? `<span>${esc(c.name)}</span>` : ""}
    </button></li>`).join("") || `<li class="muted">No clients yet</li>`;
  $$("button[data-id]", list).forEach((button) => button.onclick = () => selectClient(button.dataset.id).catch(showError));
  const id = selectId || state.client?.id || state.clients[0]?.id;
  if (id) await selectClient(id);
}

async function selectClient(id) {
  const selection = ++clientSelection;
  const c = await api(`/api/clients/${id}`);
  if (selection !== clientSelection) return;
  state.client = c;
  $("#prepTitle").textContent = c.company || c.name;
  $("#prepContext").textContent = [c.company && c.name, c.industry, c.deal].filter(Boolean).join(" · ");
  $("#prepClient").innerHTML = `<div class="person prep-person"><span class="client-initials" aria-hidden="true">${esc(initials(c.name))}</span><div><b>${esc(c.name)}</b><span>${esc(c.company)}</span></div></div>
    <dl class="client-facts">${[["Industry", c.industry], ["Deal context", c.deal], ["Last call", c.meeting_list?.[0]?.started_at ? dateLabel(c.meeting_list[0].started_at) : "No calls yet"]].filter(([, value]) => value).map(([label, value]) => `<div><dt>${label}</dt><dd>${esc(value)}</dd></div>`).join("")}</dl>`;
  $$("#clientList button").forEach((button) => {
    if (button.dataset.id === id) button.setAttribute("aria-current", "true");
    else button.removeAttribute("aria-current");
  });
  const f = $("#clientForm");
  for (const k of ["id", "name", "company", "industry", "deal", "offering", "notes", "website_url"]) f.elements[k].value = c[k] || "";
  f.elements.local_only.checked = Boolean(c.local_only);
  f.elements.contacts.value = (c.contacts || []).map((x) => `${x.name}${x.role ? " - " + x.role : ""}`).join("\n");
  renderDocs(); renderProfile(); renderKb(c.kb, c.kb_engine); renderHistory(); renderWebsite();
}

$("#newClient").addEventListener("click", () => {
  clientSelection++;
  state.client = null;
  $("#prepTitle").textContent = "New client";
  $("#prepContext").textContent = "";
  $("#prepClient").replaceChildren();
  $("#clientEditor").open = true;
  $("#clientForm").reset(); $("#clientForm").elements.id.value = "";
  $$("#clientList button").forEach((button) => button.removeAttribute("aria-current"));
  renderDocs(); renderProfile(); renderKb(null); renderHistory(); renderWebsite(); show("prep");
  $("#clientForm").elements.name.focus();
});

$("#clientForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const f = e.target.elements;
  const body = {
    id: f.id.value || undefined, name: f.name.value, company: f.company.value, industry: f.industry.value,
    deal: f.deal.value, offering: f.offering.value, notes: f.notes.value, local_only: f.local_only.checked,
    website_url: f.website_url.value,
    contacts: f.contacts.value.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, ...role] = l.split(/\s+-\s+|,\s*/); return { name: name.trim(), role: role.join(" ").trim() };
    }),
  };
  const button = e.submitter;
  if (button) button.disabled = true;
  try {
    const c = await api("/api/clients", { method: "POST", body });
    toast({ kind: "saved", title: "Client saved", text: c.company || c.name });
    await loadClients(c.id);
  } catch (error) { showError(error); }
  finally { if (button) button.disabled = false; }
});

$("#deleteClient").addEventListener("click", async () => {
  if (!state.client || !confirm(`Delete ${state.client.name} and its saved reports and transcripts from this workspace?`)) return;
  const button = $("#deleteClient");
  button.disabled = true;
  try {
    await api(`/api/clients/${state.client.id}`, { method: "DELETE" });
    state.client = null;
    await loadClients();
    if (!state.client) $("#newClient").click();
  } catch (error) { showError(error); }
  finally { button.disabled = false; }
});

// ---------------- client website intelligence
const WEBSITE_SECTIONS = {
  overview: "Company overview and positioning",
  products: "Products and services",
  pricing: "Public pricing",
  audience: "Industries and customers",
  case_studies: "Case studies and customer stories",
  faqs: "FAQs and common objections",
  competitors: "Competitive positioning",
  integrations: "Integrations",
};
let websiteTimer;
let websiteGeneration = 0;
let displayedWebsiteClient;
let displayedWebsiteUrl;
let displayedWebsiteRevision;

function setWebsiteLink(link, url) {
  link.removeAttribute("href");
  try {
    const source = new URL(url);
    if (["https:", "http:"].includes(source.protocol) && !source.username && !source.password) link.href = source.href;
  } catch { /* Keep invalid URLs as text only. */ }
}

function renderWebsite(retry = false) {
  clearTimeout(websiteTimer);
  const generation = ++websiteGeneration;
  const client = state.client;
  const panel = $("#websiteIntelligence");
  panel.hidden = !client?.website_url;
  if (panel.hidden) {
    displayedWebsiteClient = displayedWebsiteUrl = displayedWebsiteRevision = null;
    return;
  }
  const crawl = client.website_crawl;
  const knowledge = client.website_knowledge;
  const busy = ["queued", "crawling", "indexing"].includes(crawl?.status);
  const selectionChanged = displayedWebsiteClient !== client.id;
  if (selectionChanged || displayedWebsiteUrl !== client.website_url) panel.open = busy;
  displayedWebsiteClient = client.id;
  displayedWebsiteUrl = client.website_url;

  const source = $("#indexedWebsite");
  source.textContent = client.website_url;
  setWebsiteLink(source, client.website_url);
  const count = `${crawl?.indexed || 0} indexed · ${crawl?.attempted || 0} checked`;
  const status = {
    queued: "Waiting to crawl.",
    crawling: `Crawling public pages. ${count}.`,
    indexing: `Saving the website index. ${count}.`,
    ready: `${count}.${crawl?.skipped ? ` ${crawl.skipped} skipped.` : ""} ${crawl?.message || ""} Generate a brief to use this research in Prepare.`,
    failed: `${crawl?.message || "The crawl failed. Try refreshing the website."}${knowledge ? " Showing the previous index." : ""}`,
  };
  const statusText = retry ? "Could not check progress. Retrying…" : status[crawl?.status] || "Ready to crawl.";
  if ($("#websiteStatus").textContent !== statusText) $("#websiteStatus").textContent = statusText;
  const progress = $("#websiteProgress");
  progress.hidden = !busy;
  progress.max = crawl?.page_limit || 8;
  progress.value = crawl?.attempted || 0;
  $("#refreshWebsite").disabled = busy;
  $("#removeWebsite").disabled = false;

  if (selectionChanged || displayedWebsiteRevision !== knowledge?.revision) {
    displayedWebsiteRevision = knowledge?.revision;
    const findings = $("#websiteFindings");
    findings.replaceChildren();
    for (const [key, label] of Object.entries(WEBSITE_SECTIONS)) {
      const entries = knowledge?.sections?.[key];
      if (!entries?.length) continue;
      const group = document.createElement("details");
      const summary = document.createElement("summary");
      summary.textContent = label;
      const list = document.createElement("ul");
      list.className = "plain-list small";
      for (const entry of entries) {
        const item = document.createElement("li");
        const text = document.createElement("p");
        text.textContent = entry.text;
        const link = document.createElement("a");
        link.className = "website-source";
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        link.textContent = entry.url;
        setWebsiteLink(link, entry.url);
        item.append(text, link);
        list.append(item);
      }
      group.append(summary, list);
      findings.append(group);
    }
  }

  if (busy) websiteTimer = setTimeout(async () => {
    try {
      const result = await api(`/api/clients/${client.id}/website`);
      if (generation === websiteGeneration) applyWebsiteState(result);
    } catch {
      if (generation === websiteGeneration) renderWebsite(true);
    }
  }, retry ? 4000 : 1250);
}

function applyWebsiteState(result) {
  const client = state.client;
  const previousRevision = client.website_knowledge?.revision;
  const previousUrl = client.website_url;
  Object.assign(client, { website_url: result.website_url, website_crawl: result.crawl, website_knowledge: result.knowledge });
  const input = $("#clientForm").elements.website_url;
  if (input.value === previousUrl) input.value = result.website_url;
  if (previousRevision !== result.knowledge?.revision) {
    client.kb = result.kb;
    client.kb_engine = result.kb_engine;
    renderKb(client.kb, client.kb_engine);
  }
  renderWebsite();
}

async function changeWebsite(method) {
  const id = state.client?.id;
  if (!id) return;
  clearTimeout(websiteTimer);
  const generation = ++websiteGeneration;
  $("#refreshWebsite").disabled = $("#removeWebsite").disabled = true;
  try {
    const result = await api(`/api/clients/${id}/website`, { method });
    if (generation === websiteGeneration) applyWebsiteState(result);
  } catch (error) {
    if (generation === websiteGeneration) {
      renderWebsite();
      showError(error);
    }
  }
}

$("#refreshWebsite").onclick = () => changeWebsite("POST");
$("#removeWebsite").onclick = () => {
  if (confirm("Remove this client’s website URL and indexed information?")) changeWebsite("DELETE");
};

// ---------------- documents
function renderDocs() {
  const docs = state.client?.documents || [];
  $("#docList").innerHTML = docs.map((d, i) => `<li><span>📄 ${esc(d.name)} ${d.approved_technical ? '<span class="chip">Approved source</span>' : ""}</span>
    <div class="doc-actions">${d.id ? `<button type="button" data-source="${esc(d.id)}" aria-label="${d.approved_technical ? "Revoke" : "Approve"} source for ${esc(d.name)}">${d.approved_technical ? "Revoke" : "Approve source"}</button>` : ""}
    <button data-i="${i}" aria-label="Remove ${esc(d.name)}">✕</button></div></li>`).join("");
  $$("#docList button[data-i]").forEach((b) => b.addEventListener("click", async () => {
    const clientId = state.client.id;
    try {
      await api(`/api/clients/${clientId}/documents/${b.dataset.i}`, { method: "DELETE" });
      if (state.client?.id === clientId) await selectClient(clientId);
    } catch (error) { showError(error); }
  }));
  $$("#docList button[data-source]").forEach((button) => button.onclick = async () => {
    const client = state.client;
    const doc = client.documents.find((item) => item.id === button.dataset.source);
    button.disabled = true;
    try {
      Object.assign(doc, await api(`/api/clients/${encodeURIComponent(client.id)}/technical-sources/${encodeURIComponent(doc.id)}`, {
        method: "PATCH", body: { approved: !doc.approved_technical },
      }));
      if (state.client === client) renderDocs();
    } catch (error) { showError(error); button.disabled = false; }
  });
}
async function uploadFiles(files) {
  const clientId = state.client?.id;
  if (!clientId) return toast({ kind: "note", title: "Save the client first", text: "Then add documents to it." });
  for (const file of files) {
    if (file.size > 20 * 1024 * 1024) { toast({ kind: "error", title: "File too large", text: `${file.name} is over 20 MB.` }); continue; }
    drop.classList.add("busy");
    try {
      const bytes = new Uint8Array(await file.arrayBuffer());
      let bin = "";
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      await api(`/api/clients/${clientId}/documents`, { method: "POST", body: { name: file.name, data: btoa(bin) } });
      toast({ kind: "document added", title: file.name, text: "Regenerate the knowledge base to include it." });
    } catch (err) { toast({ kind: "error", title: `Could not read ${file.name}`, text: err.message }); }
    finally { drop.classList.remove("busy"); }
  }
  if (state.client?.id === clientId) await selectClient(clientId);
}
$("#fileInput").addEventListener("change", (e) => {
  const files = [...e.target.files];
  e.target.value = "";
  uploadFiles(files).catch(showError);
});
const drop = $("#drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => {
  e.preventDefault();
  drop.classList.remove("over");
  uploadFiles([...e.dataTransfer.files]).catch(showError);
});

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

const KB_TILES = ["#kbGoals", "#kbPains", "#kbObjections", "#kbAsk", "#kbTheirQs", "#kbStake", "#kbExpect"];

function renderKb(kb, engine) {
  const sum = $("#kbSummary");
  $("#kbBriefNotes").open = !kb;
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
  const sourcedQuestions = kb.website_discovery_questions || [];
  const discovery = $("#kbAsk");
  discovery.innerHTML = kb.questions_to_ask.map(question => `<li>${esc(question)}</li>`).join("");
  const sourcedItems = sourcedQuestions.map(({ question, source }) => {
    const item = document.createElement("li");
    item.textContent = question + " ";
    const link = document.createElement("a");
    link.className = "website-source discovery-source";
    link.textContent = "View source";
    link.title = source.title || source.url;
    link.setAttribute("aria-label", `View source for: ${question}`);
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    setWebsiteLink(link, source.url);
    if (link.hasAttribute("href")) item.append(link);
    return item;
  });
  discovery.prepend(...sourcedItems);
  $("#kbTheirQs").innerHTML = kb.questions_they_may_ask.map((q) => `<div class="kb-item"><b>${esc(q.question)}</b><i>${esc(q.suggested_answer)}</i></div>`).join("");
  $("#kbStake").innerHTML = (kb.stakeholders || []).map((s) => `<div class="person"><div><b>${esc(s.name)}</b><span>${esc([s.role, s.likely_priorities].filter(Boolean).join(" · "))}</span></div></div>`).join("") || `<p class="empty">No stakeholders listed.</p>`;
  $("#kbExpect").innerHTML = kb.expectations.length ? `<span class="label">They expect</span><ul class="plain-list" style="margin-top:6px">${kb.expectations.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
  $("#kbMini").innerHTML = `
    <h4>Goals</h4><ul>${kb.goals_for_call.map((x) => `<li>${esc(x)}</li>`).join("")}</ul>
    <details><summary>Questions to ask</summary><ul>${[...sourcedQuestions.map(item => item.question), ...kb.questions_to_ask].map((x) => `<li>${esc(x)}</li>`).join("")}</ul></details>
    <details><summary>Objection handling</summary><ul>${kb.likely_objections.map((o) => `<li><b>${esc(o.objection)}:</b> ${esc(o.response)}</li>`).join("")}</ul></details>`;
}

$("#genKb").addEventListener("click", async (e) => {
  if (!state.client) return toast({ kind: "note", title: "Save the client first", text: "Fill in client information and save." });
  const id = state.client.id;
  const b = e.target; b.disabled = true; b.textContent = "Generating…";
  try {
    const c = await api(`/api/clients/${id}/kb`, { method: "POST" });
    if (state.client?.id === id && state.client.website_knowledge?.revision === c.website_knowledge?.revision) {
      state.client.kb = c.kb;
      state.client.kb_engine = c.kb_engine;
      renderKb(c.kb, c.kb_engine);
    }
  }
  catch (err) { toast({ kind: "error", title: "Could not generate", text: err.message }); }
  finally { b.disabled = false; b.textContent = "Regenerate brief"; }
});

// ---------------- start call
let lensLanguage = null;
let meetingStarting = false;
const meetingMode = () => $("#meetingForm").elements.source.value;

function renderMeetingMode() {
  const mode = meetingMode();
  const local = mode === "client-lens";
  $("#meetingModeHelp").textContent = $(".meeting-sources .source:has(:checked) .sr-only")?.textContent || "";
  $("#sourceOpts").hidden = local;
  $("#meetingLink").disabled = $("#repName").disabled = local;
  $("#localLensOptions").hidden = !local;
  $("#startCall").disabled = meetingStarting || (local && lensLanguage !== "available");
  $("#startCall").textContent = meetingStarting ? (local ? "Starting…" : "Sending…")
    : ({ mia: "Send assistant", "client-lens": "Start Client Lens" }[mode] || "Send bot");
}

async function refreshLensSupport() {
  const status = $("#localLensSupport");
  const install = $("#installLensLanguage");
  lensLanguage = null;
  renderMeetingMode();
  install.hidden = true;
  status.textContent = "Checking on-device speech support…";
  try {
    lensLanguage = await lensAvailability();
    install.hidden = !["downloadable", "downloading"].includes(lensLanguage);
    status.textContent = lensLanguage === "available" ? "" : !install.hidden
      ? "Download the English speech pack to process audio on this device."
      : "On-device English speech recognition is unavailable in this browser.";
  } catch (error) { status.textContent = error.message; }
  renderMeetingMode();
}

$("#installLensLanguage").onclick = async ({ currentTarget: button }) => {
  button.disabled = true;
  $("#localLensSupport").textContent = "Downloading English speech pack…";
  try {
    if (!await installLensLanguage()) throw new Error("The speech pack download did not finish. Try again.");
    await refreshLensSupport();
  } catch (error) { $("#localLensSupport").textContent = error.message; }
  finally { button.disabled = false; }
};

$("#meetingForm").addEventListener("change", event => {
  if (event.target.name === "source") {
    renderMeetingMode();
    if (meetingMode() === "client-lens") refreshLensSupport();
  }
  $("#meetingStatus").textContent = "";
});

async function beginLocalLens() {
  if (state.session) throw new Error("End the active bot call before starting Client Lens only.");
  if (state.localLens) { show("live"); return; }
  const controller = new AbortController();
  const local = { controller, active: false };
  state.localLens = local;
  try {
    const stop = await startLocalLens({
      signal: controller.signal,
      onCue(cue) {
        if (state.localLens !== local) return;
        const title = document.createElement("h3");
        const detail = document.createElement("p");
        title.textContent = cue.title;
        detail.textContent = cue.text;
        $("#localLensCue").replaceChildren(title, detail);
        toast(cue, true);
      },
      onStop(message) {
        if (state.localLens !== local) return;
        state.localLens = null;
        $("#localLensCue").replaceChildren();
        $(".toast.live-cue")?.remove();
        if (local.active) renderLiveView();
        if (message) toast({ title: "Client Lens stopped", text: message });
      },
    });
    if (!stop || state.localLens !== local) return;
    local.active = true;
    $("#localLensCue").innerHTML = '<p class="muted">Waiting for a coaching cue…</p>';
    show("live");
  } catch (error) {
    if (state.localLens === local) state.localLens = null;
    if (error.name === "NotAllowedError") throw new Error("Tab audio wasn’t shared. Start Client Lens again when you’re ready.");
    throw error;
  }
}

$("#stopLocalLens").onclick = () => state.localLens?.controller.abort();
window.addEventListener("pagehide", () => state.localLens?.controller.abort());

$("#meetingForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("#meetingStatus");
  const mode = meetingMode();
  if (mode !== "client-lens" && !state.client) { status.textContent = "Select or save a client first."; return; }
  status.textContent = "";
  meetingStarting = true;
  renderMeetingMode();
  try {
    if (mode === "client-lens") {
      if (lensLanguage === "available") await beginLocalLens();
      return;
    }
    const session = await api("/api/sessions", { method: "POST", body: {
      clientId: state.client.id, source: mode === "mia" ? "mia" : "meetstream",
      meetingLink: $("#meetingLink").value, repName: $("#repName").value, lensEnabled: false,
    } });
    if (state.client?.id !== session.clientId) await selectClient(session.clientId);
    state.client.kb = session.kb;
    renderKb(session.kb);
    beginLive(session);
  } catch (error) { status.textContent = error.message; }
  finally { meetingStarting = false; renderMeetingMode(); }
});

function renderLens(enabled) {
  if (state.session) state.session.lensEnabled = enabled;
  const control = $("#liveLens");
  control.checked = enabled;
  $("#liveOverlayLink").hidden = !enabled || state.session?.source !== "meetstream";
  $("#view-live").classList.toggle("lens-off", !enabled);
  if (!enabled) {
    $("#thinking").hidden = true;
    $(".toast.live-cue")?.remove();
  }
}

$("#liveLens").onchange = async (event) => {
  const control = event.currentTarget;
  const session = state.session;
  if (!session) return;
  control.disabled = true;
  try {
    const result = await api("/api/sessions/" + encodeURIComponent(session.id) + "/lens", {
      method: "PATCH", body: { enabled: control.checked },
    });
    if (state.session === session) renderLens(result.enabled);
  } catch (error) {
    if (state.session === session) renderLens(session.lensEnabled);
    showError(error);
  } finally { if (state.session === session) control.disabled = false; }
};

// ---------------- live
function beginLive(s, historyMode = "push") {
  state.ws?.close();
  state.session = { id: s.id, client: s.client, source: s.source, lensEnabled: s.lensEnabled };
  $("#liveOverlayLink").href = `/overlay/?session=${encodeURIComponent(s.id)}`;
  $("#liveLens").disabled = s.source !== "meetstream";
  $("#liveLensControl").hidden = s.source !== "meetstream";
  renderLens(s.lensEnabled);
  state.liveWords = { rep: 0, client: 0 };
  $("#liveTalkRatio").innerHTML = renderTalkRatio(state.liveWords);
  $("#liveCueCount").textContent = "0 cues";
  state.signals = []; state.filters.clear();
  $("#transcript").innerHTML = ""; $("#signals").innerHTML = "";
  $("#suggestions").innerHTML = `<p class="muted small">Suggestions appear here and as pop-ups as the client speaks.</p>`;
  $("#liveClient").textContent = state.client.company || state.client.name;
  $("#liveSource").textContent = ` · ${SOURCES[s.source]}`;
  $("#botStatus").hidden = true;
  $("#endCall").disabled = false; $(".dot.rec").style.display = "";
  renderFilters(); show("live", { historyMode });

  const proto = location.protocol === "https:" ? "wss" : "ws";
  const ws = new WebSocket(`${proto}://${location.host}/ws?session=${s.id}`);
  state.ws = ws;
  ws.onmessage = (ev) => {
    if (state.ws !== ws) return;
    const { type, data } = JSON.parse(ev.data);
    if (type === "hello") {
      renderLens(data.lensEnabled);
      data.transcript.forEach((u) => addUtt(u)); data.signals.forEach(addSignal); data.suggestions.forEach((x) => addSuggestion(x, false));
      if (data.bot) setBot(data.bot);
      if (data.status === "ending") { $("#endCall").disabled = true; $("#endCall").textContent = "Building report…"; }
    }
    if (type === "lens") renderLens(data);
    if (type === "bot") { setBot(data); if (data.failed) toast({ kind: "MeetStream", title: data.label, text: data.message || "", priority: "high" }); }
    if (type === "commitment") toast({ kind: "commitment logged", title: data.commitment, text: `Owner: ${data.owner === "us" ? "our team" : "client"} · due ${data.due}` });
    if (type === "status" && data === "ending") { $("#endCall").disabled = true; $("#endCall").textContent = "Building report…"; }
    if (type === "status" && data === "live") { $("#endCall").disabled = false; $("#endCall").textContent = "End call & build report"; }
    if (type === "utterance") addUtt(data, true);
    if (type === "signal") addSignal(data);
    if (type === "suggestion") addSuggestion(data, true);
    if (type === "analyzing") $("#thinking").hidden = !data || !state.session.lensEnabled;
    if (type === "ended") showReport(data);
    if (type === "cancelled") {
      $("#liveLens").disabled = true;
      $("#endCall").disabled = true;
      $(".dot.rec").style.display = "none";
      setBot({ label: data?.label || "Call ended", message: data?.message });
    }
  };
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
  const at = u.recording_time === undefined ? (u.ts ? new Date(u.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "") : elapsed(Math.floor(u.recording_time));
  el.innerHTML = `<div class="who">${esc(u.speaker)}<small>${esc(at)}</small></div><div class="bubble">${esc(u.text)}</div><div class="tags"></div>`;
  $("#liveTalkRatio").innerHTML = renderTalkRatio(countWords(state.liveWords, u));
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
  const focusedFilter = $("#sigFilters").contains(document.activeElement) ? document.activeElement.dataset.t : null;
  $("#sigFilters").innerHTML = Object.keys(LABEL).map((t) => `<button type="button" class="tag t-${t}${state.filters.has(t) ? " off" : ""}" data-t="${t}" aria-pressed="${!state.filters.has(t)}">${LABEL[t]} ${counts[t] || 0}</button>`).join("");
  $$("#sigFilters .tag").forEach((button) => {
    const type = button.dataset.t;
    button.onclick = () => {
      if (state.filters.has(type)) state.filters.delete(type);
      else state.filters.add(type);
      renderFilters();
      renderSignals();
    };
    if (type === focusedFilter) button.focus({ preventScroll: true });
  });
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
  const sourced = Boolean(s.sources?.length);
  el.innerHTML = `<div class="k">${esc(s.kind.replace("_", " "))}</div><b>${esc(s.title)}</b>
    ${sourced ? `<div class="why">${esc(s.why)}</div>` : `<p>${esc(s.text)}</p><div class="why">${esc(s.why)}</div>`}
    <div class="btns">${sourced ? '<button class="btn sm" data-evidence>View source</button>' : ""}<button class="btn sm" data-a="used">✓ Used it</button><button class="btn sm" data-a="dismissed">Dismiss</button></div>`;
  if (sourced) $("[data-evidence]", el).onclick = () => showTechnicalSource(s);
  $$("[data-a]", el).forEach((b) => b.addEventListener("click", () => {
    el.classList.add(b.dataset.a);
    api(`/api/sessions/${state.session.id}/suggestions/${s.id}`, { method: "POST", body: { status: b.dataset.a } }).catch(() => {});
  }));
  box.prepend(el);
  $("#liveCueCount").textContent = `${box.children.length} ${box.children.length === 1 ? "cue" : "cues"}`;
  if (requestedCue === s.id && sourced) { requestedCue = null; showTechnicalSource(s); }
  if (popup) toast(s, true);
}

const showTechnicalSource = cue => showCueDetails(cue);

function showCueDetails(cue, meeting) {
  const dialog = $("#technicalSource");
  const website = cue.sources?.some(source => source.type === "website");
  $("#technicalSourceTitle").textContent = meeting ? cue.title : website ? "Client website source" : "Technical source";
  $("#technicalSourceBody").innerHTML = `
    ${meeting ? `<p class="muted small">${esc(meeting.client)} · ${esc(workspaceDate(meeting.started_at))}</p>` : ""}
    ${cue.text && (website || (meeting && !cue.sources?.length)) ? `<p>${esc(cue.text)}</p>` : ""}
    ${cue.why ? `<p class="muted">${esc(cue.why)}</p>` : ""}
    ${(cue.sources || []).map(source => `<blockquote><p>${esc(source.quote)}</p><footer>${esc(source.name)}${source.type === "website" ? ' · <a class="website-source" data-website-origin target="_blank" rel="noopener noreferrer">Open webpage</a>' : ""}</footer></blockquote>`).join("")}
    ${meeting ? `<div class="actions"><a class="btn sm" href="?session=${encodeURIComponent(meeting.id)}">Open report</a></div>` : ""}`;
  $$("[data-website-origin]", dialog).forEach((link, index) => setWebsiteLink(link, cue.sources.filter(source => source.type === "website")[index].url));
  if (!dialog.open) dialog.showModal();
}

$("#endCall").addEventListener("click", async (e) => {
  if (!state.session) return;
  const b = e.target; b.disabled = true; b.textContent = "Building report…";
  $(".dot.rec").style.display = "none";
  try {
    const m = await api(`/api/sessions/${state.session.id}/end`, { method: "POST" });
    showReport(m);
  }
  catch (err) { toast({ kind: "error", title: "Could not end call", text: err.message }); b.disabled = false; }
  finally { b.textContent = "End call & build report"; }
});

// ---------------- report
function showReport(m, historyMode = "push") {
  const isCurrentCall = state.session?.id === m.id;
  const clientName = (isCurrentCall && state.session.client) || state.client?.company || state.client?.name || "Post-call report";
  if (isCurrentCall) {
    state.ws?.close();
    state.ws = null;
    state.session = null;
  }
  $("#endCall").textContent = "End call & build report";
  const r = m.report;
  const used = (m.suggestions || []).filter((s) => s.status === "used").length;
  const cited = m.suggestions.filter((item) => item.sources?.length);
  const duration = Math.round((Date.parse(m.ended_at) - Date.parse(m.started_at)) / 1000);
  const counts = m.transcript.reduce(countWords, { rep: 0, client: 0 });
  const moments = m.signals.filter((signal) => signal.quote);
  const momentRows = moments.map(signal => `<li><span class="muted">${esc(signal.speaker)}</span><div><q>${esc(signal.quote)}</q><span class="tag t-${esc(signal.type)}">${esc(LABEL[signal.type] || signal.type)}</span></div></li>`);
  const none = `<li class="muted">None captured</li>`;
  const list = (items, fn) => `<ul>${items.map(fn).join("") || none}</ul>`;
  $("#report").className = "bento bento-report report";
  $("#report").innerHTML = `
    <header class="tile s12 report-summary">
      <div class="tile-head report-summary-head"><div><p class="section-context">Call report</p><h1>${esc(clientName)}</h1><p class="muted">${esc(SOURCES[m.source] || "Archived session")} · ${esc(dateLabel(m.started_at))}</p></div><div class="actions"><button class="btn sm" id="reportBack">Workspace</button><button class="btn sm" id="dlReport">Download report</button></div></div>
      <dl class="report-metrics">
        <div><dt>Coaching cues</dt><dd>${m.suggestions.length}</dd></div>
        <div><dt>Next steps</dt><dd>${r.next_steps?.length || 0}</dd></div>
        <div><dt>Estimated conversion</dt><dd>${m.transcript.length ? `${Math.round(r.conversion_likelihood)}%` : "—"}</dd></div>
        <div><dt>Session duration</dt><dd>${Number.isFinite(duration) && duration >= 0 ? elapsed(duration) : "—"}</dd></div>
      </dl>
    </header>
    <section class="tile s5 next-step-tile"><div class="tile-head"><h2>Next steps</h2></div><div id="reviewNextSteps"></div></section>
    <section class="tile s7 report-narrative"><div class="tile-head"><h2>Call summary</h2></div><p>${esc(r.executive_summary)}</p></section>
    <section class="tile s8"><div class="tile-head"><h2>Key moments</h2><span class="muted small">${moments.length} flagged</span></div>
      ${momentRows.length ? `<ul class="moment-list">${momentRows.slice(0, 3).join("")}</ul>` : '<p class="muted">No quoted moments were flagged.</p>'}
      ${momentRows.length > 3 ? `<details class="review-disclosure more-moments"><summary>Show ${momentRows.length - 3} more</summary><ul class="moment-list">${momentRows.slice(3).join("")}</ul></details>` : ""}</section>
    <section class="tile s4 report-ratio"><div class="tile-head"><h2>Talk ratio</h2></div>${renderTalkRatio(counts)}<p class="muted small">Share of transcript words</p></section>
    <section class="tile s7 coaching-tile"><div class="tile-head"><h2>Coaching insights</h2></div>${list([...r.insights, ...r.coaching_notes], (x) => `<li>${esc(x)}</li>`)}</section>
    <section class="tile s5"><div class="tile-head"><h2>Risks</h2><span class="tag t-risk">${r.risks.length}</span></div>${list(r.risks, (x) => `<li>${esc(x)}</li>`)}</section>
    <section class="tile ${cited.length ? "s7" : "s12"}"><div class="tile-head"><h2>Client requirements</h2></div><div class="requirement-list">
      ${r.client_requirements.map((x) => `<article><div><h3>${esc(x.requirement)}</h3><span class="pill ${esc(x.priority)}">${esc(x.priority)}</span></div>${x.evidence ? `<p class="muted">${esc(x.evidence)}</p>` : ""}</article>`).join("") || '<p class="muted">None captured</p>'}</div></section>
    ${cited.length ? `<section class="tile s5 evidence-tile"><div class="tile-head"><h2>${cited.some(item => item.sources.some(source => source.type === "website")) ? "Coaching sources" : "Technical sources"}</h2></div><div class="source-list">${cited.map((item) =>
      `<div><p>${esc(item.why || item.title)}</p><button class="btn sm" data-report-cue="${esc(item.id)}">View source<span class="sr-only">: ${esc(item.why || item.title)}</span></button></div>`).join("")}</div></section>` : ""}
    <details class="tile s12 review-disclosure"><summary>Follow-up email draft</summary><pre>${esc(r.follow_up_email)}</pre></details>
    <details class="tile s12 review-disclosure"><summary>Call signals and coaching</summary>
      <div class="report-detail-grid">
        <section><h3>Pain points</h3>${list(r.pain_points, (p) => `<li><b>${esc(p.title)}</b> · ${esc(p.detail)}</li>`)}</section>
        <section><h3>Objections</h3>${list(r.objections, (o) => `<li><span class="pill ${esc(o.status)}">${esc(o.status.replace("_", " "))}</span> <b>${esc(o.objection)}</b> · ${esc(o.notes)}</li>`)}</section>
        <section><h3>Buying signals</h3>${list(r.buying_signals, (x) => `<li>${esc(x)}</li>`)}</section>
        <section><h3>Cue activity</h3><p>${used} of ${m.suggestions.length} cues used${m.suppressed_suggestions ? ` · ${m.suppressed_suggestions} held back` : ""}.</p><p class="muted small">${r.transcript_quality ? `Transcript quality: ${esc(r.transcript_quality)} · ` : ""}${esc(m.report_engine)}</p></section>
      </div>
    </details>
    <details class="tile s12 review-disclosure"><summary>Transcript (${m.transcript.length} lines)</summary>
      <ul class="report-transcript">${m.transcript.map(line => `<li><b>${esc(line.speaker)}</b><span>${esc(line.text)}</span></li>`).join("") || none}</ul></details>
    ${["demo", "practice", "agent_test", "agent_meet", "replay"].includes(m.source) ? "" : `<div class="tile s12 accent-tile"><span class="label">Client memory updated</span><p style="margin-top:6px">${esc(m.profile_after?.summary || "")}</p>
      <div class="chips">${(m.profile_after?.known_pain_points || []).map((x) => `<span class="chip">${esc(x)}</span>`).join("")}</div></div>`}`;
  $("#dlReport").addEventListener("click", () => download(`report-${m.id}.md`, toMarkdown(m, clientName)));
  $("#reportBack").onclick = () => show("home");
  $("#meetingHistory").open = false;
  $$("[data-report-cue]").forEach((button) => button.onclick = () => showTechnicalSource(m.suggestions.find((item) => item.id === button.dataset.reportCue)));
  const citedCue = m.suggestions.find((item) => item.id === requestedCue && item.sources?.length);
  if (citedCue) { requestedCue = null; showTechnicalSource(citedCue); }
  show("report", { historyMode, sessionId: m.id });
  loadClients(m.client_id).then(() => {
    if (new URLSearchParams(location.search).get("session") === m.id) renderNextSteps(m);
  }).catch(showError);
}

function renderNextSteps(meeting) {
  const container = $("#reviewNextSteps");
  const steps = meeting.report.next_steps || [];
  const client = state.client;
  const canTrack = !["demo", "practice", "agent_test", "agent_meet", "replay"].includes(meeting.source);
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

function toMarkdown(m, clientName) {
  const r = m.report;
  return `# Post-call report: ${clientName}\n\n_${new Date(m.started_at).toLocaleString()}${m.transcript.length ? ` · conversion likelihood ${r.conversion_likelihood}%` : ""}${r.transcript_quality ? ` · transcript quality: ${r.transcript_quality}` : ""}_\n\n${r.executive_summary}\n
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
  $("#history").innerHTML = list.map((m) => `<li><a href="?session=${encodeURIComponent(m.id)}" data-id="${esc(m.id)}"><div><b>${esc(dateLabel(m.started_at))}</b> <span class="muted">· ${esc(SOURCES[m.source] || "Archived session")}</span><div class="small muted">${esc(m.report?.executive_summary?.slice(0, 160) || "")}…</div></div><span class="pill">${Math.round(m.report?.conversion_likelihood ?? 0)}%</span></a></li>`).join("") || `<li class="muted">No meetings yet</li>`;
  $$("#history a[data-id]").forEach((link) => link.onclick = (event) => {
    event.preventDefault();
    openSavedSession(link.dataset.id).catch(showError);
  });
}

// ---------------- toasts (real-time pop-ups)
function toast(s, liveCue = false) {
  const el = document.createElement("div");
  el.className = `toast ${s.priority || ""}`;
  const sourced = liveCue && s.sources?.length;
  el.innerHTML = `<b>${esc(s.title)}</b>${sourced ? '<button type="button" class="btn sm">View source</button>' : `<p>${esc(s.text)}</p>`}`;
  if (liveCue) {
    $(".toast.live-cue")?.remove();
    el.classList.add("live-cue");
  }
  if (sourced) $("button", el).onclick = () => showTechnicalSource(s);
  $("#toasts").prepend(el);
  while ($("#toasts").children.length > 3) $("#toasts").lastChild.remove();
  setTimeout(() => { el.classList.add("out"); setTimeout(() => el.remove(), 300); }, s.priority === "high" ? 11000 : 8000);
  el.addEventListener("click", () => el.remove());
}

renderMeetingMode();
if (meetingMode() === "client-lens") refreshLensSupport();
loadStatus().catch(showError);
loadSettings().catch(showError);
const initialNavigation = navigationRevision;
loadClients().then(() => {
  if (navigationRevision === initialNavigation) return restoreLocation();
}).catch((err) => toast({ kind: "error", title: "Could not load Cuelensa", text: err.message }));
