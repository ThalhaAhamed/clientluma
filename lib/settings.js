import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const file = path.resolve(process.env.MIA_DATA_DIR || "./data", "settings.json");
const secretFields = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY", "MEETSTREAM_API_KEY", "MIA_DOCS_MCP_TOKEN", "MIA_DATABASE_URL"];
const optionalTextFields = ["MIA_DATABASE_NAME", "MIA_DOCS_MCP_URL", "MIA_DOCS_MCP_TOOL", "MIA_DOCS_MCP_QUERY_FIELD"];
const fields = ["MIA_PROVIDER", "PUBLIC_URL", "MIA_AGENT_LLM_PROVIDER", "MIA_AGENT_LLM_MODEL", "MIA_AGENT_LLM_KEY_SOURCE", "MIA_DATABASE_PROVIDER",
  ...secretFields, ...optionalTextFields];
const callbackUrl = z.string().trim().max(2048).refine((value) => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.search && !url.hash && url.pathname === "/";
  } catch { return false; }
}, "Enter a public HTTPS origin without a path, credentials or query.");
const docsUrl = z.string().trim().max(2048).refine(value => {
  if (!value) return true;
  try {
    const url = new URL(value);
    return !url.username && !url.password && !url.hash && !url.search &&
      (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)));
  } catch { return false; }
}, "Enter an HTTPS MCP endpoint or a loopback HTTP endpoint.");
const toolName = z.string().trim().regex(/^[A-Za-z0-9_.-]{0,128}$/);
const databaseName = z.string().trim().regex(/^(?:[A-Za-z0-9][A-Za-z0-9_-]{0,59}\.sqlite)?$/i,
  "Enter a SQLite filename such as team.sqlite.");
const databaseProvider = z.enum(["sqlite", "postgresql"]);
export function parseDatabaseUrl(value) {
  try {
    const url = new URL(value);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username || url.pathname.length < 2 || url.hash) return null;
    if ([...url.searchParams.keys()].some(key => !["sslmode", "channel_binding"].includes(key))) return null;
    const mode = url.searchParams.get("sslmode");
    const binding = url.searchParams.get("channel_binding");
    if (mode && !["require", "verify-ca", "verify-full", ...(loopback ? ["disable"] : [])].includes(mode)) return null;
    if (binding && !["require", "prefer", "disable"].includes(binding)) return null;
    url.search = "";
    return { connectionString: url.href, ssl: mode ? mode !== "disable" : !loopback, enableChannelBinding: binding !== "disable" };
  } catch { return null; }
}
const databaseUrl = z.string().trim().max(4096).refine(value => !value || parseDatabaseUrl(value),
  "Enter a PostgreSQL connection URL. Remote connections require verified TLS.");
const schema = z.strictObject({
  MIA_PROVIDER: z.enum(["offline", "gemini", "claude", "auto"]).optional(),
  GEMINI_API_KEY: z.string().trim().max(4096).optional(),
  ANTHROPIC_API_KEY: z.string().trim().max(4096).optional(),
  MEETSTREAM_API_KEY: z.string().trim().max(4096).optional(),
  PUBLIC_URL: callbackUrl.optional(),
  MIA_AGENT_LLM_PROVIDER: z.enum(["google", "openai", "anthropic", "xai"]).optional(),
  MIA_AGENT_LLM_MODEL: z.string().trim().min(1).max(200).optional(),
  MIA_AGENT_LLM_KEY_SOURCE: z.enum(["user", "meetstream"]).optional(),
  MIA_DATABASE_PROVIDER: databaseProvider.optional(),
  MIA_DATABASE_URL: databaseUrl.optional(),
  MIA_DATABASE_NAME: databaseName.optional(),
  MIA_DOCS_MCP_URL: docsUrl.optional(),
  MIA_DOCS_MCP_TOOL: toolName.optional(),
  MIA_DOCS_MCP_QUERY_FIELD: z.string().trim().regex(/^(?:[A-Za-z][A-Za-z0-9_]{0,63})?$/).optional(),
  MIA_DOCS_MCP_TOKEN: z.string().trim().max(4096).optional(),
  clear: z.array(z.enum(secretFields)).optional(),
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
export function docsMcpSettings() {
  return {
    url: docsUrl.parse(setting("MIA_DOCS_MCP_URL")), tool: toolName.parse(setting("MIA_DOCS_MCP_TOOL")),
    queryField: setting("MIA_DOCS_MCP_QUERY_FIELD") || "query", token: setting("MIA_DOCS_MCP_TOKEN"),
  };
}
export const selectedDatabaseName = () => databaseName.parse(setting("MIA_DATABASE_NAME")) || "workspace.sqlite";
export const selectedDatabaseProvider = () => databaseProvider.parse(setting("MIA_DATABASE_PROVIDER") || "sqlite");

export function settingsStatus() {
  return {
    ready: Boolean(saved.MIA_PROVIDER || environment("MIA_PROVIDER") || setting("GEMINI_API_KEY") || setting("ANTHROPIC_API_KEY")),
    provider: setting("MIA_PROVIDER") || "auto",
    callbackUrl: setting("PUBLIC_URL"),
    options: Object.fromEntries(fields.filter(key => !secretFields.includes(key)).map(key => [key, setting(key)])),
    configured: Object.fromEntries(fields.map((key) => [key, Boolean(setting(key))])),
    managed: fields.filter((key) => environment(key) || (key === "MIA_DATABASE_NAME" && process.env.MIA_DATABASE_PATH)),
    desktop: process.env.MIA_DESKTOP === "1",
  };
}

export function saveSettings(body) {
  const { clear = [], ...updates } = schema.parse(body);
  const next = { ...saved };
  const managed = new Set(settingsStatus().managed);
  for (const key of clear) if (!environment(key)) delete next[key];
  for (const [key, value] of Object.entries(updates)) {
    if (!managed.has(key) && (value || key === "PUBLIC_URL" || optionalTextFields.includes(key))) next[key] = value;
  }
  if ((environment("MIA_DATABASE_PROVIDER") || next.MIA_DATABASE_PROVIDER) === "postgresql" &&
      !parseDatabaseUrl(environment("MIA_DATABASE_URL") || next.MIA_DATABASE_URL)) {
    databaseUrl.parse("invalid");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
  fs.renameSync(tmp, file);
  saved = next;
}
