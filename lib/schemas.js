// Zod schemas shared by the Claude calls (structured outputs) and the offline engine.
import { z } from "zod";


export const KnowledgeBase = z.object({
  summary: z.string().describe("2-3 sentence brief on the client and the deal"),
  company_context: z.array(z.string()).describe("Key facts about the client's business"),
  stakeholders: z.array(
    z.object({ name: z.string(), role: z.string(), likely_priorities: z.string() })
  ),
  pain_points: z.array(
    z.object({ title: z.string(), detail: z.string(), probe_question: z.string() })
  ),
  expectations: z.array(z.string()),
  likely_objections: z.array(
    z.object({ objection: z.string(), response: z.string() })
  ),
  questions_to_ask: z.array(z.string()),
  questions_they_may_ask: z.array(
    z.object({ question: z.string(), suggested_answer: z.string() })
  ),
  goals_for_call: z.array(z.string()),
});

export const SIGNAL_TYPES = [
  "pain_point",
  "objection",
  "buying_signal",
  "requirement",
  "question",
  "risk",
];

export const LiveAnalysis = z.object({
  signals: z.array(
    z.object({
      type: z.enum(SIGNAL_TYPES),
      summary: z.string().describe("Short label, max ~10 words"),
      quote: z.string().describe("Verbatim words from the transcript that triggered it"),
      speaker: z.string(),
      confidence: z.number().describe("0 to 1"),
    })
  ),
  suggestions: z.array(
    z.object({
      kind: z.enum(["question", "solution", "rebuttal", "next_step", "caution"]),
      title: z.string().describe("Max ~8 words, shown as the pop-up headline"),
      text: z.string().describe("What the rep can say, in one or two sentences"),
      why: z.string().describe("The signal or KB item this responds to"),
      priority: z.enum(["high", "medium", "low"]),
    })
  ),
  sentiment: z.enum(["positive", "neutral", "negative", "mixed"]),
  deal_temperature: z.number().describe("0-100 likelihood the client moves forward, judged so far"),
});

export const PostCallReport = z.object({
  transcript_quality: z.enum(["good", "fair", "poor"]).describe("good: nearly all clear; fair: meaning clear despite word errors; poor: mostly unintelligible"),
  executive_summary: z.string(),
  client_requirements: z.array(
    z.object({ requirement: z.string(), priority: z.enum(["must", "should", "nice"]), evidence: z.string() })
  ),
  pain_points: z.array(z.object({ title: z.string(), detail: z.string() })),
  objections: z.array(
    z.object({ objection: z.string(), status: z.enum(["resolved", "open", "partially_resolved"]), notes: z.string() })
  ),
  buying_signals: z.array(z.string()),
  insights: z.array(z.string()),
  risks: z.array(z.string()),
  next_steps: z.array(
    z.object({ action: z.string(), owner: z.enum(["us", "client", "both"]), due: z.string() })
  ),
  follow_up_email: z.string().describe("A short follow-up email draft the rep can send"),
  conversion_likelihood: z.number().describe("0-100"),
  coaching_notes: z.array(z.string()).describe("What the rep did well and could improve"),
});

export const ProfileUpdate = z.object({
  summary: z.string().describe("Updated rolling summary of the relationship"),
  deal_stage: z.enum(["prospect", "discovery", "evaluation", "proposal", "negotiation", "closed_won", "closed_lost"]),
  known_pain_points: z.array(z.string()),
  requirements: z.array(z.string()),
  open_objections: z.array(z.string()),
  stakeholders: z.array(z.object({ name: z.string(), role: z.string(), notes: z.string() })),
  preferences: z.array(z.string()).describe("Communication style, decision process, budget cues"),
});
