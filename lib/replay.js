import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const RECORDINGS = path.resolve(process.env.MIA_DATA_DIR || "./data", "replays");
const clientKey = /^[a-zA-Z0-9_-]+$/;
const transcript = z.object({
  duration: z.number().positive(),
  segments: z.array(z.object({
    start: z.number().nonnegative(), end: z.number().positive(),
    role: z.enum(["rep", "client", "agent", "unknown"]),
    speaker: z.string().trim().min(1), text: z.string().trim().min(1),
  })).min(1),
});

export function saveReplay(clientId, videoPath, input) {
  if (!clientKey.test(clientId || "")) throw new Error("Invalid client ID.");
  const file = path.resolve(videoPath);
  if (!/\.(mp4|webm)$/i.test(file) || !fs.statSync(file, { throwIfNoEntry: false })?.isFile()) {
    throw new Error("Provide a local MP4 or WebM file.");
  }
  const values = transcript.parse(input);
  if (values.segments.some(({ start, end }) => end <= start || end > values.duration)) {
    throw new Error("Each segment must end after it starts and within the recording duration.");
  }
  values.segments.sort((a, b) => a.end - b.end);
  fs.mkdirSync(RECORDINGS, { recursive: true });
  const output = path.join(RECORDINGS, `${clientId}.json`);
  const temporary = `${output}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ ...values, file }, null, 2));
  fs.renameSync(temporary, output);
  return values.segments.length;
}

export function getReplay(clientId) {
  if (!clientKey.test(clientId || "")) return null;
  const manifestPath = path.join(RECORDINGS, `${clientId}.json`);
  if (!fs.existsSync(manifestPath)) return null;
  const replay = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (!path.isAbsolute(replay.file) || !fs.existsSync(replay.file)) return null;
  return replay;
}

export function advanceReplay(session, time) {
  const replay = session.replay;
  const position = Math.min(replay.duration, time);
  if (position <= replay.position) return;
  replay.position = position;
  while (replay.cursor < replay.segments.length && replay.segments[replay.cursor].end <= position) {
    const { speaker, role, text, end } = replay.segments[replay.cursor++];
    session.addUtterance({ speaker, role, text, recording_time: end });
  }
}
