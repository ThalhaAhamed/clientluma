// Cuelensa server.
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { WebSocketServer } from "ws";
import * as store from "./lib/store.js";
import { generateKnowledgeBase, engine } from "./lib/ai.js";
import { startSession, getSession, bindBot, sessionForBot, liveSessions, describeSession } from "./lib/session.js";
import { isPracticeRun } from "./lib/call-workflow.js";
import * as meetstream from "./lib/meetstream.js";
import { extractDocText } from "./lib/extract.js";
import * as miaAgent from "./lib/mia-agent.js";
import * as miaTools from "./lib/mia-tools.js";
import { docsMcpSettings, parseDatabaseUrl, setting, saveSettings, settingsStatus } from "./lib/settings.js";
import { searchDocs, testDocs } from "./lib/docs-mcp.js";
import { testPostgres } from "./lib/postgres-store.js";
import { ZodError } from "zod";
import { sourceId } from "./lib/technical-sources.js";
import { websiteUrl } from "./lib/website-fetch.js";
import { websiteRevision } from "./lib/website-index.js";
import { clearWebsiteKnowledge, createWebsiteJobs, queueWebsiteCrawl, websiteActive, websiteState } from "./lib/website-jobs.js";

const websiteJobs = createWebsiteJobs(store);

const PORT = Number(process.env.PORT || 4000);
const LISTEN_HOST = process.env.MIA_LISTEN_HOST || "127.0.0.1";
const CALLBACK_PORT = process.env.MIA_CALLBACK_PORT ? Number(process.env.MIA_CALLBACK_PORT) : null;
if (CALLBACK_PORT !== null && (!Number.isInteger(CALLBACK_PORT) || CALLBACK_PORT < 0 || CALLBACK_PORT > 65535)) {
  throw new Error("MIA_CALLBACK_PORT must be a valid port number.");
}
const APP_ORIGIN = process.env.MIA_APP_ORIGIN ? new URL(process.env.MIA_APP_ORIGIN) : null;
const PROXY_TOKEN = process.env.MIA_PROXY_TOKEN || "";
if (APP_ORIGIN && (APP_ORIGIN.protocol !== "https:" || APP_ORIGIN.href !== `${APP_ORIGIN.origin}/` || APP_ORIGIN.username || PROXY_TOKEN.length < 32)) {
  throw new Error("Hosted mode needs a public HTTPS origin and a proxy token of at least 32 characters.");
}
const SOURCES = new Set(["meetstream", "mia"]);
// Public https URL for MeetStream webhooks: the live `npm run tunnel` address if that is running, else PUBLIC_URL.
// Read on every use so a restarted tunnel is picked up without restarting the server.
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const publicUrl = () => {
  let u = "";
  if (process.env.MIA_DESKTOP !== "1" && CALLBACK_PORT === null) try {
    const [url, pid] = fs.readFileSync(".tunnel-url", "utf8").trim().split(/\s+/);
    if (url && (!pid || alive(Number(pid)))) u = url; // stale file from a killed tunnel: ignore it
  } catch {}
  return (APP_ORIGIN ? setting("PUBLIC_URL") || APP_ORIGIN.origin : u || setting("PUBLIC_URL")).replace(/\/$/, "");
};
// MeetStream's per-bot webhooks are unsigned, so each webhook URL carries this secret (MeetStream's recommendation).
const WEBHOOK_SECRET = process.env.MIA_WEBHOOK_SECRET || crypto.randomBytes(16).toString("hex");
const matchesWebhookToken = (token) => {
  const got = Buffer.from(String(token || ""));
  const want = Buffer.from(WEBHOOK_SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const validToken = (req) => matchesWebhookToken(req.query.token);
const authenticatedProxy = (req) => {
  if (!APP_ORIGIN || req.headers.host?.toLowerCase() !== APP_ORIGIN.host) return false;
  const received = Buffer.from(req.headers["x-clientluma-proxy"] || "");
  const expected = Buffer.from(PROXY_TOKEN);
  return received.length === expected.length && crypto.timingSafeEqual(received, expected);
};


const app = express();
app.disable("x-powered-by");
const webhookPaths = new Set(["/webhooks/meetstream/transcript", "/webhooks/meetstream/status"]);
const toolPaths = new Set(["/mia-tools/get_client_context", "/mia-tools/search_client_history", "/mia-tools/log_commitment", "/mia-tools/search_product_docs"]);
const isCallback = (req) => req.method === "POST" && webhookPaths.has(req.url.split("?", 1)[0]);

// Traffic arriving through a public tunnel (ngrok, cloudflared) may only reach the MeetStream webhooks.
// The UI and API stay local-only, since they hold client data and use the AI key.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
app.use((req, res, next) => {
  res.set({
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  });
  if (req.method === "POST" && webhookPaths.has(req.path)) return validToken(req) ? next() : res.sendStatus(401);
  if (req.method === "POST" && toolPaths.has(req.path)) return validBearer(req) ? next() : res.sendStatus(401);
  const viaTunnel = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["ngrok-trace-id"]
    || !LOCAL_HOST.test(req.headers.host || "");
  const origin = APP_ORIGIN?.origin || `http://${req.headers.host}`;
  if (req.headers["sec-fetch-site"] === "cross-site" || (req.headers.origin && req.headers.origin !== origin)) return res.sendStatus(403);
  if (APP_ORIGIN ? authenticatedProxy(req) : !viaTunnel) return next();
  res.status(404).send("Not found");
});

const standardBody = express.json({ limit: "256kb" });
const documentBody = express.json({ limit: "30mb" });
app.use((req, res, next) => (req.method === "POST" && /^\/api\/clients\/[^/]+\/documents\/?$/.test(req.path)
  ? documentBody : standardBody)(req, res, next));
app.use(express.static("public"));

const wrap = (fn) => (req, res) => fn(req, res).catch((error) => {
  console.error("Workspace request failed.", error.name);
  res.status(500).json({ error: "The workspace request failed. Check the server logs." });
});

app.get("/api/status", (_req, res) =>
  res.json({ engine: engine(), meetstream: meetstream.meetstreamEnabled(), webhook: Boolean(publicUrl()), mia_agent: miaAgent.agentStatus() })
);
const appSettings = () => ({ ...settingsStatus(), database: store.databaseStatus(),
  databaseSelection: store.databaseSelection(), databaseRestartRequired: store.databaseRestartRequired(), hosted: Boolean(APP_ORIGIN),
  callbackTarget: callbackServer?.address() ? `http://127.0.0.1:${callbackServer.address().port}` : null });
app.get("/api/settings", (_req, res) => res.set("Cache-Control", "no-store").json(appSettings()));
app.post("/api/settings/test-database", wrap(async (req, res) => {
  if (!req.is("application/json")) return res.sendStatus(415);
  const value = req.body?.url;
  if (value !== undefined && (typeof value !== "string" || value.length > 4096)) {
    return res.status(400).json({ error: "Enter a valid PostgreSQL connection URL." });
  }
  const url = process.env.MIA_DATABASE_URL || value?.trim() || setting("MIA_DATABASE_URL");
  if (!parseDatabaseUrl(url)) return res.status(400).json({ error: "Enter a PostgreSQL connection URL. Remote connections require verified TLS." });
  try { await testPostgres(url); res.json({ connected: true }); }
  catch { res.status(502).json({ error: "Could not connect to PostgreSQL. Check the address, credentials and TLS certificate." }); }
}));
app.post("/api/settings/test-docs", wrap(async (_req, res) => {
  const { url, tool } = docsMcpSettings();
  if (!url || !tool) return res.status(400).json({ error: "Save the MCP endpoint and search tool first." });
  const result = await testDocs();
  res.status(result.error ? 502 : 200).json(result);
}));
app.put("/api/settings", (req, res, next) => {
  if (!req.is("application/json")) return res.sendStatus(415);
  if (liveSessions({ includePending: true }).length) return res.status(409).json({ error: "Finish active calls before changing services." });
  try {
    saveSettings(req.body);
    res.set("Cache-Control", "no-store").json(appSettings());
  } catch (error) {
    if (error instanceof ZodError) return res.status(400).json({ error: error.issues[0]?.message || "Check the settings fields." });
    next(error);
  }
});

// ---------- MeetStream MIA agent (hosted voice agent that answers from client memory)
const agentToolsBase = () => publicUrl();
async function syncAgent() {
  if (!meetstream.meetstreamEnabled()) throw Object.assign(new Error("Set MEETSTREAM_API_KEY first."), { status: 400 });
  const base = agentToolsBase();
  if (!base) throw Object.assign(new Error("No public URL: run `npm run tunnel` so the agent can reach this server's tools."), { status: 400 });
  return miaAgent.ensureAgent({ toolBaseUrl: base, secret: WEBHOOK_SECRET });
}
app.get("/api/mia", (_req, res) => res.json(miaAgent.agentStatus()));
app.post("/api/mia/sync", async (_req, res) => {
  try { res.json({ agent_config_id: await syncAgent(), ...miaAgent.agentStatus() }); }
  catch (e) { res.status(e.status === 400 ? 400 : 502).json({ error: e.message, ...miaAgent.agentStatus() }); }
});

// ---------- Clients & pre-call knowledge base
app.get("/api/clients", wrap(async (_req, res) => {
  res.json((await store.listClients()).map(({ website_knowledge, ...client }) => client));
}));
app.get("/api/clients/:id", wrap(async (req, res) => {
  const c = await store.getClient(req.params.id);
  if (!c) return res.status(404).json({ error: "not found" });
  res.json({ ...c, documents: (c.documents || []).map((doc) => ({ ...doc, id: sourceId(doc) })),
    meeting_list: (await store.listMeetings(c.id)).map(({ transcript, kb, ...m }) => m) });
}));

app.post("/api/clients", wrap(async (req, res) => {
  const b = req.body || {};
  if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 200) {
    return res.status(400).json({ error: "Enter a contact name of up to 200 characters." });
  }
  for (const [key, limit] of Object.entries({ company: 300, industry: 300, deal: 8000, offering: 12000, notes: 60000 })) {
    if (b[key] !== undefined && (typeof b[key] !== "string" || b[key].length > limit)) {
      return res.status(400).json({ error: `Enter ${key} as text of up to ${limit} characters.` });
    }
  }
  if (b.contacts !== undefined && (!Array.isArray(b.contacts) || b.contacts.length > 100 || b.contacts.some(contact =>
    typeof contact?.name !== "string" || !contact.name.trim() || contact.name.length > 200 ||
    (contact.role !== undefined && (typeof contact.role !== "string" || contact.role.length > 300))))) {
    return res.status(400).json({ error: "Enter up to 100 stakeholder names and roles." });
  }
  let url;
  if (Object.hasOwn(b, "website_url")) {
    try { url = typeof b.website_url === "string" && !b.website_url.trim() ? "" : websiteUrl(b.website_url).href; }
    catch { return res.status(400).json({ error: "Enter a public website URL without credentials or a custom port." }); }
  }
  let websiteChanged = false;
  const withFields = (existing) => {
    const client = {
      ...existing,
      name: b.name.trim(), company: b.company || "", industry: b.industry || "", deal: b.deal || "",
      offering: b.offering || "", notes: b.notes || "",
      contacts: Array.isArray(b.contacts) ? b.contacts.filter((x) => x?.name) : [],
      local_only: typeof b.local_only === "boolean" ? b.local_only : Boolean(existing.local_only),
    };
    if (url !== undefined && url !== (existing.website_url || "")) {
      clearWebsiteKnowledge(client);
      client.website_url = url;
      if (url) queueWebsiteCrawl(client, store.newId("crawl"));
      websiteChanged = true;
    }
    return client;
  };
  let c = typeof b.id === "string" && await store.updateClient(b.id, existing => existing && withFields(existing));
  if (b.id && !c) return res.status(404).json({ error: "Client not found. Create a new client to save these details." });
  if (!c) {
    const id = store.newId("cli");
    c = await store.updateClient(id, () => withFields({ id, profile: null, meetings: [], documents: [] }));
  }
  if (websiteChanged) {
    if (c.website_url) websiteJobs.enqueue(c.id);
    else websiteJobs.cancel(c.id);
  }
  res.json(c);
}));

app.delete("/api/clients/:id", wrap(async (req, res) => {
  if (liveSessions({ includePending: true }).some(session => session.clientId === req.params.id)) {
    return res.status(409).json({ error: "End this client’s active call before deleting the client." });
  }
  await store.deleteClient(req.params.id);
  websiteJobs.cancel(req.params.id);
  res.json({ ok: true });
}));

app.get("/api/clients/:id/website", wrap(async (req, res) => {
  const client = await store.getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "Client not found." });
  res.json(websiteState(client));
}));

app.post("/api/clients/:id/website", wrap(async (req, res) => {
  const jobId = store.newId("crawl");
  const changed = await store.updateClient(req.params.id, client => {
    if (!client?.website_url || websiteActive(client)) return null;
    queueWebsiteCrawl(client, jobId);
    return client;
  });
  const client = changed || await store.getClient(req.params.id);
  if (!client) return res.status(404).json({ error: "Client not found." });
  if (!client.website_url) return res.status(400).json({ error: "Save a website URL on this client first." });
  if (changed) websiteJobs.enqueue(client.id);
  res.status(202).json(websiteState(client));
}));

app.delete("/api/clients/:id/website", wrap(async (req, res) => {
  const client = await store.updateClient(req.params.id, record => {
    if (!record) return null;
    clearWebsiteKnowledge(record);
    delete record.website_url;
    return record;
  });
  if (!client) return res.status(404).json({ error: "Client not found." });
  websiteJobs.cancel(client.id);
  res.json(websiteState(client));
}));

// Body: { name, text } for plain text, or { name, data } with base64 file bytes (PDF, DOCX, text formats).
app.post("/api/clients/:id/documents", wrap(async (req, res) => {
  if (!await store.getClient(req.params.id)) return res.status(404).json({ error: "not found" });
  const { data } = req.body || {};
  const name = String(req.body?.name || "document").slice(0, 255);
  let { text } = req.body || {};
  if (!text && data) {
    try { text = await extractDocText(name, Buffer.from(data, "base64")); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  text = String(text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return res.status(400).json({ error: `No text found in ${name}. Scanned PDFs need OCR first.` });
  const latest = await store.updateClient(req.params.id, client => {
    if (!client) return null;
    client.documents = [...(client.documents || []), { id: store.newId("doc"), name, text: text.slice(0, 200000), added_at: new Date().toISOString() }];
    return client;
  });
  if (!latest) return res.sendStatus(404);
  res.json(latest);
}));

app.patch("/api/clients/:id/technical-sources/:source", wrap(async (req, res) => {
  if (typeof req.body?.approved !== "boolean") return res.status(400).json({ error: "Choose whether to approve the source." });
  const changed = await store.updateClient(req.params.id, client => {
    const doc = client?.documents?.find(item => sourceId(item) === req.params.source);
    if (!doc) return null;
    doc.id = sourceId(doc);
    doc.approved_technical = req.body.approved;
    return client;
  });
  if (!changed) return res.status(404).json({ error: "Source document not found." });
  res.json({ id: req.params.source, approved_technical: req.body.approved });
}));

app.delete("/api/clients/:id/documents/:idx", wrap(async (req, res) => {
  const c = await store.updateClient(req.params.id, client => {
    const index = Number(req.params.idx);
    if (!Number.isInteger(index) || index < 0 || !client?.documents?.[index]) return null;
    client.documents.splice(index, 1);
    return client;
  });
  if (!c) return res.status(404).json({ error: "not found" });
  res.json(c);
}));

app.post("/api/clients/:id/kb", wrap(async (req, res) => {
  const c = await store.getClient(req.params.id);
  if (!c) return res.status(404).json({ error: "not found" });
  const { kb, engine: used } = await generateKnowledgeBase(c);
  const updated = await store.updateClient(c.id, client => client && websiteRevision(client) === websiteRevision(c)
    ? { ...client, kb, kb_engine: used, kb_at: new Date().toISOString() } : null);
  if (!updated) {
    if (!await store.getClient(c.id)) return res.status(404).json({ error: "Client not found." });
    return res.status(409).json({ error: "The website index changed while the brief was generating. Generate the brief again." });
  }
  res.json(updated);
}));

// ---------- Live sessions
app.post("/api/sessions", wrap(async (req, res) => {
  const { clientId, source = "meetstream", repName = "", meetingLink, lensEnabled = true } = req.body || {};
  if (!SOURCES.has(source)) return res.status(400).json({ error: "Choose Meeting bot or Meeting assistant." });
  if (typeof lensEnabled !== "boolean") return res.status(400).json({ error: "Client Lens must be on or off." });
  if (typeof repName !== "string") return res.status(400).json({ error: "The presenter name must be text." });
  let c = await store.getClient(clientId);
  if (!c) return res.status(404).json({ error: "Client not found." });
  if (source === "mia" && c.local_only) {
    return res.status(400).json({ error: "This client uses local-only coaching. Choose the silent meeting bot." });
  }
  if (!meetstream.meetstreamEnabled()) return res.status(400).json({ error: "Add a MeetStream key in Settings." });
  const webhookBase = publicUrl();
  if (!webhookBase) return res.status(400).json({ error: "Add a public HTTPS callback URL in Settings." });
  let meetingUrl;
  try {
    if (typeof meetingLink !== "string") throw new Error();
    meetingUrl = new URL(meetingLink.trim());
    if (meetingUrl.protocol !== "https:" || meetingUrl.username || meetingUrl.password) throw new Error();
  } catch {
    return res.status(400).json({ error: "Enter a valid HTTPS meeting link." });
  }
  if (!c.kb && (lensEnabled || source === "mia")) {
    const { kb, engine: used } = await generateKnowledgeBase(c);
    c = await store.updateClient(c.id, client => client && (client.kb || websiteRevision(client) !== websiteRevision(c) ? client
      : { ...client, kb, kb_engine: used, kb_at: new Date().toISOString() }));
    if (!c) return res.status(404).json({ error: "Client not found." });
  }
  let agentConfigId;
  if (source === "mia") {
    try { agentConfigId = await syncAgent(); }
    catch (error) { return res.status(502).json({ error: error.message }); }
  }
  const session = startSession({ client: c, kb: c.kb, repName, source, lensEnabled: source === "meetstream" && lensEnabled });
  const token = encodeURIComponent(WEBHOOK_SECRET);
  const options = {
    meetingLink: meetingUrl.href, meetingId: session.id,
    webhookUrl: webhookBase + "/webhooks/meetstream/transcript?token=" + token,
    callbackUrl: webhookBase + "/webhooks/meetstream/status?token=" + token,
  };
  try {
    if (source === "mia") {
      const agent = await miaAgent.launchAgentBot({
        ...options, agentConfigId, params: miaAgent.agentParams({ client: c, repName }),
      });
      bindBot(session, agent.botId);
      session.agentName = miaAgent.AGENT_SETTINGS.name;
      if (!agent.liveTranscript) {
        const listener = await meetstream.createBot(options);
        bindBot(session, listener.botId, "transcript");
      }
    } else {
      const listener = await meetstream.createBot(options);
      bindBot(session, listener.botId);
    }
    if (session.status !== "live") throw new Error(session.botStatus?.label || "The meeting ended while the bot was joining.");
    session.botStatus ||= {
      label: session.transcriptBotId ? "Assistant and transcript bot joining…" :
        source === "mia" ? "Meeting assistant joining…" : "Meeting bot joining…",
    };
  } catch (error) {
    session.discard();
    await session.removeBots();
    return res.status(502).json({ error: error.message });
  }
  res.json({ ...describeSession(session), kb: session.kb, botId: session.botId });
}));

app.get("/api/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);
  if (!session || session.status === "ended") return res.status(404).json({ error: "Active call not found." });
  res.json(describeSession(session));
});

// Calls in progress (local only, like the rest of the API). The desktop overlay polls this.
app.get("/api/live", (_req, res) => res.json(liveSessions()));

app.get("/api/workspace", wrap(async (_req, res) => {
  const [profiles, meetings] = await Promise.all([store.listClients(), store.listMeetings()]);
  const clients = new Map(profiles.map(client => [client.id, client]));
  const reports = meetings.filter(m => clients.has(m.client_id));
  const recent = reports.slice(0, 6).map((m) => {
    const client = clients.get(m.client_id);
    return { id: m.id, clientId: client.id, client: client.company || client.name, source: m.source, started_at: m.started_at };
  });
  const followUps = [...clients.values()].flatMap((client) => (client.commitments || [])
    .filter((item) => item.status === "open")
    .map(({ id, text, due, owner, created_at }) => ({ id, text, due, owner, created_at, clientId: client.id, client: client.company || client.name })))
    .sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
  const active = liveSessions({ includePending: true });
  res.json({ active, recent, followUps: followUps.slice(0, 6), totals: { reports: reports.length, followUps: followUps.length } });
}));

// Overlay context for one call.
app.get("/api/sessions/:id/brief", wrap(async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  const kb = s.researchContext(await store.getClient(s.client.id)).kb || {};
  const p = s.client.profile || {};
  res.json({
    client: s.client.company || s.client.name,
    goals: kb.goals_for_call || [],
    open_objections: p.open_objections || [],
    objection_handling: (kb.likely_objections || []).map((o) => ({ objection: o.objection, response: o.response })),
    questions_to_ask: [...(kb.website_discovery_questions || []).map(item => item.question), ...(kb.questions_to_ask || [])],
  });
}));

app.patch("/api/sessions/:id/lens", (req, res) => {
  const session = getSession(req.params.id);
  if (session?.status !== "live") return res.status(404).json({ error: "Active call not found." });
  if (session.source !== "meetstream") return res.status(409).json({ error: "Client Lens is available on Meeting bot calls." });
  const { enabled } = req.body || {};
  if (typeof enabled !== "boolean") return res.status(400).json({ error: "Client Lens must be on or off." });
  session.setLens(enabled);
  res.json({ enabled: session.lensEnabled });
});

app.post("/api/sessions/:id/suggestions/:sid", (req, res) => {
  const s = getSession(req.params.id);
  const sug = s?.suggestions.find((x) => x.id === req.params.sid);
  if (sug) sug.status = req.body?.status || "used";
  res.json({ ok: Boolean(sug) });
});

app.post("/api/sessions/:id/end", wrap(async (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  const [meeting] = await Promise.all([s.end(), s.removeBots()]);
  res.json(meeting);
}));

app.get("/api/meetings/:id", wrap(async (req, res) => {
  const m = await store.getMeeting(req.params.id);
  if (!m || !await store.getClient(m.client_id)) return res.status(404).json({ error: "Meeting not found." });
  res.json(m);
}));

app.post("/api/meetings/:id/follow-ups", wrap(async (req, res) => {
  const meeting = await store.getMeeting(req.params.id);
  if (!meeting) return res.status(404).json({ error: "Meeting or client not found." });
  if (isPracticeRun(meeting.source)) return res.status(400).json({ error: "Follow-ups from this practice report stay with the report." });
  const { index } = req.body || {};
  const proposal = Number.isInteger(index) && meeting.report?.next_steps?.[index];
  if (!proposal) return res.status(400).json({ error: "Choose a next step from this report." });
  const { action = proposal.action, owner = proposal.owner, due = proposal.due } = req.body;
  if (typeof action !== "string" || !action.trim() || action.trim().length > 300 || !["us", "client", "both"].includes(owner) || typeof due !== "string" || due.length > 120) {
    return res.status(400).json({ error: "Enter a follow-up, choose an owner, and keep the due date under 120 characters." });
  }
  let item;
  let created = false;
  const client = await store.updateClient(meeting.client_id, profile => {
    if (!profile) return null;
    const commitments = profile.commitments || [];
    item = commitments.find(entry => entry.meeting_id === meeting.id && entry.next_step_index === index);
    if (item) return null;
    created = true;
    item = { id: store.newId("cmt"), text: action.trim(), owner, due: due.trim(), status: "open",
      meeting_id: meeting.id, next_step_index: index, source: "report-review", created_at: new Date().toISOString() };
    profile.commitments = [...commitments, item];
    return profile;
  });
  if (!client && !item) return res.status(404).json({ error: "Meeting or client not found." });
  res.status(created ? 201 : 200).json(item);
}));

app.patch("/api/clients/:id/follow-ups/:followUpId", wrap(async (req, res) => {
  const status = req.body?.status;
  if (!["open", "done"].includes(status)) return res.status(400).json({ error: "Choose open or done." });
  let item;
  const client = await store.updateClient(req.params.id, profile => {
    item = profile?.commitments?.find(entry => entry.id === req.params.followUpId);
    if (!item) return null;
    item.status = status;
    return profile;
  });
  if (!client) return res.status(404).json({ error: "Follow-up not found." });
  res.json(item);
}));

// ---------- MeetStream live transcript webhook
// Only accept events for a bot this server created (the bot_id must match the session).
const sessionFor = (ev) => sessionForBot(ev.botId);
app.post("/webhooks/meetstream/transcript", (req, res) => {
  if (!validToken(req)) return res.sendStatus(401);
  res.sendStatus(200); // acknowledge fast; MeetStream sends one POST per sentence
  const ev = meetstream.parseTranscriptEvent(req.body);
  const s = ev && sessionFor(ev);
  if (s && ev.botId === (s.transcriptBotId || s.botId)) s.addUtterance(ev.utterance);
});

// Bot lifecycle (callback_url): show status in the UI and build the report when the meeting ends.
app.post("/webhooks/meetstream/status", (req, res) => {
  if (!validToken(req)) return res.sendStatus(401);
  res.sendStatus(200);
  const ev = meetstream.parseStatusEvent(req.body);
  const s = ev && sessionFor(ev);
  if (!s) return;
  if (s.status !== "live") return;
  const label = s.transcriptBotId ? (ev.botId === s.transcriptBotId ? "Transcript bot: " : "Assistant: ") + ev.label : ev.label;
  s.botStatus = { ...ev, label };
  s.emit("bot", s.botStatus);
  if (!ev.ended) return;
  s.removeBots();
  if (s.transcript.length || s.hold) s.end().catch((error) => console.error("Meeting report failed:", error));
  else {
    s.botStatus = { ...s.botStatus, label: label + " · No transcript captured" };
    s.discard();
    s.emit("cancelled", s.botStatus);
  }
});

// ---------- Tools called by the MIA agent (MeetStream custom functions)
// Auth: Bearer secret set in the agent config. The meeting is identified by MeetStream's X-Bot-ID header, so the
// agent can only read the client of the meeting it is in.
const validBearer = (req) => {
  const got = Buffer.from(String(req.headers.authorization || "").replace(/^Bearer\s+/i, ""));
  const want = Buffer.from(WEBHOOK_SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
app.post("/mia-tools/:name", wrap(async (req, res) => {
  if (!validBearer(req)) return res.status(401).json({ error: "unauthorized" });
  const botId = req.headers["x-bot-id"] || req.body?.bot?.bot_id;
  const s = botId && sessionForBot(botId);
  if (s?.status !== "live" || s.source !== "mia" || s.botId !== botId) return res.status(404).json({ error: "No active MIA assistant meeting found for this bot." });
  const args = req.body?.args ?? req.body ?? {};
  const clientId = s.client.id;
  if (req.params.name === "search_product_docs") {
    const { url, tool } = docsMcpSettings();
    if (!url || !tool) return res.status(404).json({ error: "Product docs are not configured." });
    const result = await searchDocs(args.query);
    return res.status(result.error ? 400 : 200).json({ data: result });
  }
  let out;
  switch (req.params.name) {
    case "get_client_context": out = await miaTools.getClientContext(clientId); break;
    case "search_client_history": out = await miaTools.searchClientHistory(clientId, args.query); break;
    case "log_commitment":
      out = await miaTools.logCommitment(clientId, args, { meetingId: s.id, botId });
      if (out.ok) s.emit("commitment", out.logged);
      break;
    default: return res.status(404).json({ error: `Unknown tool ${req.params.name}` });
  }
  s.emit("agent_tool", { name: req.params.name, args, ok: !out.error });
  res.status(out.error ? 400 : 200).json({ data: out });
}));

// ---------- WebSocket: UI subscribes to a session's live events
app.use((error, _req, res, next) => {
  if (res.headersSent) return next(error);
  if (error.type === "entity.too.large") return res.status(413).json({ error: "The request exceeds the upload limit." });
  if (error.type === "entity.parse.failed") return res.status(400).json({ error: "The request body is not valid JSON." });
  console.error("Workspace middleware failed.", error.name);
  res.status(500).json({ error: "The workspace request failed. Check the server logs." });
});

const server = http.createServer(app);
// The callback listener exposes only authenticated MeetStream webhooks and assistant tools.
const callbackServer = CALLBACK_PORT === null ? null : http.createServer((req, res) => {
  if (req.method === "POST" && toolPaths.has(req.url.split("?", 1)[0]) && validBearer(req)) return app(req, res);
  if (!isCallback(req)) return res.writeHead(404).end();
  const token = new URLSearchParams(req.url.slice(req.url.indexOf("?") + 1)).get("token");
  if (!matchesWebhookToken(token)) return res.writeHead(401).end();
  app(req, res);
});
const localSocket = (req) => {
  if (req.url.split("?", 1)[0] !== "/ws") return false;
  if (APP_ORIGIN) return authenticatedProxy(req) && req.headers.origin === APP_ORIGIN.origin;
  if (!LOCAL_HOST.test(req.headers.host || "")) return false;
  if (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]) return false;
  return !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
};
const wss = new WebSocketServer({ noServer: true, maxPayload: 32 * 1024 });
const rejectUpgrade = (socket) => socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
server.on("upgrade", (req, socket, head) => {
  if (!localSocket(req)) return rejectUpgrade(socket);
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
callbackServer?.on("upgrade", (_req, socket) => rejectUpgrade(socket));
wss.on("connection", (ws, req) => {
  const id = new URL(req.url, "http://x").searchParams.get("session");
  const s = getSession(id);
  if (!s) return ws.close(4404, "session not found");
  s.listeners.add(ws);
  ws.send(JSON.stringify({ type: "hello", data: { transcript: s.transcript, signals: s.signals, suggestions: s.suggestions, bot: s.botStatus || null, status: s.status, lensEnabled: s.lensEnabled, lensCue: s.lensCue } }));
  if (s.meeting) ws.send(JSON.stringify({ type: "ended", data: s.meeting }));
  else if (s.status === "ended") ws.send(JSON.stringify({ type: "cancelled", data: s.botStatus }));
  ws.on("close", () => s.listeners.delete(ws));
});

server.listen(PORT, LISTEN_HOST, () => {
  websiteJobs.resume().catch(error => console.error("Could not resume website indexing:", error.message));
  process.parentPort?.postMessage({ port: server.address().port });
  console.log(`Cuelensa running at http://localhost:${server.address().port}`);
  console.log(`  engine: ${engine()}`);
  console.log(`  meetstream: ${meetstream.meetstreamEnabled() ? "enabled" : "disabled (set MEETSTREAM_API_KEY)"}`);
  const a = miaAgent.agentStatus();
  console.log(`  mia agent: ${a.mode}, llm ${a.llm}${a.agent_config_id ? `, config ${a.agent_config_id}` : " (created on first use)"}`);
});
callbackServer?.listen(CALLBACK_PORT, "127.0.0.1", () => {
  console.log(`MeetStream callbacks only at http://127.0.0.1:${callbackServer.address().port}`);
});
