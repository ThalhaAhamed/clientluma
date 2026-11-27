// Live meeting sessions: collect utterances from any source, run throttled analysis, push events to the UI.
import { analyzeLive, generateReport, updateProfile } from "./ai.js";
import { getClient, saveMeeting, newId } from "./store.js";
import { removeBot } from "./meetstream.js";
import { websiteRevision } from "./website-index.js";

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

class Session {
  constructor({ client, kb, repName, source, lensEnabled = true }) {
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
    this.lensEnabled = lensEnabled;
    this.lensRevision = 0;
    this.lensCue = null;
    this.hold = null; // fragment being stitched
    this.lastSuggestionAt = 0;
    this.lastSourceCueAt = 0;
    this.droppedSuggestions = 0;
  }

  emit(type, data) {
    const msg = JSON.stringify({ type, data });
    for (const ws of this.listeners) if (ws.readyState === 1) ws.send(msg);
  }

  roleOf(speaker) {
    const s = (speaker || "").trim().toLowerCase();
    if (this.agentName && s.startsWith(this.agentName.toLowerCase())) return "agent"; // the MIA bot's own voice
    if (s && this.repName && (s.includes(this.repName) || this.repName.includes(s))) return "rep";
    if (this.source === "mia" && s !== this.client.name?.trim().toLowerCase()) return "unknown";
    return "client";
  }

  addUtterance({ speaker, text, role, ts, recording_time }) {
    text = (text || "").trim();
    if (!text || this.status !== "live") return;
    const u = { speaker: speaker || "Speaker", role: role || this.roleOf(speaker), text, ts: ts || Date.now(), ...(recording_time !== undefined && { recording_time }) };
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
    const ids = [this.botId, this.transcriptBotId].filter(Boolean);
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
    for (const id of [this.botId, this.transcriptBotId]) if (id) botIndex.delete(id);
    setTimeout(() => sessions.delete(this.id), 10 * 60 * 1000).unref();
  }

  commit(u) {
    this.lastSpeechAt = Date.now();
    u = { id: this.transcript.length + 1, ...u, substantive: isSubstantive(u.text) };
    this.transcript.push(u);
    this.emit("utterance", u);
    if (this.lensEnabled) {
      this.pending.push(u);
      this.schedule();
    }
  }

  setLens(enabled) {
    if (this.lensEnabled === enabled) return;
    this.lensEnabled = enabled;
    this.lensRevision++;
    this.lensCue = null;
    this.lastSuggestionAt = this.lastSourceCueAt = 0;
    if (!enabled) {
      clearTimeout(this.timer);
      this.pending = [];
    }
    this.emit("lens", enabled);
  }

  schedule() {
    const substantive = this.pending.filter((u) => u.role === "client" && u.substantive).length;
    if (substantive >= MIN_NEW) return this.analyze();
    clearTimeout(this.timer);
    if (this.pending.some((u) => u.substantive)) this.timer = setTimeout(() => this.analyze(), MAX_WAIT_MS);
  }

  /** Keep at most one pop-up per cooldown window, and never repeat a title or coaching line. */
  admitSuggestion(s) {
    const now = Date.now();
    const sourced = Boolean(s.sources?.length);
    const since = now - (sourced ? this.lastSourceCueAt : this.lastSuggestionAt);
    const wait = s.priority === "high" ? COOLDOWN_MS / 2 : COOLDOWN_MS;
    const dup = this.suggestions.some((x) => ((!s.sources?.length || !x.sources?.length) && norm(x.title) === norm(s.title)) || norm(x.text) === norm(s.text));
    if (dup || since < wait) { this.droppedSuggestions++; return false; }
    this.lastSuggestionAt = now;
    if (sourced) this.lastSourceCueAt = now;
    return true;
  }

  analyze() {
    clearTimeout(this.timer);
    if (this.analysis) return this.analysis;
    if (!this.lensEnabled || !this.pending.length) return;
    if (!this.pending.some((u) => u.substantive)) { this.pending = []; return; } // only filler: nothing to analyse
    const batch = this.pending.splice(0);
    this.analysis = this.runAnalysis(batch);
    return this.analysis;
  }

  async runAnalysis(batch) {
    const revision = this.lensRevision;
    const seen = new Set(this.alreadySeen);
    this.emit("analyzing", true);
    try {
      const fresh = await getClient(this.client.id);
      const { c, kb } = this.researchContext(fresh);
      const r = await analyzeLive({
        c: { ...c, documents: fresh?.documents || [] },
        kb, transcript: this.transcript, newUtterances: batch,
        recentSuggestions: this.suggestions.slice(-12), alreadySeen: seen,
      });
      if (revision !== this.lensRevision || this.status === "ended") return;
      this.alreadySeen = seen;
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
        this.lensCue = sug.id;
        this.emit("suggestion", sug);
      }
      this.sentiment = r.sentiment || this.sentiment;
      this.deal_temperature = r.deal_temperature ?? this.deal_temperature;
      this.emit("pulse", { sentiment: this.sentiment, deal_temperature: this.deal_temperature, engine: r.engine });
    } catch (error) {
      console.error("Live Client Lens analysis failed:", error.message);
    } finally {
      this.analysis = null;
      this.emit("analyzing", false);
      if (this.status === "live" && this.pending.length) this.schedule();
    }
  }

  researchContext(fresh) {
    return {
      c: { ...this.client, website_knowledge: fresh?.website_knowledge },
      kb: websiteRevision(fresh) === websiteRevision(this.client) ? this.kb : fresh?.kb || null,
    };
  }

  end() {
    if (this.ending) return this.ending;
    if (this.status !== "live") return this.meeting;
    this.ending = this.finish().catch(error => {
      this.ending = null;
      this.status = "live";
      this.emit("status", "live");
      throw error;
    });
    return this.ending;
  }

  async finish() {
    this.flushHold();
    this.status = "ending";
    this.emit("status", "ending");
    await this.analysis;
    await this.analyze();
    const { c, kb } = this.researchContext(await getClient(this.client.id));
    const { report, engine } = await generateReport({ c, kb, transcript: this.transcript, signals: this.signals });

    // Knowledge-base loop: fold this meeting into the client's long-term profile.
    const fresh = await getClient(this.client.id);
    const profile = fresh && this.transcript.length ? await updateProfile({ c: fresh, report }) : fresh?.profile ?? null;

    this.meeting = await saveMeeting({
      id: this.id, client_id: this.client.id, source: this.source, started_at: this.started_at,
      ended_at: new Date().toISOString(), transcript: this.transcript, signals: this.signals,
      suggestions: this.suggestions, suppressed_suggestions: this.droppedSuggestions,
      kb, report, report_engine: engine, profile_after: profile,
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
  source: s.source, status: s.status, started_at: s.started_at, lensEnabled: s.lensEnabled });
/** The workspace can resume pending calls and reports, while the overlay follows active conversations. */
export const liveSessions = ({ includePending = false } = {}) => [...sessions.values()]
  .filter((s) => includePending ? s.status !== "ended" : s.status === "live")
  .sort((a, b) => b.started_at.localeCompare(a.started_at))
  .map(describeSession);
export function bindBot(session, botId, kind = "listener") {
  if (!botId) throw new Error(`MeetStream did not return an ID for the ${kind} bot`);
  if (kind === "transcript") session.transcriptBotId = botId;
  else session.botId = botId;
  botIndex.set(botId, session.id);
  session.watchIdle();
}
export const sessionForBot = (botId) => sessions.get(botIndex.get(botId));
