// Gemini provider: structured JSON output validated against the same Zod schemas as Claude.
import { GoogleGenAI, ApiError, ThinkingLevel } from "@google/genai";
import { z } from "zod";

const MODEL = process.env.MIA_GEMINI_MODEL || "gemini-pro-latest";
const LIVE_MODEL = process.env.MIA_GEMINI_LIVE_MODEL || "gemini-flash-latest";
const LEVEL = { low: ThinkingLevel.LOW, medium: ThinkingLevel.MEDIUM, high: ThinkingLevel.HIGH };

export function createGemini(apiKey) {
  if (!apiKey) return null;
  // v1beta carries the "-latest" model aliases and JSON-schema structured output.
  const ai = new GoogleGenAI({ apiKey, apiVersion: "v1beta" });
  const jsonSchemas = new Map();

  return {
    name: (tier) => `gemini (${tier === "live" ? LIVE_MODEL : MODEL})`,
    async generate({ system, schema, prompt, effort = "medium", tier = "deep", maxTokens = 16000 }) {
      const model = tier === "live" ? LIVE_MODEL : MODEL;
      if (!jsonSchemas.has(schema)) jsonSchemas.set(schema, z.toJSONSchema(schema));
      const config = {
        systemInstruction: system,
        responseMimeType: "application/json",
        responseJsonSchema: jsonSchemas.get(schema),
        maxOutputTokens: maxTokens,
        thinkingConfig: LEVEL[effort] ? { thinkingLevel: LEVEL[effort] } : undefined,
      };
      let res;
      try {
        res = await ai.models.generateContent({ model, contents: prompt, config });
      } catch (err) {
        // Older models reject thinkingLevel; retry once without it.
        if (err instanceof ApiError && err.status === 400 && /thinking/i.test(err.message)) {
          delete config.thinkingConfig;
          res = await ai.models.generateContent({ model, contents: prompt, config });
        } else throw err;
      }
      const finish = res.candidates?.[0]?.finishReason;
      if (finish && finish !== "STOP") console.warn(`[mia] gemini finishReason=${finish}`);
      const text = res.text;
      if (!text) return null;
      const parsed = schema.safeParse(JSON.parse(text));
      if (!parsed.success) {
        console.warn("[mia] Gemini output failed schema validation.");
        return null;
      }
      return parsed.data;
    },
    describeError(err) {
      return err instanceof ApiError ? `Gemini API error ${err.status}` : "Gemini call failed";
    },
  };
}
