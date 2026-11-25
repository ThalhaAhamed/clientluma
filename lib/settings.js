import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const file = path.resolve(process.env.MIA_DATA_DIR || "./data", "settings.json");
const fields = ["MIA_PROVIDER", "GEMINI_API_KEY", "ANTHROPIC_API_KEY", "MEETSTREAM_API_KEY", "PUBLIC_URL"];
const callbackUrl = z.string().trim().max(2048).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}, "Enter a public HTTPS origin without a path, credentials or query.");
const schema = z.strictObject({
  MIA_PROVIDER: z.enum(["offline", "gemini", "claude", "auto"]).optional(),
  GEMINI_API_KEY: z.string().trim().max(4096).optional(),
  ANTHROPIC_API_KEY: z.string().trim().max(4096).optional(),
  MEETSTREAM_API_KEY: z.string().trim().max(4096).optional(),
  PUBLIC_URL: callbackUrl.optional(),
  clear: z.array(z.enum(["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "MEETSTREAM_API_KEY"])).optional(),
});

let saved = {};
try { saved = schema.parse(JSON.parse(fs.readFileSync(file, "utf8"))); }
catch (error) { if (error.code !== "ENOENT") throw error; }

const overrides = {
  MIA_PROVIDER: () => process.env.MIA_OFFLINE === "1" ? "offline" : process.env.MIA_PROVIDER,
  GEMINI_API_KEY: () => process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  ANTHROPIC_API_KEY: () => process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN,
};
const environment = (key) => overrides[key] ? overrides[key]() : process.env[key];
export const setting = (key) => environment(key) || saved[key] || "";

export function settingsStatus() {
  return {
    ready: Boolean(saved.MIA_PROVIDER || environment("MIA_PROVIDER") || setting("GEMINI_API_KEY") || setting("ANTHROPIC_API_KEY")),
    provider: setting("MIA_PROVIDER") || "auto",
    callbackUrl: setting("PUBLIC_URL"),
    configured: Object.fromEntries(fields.map((key) => [key, Boolean(setting(key))])),
    managed: fields.filter((key) => environment(key)),
    desktop: process.env.MIA_DESKTOP === "1",
    callbackTarget: process.env.MIA_DESKTOP === "1" ? `http://127.0.0.1:${process.env.PORT}` : null,
  };
}

export function saveSettings(body) {
  const { clear = [], ...updates } = schema.parse(body);
  const next = { ...saved };
  for (const key of clear) if (!environment(key)) delete next[key];
  for (const [key, value] of Object.entries(updates)) {
    if (!environment(key) && (value || key === "PUBLIC_URL")) next[key] = value;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, file);
  saved = next;
}
