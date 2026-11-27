// Keeps a Cloudflare quick tunnel to Cuelensa running and writes its public URL to .tunnel-url.
// The server reads that file whenever it sends a MeetStream bot, so no .env edit or restart is needed.
// Usage: npm run tunnel        (needs `cloudflared` on PATH; no Cloudflare account required)
//
// Quick-tunnel URLs change on every restart. A bot that is already in a meeting keeps posting to the old URL, so if
// the tunnel restarts mid-call, that call stops receiving transcript. For real use, put a fixed domain in PUBLIC_URL
// (a named Cloudflare tunnel or an ngrok reserved domain) and don't run this script.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PORT = Number(process.env.MIA_CALLBACK_PORT);
if (!Number.isInteger(PORT) || PORT < 1 || PORT > 65535) {
  throw new Error("Set MIA_CALLBACK_PORT to the callback-only listener port before starting the tunnel.");
}
const ORIGIN = `http://127.0.0.1:${PORT}`;
const probe = (route, method) => fetch(ORIGIN + route, { method, signal: AbortSignal.timeout(3000) });
const [root, callback] = await Promise.all([probe("/", "GET"), probe("/webhooks/meetstream/status", "POST")]);
if (root.status !== 404 || callback.status !== 401) {
  throw new Error("The listener did not reject workspace access and unauthenticated callbacks. Check MIA_CALLBACK_PORT.");
}
const FILE = path.resolve(".tunnel-url");
let child = null;
let stopping = false;

function clear() {
  try { fs.unlinkSync(FILE); } catch {}
}

function start() {
  clear();
  console.log(`[tunnel] starting cloudflared -> ${ORIGIN}`);
  child = spawn("cloudflared", ["tunnel", "--no-autoupdate", "--url", ORIGIN], { stdio: ["ignore", "pipe", "pipe"] });
  const onData = (buf) => {
    const text = buf.toString();
    const m = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
    if (m && !fs.existsSync(FILE)) {
      // Second line is our pid: the server ignores the file if this process is gone (e.g. killed without cleanup).
      fs.writeFileSync(FILE, `${m[0]}\n${process.pid}\n`);
      console.log(`[tunnel] public URL: ${m[0]}  (written to .tunnel-url)`);
    }
    if (/\bERR\b/.test(text) && !/Failed to refresh DNS/.test(text)) process.stdout.write(`[cloudflared] ${text}`);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  child.on("error", (e) => {
    console.error(`[tunnel] could not start cloudflared: ${e.message}. Install it or set PUBLIC_URL instead.`);
    process.exit(1);
  });
  child.on("exit", (code, signal) => {
    clear();
    if (stopping) return;
    console.warn(`[tunnel] cloudflared exited (${signal || code}); restarting in 3 s with a NEW url.`);
    console.warn("[tunnel] any bot already in a meeting keeps the old url - send a new bot for live calls.");
    setTimeout(start, 3000);
  });
}

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => { stopping = true; clear(); child?.kill(); process.exit(0); });
}
start();
