import { setTimeout as delay } from "node:timers/promises";
import { execFile } from "node:child_process";
import { setting } from "./settings.js";

const MODEL = "gemini-2.5-flash-preview-tts";
const SAMPLE_RATE = 48000;
const CHUNK_MS = 250;

export function connectVoice(socket, botId, voices) {
  socket.once("message", (data) => {
    let event;
    try { event = JSON.parse(data.toString()); } catch { socket.close(1003); return; }
    if (event.type !== "ready" || event.bot_id !== botId) { socket.close(1008); return; }
    voices.set(botId, socket);
    socket.send(JSON.stringify({ command: "ack", bot_id: botId }));
  });
  socket.on("close", () => { if (voices.get(botId) === socket) voices.delete(botId); });
}

const WINDOWS_SPEECH = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Speech
[Console]::InputEncoding = [System.Text.Encoding]::UTF8
$text = [Console]::In.ReadToEnd()
$speaker = New-Object System.Speech.Synthesis.SpeechSynthesizer
$speaker.SelectVoice($env:MIA_WINDOWS_VOICE)
$stream = New-Object System.IO.MemoryStream
$format = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(48000, 'Sixteen', 'Mono')
$speaker.SetOutputToAudioStream($stream, $format)
$speaker.Speak($text)
$audio = $stream.ToArray()
[Console]::OpenStandardOutput().Write($audio, 0, $audio.Length)
`;

function windowsSpeech(voice, text) {
  return new Promise((resolve, reject) => {
    const child = execFile("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_SPEECH], {
      windowsHide: true, encoding: "buffer", timeout: 30_000, maxBuffer: 5 * 1024 * 1024,
      env: { ...process.env, MIA_WINDOWS_VOICE: voice },
    }, (error, stdout, stderr) => error ? reject(new Error(`Local speech generation failed for ${voice}: ${stderr.toString().trim().slice(0, 240) || error.message}`)) : resolve(stdout));
    child.stdin.on("error", () => {});
    child.stdin.end(text, "utf8");
  });
}

async function geminiSpeech(voice, text) {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
    method: "POST",
    headers: { "x-goog-api-key": setting("GEMINI_API_KEY"), "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Say this transcript aloud verbatim:\n<transcript>${text}</transcript>` }] }],
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      },
    }),
    signal: AbortSignal.timeout(45_000),
  });
  const result = await res.json();
  const parts = result.candidates?.[0]?.content?.parts || [];
  const audio = parts.map((part) => part.inlineData).filter(Boolean);
  if (!res.ok || !audio.length || audio.some((part) => !part.mimeType.includes("rate=24000"))) {
    throw new Error(`Speech synthesis did not return 24 kHz audio (HTTP ${res.status}).`);
  }
  const input = Buffer.concat(audio.map((part) => Buffer.from(part.data, "base64")));
  const pcm = Buffer.alloc(input.length * 2);
  for (let i = 0; i + 1 < input.length; i += 2) {
    const sample = input.readInt16LE(i);
    const next = i + 3 < input.length ? input.readInt16LE(i + 2) : sample;
    pcm.writeInt16LE(sample, i * 2);
    pcm.writeInt16LE(Math.round((sample + next) / 2), i * 2 + 2);
  }
  return pcm;
}

export async function speakInMeet({ socket, botId, role, text, active }) {
  const buyer = role === "client";
  const pcm = process.platform === "win32"
    ? await windowsSpeech(buyer ? "Microsoft Zira Desktop" : "Microsoft David Desktop", text)
    : await geminiSpeech(buyer ? "Kore" : "Charon", text);
  if (!pcm.length) throw new Error("Speech generation returned no audio.");
  const chunkSize = SAMPLE_RATE * 2 * CHUNK_MS / 1000;
  for (let offset = 0; active() && offset < pcm.length; offset += chunkSize) {
    const ws = socket();
    if (ws?.readyState !== 1) throw new Error("The speaking bot disconnected from the meeting.");
    const chunk = pcm.subarray(offset, offset + chunkSize);
    const command = JSON.stringify({ command: "sendaudio", bot_id: botId, audiochunk: chunk.toString("base64"), sample_rate: SAMPLE_RATE });
    await new Promise((resolve, reject) => ws.send(command, (error) => error ? reject(error) : resolve()));
    await delay(chunk.length / (SAMPLE_RATE * 2) * 1000);
  }
}
