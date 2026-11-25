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
    ...process.env, PORT: "0", MIA_LISTEN_HOST: "127.0.0.1", MIA_DATA_DIR: data, MIA_DESKTOP: "1",
    MIA_ANALYZE_EVERY: "1", MIA_WEBHOOK_SECRET: "test-secret",
  };
  for (const name of ["MIA_OFFLINE", "MIA_PROVIDER", "MEETSTREAM_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PUBLIC_URL"]) delete env[name];
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
  const configure = (body) => fetch(origin + "/api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await get("/api/settings")).ready, false);
  assert.equal((await configure({ PUBLIC_URL: "http://insecure.test" })).status, 400);
  const configured = await configure({ MIA_PROVIDER: "gemini", GEMINI_API_KEY: "placeholder-test-key", PUBLIC_URL: "https://tunnel.example.test" });
  assert.equal(configured.status, 200);
  const configuredJson = await configured.text();
  assert.equal(configuredJson.includes("placeholder-test-key"), false);
  assert.equal(JSON.parse(configuredJson).configured.GEMINI_API_KEY, true);
  assert.match((await get("/api/status")).engine, /^gemini/);
  assert.equal((await configure({ MIA_PROVIDER: "offline", clear: ["GEMINI_API_KEY"] })).status, 200);
  assert.equal((await get("/api/status")).engine, "offline");
  assert.equal((await fetch(origin + "/api/clients", { headers: { "X-Forwarded-For": "192.0.2.2" } })).status, 404);
  assert.equal((await post("/api/sessions", {}, { "Sec-Fetch-Site": "cross-site" })).status, 403);
  assert.equal((await post("/webhooks/meetstream/status", {})).status, 401);

  const local = await post("/api/sessions", { clientId: client.id, source: "browser" });
  assert.equal(local.status, 200);
  const { id: session } = await local.json();
  assert.equal((await configure({ MIA_PROVIDER: "auto" })).status, 409);
  const line = "The price is too expensive for our team right now.";
  await post(`/api/sessions/${session}/utterances`, { speaker: "Priya", role: "client", text: line });
  const localReport = await post(`/api/sessions/${session}/end`, {});
  assert.equal(localReport.status, 200);
  const saved = await localReport.json();
  assert.equal(saved.signals[0].quote, line);
  assert.equal(saved.suggestions.length, 1);
  assert.equal((await get(`/api/meetings/${session}`)).id, session);
  const review = () => post(`/api/meetings/${session}/follow-ups`, { index: 0, action: "Send details after legal review", owner: "both", due: "Friday" });
  const created = await review();
  assert.equal(created.status, 201);
  const commitment = await created.json();
  assert.equal(commitment.text, "Send details after legal review");
  assert.equal((await (await review()).json()).id, commitment.id);
  const workspaceState = await get("/api/workspace");
  assert.equal(workspaceState.recent[0].id, session);
  assert.equal(workspaceState.followUps[0].id, commitment.id);
  const setFollowUp = (status) => fetch(origin + `/api/clients/${client.id}/follow-ups/${commitment.id}`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ status }),
  });
  assert.equal((await (await setFollowUp("done")).json()).status, "done");
  assert.equal((await get("/api/workspace")).followUps.length, 0);
  assert.equal((await (await setFollowUp("open")).json()).status, "open");

  const clip = path.join(workspace, "fixture.mp4");
  const transcript = path.join(workspace, "fixture.json");
  await fs.writeFile(clip, "media range fixture");
  await fs.writeFile(transcript, JSON.stringify({ duration: 5, segments: [
    { start: 2, end: 4, speaker: "Priya", role: "client", text: line },
    { start: 0, end: 1, speaker: "Alex", role: "rep", text: "Tell me about your priorities." },
  ] }));
  const importer = spawn(process.execPath, ["scripts/import-replay.mjs", client.id, clip, transcript], { env, stdio: "ignore" });
  assert.equal((await once(importer, "close"))[0], 0);
  const replayInput = JSON.parse(await fs.readFile(transcript, "utf8"));
  assert.equal((await post(`/api/clients/${client.id}/replay`, { file: clip, transcript: {} })).status, 400);
  assert.equal((await (await post(`/api/clients/${client.id}/replay`, { file: clip, transcript: replayInput })).json()).segments, 2);
  const detail = await get(`/api/clients/${client.id}`);
  assert.equal(detail.recording_available, true);
  const started = await post("/api/sessions", { clientId: client.id, source: "replay" });
  assert.equal(started.status, 200);
  const { id: replay } = await started.json();
  assert.equal((await get(`/api/sessions/${replay}`)).status, "live");
  assert.ok((await get("/api/workspace")).active.some((item) => item.id === replay));
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
  assert.equal((await post(`/api/meetings/${replay}/follow-ups`, { index: 0 })).status, 400);
  assert.deepEqual((await get(`/api/clients/${client.id}`)).profile, detail.profile);
});
