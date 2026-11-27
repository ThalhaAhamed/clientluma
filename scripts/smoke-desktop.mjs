import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const data = await mkdtemp(path.join(os.tmpdir(), "clientluma-desktop-test-"));
const listener = createServer();
await new Promise((resolve) => listener.listen(0, "127.0.0.1", resolve));
const port = listener.address().port;
await new Promise((resolve) => listener.close(resolve));
const file = process.argv[2] || createRequire(new URL("../overlay/package.json", import.meta.url))("electron");
const args = process.argv[2] ? [] : [path.resolve("overlay"), "--desktop"];
const env = { ...process.env, MIA_DESKTOP_DATA_DIR: data, MIA_DESKTOP_PORT: "0", MIA_ANALYZE_EVERY: "1" };
for (const name of ["MIA_PROVIDER", "MIA_OFFLINE", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "MEETSTREAM_API_KEY", "PUBLIC_URL"]) delete env[name];
const child = spawn(path.resolve(file), [...args, "--disable-gpu", `--remote-debugging-port=${port}`, `--user-data-dir=${path.join(data, "profile")}`], { env, stdio: "inherit" });
const sockets = [];
const base = `http://127.0.0.1:${port}`;

async function until(probe, description, milliseconds = 30000) {
  const end = Date.now() + milliseconds;
  while (Date.now() < end) {
    if (child.exitCode !== null) throw new Error(`Desktop app exited early (${child.exitCode}).`);
    const result = await probe();
    if (result) return result;
    await delay(200);
  }
  throw new Error(`Timed out waiting for ${description}.`);
}

async function page(pathname) {
  let targets = [];
  const target = await until(async () => {
    const response = await fetch(`${base}/json/list`).catch(() => null);
    if (!response?.ok) return null;
    targets = (await response.json()).filter(entry => entry.type === "page");
    return targets.find(entry => new URL(entry.url).pathname === pathname);
  }, `desktop window at ${pathname}`).catch(error => {
    const paths = targets.map(entry => new URL(entry.url).pathname).join(", ");
    throw new Error(`${error.message} Browser paths: ${paths || "none"}`);
  });
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  sockets.push(socket);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });
  let id = 0;
  return (expression) => new Promise((resolve, reject) => {
    const request = ++id;
    const receive = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== request) return;
      socket.removeEventListener("message", receive);
      if (message.error || message.result.exceptionDetails) return reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
      resolve(message.result.result.value);
    };
    socket.addEventListener("message", receive);
    socket.send(JSON.stringify({ id: request, method: "Runtime.evaluate", params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

try {
  const workspace = await page("/");
  await until(() => workspace("Boolean(window.clientLuma && document.querySelector('#welcome')?.offsetWidth)"), "first-run setup");
  const overlay = await page("/overlay/");
  await workspace("document.querySelector('#prepareCall').click()");
  assert.deepEqual(await workspace("Array.from(document.querySelectorAll('input[name=source]'), field => field.value)"), ["meetstream", "client-lens", "mia"]);
  assert.equal(await workspace("document.querySelector('#liveLens').checked"), false);
  await until(() => overlay("document.title === 'Client Lens' && Boolean(window.miaOverlay)"), "desktop overlay bridge");
  const firstRun = await workspace("fetch('/api/settings').then(r => r.json())");
  assert.equal(firstRun.ready, false);
  assert.equal(firstRun.desktop, true);
  assert.match(firstRun.callbackTarget, /^http:\/\/127\.0\.0\.1:\d+$/);
  const health = new URL(await workspace("location.origin"));
  assert.notEqual(new URL(firstRun.callbackTarget).port, health.port);
  assert.equal((await fetch(firstRun.callbackTarget)).status, 404);
  assert.equal((await fetch(firstRun.callbackTarget + "/webhooks/meetstream/status", { method: "POST" })).status, 401);
  console.log("Desktop setup, meeting modes, and Client Lens passed.");
} finally {
  for (const socket of sockets) socket.close();
  child.kill();
}
