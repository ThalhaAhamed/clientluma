// Tiny JSON-file store for client profiles and meetings. Swap for a DB in production.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = path.resolve(process.env.MIA_DATA_DIR || "./data");
const CLIENTS = path.join(DATA_DIR, "clients");
const MEETINGS = path.join(DATA_DIR, "meetings");
fs.mkdirSync(CLIENTS, { recursive: true });
fs.mkdirSync(MEETINGS, { recursive: true });

const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
const writeJson = (file, value) => {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value, null, 2));
  fs.renameSync(temporary, file);
};
export const newId = (p) => `${p}_${crypto.randomBytes(5).toString("hex")}`;
const safe = (id) => String(id).replace(/[^a-zA-Z0-9_-]/g, "");

export function listClients() {
  return fs
    .readdirSync(CLIENTS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(CLIENTS, f)))
    .sort((a, b) => (b.updated_at || "").localeCompare(a.updated_at || ""));
}

export function getClient(id) {
  const f = path.join(CLIENTS, `${safe(id)}.json`);
  return fs.existsSync(f) ? readJson(f) : null;
}

export function saveClient(client) {
  client.updated_at = new Date().toISOString();
  writeJson(path.join(CLIENTS, `${safe(client.id)}.json`), client);
  return client;
}

export function deleteClient(id) {
  const f = path.join(CLIENTS, `${safe(id)}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

export function getMeeting(id) {
  const f = path.join(MEETINGS, `${safe(id)}.json`);
  return fs.existsSync(f) ? readJson(f) : null;
}

export function saveMeeting(m) {
  writeJson(path.join(MEETINGS, `${safe(m.id)}.json`), m);
  return m;
}

export function listMeetings(clientId) {
  return fs
    .readdirSync(MEETINGS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson(path.join(MEETINGS, f)))
    .filter((m) => !clientId || m.client_id === clientId)
    .sort((a, b) => (b.started_at || "").localeCompare(a.started_at || ""));
}
