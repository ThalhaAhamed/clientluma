import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { WebSocket as Socket } from "ws";

test("fresh installation runs the coaching and replay workflows locally", { timeout: 20_000 }, async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "call-coach-test-"));
  const data = path.join(workspace, "data");
  const env = {
    ...process.env, PORT: "0", MIA_LISTEN_HOST: "127.0.0.1", MIA_DATA_DIR: data,
    MIA_OFFLINE: "1", MIA_ANALYZE_EVERY: "1", MEETSTREAM_API_KEY: "", MIA_WEBHOOK_SECRET: "test-secret",
  };
  const server = spawn(process.execPath, ["server.js"], { env, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      const closed = once(server, "close");
      server.kill();
      await closed;
    }
    await fs.rm(workspace, { recursive: true, force: true });
  });
  const port = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Server did not start")), 6_000);
    server.stdout.on("data", (data) => {
      const match = data.toString().match(/running at http:\/\/localhost:(\d+)/);
      if (match) { clearTimeout(timeout); resolve(match[1]); }
    });
    server.once("error", (error) => { clearTimeout(timeout); reject(error); });
    server.once("exit", (code) => { clearTimeout(timeout); reject(new Error(`Server exited before startup (${code})`)); });
  });
  const origin = `http://127.0.0.1:${port}`;
  const post = (route, body, headers = {}) => fetch(origin + route, {
    method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body),
  });
  const get = async (route) => {
    const response = await fetch(origin + route);
    assert.equal(response.status, 200);
    return response.json();
  };
  const client = (await get("/api/clients"))[0];
  assert.equal(client.id, "cli_demo_northwind");
  assert.equal((await get("/api/status")).engine, "offline");
  assert.equal((await fetch(origin + "/api/clients", { headers: { "X-Forwarded-For": "192.0.2.2" } })).status, 404);
  assert.equal((await post("/api/sessions", {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post("/webhooks/meetstream/status", {})).status, 401);

  const local = await post("/api/sessions", { clientId: client.id, source: "browser" });
  assert.equal(local.status, 200);
  const { id: session } = await local.json();
  const line = "The price is too expensive for our team right now.";
  await post(`/api/sessions/${session}/utterances`, { speaker: "Priya", role: "client", text: line });
  const localReport = await post(`/api/sessions/${session}/end`, {});
  assert.equal(localReport.status, 200);
  const saved = await localReport.json();
  assert.equal(saved.signals[0].quote, line);
  assert.equal(saved.suggestions.length, 1);
  assert.equal((await get(`/api/meetings/${session}`)).id, session);

  const clip = path.join(workspace, "fixture.mp4");
  const transcript = path.join(workspace, "fixture.json");
  await fs.writeFile(clip, "media range fixture");
  await fs.writeFile(transcript, JSON.stringify({ duration: 5, segments: [
    { start: 2, end: 4, speaker: "Priya", role: "client", text: line },
    { start: 0, end: 1, speaker: "Alex", role: "rep", text: "Tell me about your priorities." },
  ] }));
  const importer = spawn(process.execPath, ["scripts/import-replay.mjs", client.id, clip, transcript], { env, stdio: "ignore" });
  assert.equal((await once(importer, "close"))[0], 0);
  const detail = await get(`/api/clients/${client.id}`);
  assert.equal(detail.recording_available, true);
  const started = await post("/api/sessions", { clientId: client.id, source: "replay" });
  assert.equal(started.status, 200);
  const { id: replay } = await started.json();
  const media = await fetch(origin + `/api/sessions/${replay}/recording`, { headers: { Range: "bytes=0-4" } });
  assert.equal(media.status, 206);
  assert.equal(await media.text(), "media");
  const progress = (time) => post(`/api/sessions/${replay}/replay/progress`, { time });
  await progress(3);
  const foreign = new Socket(origin.replace("http:", "ws:") + `/ws?session=${replay}`, { origin: "https://example.invalid" });
  assert.match((await once(foreign, "error"))[0].message, /401/);
  const socket = new WebSocket(origin.replace("http:", "ws:") + `/ws?session=${replay}`);
  t.after(() => socket.close());
  const hello = await new Promise((resolve) => socket.addEventListener("message", (event) => resolve(JSON.parse(event.data)), { once: true }));
  assert.equal(hello.type, "hello");
  assert.equal(hello.data.transcript.length, 1);
  assert.equal(hello.data.suggestions.length, 0);
  await progress(4);
  await progress(1);
  await progress(5);
  const report = await post(`/api/sessions/${replay}/end`, {}).then((r) => r.json());
  assert.equal(report.transcript.length, 2);
  assert.equal(report.transcript[1].recording_time, 4);
  assert.equal(report.suggestions.length, 1);
  assert.equal(report.report_engine, "offline");
  assert.deepEqual((await get(`/api/clients/${client.id}`)).profile, detail.profile);
});
