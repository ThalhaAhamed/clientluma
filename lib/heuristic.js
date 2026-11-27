// Offline engine: rule-based stand-in for Claude so the full workflow runs with no API key.
// Output shapes match lib/schemas.js exactly, so the UI cannot tell the engines apart.
import { websiteDiscussionTopic } from "./website-context.js";

const RULES = [
  // ---- objections
  { type: "objection", re: /\b(expensive|pricey|budget(s)? (is|are) tight|tight budget|over (our )?budget|cost(s)? (too|a lot)|can'?t afford|price is (high|steep))\b/i,
    summary: "Price / budget concern",
    sug: { kind: "rebuttal", title: "Reframe price as ROI", text: "Totally fair. Can we put numbers on what the current problem costs you each month? Most teams see payback within one quarter, and I can walk you through that math.", priority: "high" } },
  { type: "objection", re: /\b(already (use|have|using)|current (vendor|tool|provider)|happy with|locked in|contract with)\b/i,
    summary: "Incumbent solution in place",
    sug: { kind: "question", title: "Probe gaps in the incumbent", text: "What would you change about your current setup if you could? Where does it fall short today?", priority: "high" } },
  { type: "objection", re: /\b(not (a )?priority|not right now|next (quarter|year)|bad timing|too busy|bandwidth)\b/i,
    summary: "Timing / priority objection",
    sug: { kind: "question", title: "Find the cost of waiting", text: "Understood. What happens if this stays as-is for another two quarters? Who feels that most?", priority: "medium" } },
  { type: "objection", re: /\b(security|compliance|gdpr|soc ?2|hipaa|data (privacy|residency))\b/i,
    summary: "Security / compliance concern",
    sug: { kind: "caution", title: "Verify security requirements", text: "Which security or residency requirements should I confirm with our security team?", priority: "high" } },
  { type: "objection", re: /\b(integrat(e|ion)s?|work with (our|the)|api|salesforce|hubspot|crm)\b.*\?|\bdoes it (integrate|work with)\b/i,
    summary: "Integration question",
    sug: { kind: "question", title: "Confirm integration path", text: "Which systems and fields need to connect? I’ll verify what we support.", priority: "medium" } },
  { type: "objection", re: /\b(need to (check|talk|run it by)|loop in|my (boss|manager|cfo|cto)|decision (maker|committee)|sign[- ]off)\b/i,
    summary: "Other decision-makers involved",
    sug: { kind: "question", title: "Map the buying committee", text: "Who else will weigh in, and what will matter most to them? Would it help if I prepared a one-pager for them?", priority: "high" } },
  { type: "objection", re: /\b(risky|worried|concern(ed)?|not sure|skeptical|hesitant)\b/i,
    summary: "Hesitation / perceived risk",
    sug: { kind: "rebuttal", title: "De-risk with a pilot", text: "What would you need to see to feel confident? We could start with a scoped 30-day pilot with clear success criteria.", priority: "medium" } },

  // ---- pain points
  { type: "pain_point", re: /\b(struggl\w*|frustrat\w*|pain|problem|headache|challenge|bottleneck|manual(ly)?|spreadsheet|takes (forever|too long|hours|days))\b/i,
    summary: "Operational pain described",
    sug: { kind: "question", title: "Quantify the pain", text: "How much time or money does that cost you each week? Who on the team is most affected?", priority: "high" } },
  { type: "pain_point", re: /\b(churn|losing (customers|deals|clients)|missed (deals|opportunities)|drop(ping)? off|conversion (is )?(low|down))\b/i,
    summary: "Revenue leakage",
    sug: { kind: "solution", title: "Connect to revenue outcome", text: "Share a short case study where a similar team lifted conversion and cut churn, with the numbers.", priority: "high" } },
  { type: "pain_point", re: /\b(visibility|no insight|don'?t know (why|what)|blind spot|can'?t (see|track|measure))\b/i,
    summary: "Lack of visibility",
    sug: { kind: "solution", title: "Show the analytics view", text: "Offer to show the dashboard that answers exactly that question, using a sample of their data.", priority: "medium" } },

  // ---- buying signals
  { type: "buying_signal", re: /\b(how (much|soon|long)|pricing|price list|what does it cost|timeline|implementation|onboard\w*|get started|next steps?|trial|pilot|proposal|sign the contract|when can we)\b/i,
    summary: "Buying signal: evaluating logistics",
    sug: { kind: "next_step", title: "Lock in a next step", text: "Propose a concrete next step now: a scoped proposal or pilot kickoff, with a date in the calendar before the call ends.", priority: "high" } },
  { type: "buying_signal", re: /\b(love (that|this)|that'?s (great|exactly|perfect)|really (like|helpful)|impressive|would (help|solve)|game changer)\b/i,
    summary: "Positive reaction",
    sug: { kind: "question", title: "Anchor the value", text: "Glad that resonates - what would that mean for your team if it was live next month?", priority: "medium" } },

  // ---- requirements
  { type: "requirement", re: /\b(we need|must have|has to|need(s)? to be able|requirement|non-negotiable|important (for|to) us)\b/i,
    summary: "Stated requirement",
    sug: { kind: "question", title: "Clarify the requirement", text: "Can you tell me more about that? What does 'good' look like and how will you measure it?", priority: "medium" } },
  { type: "requirement", re: /\b(\d+\s?(users|seats|reps|agents|locations|people))\b/i,
    summary: "Scale / sizing detail",
    sug: null },

  // ---- risk
  { type: "risk", re: /\b(competitor|also (looking at|evaluating)|other vendors|shortlist|comparing)\b/i,
    summary: "Competitive evaluation",
    sug: { kind: "question", title: "Learn the decision criteria", text: "What criteria will you use to compare options? What would make one a clear winner for you?", priority: "high" } },
];

function shortTitle(s, max = 55) {
  s = s.replace(/[.!?]+$/, "");
  if (s.length <= max) return s;
  return s.slice(0, s.lastIndexOf(" ", max)) + "…";
}

function sentences(text) {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

/** Pre-call knowledge base from free-form client notes. */
export function buildKnowledgeBase(client) {
  const notes = [client.notes, client.documents?.map((d) => d.text).join("\n")].filter(Boolean).join("\n");
  const lines = sentences(notes);
  const painLines = lines.filter((l) => RULES.some((r) => r.type === "pain_point" && r.re.test(l)));
  const reqLines = lines.filter((l) => /need|want|goal|looking for|require/i.test(l));
  const profile = client.profile || {};
  const known = profile.known_pain_points || [];

  const pain_points = [
    ...known.map((p) => ({ title: p, detail: "Raised in a previous meeting.", probe_question: `Last time you mentioned "${p}" - has anything changed there?` })),
    ...painLines.slice(0, 4).map((l) => ({ title: shortTitle(l), detail: l, probe_question: "How is this affecting the team today, and what have you tried so far?" })),
  ];
  if (!pain_points.length)
    pain_points.push({ title: `Scaling ${client.industry || "operations"} efficiently`, detail: "Common pain for companies of this profile.", probe_question: "What's the biggest thing slowing your team down right now?" });

  return {
    summary: `${client.company || client.name} (${client.industry || "industry unknown"}). ${lines[0] || "No notes provided yet."}`,
    company_context: [...lines.slice(0, 5), ...(client.website_knowledge?.sections.overview || []).slice(0, 2)
      .map(item => `Public website: ${item.text}`)],
    stakeholders: (client.contacts || []).map((c) => ({ name: c.name, role: c.role || "Unknown", likely_priorities: /cfo|finance/i.test(c.role) ? "ROI, cost control" : /cto|engineer|it/i.test(c.role) ? "Integration, security, reliability" : "Team productivity, outcomes" })),
    pain_points,
    expectations: reqLines.slice(0, 4).length ? reqLines.slice(0, 4) : ["A clear picture of how the solution fits their workflow", "Pricing and timeline indications"],
    likely_objections: [
      { objection: "Price / budget", response: "Anchor on the cost of the current problem and payback period." },
      { objection: "Switching cost from current tools", response: "Offer migration support and a phased rollout." },
      { objection: "Security and compliance", response: "Share SOC 2, DPA and data-residency options proactively." },
    ],
    questions_to_ask: [
      "What prompted you to look at this now?",
      "How do you handle this today, and what does it cost you?",
      "Who else is involved in the decision, and what's your timeline?",
      "What would success look like six months from now?",
    ],
    questions_they_may_ask: [
      { question: "How long does implementation take?", suggested_answer: "Typically 2-4 weeks, with a dedicated onboarding lead." },
      { question: "How is pricing structured?", suggested_answer: "Per seat with volume tiers; share a ballpark and offer a tailored proposal." },
      { question: "Does it integrate with our stack?", suggested_answer: "Native CRM integrations plus an open API; offer a technical session." },
    ],
    goals_for_call: ["Confirm the top 2 pain points and their cost", "Identify all decision-makers", "Agree a dated next step"],
  };
}

/** Live analysis over the newest utterances. */
const LOCAL_FOLLOW_UPS = {
  objection: "What would you need to see to address that concern?",
  pain_point: "How does that affect your team today?",
  buying_signal: "What would be the most useful next step for your team?",
  requirement: "How would you verify that this meets your requirement?",
  risk: "What would make this a blocker for your team?",
};

export function analyzeLive({ newUtterances, alreadySeen = new Set(), coachingTopics = [], grounded = false, client }) {
  const signals = [];
  const suggestions = [];
  for (const u of newUtterances) {
    if (u.role !== "client") continue; // analyse what the client says (not the rep or the MIA agent)
    const spoken = u.text.toLowerCase();
    const topic = coachingTopics.find((item) => item.phrases.some((phrase) => spoken.includes(phrase)));
    if (topic) {
      signals.push({ type: topic.type, summary: topic.summary, quote: u.text, speaker: u.speaker, confidence: 0.6 });
      if (!alreadySeen.has(topic.summary)) {
        suggestions.push({ kind: "question", title: topic.title, text: topic.question, why: topic.summary, priority: "high" });
        alreadySeen.add(topic.summary);
      }
      continue;
    }
    for (const r of RULES) {
      const m = u.text.match(r.re);
      if (!m) continue;
      const key = `${r.type}:${r.summary}`;
      signals.push({ type: r.type, summary: r.summary, quote: u.text, speaker: u.speaker, confidence: 0.6 });
      if (r.sug && !alreadySeen.has(key)) {
        const websiteTopic = client && websiteDiscussionTopic(client, u.text);
        const suggestion = grounded ? { ...r.sug, kind: "question", title: r.summary, text: LOCAL_FOLLOW_UPS[r.type] }
          : websiteTopic ? { ...r.sug, kind: "question", title: `Clarify ${websiteTopic.name}`, text: websiteTopic.question } : r.sug;
        suggestions.push({ ...suggestion, why: `${r.summary}: "${m[0]}"` });
        alreadySeen.add(key);
      }
      break; // one signal per utterance keeps the offline engine quiet
    }
  }
  return { signals, suggestions };
}

export function sentimentFrom(signals) {
  const pos = signals.filter((s) => s.type === "buying_signal").length;
  const neg = signals.filter((s) => s.type === "objection" || s.type === "risk").length;
  const temp = Math.max(5, Math.min(95, 50 + pos * 8 - neg * 5));
  const sentiment = pos && neg ? "mixed" : pos ? "positive" : neg ? "negative" : "neutral";
  return { sentiment, deal_temperature: temp };
}

/** Post-call report from the transcript and the signals collected live. */
export function buildReport({ client, transcript, signals }) {
  const by = (t) => signals.filter((s) => s.type === t);
  const uniq = (arr) => [...new Map(arr.map((s) => [s.summary + s.quote, s])).values()];
  const { deal_temperature } = sentimentFrom(signals);
  const name = client.contacts?.[0]?.name || client.name;
  const substantive = transcript.filter((u) => u.substantive ?? u.text.split(/\s+/).length >= 4).length;
  const ratio = transcript.length ? substantive / transcript.length : 0;
  if (!transcript.length) return {
    transcript_quality: "poor", executive_summary: "No transcript was captured for this call.",
    client_requirements: [], pain_points: [], objections: [], buying_signals: [], insights: [], risks: [], next_steps: [],
    follow_up_email: "", conversion_likelihood: 0, coaching_notes: [],
  };
  const websiteTopic = transcript.filter(u => u.role === "client" && (u.substantive ?? true))
    .map(u => websiteDiscussionTopic(client, u.text)).find(Boolean);
  return {
    transcript_quality: ratio > 0.7 ? "good" : ratio > 0.4 ? "fair" : "poor",
    executive_summary: `${transcript.length}-turn call with ${client.company || client.name}. Detected ${by("pain_point").length} pain points, ${by("objection").length} objections and ${by("buying_signal").length} buying signals. (Generated by the offline engine - set ANTHROPIC_API_KEY for a full AI report.)`,
    client_requirements: uniq(by("requirement")).map((s) => ({ requirement: s.quote, priority: /must|need|has to/i.test(s.quote) ? "must" : "should", evidence: `${s.speaker}: "${s.quote}"` })),
    pain_points: uniq(by("pain_point")).map((s) => ({ title: s.summary, detail: s.quote })),
    objections: uniq(by("objection")).map((s) => ({ objection: s.summary, status: "open", notes: s.quote })),
    buying_signals: uniq(by("buying_signal")).map((s) => s.quote),
    insights: uniq(signals).slice(0, 5).map((s) => `${s.type.replace("_", " ")}: ${s.summary}`),
    risks: uniq(by("risk")).map((s) => s.quote),
    next_steps: [
      { action: "Send recap and follow-up materials", owner: "us", due: "Within 24 hours" },
      ...(by("objection").length ? [{ action: "Address open objections with supporting evidence", owner: "us", due: "Before next call" }] : []),
      ...(websiteTopic ? [{ action: `Review the client’s public information on ${websiteTopic.name} and confirm how it applies to this deal`, owner: "us", due: "Before next call" }] : []),
      { action: "Schedule next meeting with all decision-makers", owner: "both", due: "This week" },
    ],
    follow_up_email: `Hi ${name},\n\nThanks for your time today. Here is a quick recap of what we discussed and the next steps we agreed.\n\n${uniq(by("pain_point")).slice(0, 3).map((s) => `- ${s.summary}`).join("\n") || "- Your current priorities"}\n\nI'll follow up with the materials shortly. Would a call later this week work to go deeper?\n\nBest regards`,
    conversion_likelihood: deal_temperature,
    coaching_notes: ["Offline engine: connect Claude for personalised coaching notes."],
  };
}

export function mergeProfile({ client, report }) {
  const p = client.profile || {};
  const merge = (a = [], b = []) => [...new Set([...a, ...b])].slice(0, 15);
  return {
    summary: report.executive_summary,
    deal_stage: report.transcript_quality === "poor" ? (p.deal_stage || "discovery")
      : report.conversion_likelihood > 65 ? "proposal" : report.conversion_likelihood > 40 ? "evaluation" : "discovery",
    known_pain_points: merge(p.known_pain_points, report.pain_points.map((x) => x.title)),
    requirements: merge(p.requirements, report.client_requirements.map((x) => x.requirement)),
    open_objections: merge([], report.objections.filter((o) => o.status !== "resolved").map((o) => o.objection)),
    stakeholders: p.stakeholders || (client.contacts || []).map((c) => ({ name: c.name, role: c.role || "", notes: "" })),
    preferences: p.preferences || [],
  };
}
