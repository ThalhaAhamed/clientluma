// ClientLuma server.
import express from "express";
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import { WebSocketServer } from "ws";
import * as store from "./lib/store.js";
import { generateKnowledgeBase, engine } from "./lib/ai.js";
import { startSession, getSession, bindBot, sessionForBot, liveSessions } from "./lib/session.js";
import * as meetstream from "./lib/meetstream.js";
import { DEMO_CLIENT, playDemo } from "./lib/demo.js";
import { AI_PRESENTER, playAgentTest } from "./lib/agent-test.js";
import { connectVoice, speakInMeet } from "./lib/meet-voice.js";
import { getReplay, advanceReplay } from "./lib/replay.js";
import { extractDocText } from "./lib/extract.js";
import * as miaAgent from "./lib/mia-agent.js";
import * as miaTools from "./lib/mia-tools.js";

const PORT = Number(process.env.PORT || 4000);
const LISTEN_HOST = process.env.MIA_LISTEN_HOST || "127.0.0.1";
const SOURCES = new Set(["browser", "demo", "replay", "meetstream", "mia", "practice", "agent_test", "agent_meet"]);
// Public https URL for MeetStream webhooks: the live `npm run tunnel` address if that is running, else PUBLIC_URL.
// Read on every use so a restarted tunnel is picked up without restarting the server.
const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
};
const publicUrl = () => {
  let u = "";
  try {
    const [url, pid] = fs.readFileSync(".tunnel-url", "utf8").trim().split(/\s+/);
    if (url && (!pid || alive(Number(pid)))) u = url; // stale file from a killed tunnel: ignore it
  } catch {}
  return (u || process.env.PUBLIC_URL || "").replace(/\/$/, "");
};
// MeetStream's per-bot webhooks are unsigned, so each webhook URL carries this secret (MeetStream's recommendation).
const WEBHOOK_SECRET = process.env.MIA_WEBHOOK_SECRET || crypto.randomBytes(16).toString("hex");
const validToken = (req) => {
  const got = Buffer.from(String(req.query.token || ""));
  const want = Buffer.from(WEBHOOK_SECRET);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};

if (!store.getClient(DEMO_CLIENT.id)) store.saveClient(structuredClone(DEMO_CLIENT));

const app = express();

// Traffic arriving through a public tunnel (ngrok, cloudflared) may only reach the MeetStream webhooks.
// The UI and API stay local-only, since they hold client data and use the AI key.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
app.use((req, res, next) => {
  const viaTunnel = req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.headers["ngrok-trace-id"]
    || !LOCAL_HOST.test(req.headers.host || "");
  const publicRoute = req.method === "POST" && (req.path.startsWith("/webhooks/meetstream/") || req.path.startsWith("/mia-tools/"));
  if (!publicRoute && req.headers["sec-fetch-site"] === "cross-site") return res.sendStatus(403);
  if (!viaTunnel || publicRoute) return next();
  res.status(404).send("Not found");
});

app.use(express.json({ limit: "30mb" })); // base64 document uploads
app.use(express.static("public"));

const wrap = (fn) => (req, res) => fn(req, res).catch((e) => { console.error(e); res.status(500).json({ error: e.message }); });

app.get("/api/status", (_req, res) =>
  res.json({ engine: engine(), meetstream: meetstream.meetstreamEnabled(), webhook: Boolean(publicUrl()), mia_agent: miaAgent.agentStatus() })
);

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
app.get("/api/clients", (_req, res) => res.json(store.listClients()));
app.get("/api/clients/:id", (req, res) => {
  const c = store.getClient(req.params.id);
  if (!c) return res.status(404).json({ error: "not found" });
  res.json({ ...c, recording_available: Boolean(getReplay(c.id)), meeting_list: store.listMeetings(c.id).map(({ transcript, kb, ...m }) => m) });
});

app.post("/api/clients", (req, res) => {
  const b = req.body || {};
  if (!b.name) return res.status(400).json({ error: "name is required" });
  const existing = b.id ? store.getClient(b.id) : null;
  const c = {
    ...(existing || { id: store.newId("cli"), profile: null, meetings: [], documents: [] }),
    name: b.name, company: b.company || "", industry: b.industry || "", deal: b.deal || "",
    offering: b.offering || "", notes: b.notes || "",
    contacts: Array.isArray(b.contacts) ? b.contacts.filter((x) => x?.name) : [],
    local_only: typeof b.local_only === "boolean" ? b.local_only : Boolean(existing?.local_only),
  };
  res.json(store.saveClient(c));
});

app.delete("/api/clients/:id", (req, res) => { store.deleteClient(req.params.id); res.json({ ok: true }); });

// Body: { name, text } for plain text, or { name, data } with base64 file bytes (PDF, DOCX, text formats).
app.post("/api/clients/:id/documents", wrap(async (req, res) => {
  const c = store.getClient(req.params.id);
  if (!c) return res.status(404).json({ error: "not found" });
  const { name = "document", data } = req.body || {};
  let { text } = req.body || {};
  if (!text && data) {
    try { text = await extractDocText(name, Buffer.from(data, "base64")); }
    catch (e) { return res.status(400).json({ error: e.message }); }
  }
  text = String(text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  if (!text) return res.status(400).json({ error: `No text found in ${name}. Scanned PDFs need OCR first.` });
  c.documents = [...(c.documents || []), { name, text: text.slice(0, 200000), added_at: new Date().toISOString() }];
  res.json(store.saveClient(c));
}));

app.delete("/api/clients/:id/documents/:idx", (req, res) => {
  const c = store.getClient(req.params.id);
  if (!c) return res.status(404).json({ error: "not found" });
  c.documents.splice(Number(req.params.idx), 1);
  res.json(store.saveClient(c));
});

app.post("/api/clients/:id/kb", wrap(async (req, res) => {
  const c = store.getClient(req.params.id);
  if (!c) return res.status(404).json({ error: "not found" });
  const { kb, engine: used } = await generateKnowledgeBase(c);
  c.kb = kb; c.kb_engine = used; c.kb_at = new Date().toISOString();
  store.saveClient(c);
  res.json(c);
}));

// ---------- Live sessions
app.post("/api/sessions", wrap(async (req, res) => {
  const { clientId, source = "browser", repName = "", meetingLink } = req.body || {};
  const c = store.getClient(clientId);
  if (!c) return res.status(404).json({ error: "client not found" });
  if (!SOURCES.has(source)) return res.status(400).json({ error: "Unknown call source." });
  if (typeof repName !== "string") return res.status(400).json({ error: "The presenter name must be text." });
  if (c.local_only && ["mia", "practice", "agent_test", "agent_meet"].includes(source)) {
    return res.status(400).json({ error: "This client uses local-only coaching. Choose Recording replay, Simulated call, Microphone, or a silent MeetStream bot." });
  }
  const recording = source === "replay" ? getReplay(c.id) : null;
  if (source === "replay" && !recording) return res.status(404).json({ error: "No replay recording is available for this client." });
  const agentMeet = source === "agent_meet";
  if (["agent_test", "agent_meet"].includes(source) && engine() === "offline") return res.status(400).json({ error: "Configure an AI provider to run the two-agent test." });
  if (agentMeet && process.platform !== "win32" && !process.env.GEMINI_API_KEY && !process.env.GOOGLE_API_KEY) return res.status(400).json({ error: "Configure a Gemini key for voice playback in Meet." });
  const remote = ["meetstream", "mia", "practice", "agent_meet"].includes(source);
  const webhookBase = remote ? publicUrl() : "";
  if (remote) {
    if (!meetstream.meetstreamEnabled()) return res.status(400).json({ error: "Set MEETSTREAM_API_KEY to send a bot." });
    if (!webhookBase) return res.status(400).json({ error: "Start the tunnel or set PUBLIC_URL so MeetStream can reach the webhook." });
    if (typeof meetingLink !== "string" || !meetingLink.trim()) return res.status(400).json({ error: "Meeting link is required." });
  }
  if (!c.kb) {
    const { kb, engine: used } = await generateKnowledgeBase(c);
    c.kb = kb; c.kb_engine = used; c.kb_at = new Date().toISOString();
    store.saveClient(c);
  }
  let agentConfigId;
  if (source === "mia" || source === "practice") {
    try { agentConfigId = source === "practice" ? await miaAgent.ensureAgent({ kind: "persona" }) : await syncAgent(); }
    catch (e) { return res.status(502).json({ error: `Could not set up the ${source === "practice" ? "AI client" : "MIA agent"}: ${e.message}` }); }
  }
  const s = startSession({ client: c, kb: c.kb, repName: source === "demo" ? "Alex" : repName, source });
  if (recording) s.replay = { ...recording, cursor: 0, position: 0 };
  const q = `?token=${encodeURIComponent(WEBHOOK_SECRET)}`;
  const botOptions = {
    meetingLink: remote ? meetingLink.trim() : undefined, meetingId: s.id,
    webhookUrl: `${webhookBase}/webhooks/meetstream/transcript${q}`,
    callbackUrl: `${webhookBase}/webhooks/meetstream/status${q}`,
  };
  try {
    if (agentMeet) {
      const buyer = miaAgent.personaParams({ client: c, repName: AI_PRESENTER });
      s.personaName = buyer.persona_name;
      s.personaBotName = miaAgent.personaBotName(buyer);
      s.practiceBots = { listener: "Joining…", persona: "Joining…", presenter: "Joining…" };
      s.voiceTokens = { persona: crypto.randomBytes(24).toString("hex"), presenter: crypto.randomBytes(24).toString("hex") };
      s.voices = new Map();
      s.botStatus = { label: practiceStatus(s) };
      const { botId } = await meetstream.createBot(botOptions);
      bindBot(s, botId);
      for (const [kind, botName] of [["persona", s.personaBotName], ["presenter", AI_PRESENTER]]) {
        const controlUrl = new URL("/meet-voice", webhookBase);
        controlUrl.protocol = "wss:";
        controlUrl.search = new URLSearchParams({ session: s.id, role: kind, token: s.voiceTokens[kind] });
        const id = await meetstream.createSpeakingBot({ ...botOptions, botName, controlUrl: controlUrl.href });
        bindBot(s, id, kind);
      }
      if (s.botStatus?.ended) throw new Error(s.botStatus.message || s.botStatus.label);
      s.practiceReady = true;
      s.stopSource = playAgentTest(s, {
        ready: () => s.listenerReady && [s.personaBotId, s.presenterBotId].every((id) => s.voices.get(id)?.readyState === 1),
        speak: ({ role, text }, active) => {
          const botId = role === "client" ? s.personaBotId : s.presenterBotId;
          return speakInMeet({ socket: () => s.voices.get(botId), botId, role, text, active });
        },
      });
    }
    if (source === "meetstream" || source === "practice") {
      if (source === "practice") {
        const params = miaAgent.personaParams({ client: c, repName });
        s.personaName = params.persona_name;
        s.personaBotName = miaAgent.personaBotName(params);
        s.practiceBots = { listener: "Joining…", persona: "Joining…" };
        const { botId } = await meetstream.createBot(botOptions);
        bindBot(s, botId);
        const personaId = await miaAgent.launchPersonaBot({ ...botOptions, agentConfigId, params });
        bindBot(s, personaId, "persona");
        if (s.botStatus?.ended) throw new Error(s.botStatus.message || s.botStatus.label);
        s.botStatus ||= { label: "Listener: Joining… · AI client: Joining…" };
        s.practiceReady = true;
      } else {
        const { botId } = await meetstream.createBot(botOptions);
        bindBot(s, botId);
        s.botStatus = { event: "bot.joining", label: "Bot joining…", message: "" };
      }
    }
    if (source === "mia") {
      const { botId, liveTranscript } = await miaAgent.launchAgentBot({
        ...botOptions, agentConfigId, params: miaAgent.agentParams({ client: c, repName }),
      });
      bindBot(s, botId);
      s.agentName = miaAgent.AGENT_SETTINGS.name;
      s.botStatus = { event: "bot.joining", label: liveTranscript ? "MIA agent joining…" : "MIA agent joining… (no live transcript for agent bots)", message: "" };
    }
  } catch (e) {
    s.discard();
    await s.removeBots();
    return res.status(502).json({ error: e.message });
  }
  if (source === "demo") s.stopSource = playDemo(s, { speedMs: Number(req.body.speedMs) || 3200 });
  if (source === "agent_test") s.stopSource = playAgentTest(s);
  res.json({ id: s.id, kb: s.kb, botId: s.botId || null, ...(s.replay && { replayPosition: 0 }), ...(s.personaBotId && { personaBotId: s.personaBotId }), ...(s.presenterBotId && { presenterBotId: s.presenterBotId }) });
}));

app.get("/api/sessions/:id/recording", (req, res) => {
  const replay = getSession(req.params.id)?.replay;
  if (!replay) return res.sendStatus(404);
  res.sendFile(replay.file, { cacheControl: false });
});

app.post("/api/sessions/:id/replay/progress", (req, res) => {
  const s = getSession(req.params.id);
  if (!s?.replay) return res.sendStatus(404);
  const time = req.body?.time;
  if (!Number.isFinite(time) || time < 0) return res.status(400).json({ error: "Invalid playback time." });
  if (s.status === "live") advanceReplay(s, time);
  res.json({ position: s.replay.position });
});

// Calls in progress (local only, like the rest of the API). The desktop overlay polls this.
app.get("/api/live", (_req, res) => res.json(liveSessions()));

// Overlay context for one call: the cheat-sheet that doesn't change during the call.
app.get("/api/sessions/:id/brief", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  const kb = s.kb || {};
  const p = s.client.profile || {};
  res.json({
    client: s.client.company || s.client.name,
    goals: kb.goals_for_call || [],
    open_objections: p.open_objections || [],
    objection_handling: (kb.likely_objections || []).map((o) => ({ objection: o.objection, response: o.response })),
    questions_to_ask: kb.questions_to_ask || [],
  });
});

// Manual or browser-mic utterances.
app.post("/api/sessions/:id/utterances", (req, res) => {
  const s = getSession(req.params.id);
  if (!s) return res.status(404).json({ error: "session not found" });
  s.addUtterance(req.body || {});
  res.json({ ok: true });
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
  s.stopSource?.();
  const [meeting] = await Promise.all([s.end(), s.removeBots()]);
  res.json(meeting);
}));

app.get("/api/meetings/:id", (req, res) => {
  const m = store.getMeeting(req.params.id);
  m ? res.json(m) : res.status(404).json({ error: "not found" });
});

// ---------- MeetStream live transcript webhook
// Only accept events for a bot this server created (the bot_id must match the session).
const sessionFor = (ev) => sessionForBot(ev.botId);
const practiceStatus = (s) => [
  `Listener: ${s.practiceBots.listener}`, `AI client: ${s.practiceBots.persona}`,
  ...(s.practiceBots.presenter ? [`AI presenter: ${s.practiceBots.presenter}`] : []),
].join(" · ");

app.post("/webhooks/meetstream/transcript", (req, res) => {
  if (!validToken(req)) return res.sendStatus(401);
  res.sendStatus(200); // acknowledge fast; MeetStream sends one POST per sentence
  const ev = meetstream.parseTranscriptEvent(req.body);
  const s = ev && sessionFor(ev);
  if (s && ev.botId === s.botId) s.addUtterance(ev.utterance);
});

// Bot lifecycle (callback_url): show status in the UI and build the report when the meeting ends.
app.post("/webhooks/meetstream/status", (req, res) => {
  if (!validToken(req)) return res.sendStatus(401);
  res.sendStatus(200);
  const ev = meetstream.parseStatusEvent(req.body);
  const s = ev && sessionFor(ev);
  if (!s) return;
  if (["practice", "agent_meet"].includes(s.source)) {
    if (s.status !== "live" || s.botStatus?.ended) return;
    const kind = ev.botId === s.personaBotId ? "persona" : ev.botId === s.presenterBotId ? "presenter" : "listener";
    if (kind === "listener" && ["bot.inmeeting", "bot.recording"].includes(ev.event)) s.listenerReady = true;
    s.practiceBots[kind] = ev.label;
    s.botStatus = { ...ev, label: practiceStatus(s) };
    s.emit("bot", s.botStatus);
    if (ev.ended && s.practiceReady) {
      s.removeBots();
      if (s.transcript.length || s.hold) s.end().catch((e) => console.error("[mia] practice auto-end failed:", e));
      else {
        s.discard();
        s.emit("cancelled", s.botStatus);
      }
    }
    return;
  }
  s.botStatus = ev;
  s.emit("bot", ev);
  if (ev.ended && s.status === "live") {
    if (s.transcript.length) s.end().catch((e) => console.error("[mia] auto-end failed:", e));
    else s.emit("bot", { ...ev, label: `${ev.label} - nothing was transcribed`, failed: true });
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
app.post("/mia-tools/:name", (req, res) => {
  if (!validBearer(req)) return res.status(401).json({ error: "unauthorized" });
  const botId = req.headers["x-bot-id"] || req.body?.bot?.bot_id;
  const s = botId && sessionForBot(botId);
  if (!s || s.source !== "mia") return res.status(404).json({ error: "No active MIA assistant meeting found for this bot." });
  const args = req.body?.args ?? req.body ?? {};
  const clientId = s.client.id;
  let out;
  switch (req.params.name) {
    case "get_client_context": out = miaTools.getClientContext(clientId); break;
    case "search_client_history": out = miaTools.searchClientHistory(clientId, args.query); break;
    case "log_commitment":
      out = miaTools.logCommitment(clientId, args, { meetingId: s.id, botId });
      if (out.ok) s.emit("commitment", out.logged);
      break;
    default: return res.status(404).json({ error: `Unknown tool ${req.params.name}` });
  }
  console.log(`[mia-agent] ${req.params.name} ${JSON.stringify(args).slice(0, 120)} -> ${out.error ? "error" : "ok"}`);
  s.emit("agent_tool", { name: req.params.name, args, ok: !out.error });
  res.status(out.error ? 400 : 200).json({ data: out });
});

// ---------- WebSocket: UI subscribes to a session's live events
const server = http.createServer(app);
const localSocket = (req) => {
  if (new URL(req.url, "http://x").pathname !== "/ws" || !LOCAL_HOST.test(req.headers.host || "")) return false;
  if (req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"]) return false;
  return !req.headers.origin || req.headers.origin === `http://${req.headers.host}`;
};
const voiceConnection = (req) => {
  const { pathname, searchParams } = new URL(req.url, "http://x");
  if (pathname !== "/meet-voice") return null;
  const session = getSession(searchParams.get("session"));
  const role = searchParams.get("role");
  if (session?.status !== "live" || !["persona", "presenter"].includes(role) || session.voiceTokens?.[role] !== searchParams.get("token")) return null;
  return { session, botId: role === "persona" ? session.personaBotId : session.presenterBotId };
};
const wss = new WebSocketServer({
  server, maxPayload: 32 * 1024,
  verifyClient: ({ req }) => Boolean(voiceConnection(req)?.botId) || localSocket(req),
});
wss.on("connection", (ws, req) => {
  const voice = voiceConnection(req);
  if (voice) {
    ws.on("error", () => ws.terminate());
    connectVoice(ws, voice.botId, voice.session.voices);
    return;
  }
  const id = new URL(req.url, "http://x").searchParams.get("session");
  const s = getSession(id);
  if (!s) return ws.close(4404, "session not found");
  s.listeners.add(ws);
  ws.send(JSON.stringify({ type: "hello", data: { transcript: s.transcript, signals: s.signals, suggestions: s.suggestions, bot: s.botStatus || null, status: s.status } }));
  if (s.meeting) ws.send(JSON.stringify({ type: "ended", data: s.meeting }));
  else if (s.status === "ended") ws.send(JSON.stringify({ type: "cancelled", data: s.botStatus }));
  ws.on("close", () => s.listeners.delete(ws));
});

server.listen(PORT, LISTEN_HOST, () => {
  console.log(`ClientLuma running at http://localhost:${server.address().port}`);
  console.log(`  engine: ${engine()}`);
  console.log(`  meetstream: ${meetstream.meetstreamEnabled() ? "enabled" : "disabled (set MEETSTREAM_API_KEY)"}`);
  const a = miaAgent.agentStatus();
  console.log(`  mia agent: ${a.mode}, llm ${a.llm}${a.agent_config_id ? `, config ${a.agent_config_id}` : " (created on first use)"}`);
});
