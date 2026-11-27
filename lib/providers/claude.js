// Claude provider: structured outputs via the Anthropic SDK, with server-side refusal fallback.
import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";

const MODEL = process.env.MIA_MODEL || "claude-opus-5-5";
const LIVE_MODEL = process.env.MIA_LIVE_MODEL || MODEL;

export function createClaude(apiKey) {
  if (!apiKey && !process.env.ANTHROPIC_AUTH_TOKEN) return null;
  const client = new Anthropic({ apiKey: apiKey || undefined });

  return {
    name: (tier) => `claude (${tier === "live" ? LIVE_MODEL : MODEL})`,
    async generate({ system, schema, prompt, effort = "medium", tier = "deep", maxTokens = 16000 }) {
      const res = await client.beta.messages.parse({
        model: tier === "live" ? LIVE_MODEL : MODEL,
        max_tokens: maxTokens,
        betas: ["server-side-fallback-2026-07-01"],
        fallbacks: "default",
        system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
        output_config: { effort, format: betaZodOutputFormat(schema) },
        messages: [{ role: "user", content: prompt }],
      });
      if (res.stop_reason === "refusal") {
        console.warn("[mia] Claude declined:", res.stop_details?.category);
        return null;
      }
      if (res.stop_reason === "max_tokens") console.warn("[mia] output hit max_tokens");
      return res.parsed_output ?? null;
    },
    describeError(err) {
      if (err instanceof Anthropic.RateLimitError) return "Claude rate limited";
      if (err instanceof Anthropic.AuthenticationError) return "Claude auth failed - check ANTHROPIC_API_KEY";
      if (err instanceof Anthropic.APIError) return `Claude API error ${err.status}`;
      return "Claude call failed";
    },
  };
}
