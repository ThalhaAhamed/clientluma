// MIA intelligence layer. Uses Gemini or Claude when credentials are available, otherwise the offline engine.
// MIA_PROVIDER=gemini|claude picks one explicitly; without it, the first provider with a key wins (Gemini, then Claude).
import { AgentTurn, KnowledgeBase, LiveAnalysis, PostCallReport, ProfileUpdate } from "./schemas.js";
import * as offline from "./heuristic.js";
import { createGemini } from "./providers/gemini.js";
import { createClaude } from "./providers/claude.js";
import { setting } from "./settings.js";

let provider, previousConfig;
function pickProvider() {
  const mode = setting("MIA_PROVIDER").toLowerCase();
  const gemini = setting("GEMINI_API_KEY");
  const claude = process.env.ANTHROPIC_API_KEY || (!process.env.ANTHROPIC_AUTH_TOKEN && setting("ANTHROPIC_API_KEY"));
  const config = JSON.stringify([mode, gemini, claude, process.env.ANTHROPIC_AUTH_TOKEN]);
  if (config !== previousConfig) {
    provider = mode === "offline" ? null : mode === "claude" ? createClaude(claude) :
      createGemini(gemini) || (mode !== "gemini" ? createClaude(claude) : null);
    previousConfig = config;
  }
  return provider;
}
export const engine = (tier = "deep") => pickProvider()?.name(tier) || "offline";

const SYSTEM = `You are MIA, a client-intelligence copilot for B2B sales, consulting and customer-success teams.
You help a rep ("rep") understand a client, catch pain points, objections and buying signals, and convert the deal.
Be concrete and specific to this client. Never invent facts about the client that are not in the material given;
when you infer, say it is an inference. Suggestions must be things the rep can say out loud in one breath.`;

/** One structured model call. Returns parsed output, or null so callers can fall back to the offline engine. */
async function ask({ system = SYSTEM, schema, prompt, effort = "medium", tier = "deep", maxTokens = 16000 }) {
  const provider = pickProvider();
  if (!provider) return null;
  const t0 = Date.now();
  try {
    const out = await provider.generate({ system, schema, prompt, effort, tier, maxTokens });
    console.log(`[mia] ${provider.name(tier)} ${tier} call ${out ? "ok" : "empty"} in ${Date.now() - t0} ms`);
    return out;
  } catch (err) {
    console.warn(`[mia] ${provider.describeError(err)} - using offline engine`);
    return null;
  }
}

export async function generateAgentTurn({ instructions, transcript, wrapUp }) {
  const recent = transcript.map(({ speaker, text }) => `${speaker}: ${text}`).join("\n");
  const out = await ask({
    system: instructions,
    schema: AgentTurn,
    prompt: `${recent || "You are starting the conversation."}\n\n${wrapUp ? "Close the conversation with a realistic next step." : "Continue the conversation."} Write only your own next spoken turn in one to three sentences.`,
    tier: "live", effort: "low", maxTokens: 1024,
  });
  return out?.text.trim();
}

const clientBlock = (c) => `<client>
Name: ${c.name}
Company: ${c.company || "-"}
Industry: ${c.industry || "-"}
Deal size / context: ${c.deal || "-"}
Contacts: ${(c.contacts || []).map((x) => `${x.name} (${x.role || "?"})`).join("; ") || "-"}
Our offering: ${c.offering || "-"}
Notes:
${c.notes || "-"}
${(c.documents || []).map((d) => `<document name="${d.name}">\n${d.text.slice(0, 60000)}\n</document>`).join("\n")}
</client>
<profile_from_past_meetings>
${c.profile ? JSON.stringify(c.profile, null, 1) : "No previous meetings."}
</profile_from_past_meetings>`;

// ---------- Pre-call
export async function generateKnowledgeBase(c) {
  const out = c.local_only ? null : await ask({
    schema: KnowledgeBase,
    effort: "high",
    prompt: `${clientBlock(c)}

Build a pre-call knowledge base for the rep's next meeting with this client: their likely pain points (each with a
probing question), expectations, likely objections with responses, questions to ask, questions they may ask us with
suggested answers, and 3 goals for this call. Use the past-meeting profile to avoid re-asking settled questions.`,
  });
  return { kb: out || offline.buildKnowledgeBase(c), engine: out ? engine() : "offline" };
}

// ---------- During call
export async function analyzeLive({ c, kb, transcript, newUtterances, recentSuggestions, alreadySeen, localOnly = false }) {
  const fmt = (u) => `[${u.speaker} (${u.role === "unknown" ? "role unclear" : u.role})] ${u.text}`;
  const out = localOnly || c.local_only ? null : await ask({
    schema: LiveAnalysis,
    tier: "live",
    effort: "low", // latency matters more than depth here
    maxTokens: 4000,
    prompt: `<knowledge_base>
${JSON.stringify(kb)}
</knowledge_base>
<conversation_so_far>
${transcript.slice(-40, -newUtterances.length || undefined).map(fmt).join("\n") || "(start of call)"}
</conversation_so_far>
<new_utterances>
${newUtterances.map(fmt).join("\n")}
</new_utterances>
<suggestions_already_shown>
${recentSuggestions.map((s) => `- ${s.title}`).join("\n") || "(none)"}
</suggestions_already_shown>

Client: ${c.company || c.name}. Analyse ONLY the new utterances, in the context of the conversation and knowledge base.
- signals: pain points, objections, buying signals, requirements, client questions and risks voiced by the CLIENT
  (not the rep). Quote their exact words. Return an empty list if nothing new.
  Do not attribute a signal to a speaker whose role is unclear.
  Ignore filler, false starts and garbled fragments; never infer a signal from text that does not make sense.
- suggestions: usually return NONE. Return one (at most) only when the client just said something specific that the
  rep should act on in the next 30 seconds: a question to ask, a solution to mention, a rebuttal, a next step, or a
  caution. Never repeat or rephrase one already shown. Each pop-up interrupts the rep, so the bar is high.
- sentiment and deal_temperature for the call so far.`,
  });
  if (out) return { ...out, engine: engine("live") };
  const r = offline.analyzeLive({ newUtterances, alreadySeen, coachingTopics: localOnly ? c.coaching_topics : undefined, grounded: localOnly });
  return { ...r, ...offline.sentimentFrom(r.signals), engine: "offline", partialSentiment: true };
}

// ---------- Post call
/** Share of transcript lines that carry real content - a rough audio/transcription quality signal. */
export function transcriptStats(transcript) {
  const n = transcript.length;
  const substantive = transcript.filter((u) => u.substantive ?? u.text.split(/\s+/).length >= 4).length;
  const speakers = new Set(transcript.map((u) => u.speaker)).size;
  return { lines: n, substantive, ratio: n ? substantive / n : 0, speakers };
}

export async function generateReport({ c, kb, transcript, signals, localOnly = false }) {
  const st = transcriptStats(transcript);
  const out = localOnly || c.local_only ? null : await ask({
    schema: PostCallReport,
    effort: "high",
    prompt: `<background_only>
The material below was known BEFORE this call. It is background, not evidence of what was said.
${clientBlock(c)}
<pre_call_knowledge_base>
${JSON.stringify(kb)}
</pre_call_knowledge_base>
</background_only>
<transcript lines="${st.lines}" substantive_lines="${st.substantive}" distinct_speakers="${st.speakers}">
${transcript.map((u) => `[${u.speaker}${u.role === "rep" ? " (rep)" : u.role === "agent" ? " (MIA assistant)" : ""}] ${u.text}`).join("\n")}
</transcript>
<signals_flagged_live>
${signals.map((s) => `${s.type}: ${s.summary} - "${s.quote}"`).join("\n")}
</signals_flagged_live>

Write the post-call report for THIS call.
Grounding rules:
- Requirements, pain points, objections, buying signals and insights must come from the transcript. Every
  requirement's evidence must be a verbatim transcript quote. Do not present anything from the background as
  discussed; if a background item matters and was not covered, list it under risks as "not covered on this call".
- Ignore garbled or nonsensical lines. Do not reinterpret them into business meaning.
- Rate transcript_quality by how much of the business content is understandable:
  good = nearly every line is clear; fair = the meaning is clear but there are mistranscribed words (for example a
  misspelled product name) or only one speaker was captured; poor = most lines are unintelligible or meaningless.
  Ordinary speech-to-text slips do not make a transcript poor. If it is poor, say so first in the executive summary,
  keep the lists short, and keep conversion_likelihood near the pre-call baseline (40-55).
Then include: objection status, risks, dated next steps with owners, a short follow-up email in the rep's voice that
only references what was actually discussed, a 0-100 conversion likelihood, and 2-4 coaching notes.`,
  });
  return { report: out || offline.buildReport({ client: c, transcript, signals }), engine: out ? engine() : "offline" };
}

export async function updateProfile({ c, report }) {
  const out = c.local_only ? null : await ask({
    schema: ProfileUpdate,
    effort: "medium",
    prompt: `${clientBlock(c)}
<latest_meeting_report>
${JSON.stringify(report)}
</latest_meeting_report>

Update the client's rolling profile by merging the latest meeting into the existing profile. Keep facts that are
still true, drop objections that were resolved, and keep lists short and deduplicated.
Move deal_stage forward only when the report shows clear evidence of it (for example an agreed proposal or pricing
discussion). If the report's transcript_quality is "poor", keep the current deal_stage and add nothing that is not
quoted in the report.`,
  });
  return out || offline.mergeProfile({ client: c, report });
}
