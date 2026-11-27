import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { request } from "node:https";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocket } from "ws";

const fixture = () => randomBytes(16).toString("hex");
const name = "cuelensa-qa-" + fixture().slice(0, 10);
const network = name + "-network";
const app = name + "-app";
const proxy = name + "-proxy";
const password = fixture();
const webhook = fixture();
const proxyToken = fixture();
const credentials = "Basic " + Buffer.from(`fixture:${password}`).toString("base64");
const image = process.argv[2] || "cuelensa:ci";
const caddy = "caddy:2-alpine";
const dir = await mkdtemp(join(tmpdir(), "cuelensa-hosted-smoke-"));
const certPath = join(dir, "ca.crt");
const allocated = createServer();
await new Promise((ok, fail) => {
  allocated.once("error", fail);
  allocated.listen(0, "127.0.0.1", ok);
});
const { port } = allocated.address();
await new Promise(ok => allocated.close(ok));
const origin = `https://localhost:${port}`;
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const cleanup = (...args) => { try { docker(...args); } catch { /* Fixture may have already exited. */ } };

function probe(ca, path, { auth = false, method = "GET" } = {}) {
  return new Promise((ok, fail) => {
    const req = request({
      hostname: "127.0.0.1", servername: "localhost", port, ca, path, method,
      headers: { Host: `localhost:${port}`, ...(auth && { Authorization: credentials }) }, timeout: 4000,
    }, res => { res.resume(); ok(res.statusCode); });
    req.once("error", fail);
    req.once("timeout", () => req.destroy(Error("HTTPS fixture probe timed out.")));
    req.end();
  });
}

try {
  docker("network", "create", network);
  const hash = docker("run", "--rm", caddy, "caddy", "hash-password", "--plaintext", password);
  docker("run", "-d", "--rm", "--name", app, "--network", network, "--network-alias", "clientluma",
    "-e", `MIA_APP_ORIGIN=${origin}`, "-e", `MIA_PROXY_TOKEN=${proxyToken}`, "-e", `MIA_WEBHOOK_SECRET=${webhook}`, image);
  docker("run", "-d", "--rm", "--name", proxy, "--network", network, "-p", `127.0.0.1:${port}:${port}`,
    "--mount", `type=bind,source=${resolve("Caddyfile")},target=/etc/caddy/Caddyfile,readonly`,
    "-e", `MIA_PUBLIC_HOST=localhost:${port}`, "-e", "MIA_HOST_USER=fixture",
    "-e", `MIA_HOST_PASSWORD_HASH=${hash}`, "-e", `MIA_PROXY_TOKEN=${proxyToken}`, caddy);

  let ca;
  for (let attempt = 0; attempt < 25; attempt++) {
    try {
      docker("cp", `${proxy}:/data/caddy/pki/authorities/local/root.crt`, certPath);
      ca = await readFile(certPath);
      if (await probe(ca, "/api/settings", { auth: true }) === 200) break;
    } catch { /* Allow the app and certificate to initialize. */ }
    await delay(400);
  }
  assert.ok(ca, "Caddy did not produce a fixture CA.");
  assert.equal(await probe(ca, "/api/settings"), 401);
  assert.equal(await probe(ca, "/api/settings", { auth: true }), 200);
  assert.equal(await probe(ca, "/webhooks/meetstream/status", { method: "POST" }), 401);
  assert.equal(await probe(ca, `/webhooks/meetstream/status?token=${webhook}`, { method: "POST" }), 200);
  const socket = new WebSocket(`wss://127.0.0.1:${port}/ws?session=fixture`, {
    servername: "localhost", ca, origin, headers: { Host: `localhost:${port}`, Authorization: credentials },
    handshakeTimeout: 4000,
  });
  const closeCode = await new Promise((ok, fail) => {
    socket.once("error", fail);
    socket.once("close", ok);
  });
  assert.equal(closeCode, 4404, "Caddy did not reach the authenticated WebSocket service.");
  docker("exec", app, "node", "-e", "const f=require('node:fs');if(process.getuid()===0||['/app/.env','/app/.git','/app/data/settings.json','/app/test'].some(x=>f.existsSync(x)))process.exit(1)");
  console.log("Hosted HTTPS, workspace password, callback token, WebSocket, and container privacy verified.");
} finally {
  cleanup("stop", proxy, app);
  cleanup("network", "rm", network);
  await rm(dir, { recursive: true, force: true });
}
