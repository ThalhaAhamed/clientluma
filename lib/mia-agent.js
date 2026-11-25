// MeetStream MIA (Agents API) integration: a hosted voice agent that joins the meeting and, when asked,
// answers from this server's client memory through custom functions.
// Docs: https://docs.meetstream.ai/guides/mia/mia-api-guide
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const BASE = process.env.MEETSTREAM_BASE_URL || "https://api.meetstream.ai/api/v1";
const KEY = () => process.env.MEETSTREAM_API_KEY;
const STATE_FILE = path.resolve(process.env.MIA_DATA_DIR || "./data", "mia-agent.json");

// Everything below is configurable from .env; defaults are the Gemini test setup.
export const AGENT_SETTINGS = {
  name: process.env.MIA_AGENT_NAME || "MIA",
  mode: process.env.MIA_AGENT_MODE || "pipeline", // wake word + speak-only-when-asked need pipeline mode
  llmProvider: process.env.MIA_AGENT_LLM_PROVIDER || "google",
  llmModel: process.env.MIA_AGENT_LLM_MODEL || "gemini-2.5-flash",
  llmKeySource: process.env.MIA_AGENT_LLM_KEY_SOURCE || "user", // "user" = key saved in MeetStream Integrations
  sttProvider: process.env.MIA_AGENT_STT_PROVIDER || "deepgram",
  sttModel: process.env.MIA_AGENT_STT_MODEL || "nova-3",
  sttKeySource: process.env.MIA_AGENT_STT_KEY_SOURCE || "meetstream",
  voiceProvider: process.env.MIA_AGENT_VOICE_PROVIDER || "openai",
  voiceModel: process.env.MIA_AGENT_VOICE_MODEL || "tts-1",
  voiceId: process.env.MIA_AGENT_VOICE_ID || "alloy",
  voiceKeySource: process.env.MIA_AGENT_VOICE_KEY_SOURCE || "meetstream",
  realtimeVoice: process.env.MIA_AGENT_REALTIME_VOICE || "Puck",
  wakeWords: (process.env.MIA_AGENT_WAKE_WORDS || "hey mia,ok mia,mia").split(",").map((w) => w.trim()).filter(Boolean),
  language: process.env.MIA_AGENT_LANGUAGE || "en",
};

async function call(method, urlPath, body) {
  if (!KEY()) throw new Error("MEETSTREAM_API_KEY is not set");
  const res = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: { Authorization: `Token ${KEY()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`MeetStream ${method} ${urlPath} ${res.status}: ${(json.message || json.error || json.detail || text).toString().slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// ---------------------------------------------------------------- agent config

const SYSTEM_PROMPT = `You are MIA, a client-intelligence assistant sitting in on a meeting between {{rep_name}} from our team
and {{client_name}} of {{company}}. You stay silent unless someone addresses you by name.

When addressed:
- Answer in one or two short spoken sentences. No lists, no markdown.
- For anything about this client (their needs, objections, past meetings, stakeholders, what was promised), call
  get_client_context or search_client_history first and answer only from what they return. If they don't have it,
  say you don't have that on record. Never invent prices, dates or commitments.
- When someone asks you to note a promise or follow-up ("MIA, note that we'll send the security pack by Friday"),
  call log_commitment, then confirm in a few words.
- Be discreet: the client can hear you. Don't reveal internal strategy, deal scores or coaching notes.

Background brief, prepared before the meeting:
{{client_brief}}`;

function customFunctions(toolBaseUrl, secret) {
  const common = {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}` },
    timeout: 15,
    retries: 1,
  };
  return [
    {
      ...common,
      name: "get_client_context",
      description:
        "Get what we know about the client in this meeting: summary, deal stage, pain points, requirements, open " +
        "objections, stakeholders, open commitments from either side, and the last meeting's summary. Call this " +
        "before answering any question about the client.",
      url: `${toolBaseUrl}/mia-tools/get_client_context`,
      parameters: { type: "object", properties: {}, required: [] },
    },
    {
      ...common,
      name: "search_client_history",
      description:
        "Search past meetings and documents for this client by topic (for example 'budget', 'security', 'HubSpot', " +
        "'CEO approval'). Returns matching quotes with the meeting date and speaker.",
      url: `${toolBaseUrl}/mia-tools/search_client_history`,
      parameters: {
        type: "object",
        properties: { query: { type: "string", description: "Topic or keywords to look for" } },
        required: ["query"],
      },
    },
    {
      ...common,
      name: "log_commitment",
      description:
        "Record a promise or follow-up made in this meeting, by our team or by the client, so it is tracked after " +
        "the call.",
      url: `${toolBaseUrl}/mia-tools/log_commitment`,
      parameters: {
        type: "object",
        properties: {
          owner: { type: "string", enum: ["us", "client"], description: "Who made the promise" },
          commitment: { type: "string", description: "What was promised, in one sentence" },
          due: { type: "string", description: "When it is due, as said in the meeting, or empty if not said" },
        },
        required: ["owner", "commitment"],
      },
    },
  ];
}

/** The full MIA agent configuration for MeetStream's POST/PUT /mia. */
export function buildAgentConfig({ toolBaseUrl, secret }) {
  const s = AGENT_SETTINGS;
  const functions = customFunctions(toolBaseUrl, secret);
  if (s.mode === "realtime") {
    return {
      agent_name: s.name,
      mode: "realtime",
      model: { provider: s.llmProvider, system_prompt: SYSTEM_PROMPT, voice: s.realtimeVoice, temperature: 0.4 },
      agent: { custom_functions: functions, speaker_aware_responses: true },
    };
  }
  return {
    agent_name: s.name,
    mode: "pipeline",
    model: {
      provider: s.llmProvider,
      model: s.llmModel,
      system_prompt: SYSTEM_PROMPT,
      first_message: "",
      temperature: 0.4,
      max_tokens: 200,
      key_source: s.llmKeySource,
    },
    transcriber: { provider: s.sttProvider, model: s.sttModel, language: s.language, key_source: s.sttKeySource },
    voice: { provider: s.voiceProvider, model: s.voiceModel, voice_id: s.voiceId, key_source: s.voiceKeySource },
    agent: {
      response_modality: "audio",
      speak_only_when_asked: true,
      speaker_aware_responses: true,
      speaker_aware_prompt: "Each message is prefixed with [Speaker Name]:. Use names when you reply.",
      chat_input: true,
      enable_interruptions: true,
      custom_functions: functions,
    },
    wake_word: { enabled: true, words: s.wakeWords, timeout: 30 },
  };
}

// ---------------------------------------------------------------- practice-call persona (the AI plays the client)

const PERSONA_PROMPT = `You are role-playing a real B2B buyer on a sales call so a salesperson can practise. Stay in character
for the whole call and never say you are an AI unless asked directly.

You are {{persona_name}}, {{persona_role}} at {{company}}. You are speaking with {{rep_name}}, a salesperson for
{{offering}}.

What is true for you (use it, don't recite it):
{{persona_brief}}

How to behave:
- Talk like a busy, realistic buyer: one to three spoken sentences per turn, natural and conversational, no lists.
- Share your pains when asked good questions; be vaguer when the questions are generic.
- Raise your objections naturally over the call (price and budget, an existing tool, security, needing approval
  from others) and push back once before accepting a good answer.
- Show interest when the salesperson connects their product to your real problems; ask about pricing, timeline or a
  pilot only once you are interested.
- If your budget has no confirmed amount in the brief, explain who controls it and what would justify it.
- Don't agree to buy on this call. If it goes well, agree to a concrete next step.`;

export function buildPersonaConfig() {
  const s = AGENT_SETTINGS;
  return {
    agent_name: "MIA practice client",
    mode: "pipeline",
    model: {
      provider: s.llmProvider, model: s.llmModel, system_prompt: PERSONA_PROMPT,
      first_message: "Hi, this is {{persona_name}} from {{company}}. Thanks for making the time. Where would you like to start?",
      temperature: 0.8, max_tokens: 160, key_source: s.llmKeySource,
    },
    transcriber: { provider: s.sttProvider, model: s.sttModel, language: s.language, key_source: s.sttKeySource },
    voice: { provider: s.voiceProvider, model: s.voiceModel, voice_id: process.env.MIA_PERSONA_VOICE_ID || "nova", key_source: s.voiceKeySource },
    agent: { response_modality: "audio", speak_only_when_asked: false, speaker_aware_responses: true, enable_interruptions: true },
    wake_word: { enabled: false, words: [], timeout: 30 },
  };
}

/** Values for the persona prompt, built from the client's notes and knowledge base. */
export function personaParams({ client, repName }) {
  const kb = client.kb || {};
  const profile = client.profile || {};
  const lead = client.contacts?.[0] || { name: client.name, role: "decision maker" };
  const brief = [
    client.notes || kb.summary || "",
    (kb.pain_points || []).length ? `Your pains: ${kb.pain_points.map((p) => p.title).join("; ")}.` : "",
    (profile.open_objections || []).length ? `Open objections and approvals: ${profile.open_objections.join("; ")}.` : "",
    (profile.requirements || []).length ? `Your requirements: ${profile.requirements.join("; ")}.` : "",
    (kb.likely_objections || []).length ? `Objections you hold: ${kb.likely_objections.map((o) => o.objection).join("; ")}.` : "",
    (client.contacts || []).length > 1 ? `Others involved: ${client.contacts.slice(1).map((c) => `${c.name} (${c.role})`).join(", ")}.` : "",
    client.deal ? `Deal context: ${client.deal}.` : "",
  ].filter(Boolean).join("\n");
  return {
    persona_name: lead.name, persona_role: lead.role || "decision maker",
    company: (client.company || client.name).replace(/\s*\(fictional\)\s*/i, ""),
    rep_name: repName || "the salesperson", offering: client.offering || "their product",
    persona_brief: brief.slice(0, 3000),
  };
}

// ---------------------------------------------------------------- state: agent configs kept in sync (by kind)

function readState() {
  let st = {};
  try { st = JSON.parse(fs.readFileSync(STATE_FILE, "utf8")); } catch {}
  if (st.agent_config_id) st = { assistant: st }; // older single-config file
  return st;
}
function writeState(st) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(st, null, 2));
}
const hashOf = (cfg) => crypto.createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 16);

export function agentStatus() {
  const st = readState().assistant || {};
  const s = AGENT_SETTINGS;
  return {
    agent_config_id: st.agent_config_id || null,
    synced_at: st.synced_at || null,
    mode: s.mode,
    llm: `${s.llmProvider}/${s.mode === "realtime" ? "(default)" : s.llmModel}`,
    stt: s.mode === "realtime" ? "native" : `${s.sttProvider}/${s.sttModel}`,
    voice: s.mode === "realtime" ? s.realtimeVoice : `${s.voiceProvider}/${s.voiceModel}/${s.voiceId}`,
    wake_words: s.mode === "pipeline" ? s.wakeWords : [],
    last_error: st.last_error || null,
  };
}

/**
 * Make sure MeetStream holds an agent config matching the current settings and tool URL.
 * Creates it the first time; updates it when anything changed (for example a new tunnel URL).
 */
export async function ensureAgent({ toolBaseUrl, secret, kind = "assistant" }) {
  const cfg = kind === "persona" ? buildPersonaConfig() : buildAgentConfig({ toolBaseUrl, secret });
  const hash = hashOf(cfg);
  const all = readState();
  const st = all[kind] || {};
  const save = (v) => writeState({ ...readState(), [kind]: v });
  try {
    if (st.agent_config_id && st.hash === hash) return st.agent_config_id;
    if (st.agent_config_id) {
      try {
        await call("PUT", "/mia", { agent_config_id: st.agent_config_id, ...cfg });
        save({ ...st, hash, synced_at: new Date().toISOString(), last_error: null });
        return st.agent_config_id;
      } catch (e) {
        if (e.status !== 404) throw e; // deleted on MeetStream's side: create a new one below
      }
    }
    const out = await call("POST", "/mia", cfg);
    const id = out.agent_config_id || out.agent_config?.agent_config_id || out.id;
    if (!id) throw new Error(`MeetStream did not return an agent_config_id: ${JSON.stringify(out).slice(0, 200)}`);
    save({ agent_config_id: id, hash, synced_at: new Date().toISOString(), last_error: null });
    return id;
  } catch (e) {
    save({ ...st, last_error: e.message });
    throw e;
  }
}

/** Send the practice-client persona into the meeting (it only talks; a separate bot transcribes). */
export const personaBotName = (params) => `${params.persona_name} (AI client)`;

export async function launchPersonaBot({ agentConfigId, meetingLink, params, callbackUrl, meetingId }) {
  const out = await call("POST", "/bots/create_bot", {
    meeting_link: meetingLink,
    bot_name: personaBotName(params),
    agent_config_id: agentConfigId,
    agent_config_params: params,
    callback_url: callbackUrl,
    custom_attributes: { mia_meeting_id: meetingId, role: "practice-client" },
  });
  return out.bot_id || out.id;
}

/**
 * Send the MIA agent into a meeting. Live transcription goes to our webhook as well, so the silent analyzer keeps
 * working; if MeetStream refuses that combination for agent bots, the bot is created without it.
 */
export async function launchAgentBot({ agentConfigId, meetingLink, params, webhookUrl, callbackUrl, meetingId }) {
  const base = {
    meeting_link: meetingLink,
    bot_name: `${AGENT_SETTINGS.name} (AI assistant)`,
    agent_config_id: agentConfigId,
    agent_config_params: params,
    callback_url: callbackUrl,
    custom_attributes: { mia_meeting_id: meetingId },
  };
  const withTranscript = {
    ...base,
    live_transcription_required: { webhook_url: webhookUrl },
    recording_config: { transcript: { provider: { meetstream_streaming: { transcription_mode: "sentence" } } } },
  };
  try {
    const out = await call("POST", "/bots/create_bot", withTranscript);
    return { botId: out.bot_id || out.id, liveTranscript: true };
  } catch (e) {
    if (e.status !== 400) throw e;
    console.warn("[mia-agent] create_bot with live transcription refused, retrying without it:", e.message);
    const out = await call("POST", "/bots/create_bot", base);
    return { botId: out.bot_id || out.id, liveTranscript: false };
  }
}

/** The per-meeting values filled into the system prompt's {{placeholders}}. */
export function agentParams({ client, repName }) {
  const kb = client.kb || {};
  const p = client.profile || {};
  const lines = [
    kb.summary || client.notes?.slice(0, 400) || "",
    p.deal_stage ? `Deal stage: ${p.deal_stage}.` : "",
    (kb.goals_for_call || []).length ? `Goals for this call: ${kb.goals_for_call.join("; ")}.` : "",
    (p.open_objections || []).length ? `Open objections: ${p.open_objections.join("; ")}.` : "",
    (client.contacts || []).length ? `Stakeholders: ${client.contacts.map((c) => `${c.name} (${c.role || "?"})`).join(", ")}.` : "",
  ].filter(Boolean);
  return {
    rep_name: repName || "our team",
    client_name: client.contacts?.[0]?.name || client.name,
    company: client.company || client.name,
    client_brief: lines.join("\n").slice(0, 2500),
  };
}
