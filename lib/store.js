import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { selectedDatabaseName, selectedDatabaseProvider, setting } from "./settings.js";
import { openPostgres } from "./postgres-store.js";

const dataDir = path.resolve(process.env.MIA_DATA_DIR || "./data");
const provider = selectedDatabaseProvider();
const activeDatabaseName = provider === "sqlite" && !process.env.MIA_DATABASE_PATH ? selectedDatabaseName() : null;
const activeDatabaseUrl = provider === "postgresql" ? setting("MIA_DATABASE_URL") : "";

function legacyFiles(folder) {
  try { return fs.readdirSync(folder); }
  catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
function openSqlite() {
  const databasePath = path.resolve(process.env.MIA_DATABASE_PATH || path.join(dataDir, activeDatabaseName));
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  const versions = db.prepare("PRAGMA user_version");
  if (versions.get().user_version !== 0) return db;
  db.exec("BEGIN IMMEDIATE");
  try {
    if (versions.get().user_version === 0) {
      db.exec(`
        CREATE TABLE clients (id TEXT PRIMARY KEY, updated_at TEXT NOT NULL, record TEXT NOT NULL);
        CREATE TABLE meetings (id TEXT PRIMARY KEY, client_id TEXT NOT NULL, started_at TEXT NOT NULL, record TEXT NOT NULL);
        CREATE INDEX meetings_client_date ON meetings (client_id, started_at DESC);
        CREATE INDEX meetings_date ON meetings (started_at DESC);
      `);
      const client = db.prepare("INSERT INTO clients VALUES (?, ?, ?)");
      const meeting = db.prepare("INSERT INTO meetings VALUES (?, ?, ?, ?)");
      for (const [directory, importRow] of [
        ["clients", (row) => client.run(row.id, row.updated_at || "", JSON.stringify(row))],
        ["meetings", (row) => meeting.run(row.id, row.client_id, row.started_at || "", JSON.stringify(row))],
      ]) {
        if (activeDatabaseName && activeDatabaseName !== "workspace.sqlite") continue;
        const folder = path.join(dataDir, directory);
        for (const file of legacyFiles(folder)) {
          if (file.endsWith(".json")) importRow(JSON.parse(fs.readFileSync(path.join(folder, file), "utf8")));
        }
      }
      db.exec("PRAGMA user_version = 1");
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return db;
}

let db;
if (provider === "postgresql") {
  try { db = await openPostgres(activeDatabaseUrl); }
  catch {
    throw new Error("Could not open PostgreSQL. Check the connection URL, TLS certificate and permission to create the cuelensa schema.");
  }
} else {
  db = openSqlite();
}

const clients = db.prepare("SELECT record FROM clients ORDER BY updated_at DESC");
const getClientRow = db.prepare("SELECT record FROM clients WHERE id = ?");
const saveClientSql = `INSERT INTO clients VALUES (?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, record = excluded.record`;
const upsertClient = db.prepare(saveClientSql);
const meetings = db.prepare("SELECT record FROM meetings ORDER BY started_at DESC");
const clientMeetings = db.prepare("SELECT record FROM meetings WHERE client_id = ? ORDER BY started_at DESC");
const getMeetingRow = db.prepare("SELECT record FROM meetings WHERE id = ?");
const saveMeetingSql = `INSERT INTO meetings VALUES (?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET client_id = excluded.client_id, started_at = excluded.started_at, record = excluded.record`;
const parse = (row) => row ? JSON.parse(row.record) : null;

export const newId = (prefix) => `${prefix}_${crypto.randomBytes(5).toString("hex")}`;
export const databaseStatus = () => ({
  engine: provider === "postgresql" ? "PostgreSQL" : "SQLite",
  configuredPath: provider === "sqlite" && Boolean(process.env.MIA_DATABASE_PATH),
});
export const databaseSelection = () => ({
  active: activeDatabaseName,
  next: selectedDatabaseProvider() === "sqlite" && !process.env.MIA_DATABASE_PATH ? selectedDatabaseName() : null,
});
export function databaseRestartRequired() {
  if (provider !== selectedDatabaseProvider()) return true;
  return provider === "postgresql" ? activeDatabaseUrl !== setting("MIA_DATABASE_URL")
    : databaseSelection().active !== databaseSelection().next;
}
export const listClients = async () => (await clients.all()).map(parse);
export const getClient = async (id) => typeof id === "string" ? parse(await getClientRow.get(id)) : null;
export const getMeeting = async (id) => typeof id === "string" ? parse(await getMeetingRow.get(id)) : null;
export const listMeetings = async (clientId) => (await (clientId ? clientMeetings.all(clientId) : meetings.all())).map(parse);

const clientWrites = new Map();
async function withClientWrite(id, write) {
  const previous = clientWrites.get(id);
  const current = (previous || Promise.resolve()).catch(() => {}).then(write);
  clientWrites.set(id, current);
  try { return await current; }
  finally { if (clientWrites.get(id) === current) clientWrites.delete(id); }
}
async function writeBatch(commands) {
  if (provider === "postgresql") return db.writeBatch(commands);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const [sql, args] of commands) db.prepare(sql).run(...args);
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const deleteClient = id => withClientWrite(id, () => writeBatch([
  ["DELETE FROM meetings WHERE client_id = ?", [id]],
  ["DELETE FROM clients WHERE id = ?", [id]],
]));

export function updateClient(id, edit) {
  return withClientWrite(id, async () => {
    const client = await getClient(id);
    const changed = edit(client);
    if (!changed) return null;
    return saveClient(changed);
  });
}

async function saveClient(client) {
  client.updated_at = new Date().toISOString();
  await upsertClient.run(client.id, client.updated_at, JSON.stringify(client));
  return client;
}

export function saveMeeting(meeting) {
  return withClientWrite(meeting.client_id, async () => {
    const client = await getClient(meeting.client_id);
    if (!client) throw new Error("The client was removed before the report was saved.");
    const commands = [[saveMeetingSql, [meeting.id, meeting.client_id, meeting.started_at, JSON.stringify(meeting)]]];
    if (!(client.meetings || []).some(item => item.id === meeting.id)) {
      client.profile = meeting.profile_after;
      client.meetings = [...(client.meetings || []), {
        id: meeting.id, date: meeting.started_at, conversion_likelihood: meeting.report.conversion_likelihood,
        summary: meeting.report.executive_summary,
      }];
      client.updated_at = new Date().toISOString();
      commands.push([saveClientSql, [client.id, client.updated_at, JSON.stringify(client)]]);
    }
    await writeBatch(commands);
    return meeting;
  });
}
