import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { WebSocket } from "ws";

test("hosted mode protects workspace access and imports its legacy database once", { timeout: 15000 }, async (t) => {
  const data = await fs.mkdtemp(path.join(os.tmpdir(), "clientluma-host-test-"));
  const processes = [];
  t.after(async () => {
    await Promise.all(processes.map((stop) => stop()));
    await fs.rm(data, { recursive: true, force: true });
  });
  const filename = path.join(data, "chosen.sqlite");
  await fs.mkdir(path.join(data, "clients"));
  await fs.mkdir(path.join(data, "meetings"));
  await fs.writeFile(path.join(data, "clients", "cli_legacy.json"), JSON.stringify({ id: "cli_legacy", name: "Fictional legacy client" }));
  await fs.writeFile(path.join(data, "meetings", "mtg_legacy.json"), JSON.stringify({ id: "mtg_legacy", client_id: "cli_legacy", source: "browser" }));
  const origin = "https://calls.example.test";
  const token = "example-only-proxy-token-0123456789012345";
  const webhookToken = "example-only-webhook-token";
  const env = {
    ...process.env, MIA_APP_ORIGIN: origin, MIA_PROXY_TOKEN: token, MIA_DATA_DIR: data,
    MIA_DATABASE_PROVIDER: "sqlite", MIA_DATABASE_PATH: filename, MIA_LISTEN_HOST: "127.0.0.1", PORT: "0",
    MIA_OFFLINE: "1", PUBLIC_URL: "", MIA_CALLBACK_PORT: "0", MIA_WEBHOOK_SECRET: webhookToken,
  };

  async function start() {
    const child = spawn(process.execPath, ["server.js"], { env, stdio: ["ignore", "pipe", "inherit"] });
    const closed = once(child, "close");
    const stop = async () => { child.kill(); await closed; };
    processes.push(stop);
    let output = "";
    const ports = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", () => reject(new Error("Server exited during startup.")));
      child.stdout.on("data", (chunk) => {
        output += chunk;
        const main = output.match(/running at http:\/\/localhost:(\d+)/);
        const callbacks = output.match(/callbacks only at http:\/\/127\.0\.0\.1:(\d+)/);
        if (main && callbacks) resolve({ main: main[1], callbacks: callbacks[1] });
      });
    });
    return { base: `http://127.0.0.1:${ports.main}`, callbacks: `http://127.0.0.1:${ports.callbacks}`, stop };
  }

  const headers = { Host: "calls.example.test", "X-ClientLuma-Proxy": token };
  const workspace = await start();
  const request = (base, route, headers, method = "GET", data) => new Promise((resolve, reject) => {
    const req = http.request(base + route, { headers, method, timeout: 5000 }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, json: () => JSON.parse(body) }));
      res.on("error", reject);
    });
    req.on("timeout", () => req.destroy(new Error("Request timed out")));
    req.on("error", reject);
    req.end(data);
  });
  const get = (route, headers) => request(workspace.base, route, headers);
  assert.equal((await get("/api/clients", { Host: headers.Host })).status, 404);
  assert.equal((await get("/api/clients", { ...headers, Origin: "https://other.example.test" })).status, 403);
  assert.equal((await get("/api/clients", { ...headers, Host: "untrusted.example.test" })).status, 404);
  assert.equal((await get("/api/clients", headers)).status, 200);
  const page = await get("/", headers);
  assert.match(page.headers["content-security-policy"], /script-src 'self'/);
  assert.equal(page.headers["x-powered-by"], undefined);
  assert.equal(page.headers["cache-control"], "no-store");
  const settings = await (await get("/api/settings", headers)).json();
  assert.deepEqual(settings.database, { engine: "SQLite", configuredPath: true });
  assert.equal((await (await get("/api/meetings/mtg_legacy", headers)).json()).client_id, "cli_legacy");
  const webhook = await request(workspace.base, "/webhooks/meetstream/status", { Host: headers.Host }, "POST");
  assert.equal(webhook.status, 401);
  const payloadHeaders = { "Content-Type": "application/json", Host: headers.Host };
  assert.equal((await request(workspace.base, "/webhooks/meetstream/status", payloadHeaders, "POST", "{")).status, 401);
  assert.equal((await request(workspace.base, `/webhooks/meetstream/status?token=${webhookToken}`, payloadHeaders, "POST", "{")).status, 400);
  const oversized = JSON.stringify({ message: "x".repeat(300_000) });
  assert.equal((await request(workspace.base, `/webhooks/meetstream/status?token=${webhookToken}`, payloadHeaders, "POST", oversized)).status, 413);
  for (const [route, method, status] of [
    ["/", "GET", 404],
    ["/api/clients", "GET", 404],
    ["/mia-tools/get_client_context", "POST", 404],
    ["/webhooks/meetstream/status", "POST", 401],
    ["/webhooks/meetstream/transcript", "POST", 401],
  ]) {
    assert.equal((await request(workspace.callbacks, route, headers, method)).status, status);
  }
  assert.equal((await request(workspace.callbacks, `/webhooks/meetstream/status?token=${webhookToken}`, headers, "POST")).status, 200);
  const callbackSocket = new WebSocket(workspace.callbacks.replace("http:", "ws:") + "/ws", { headers, origin });
  assert.match((await once(callbackSocket, "error"))[0].message, /401/);
  const socketUrl = workspace.base.replace("http:", "ws:") + "/ws?session=mtg_fixture";
  const untrusted = new WebSocket(socketUrl, { headers: { Host: headers.Host }, origin });
  assert.match((await once(untrusted, "error"))[0].message, /401/);
  const trusted = new WebSocket(socketUrl, { headers, origin });
  await Promise.all([once(trusted, "open"), once(trusted, "close")]);
  assert.equal((await request(workspace.base, "/api/clients/cli_legacy", headers, "DELETE")).status, 200);
  assert.equal((await get("/api/meetings/mtg_legacy", headers)).status, 404);
  await workspace.stop();
  const restarted = await start();
  assert.equal((await request(restarted.base, "/api/clients/cli_legacy", headers)).status, 404);
  assert.equal((await request(restarted.base, "/api/meetings/mtg_legacy", headers)).status, 404);
  await restarted.stop();
});
