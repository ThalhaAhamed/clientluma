import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const connection = process.env.CUELENSA_TEST_POSTGRES_URL;
test("PostgreSQL initializes, persists records across restart, and deletes client data", { skip: !connection, timeout: 20_000 }, async t => {
  const url = new URL(connection);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) && /^\/cuelensa_test_[a-z0-9_]+$/.test(url.pathname),
    "Use an isolated loopback database named cuelensa_test_*.");
  const data = await mkdtemp(join(tmpdir(), "cuelensa-postgres-test-"));
  const children = new Set();
  const stop = async record => {
    if (record.child.exitCode === null && record.child.signalCode === null) record.child.kill();
    await record.closed;
    children.delete(record);
  };
  t.after(async () => {
    await Promise.all([...children].map(stop));
    await rm(data, { recursive: true, force: true });
  });

  async function start() {
    const child = spawn(process.execPath, ["server.js"], {
      stdio: ["ignore", "pipe", "inherit"],
      env: {
        PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, PORT: "0", MIA_DATA_DIR: data, MIA_PROVIDER: "offline",
        MIA_DATABASE_PROVIDER: "postgresql", MIA_DATABASE_URL: connection,
      },
    });
    const record = { child, closed: once(child, "close") };
    children.add(record);
    record.base = await new Promise((resolve, reject) => {
      let output = "";
      child.stdout.on("data", part => {
        output += part;
        const port = output.match(/running at http:\/\/localhost:(\d+)/)?.[1];
        if (port) resolve(`http://127.0.0.1:${port}`);
      });
      child.once("error", reject);
      child.once("exit", code => reject(new Error(`PostgreSQL preview exited with code ${code}.`)));
    });
    return record;
  }
  const first = await start();
  const created = await fetch(first.base + "/api/clients", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "PostgreSQL test contact" }),
  });
  assert.equal(created.status, 200);
  const { id } = await created.json();
  assert.match(id, /^cli_/);
  const brief = await fetch(`${first.base}/api/clients/${id}/kb`, { method: "POST" });
  assert.equal(brief.status, 200);
  await stop(first);
  const second = await start();
  const route = `${second.base}/api/clients/${id}`;
  const persisted = await fetch(route);
  assert.equal(persisted.status, 200);
  assert.ok((await persisted.json()).kb.questions_to_ask.length);
  assert.equal((await fetch(route, { method: "DELETE" })).status, 200);
  assert.equal((await fetch(route)).status, 404);
});
