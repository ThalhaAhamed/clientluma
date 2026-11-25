// Live meeting sessions: collect utterances from any source, run throttled analysis, push events to the UI.
import { analyzeLive, generateReport, updateProfile } from "./ai.js";
import { getClient, saveClient, saveMeeting, newId } from "./store.js";
import { removeBot } from "./meetstream.js";
import { isPracticeRun } from "./call-workflow.js";

const sessions = new Map(); // meetingId -> Session
const botIndex = new Map(); // meetstream bot_id -> meetingId

const MIN_NEW = Number(process.env.MIA_ANALYZE_EVERY || 2); // substantive client utterances per analysis pass
const MAX_WAIT_MS = 7000; // analyse anyway after this long if anything substantive is pending
// Live transcribers send sentence fragments ("Yeah", "So on the project"). Fragments from the same speaker that
// arrive within STITCH_MS are joined into one utterance before analysis.
const STITCH_MS = Number(process.env.MIA_STITCH_MS || 1800);
const STITCH_MAX_WORDS = 40;
// Pop-up budget: after a suggestion, wait COOLDOWN_MS before the next (high-priority ones after half of it).
const COOLDOWN_MS = Number(process.env.MIA_SUGGESTION_COOLDOWN_MS || 25000);
// MeetStream doesn't always report the meeting ending (for example if someone stays in the room). After this much
// silence following the first speech, MIA removes the bot and builds the report itself. 0 disables it.
const IDLE_END_MS = Number(process.env.MIA_IDLE_END_MS ?? 180000);

const FILLER = /^(uh+|um+|mm+|mhm+|hmm+|ah+|oh+|yeah|yes|yep|no|nope|ok(ay)?|right|sure|so|and|but|i|just|well|like|cool|great|good|thanks?( you)?|got it)$/i;
const words = (t) => t.split(/\s+/).filter(Boolean);
/** A line worth analysing: at least 4 words, or 2-3 words that are not just filler. */
export function isSubstantive(text) {
  const w = words(text.replace(/[.,!?…]/g, ""));
  if (w.length >= 4) return true;
  return w.length >= 2 && !w.every((x) => FILLER.test(x));
}
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]/g, "").trim();
const speakerName = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();

class Session {
  constructor({ client, kb, repName, source }) {
    this.id = newId("mtg");
    this.client = client;
    this.kb = kb;
    this.repName = (repName || "").trim().toLowerCase();
    this.source = source;
    this.transcript = [];
    this.signals = [];
    this.suggestions = [];
    this.pending = [];
    this.alreadySeen = new Set();
    this.listeners = new Set();
    this.analysis = null;
    this.timer = null;
    this.status = "live";
    this.started_at = new Date().toISOString();
    this.sentiment = "neutral";
    this.deal_temperature = 50;
    this.stitch = ["meetstream", "browser", "practice", "agent_meet"].includes(source);
    this.hold = null; // fragment being stitched
    this.lastSuggestionAt = 0;
    this.droppedSuggestions = 0;
  }

  emit(type, data) {
    const msg = JSON.stringify({ type, data });
    for (const ws of this.listeners) if (ws.readyState === 1) ws.send(msg);
  }

  roleOf(speaker) {
    const s = (speaker || "").toLowerCase();
    if (["practice", "agent_meet"].includes(this.source)) {
      const name = speakerName(s);
      return [this.personaName, this.personaBotName].some((alias) => alias && name === speakerName(alias)) ? "client" : "rep";
    }
    if (this.agentName && s.startsWith(this.agentName.toLowerCase())) return "agent"; // the MIA bot's own voice
    if (!this.repName) return "client";
    return s && (s.includes(this.repName) || this.repName.includes(s)) ? "rep" : "client";
  }

  addUtterance({ speaker, text, role, ts, recording_time }) {
    text = (text || "").trim();
    if (!text || this.status !== "live") return;
    const u = { speaker: speaker || "Speaker", role: role || this.roleOf(speaker), text, ts: ts || Date.now(), ...(recording_time !== undefined && { recording_time }) };
    if (!this.stitch) return this.commit(u);

    const h = this.hold;
    if (h && h.speaker === u.speaker && words(h.text).length < STITCH_MAX_WORDS) {
      h.text = `${h.text.replace(/[.…]+$/, "")} ${u.text}`;
      h.ts = u.ts;
    } else {
      this.flushHold();
      this.hold = u;
    }
    clearTimeout(this.holdTimer);
    this.holdTimer = setTimeout(() => this.flushHold(), STITCH_MS);
  }

  flushHold() {
    clearTimeout(this.holdTimer);
    const h = this.hold;
    this.hold = null;
    if (h) this.commit(h);
  }

  /** For bot sessions: end the call after IDLE_END_MS without speech (counted from the first utterance). */
  watchIdle() {
    if (!this.botId || !IDLE_END_MS || this.idleTimer) return;
    this.idleTimer = setInterval(() => {
      if (this.status !== "live") return clearInterval(this.idleTimer);
      if (!this.lastSpeechAt || Date.now() - this.lastSpeechAt < IDLE_END_MS) return;
      clearInterval(this.idleTimer);
      const span = IDLE_END_MS >= 60000 ? `${Math.round(IDLE_END_MS / 60000)} min` : `${Math.round(IDLE_END_MS / 1000)} s`;
      this.emit("bot", { event: "mia.idle", label: `No speech for ${span} - ending call`, message: "" });
      this.removeBots();
      this.end().catch((e) => console.error("[mia] idle auto-end failed:", e));
    }, Math.min(15000, IDLE_END_MS / 4));
  }

  async removeBots() {
    const ids = [this.botId, this.personaBotId, this.presenterBotId].filter(Boolean);
    await Promise.all(ids.map(removeBot));
  }

  discard() {
    this.status = "ended";
    clearInterval(this.idleTimer);
    clearTimeout(this.holdTimer);
    clearTimeout(this.timer);
    this.release();
  }

  release() {
    this.stopSource?.();
    for (const id of [this.botId, this.personaBotId, this.presenterBotId]) if (id) botIndex.delete(id);
    setTimeout(() => sessions.delete(this.id), 10 * 60 * 1000).unref();
  }

  commit(u) {
    this.lastSpeechAt = Date.now();
    u = { id: this.transcript.length + 1, ...u, substantive: isSubstantive(u.text) };
    this.transcript.push(u);
    this.pending.push(u);
    this.emit("utterance", u);
    this.schedule();
  }

  schedule() {
    const substantive = this.pending.filter((u) => u.role === "client" && u.substantive).length;
    if (substantive >= MIN_NEW) return this.analyze();
    clearTimeout(this.timer);
    if (this.pending.some((u) => u.substantive)) this.timer = setTimeout(() => this.analyze(), MAX_WAIT_MS);
  }

  /** Keep at most one pop-up per cooldown window, and never repeat a title or coaching line. */
  admitSuggestion(s) {
    const since = Date.now() - this.lastSuggestionAt;
    const wait = s.priority === "high" ? COOLDOWN_MS / 2 : COOLDOWN_MS;
    const dup = this.suggestions.some((x) => norm(x.title) === norm(s.title) || norm(x.text) === norm(s.text));
    if (dup || since < wait) { this.droppedSuggestions++; return false; }
    this.lastSuggestionAt = Date.now();
    return true;
  }

  analyze() {
    clearTimeout(this.timer);
    if (this.analysis) return this.analysis;
    if (!this.pending.length) return;
    if (!this.pending.some((u) => u.substantive)) { this.pending = []; return; } // only filler: nothing to analyse
    const batch = this.pending.splice(0);
    this.analysis = this.runAnalysis(batch);
    return this.analysis;
  }

  async runAnalysis(batch) {
    this.emit("analyzing", true);
    try {
      const r = await analyzeLive({
        c: this.client, kb: this.kb, transcript: this.transcript, newUtterances: batch,
        recentSuggestions: this.suggestions.slice(-12), alreadySeen: this.alreadySeen, localOnly: this.source === "replay",
      });
      for (const s of r.signals || []) {
        const sig = { ...s, id: newId("sig"), at: Date.now() };
        this.signals.push(sig);
        this.emit("signal", sig);
      }
      const ranked = [...(r.suggestions || [])].sort((a, b) => (a.priority === "high" ? -1 : 0) - (b.priority === "high" ? -1 : 0));
      for (const s of ranked) {
        if (!this.admitSuggestion(s)) continue;
        const sug = { ...s, id: newId("sug"), at: Date.now(), status: "new" };
        this.suggestions.push(sug);
        this.emit("suggestion", sug);
      }
      this.sentiment = r.sentiment || this.sentiment;
      this.deal_temperature = r.deal_temperature ?? this.deal_temperature;
      this.emit("pulse", { sentiment: this.sentiment, deal_temperature: this.deal_temperature, engine: r.engine });
    } finally {
      this.analysis = null;
      this.emit("analyzing", false);
      if (this.status === "live" && this.pending.length) this.schedule();
    }
  }

  end() {
    if (this.ending) return this.ending;
    if (this.status !== "live") return this.meeting;
    this.ending = this.finish();
    return this.ending;
  }

  async finish() {
    this.flushHold();
    this.status = "ending";
    this.emit("status", "ending");
    await this.analysis;
    await this.analyze();
    const { report, engine } = await generateReport({ c: this.client, kb: this.kb, transcript: this.transcript, signals: this.signals, localOnly: this.source === "replay" });

    // Knowledge-base loop: fold this meeting into the client's long-term profile.
    const fresh = getClient(this.client.id);
    let profile = fresh?.profile || null;
    if (fresh && !isPracticeRun(this.source)) {
      profile = await updateProfile({ c: fresh, report });
      const latest = getClient(this.client.id);
      if (latest) {
        latest.profile = profile;
        latest.meetings = [...(latest.meetings || []), { id: this.id, date: this.started_at, conversion_likelihood: report.conversion_likelihood, summary: report.executive_summary }];
        saveClient(latest);
      }
    }

    this.meeting = saveMeeting({
      id: this.id, client_id: this.client.id, source: this.source, started_at: this.started_at,
      ended_at: new Date().toISOString(), transcript: this.transcript, signals: this.signals,
      suggestions: this.suggestions, suppressed_suggestions: this.droppedSuggestions,
      kb: this.kb, report, report_engine: engine, profile_after: profile,
    });
    this.status = "ended";
    this.emit("ended", this.meeting);
    clearInterval(this.idleTimer);
    this.release();
    return this.meeting;
  }
}

export function startSession(opts) {
  const s = new Session(opts);
  sessions.set(s.id, s);
  return s;
}
export const getSession = (id) => sessions.get(id);
export const describeSession = (s) => ({ id: s.id, client: s.client.company || s.client.name, clientId: s.client.id,
  source: s.source, status: s.status, started_at: s.started_at, ...(s.replay && { replayPosition: s.replay.position }) });
/** The workspace can resume pending calls and reports, while the overlay follows active conversations. */
export const liveSessions = ({ includePending = false } = {}) => [...sessions.values()]
  .filter((s) => includePending ? s.status !== "ended" : s.status === "live" && (!["practice", "agent_meet"].includes(s.source) || s.practiceReady))
  .sort((a, b) => b.started_at.localeCompare(a.started_at))
  .map(describeSession);
export function bindBot(session, botId, kind = "listener") {
  if (!botId) throw new Error(`MeetStream did not return an ID for the ${kind} bot`);
  if (kind === "persona") session.personaBotId = botId;
  else if (kind === "presenter") session.presenterBotId = botId;
  else session.botId = botId;
  botIndex.set(botId, session.id);
  session.watchIdle();
}
export const sessionForBot = (botId) => sessions.get(botIndex.get(botId));
