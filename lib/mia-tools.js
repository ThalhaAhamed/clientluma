// Client-memory tools the MeetStream MIA agent calls during a meeting (registered as custom functions).
// Answers come only from stored data, so the agent can say "I don't have that on record" instead of guessing.
import { getClient, saveClient, listMeetings, newId } from "./store.js";
import { isPracticeRun } from "./call-workflow.js";

const STOP = new Set("the a an and or of to in on for with about what did do does is are was were we they our their it this that how why when who".split(" "));
const terms = (s) => String(s || "").toLowerCase().match(/[a-z0-9$%]+/g)?.filter((t) => t.length > 1 && !STOP.has(t)) || [];

export function getClientContext(clientId) {
  const c = getClient(clientId);
  if (!c) return { error: "Client not found" };
  const p = c.profile || {};
  const kb = c.kb || {};
  const last = (c.meetings || []).at(-1);
  return {
    client: { name: c.name, company: c.company, industry: c.industry, deal: c.deal },
    summary: p.summary || kb.summary || null,
    deal_stage: p.deal_stage || "not yet assessed",
    pain_points: p.known_pain_points?.length ? p.known_pain_points : (kb.pain_points || []).map((x) => `${x.title} (expected, not yet confirmed)`),
    requirements: p.requirements || [],
    open_objections: p.open_objections || [],
    stakeholders: p.stakeholders?.length ? p.stakeholders : c.contacts || [],
    open_commitments: (c.commitments || []).filter((x) => x.status === "open").map(({ owner, text, due, created_at }) => ({ owner, text, due, logged: created_at.slice(0, 10) })),
    last_meeting: last ? { date: last.date.slice(0, 10), summary: last.summary } : null,
    meetings_so_far: (c.meetings || []).length,
  };
}

/** Keyword search over past transcripts, reports and documents. Returns the best-matching quotes. */
export function searchClientHistory(clientId, query, limit = 6) {
  const c = getClient(clientId);
  if (!c) return { error: "Client not found" };
  const q = terms(query);
  if (!q.length) return { error: "Give a topic to search for" };
  const hits = [];
  const score = (text) => {
    const t = terms(text);
    if (!t.length) return 0;
    let s = 0;
    for (const w of q) if (t.some((x) => x === w || (w.length > 3 && x.startsWith(w.slice(0, -1))))) s++;
    return s / q.length;
  };
  for (const m of listMeetings(c.id)) {
    if (isPracticeRun(m.source)) continue;
    const date = (m.started_at || "").slice(0, 10);
    for (const u of m.transcript || []) {
      if (u.substantive === false) continue;
      const s = score(u.text);
      if (s > 0) hits.push({ s: s + 0.1, source: "meeting", date, speaker: u.speaker, quote: u.text });
    }
    for (const r of m.report?.client_requirements || []) {
      const s = score(r.requirement + " " + r.evidence);
      if (s > 0) hits.push({ s, source: "meeting report", date, quote: `${r.requirement} (${r.priority})` });
    }
  }
  for (const d of c.documents || []) {
    for (const para of d.text.split(/\n+|(?<=[.!?])\s+/)) {
      const s = score(para);
      if (s > 0 && para.length > 20) hits.push({ s, source: `document: ${d.name}`, quote: para.slice(0, 300) });
    }
  }
  const s = score(c.notes || "");
  if (s > 0) hits.push({ s: s - 0.05, source: "CRM notes", quote: (c.notes || "").split(/(?<=[.!?])\s+/).filter((x) => score(x) > 0).join(" ").slice(0, 300) });

  const seen = new Set();
  const results = hits.sort((a, b) => b.s - a.s).filter((h) => !seen.has(h.quote) && seen.add(h.quote)).slice(0, limit)
    .map(({ s, ...h }) => h);
  return results.length ? { query, results } : { query, results: [], note: "Nothing on record about this." };
}

export function logCommitment(clientId, { owner, commitment, due }, { meetingId, botId } = {}) {
  const c = getClient(clientId);
  if (!c) return { error: "Client not found" };
  if (!commitment) return { error: "Say what was promised" };
  const item = {
    id: newId("cmt"), owner: owner === "client" ? "client" : "us", text: String(commitment).slice(0, 300),
    due: String(due || "").slice(0, 60), status: "open", meeting_id: meetingId || null, bot_id: botId || null,
    created_at: new Date().toISOString(), source: "mia-agent",
  };
  c.commitments = [...(c.commitments || []), item];
  saveClient(c);
  return { ok: true, logged: { owner: item.owner, commitment: item.text, due: item.due || "not set" } };
}
