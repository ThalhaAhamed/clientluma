// MeetStream adapter: send a bot into a Zoom / Meet / Teams call and receive its live transcript via webhook.
// Docs: https://docs.meetstream.ai/guides/transcription-recordings/live-transcription
const BASE = process.env.MEETSTREAM_BASE_URL || "https://api.meetstream.ai/api/v1";
import { setting } from "./settings.js";
const key = () => setting("MEETSTREAM_API_KEY");

export const meetstreamEnabled = () => Boolean(key());

async function call(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Token ${key()}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(`MeetStream rejected the request (HTTP ${res.status}). Check your credentials, meeting link and MeetStream settings.`);
  return json;
}

/** Create a bot with sentence-level live transcription streamed to our webhook, and lifecycle events to callbackUrl. */
export async function createBot({ meetingLink, webhookUrl, callbackUrl, meetingId, botName = "MIA Notetaker" }) {
  if (!key()) throw new Error("MEETSTREAM_API_KEY is not set");
  const body = {
    meeting_link: meetingLink,
    bot_name: botName,
    audio_required: true,
    video_required: false,
    callback_url: callbackUrl,
    live_transcription_required: { webhook_url: webhookUrl },
    recording_config: {
      transcript: { provider: { meetstream_streaming: { transcription_mode: "sentence" } } },
    },
    custom_attributes: { mia_meeting_id: meetingId },
  };
  const out = await call("POST", "/bots/create_bot", body);
  return { botId: out.bot_id || out.id, raw: out };
}

export async function removeBot(botId) {
  if (!key() || !botId) return;
  try { await call("GET", `/bots/${encodeURIComponent(botId)}/remove_bot`); }
  catch (e) { console.warn("[meetstream] remove_bot failed:", e.message); }
}

/** Normalise a live-transcript webhook POST into an utterance, or null for partials / other events. */
export function parseTranscriptEvent(p) {
  if (!p || typeof p !== "object") return null;
  if (p.is_final === false) return null; // raw-mode interim result
  if (p.transcription_mode === "word_level") return null; // word fragments; we request sentence mode
  const text = p.utterance || p.transcript || p.text;
  if (!text) return null;
  return {
    botId: p.bot_id,
    meetingId: p.custom_attributes?.mia_meeting_id,
    utterance: { speaker: p.speakerName || p.speaker_name || p.speaker || "Speaker", text, ts: Date.now() },
  };
}

const STATUS_LABEL = {
  "bot.joining": "Bot joining…", "bot.in_waiting_room": "Bot in waiting room - admit it", "bot.inmeeting": "Bot in meeting",
  "bot.recording": "Bot listening", "bot.leaving": "Bot leaving", "bot.stopped": "Meeting ended", "bot.kicked": "Bot was removed",
  "bot.denied": "Host denied the bot", "bot.notallowed": "Bot was not admitted in time", "bot.failed": "Bot failed",
  "bot.error": "MeetStream reported a live call issue", "audio.skipped": "MeetStream captured no usable audio",
};

/** Normalise a bot lifecycle event (callback_url). `ended` is true for the single ending event. */
export function parseStatusEvent(p) {
  if (!p?.bot_event && !p?.event) return null;
  const name = p.bot_event || p.event;
  return {
    botId: p.bot_id,
    meetingId: p.custom_attributes?.mia_meeting_id,
    event: name,
    label: STATUS_LABEL[name] || name,
    message: p.message || "",
    ended: p.event === "bot.stopped" || ["bot.stopped", "bot.kicked", "bot.denied", "bot.notallowed", "bot.failed"].includes(name),
    failed: ["bot.denied", "bot.notallowed", "bot.failed"].includes(name),
  };
}
