import fs from "node:fs";
import { getClient } from "../lib/store.js";
import { saveReplay } from "../lib/replay.js";

try {
  const [clientId, video, transcript] = process.argv.slice(2);
  if (!clientId || !video || !transcript) throw new Error("Usage: npm run replay:import -- CLIENT_ID VIDEO_PATH TRANSCRIPT_JSON");
  const client = getClient(clientId);
  if (!client) throw new Error("Save the client in ClientLuma first. Find the ID at /api/clients.");
  const input = JSON.parse(fs.readFileSync(transcript, "utf8").replace(/^\uFEFF/, ""));
  const count = saveReplay(client.id, video, input);
  console.log(`Imported ${count} segments for ${client.company || client.name}. Open ${`http://localhost:${process.env.PORT || 4000}`}/?replay=${client.id}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
