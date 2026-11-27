import assert from "node:assert/strict";
import { once } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import http from "node:http";
import path from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { WebSocket as Socket } from "ws";

test("meeting modes keep transcription and reports independent of Client Lens", { timeout: 20_000 }, async (t) => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "call-coach-test-"));
  const data = path.join(workspace, "data");
  const bots = [];
  const removed = [];
  const docsQueries = [];
  let agentConfig;
  const provider = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/docs-mcp") {
      if (request.headers.authorization !== "Bearer docs-token") return response.writeHead(401).end();
      if (request.method !== "POST") return response.writeHead(405).end();
      let result;
      if (body.method === "initialize") result = { protocolVersion: body.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "docs-fixture", version: "1" } };
      else if (body.method === "tools/list") result = { tools: [{
        name: "search_docs", annotations: { readOnlyHint: true },
        inputSchema: { type: "object", properties: { keywords: { type: "string" } }, required: ["keywords"] },
      }] };
      else if (body.method === "tools/call") {
        docsQueries.push(body.params);
        result = { content: [{ type: "text", text: "The Enterprise plan supports SAML SSO." }] };
      } else return response.writeHead(202).end();
      return response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result }));
    }
    if (request.url === "/mia") {
      agentConfig = body;
      return response.end(JSON.stringify({ agent_config_id: "assistant-config" }));
    }
    if (request.url === "/bots/create_bot") {
      if (body.agent_config_id && body.live_transcription_required) {
        response.statusCode = 400;
        return response.end(JSON.stringify({ message: "Use a separate transcript bot" }));
      }
      const id = "bot-" + (bots.length + 1);
      bots.push({ id, ...body });
      return response.end(JSON.stringify({ bot_id: id }));
    }
    const removal = request.url.match(/^\/bots\/([^/]+)\/remove_bot$/);
    if (removal) {
      removed.push(removal[1]);
      return response.end("{}");
    }
    response.statusCode = 404;
    response.end("{}");
  });
  await new Promise(resolve => provider.listen(0, "127.0.0.1", resolve));
  t.after(() => provider.close());
  const env = {
    ...process.env, PORT: "0", MIA_LISTEN_HOST: "127.0.0.1", MIA_DATA_DIR: data,
    MIA_ANALYZE_EVERY: "1", MIA_STITCH_MS: "20", MIA_WEBHOOK_SECRET: "test-secret", MIA_CALLBACK_PORT: "0",
    MEETSTREAM_BASE_URL: "http://127.0.0.1:" + provider.address().port,
  };
  for (const name of ["MIA_OFFLINE", "MIA_PROVIDER", "MEETSTREAM_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "PUBLIC_URL",
    "MIA_DATABASE_PROVIDER", "MIA_DATABASE_URL", "MIA_DATABASE_PATH", "MIA_DATABASE_NAME"]) delete env[name];
  const tunnelFile = path.join(workspace, ".tunnel-url");
  const tunnelOrigin = "https://quick-tunnel.example.test";
  await fs.writeFile(tunnelFile, tunnelOrigin);
  const server = spawn(process.execPath, [fileURLToPath(new URL("../server.js", import.meta.url))], {
    cwd: workspace, env, stdio: ["ignore", "pipe", "pipe"],
  });
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
  assert.deepEqual(await get("/api/clients"), []);
  const crossOrigin = await post("/api/clients", { name: "Fictional contact" }, { Origin: "http://127.0.0.1:9999", "Sec-Fetch-Site": "same-site" });
  assert.equal(crossOrigin.status, 403);
  const invalidProfile = await post("/api/clients", { name: { unexpected: true } });
  assert.equal(invalidProfile.status, 400);
  const invalidWebsite = await post("/api/clients", { name: "Website API test", website_url: "http://127.0.0.1" });
  assert.equal(invalidWebsite.status, 400);
  const websiteClient = await (await post("/api/clients", {
    name: "Website API test", website_url: "https://no-site.example/about?campaign=ignored",
  })).json();
  const websiteEndpoint = `/api/clients/${websiteClient.id}/website`;
  assert.equal(websiteClient.website_url, "https://no-site.example/about");
  assert.equal(websiteClient.website_crawl.status, "queued");
  const refreshWebsite = await post(websiteEndpoint, {});
  assert.equal(refreshWebsite.status, 202);
  assert.equal((await refreshWebsite.json()).website_url, websiteClient.website_url);
  const removeWebsite = await fetch(origin + websiteEndpoint, { method: "DELETE" });
  assert.equal(removeWebsite.status, 200);
  const websiteResult = await get(websiteEndpoint);
  assert.equal(websiteResult.website_url, "");
  assert.equal(websiteResult.crawl, null);
  assert.equal(websiteResult.knowledge, null);
  await fetch(origin + `/api/clients/${websiteClient.id}`, { method: "DELETE" });
  const client = await (await post("/api/clients", { name: "Jordan Lee", company: "Fictional company" })).json();
  assert.equal((await get("/api/status")).engine, "offline");
  assert.equal((await get("/api/status")).webhook, false);
  const configure = (body) => fetch(origin + "/api/settings", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  assert.equal((await get("/api/settings")).ready, false);
  assert.equal((await configure({ PUBLIC_URL: "http://insecure.test" })).status, 400);
  assert.equal((await configure({ MIA_DATABASE_NAME: "../escape.sqlite" })).status, 400);
  const database = await (await configure({ MIA_DATABASE_NAME: "team.sqlite" })).json();
  assert.deepEqual(database.databaseSelection, { active: "workspace.sqlite", next: "team.sqlite" });
  assert.equal(database.databaseRestartRequired, true);
  assert.equal((await configure({ MIA_DATABASE_PROVIDER: "postgresql" })).status, 400);
  assert.equal((await post("/api/settings/test-database", { url: "postgresql://tester:password@db.example.test/db?sslmode=disable" })).status, 400);
  const pgSettings = await configure({ MIA_DATABASE_PROVIDER: "postgresql", MIA_DATABASE_URL: "postgresql://tester:fixture-secret@db.example.test/db" });
  assert.equal(pgSettings.status, 200);
  const pgText = await pgSettings.text();
  assert.doesNotMatch(pgText, /fixture-secret/);
  assert.equal(JSON.parse(pgText).configured.MIA_DATABASE_URL, true);
  assert.equal(JSON.parse(pgText).database.engine, "SQLite");
  assert.equal((await configure({ MIA_DATABASE_PROVIDER: "sqlite", clear: ["MIA_DATABASE_URL"] })).status, 200);
  assert.equal((await get("/api/clients"))[0].id, client.id);
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

  const patch = (route, body) => fetch(origin + route, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const start = (source, lensEnabled = true) => post("/api/sessions", {
    clientId: client.id, source, lensEnabled, repName: "Alex", meetingLink: "https://meet.google.com/abc-defg-hij",
  });
  for (const source of ["demo", "replay", "browser", "practice", "agent_test", "agent_meet", "client-lens"]) {
    assert.equal((await start(source)).status, 400);
  }
  assert.equal((await start("meetstream")).status, 400); // key not configured
  assert.equal((await configure({ MEETSTREAM_API_KEY: "fixture-only" })).status, 200);
  assert.equal((await fetch(origin + "/api/revops")).status, 404);

  const document = await (await post("/api/clients/" + client.id + "/documents", {
    name: "Security guide.txt", text: "Our SSO integration uses SAML authentication.",
  })).json();
  const docRoute = "/api/clients/" + client.id + "/technical-sources/" + document.documents[0].id;
  assert.equal((await patch(docRoute, { approved: true })).status, 200);

  await fs.writeFile(tunnelFile, `${tunnelOrigin}\n${process.pid}\n`);
  const started = await start("meetstream", false);
  assert.equal(started.status, 200);
  const session = await started.json();
  assert.equal(session.lensEnabled, false);
  assert.equal(bots.length, 1);
  assert.equal(bots[0].agent_config_id, undefined);
  assert.equal(new URL(bots[0].live_transcription_required.webhook_url).origin, tunnelOrigin);
  await fs.unlink(tunnelFile);
  assert.equal((await configure({ MIA_PROVIDER: "auto" })).status, 409);
  const route = "/api/sessions/" + session.id;
  const socketUrl = origin.replace("http:", "ws:") + "/ws?session=" + session.id;
  const foreign = new Socket(socketUrl, { origin: "https://example.invalid" });
  assert.match((await once(foreign, "error"))[0].message, /401/);
  const socket = new Socket(socketUrl);
  t.after(() => socket.close());
  const event = (type) => new Promise(resolve => {
    const onMessage = (value) => {
      const message = JSON.parse(value);
      if (message.type !== type) return;
      socket.off("message", onMessage);
      resolve(message.data);
    };
    socket.on("message", onMessage);
  });
  assert.equal((await event("hello")).lensEnabled, false);
  const transcript = (bot, text) => post("/webhooks/meetstream/transcript?token=test-secret", {
    bot_id: bot, speaker: "Jordan Lee", utterance: text,
  });
  const captured = event("utterance");
  assert.equal((await transcript(bots[0].id, "The project is too expensive for our entire team.")).status, 200);
  assert.match((await captured).text, /too expensive/);
  assert.equal((await get(route)).lensEnabled, false);

  const enabled = event("lens");
  assert.equal((await patch(route + "/lens", { enabled: true })).status, 200);
  assert.equal(await enabled, true);
  const cue = event("suggestion");
  await transcript(bots[0].id, "Does your SSO integration use SAML authentication?");
  assert.equal((await cue).sources[0].quote, "Our SSO integration uses SAML authentication.");
  const disabled = event("lens");
  assert.equal((await patch(route + "/lens", { enabled: false })).status, 200);
  assert.equal(await disabled, false);
  const saved = await (await post(route + "/end", {})).json();
  assert.equal(saved.transcript.length, 2);
  assert.equal(saved.suggestions.length, 1);
  assert.equal((await get("/api/meetings/" + session.id)).id, session.id);
  const queued = await post("/api/meetings/" + session.id + "/follow-ups", {
    index: 0, action: "Send the security guide", owner: "us", due: "Friday",
  });
  assert.equal(queued.status, 201);
  assert.equal((await get("/api/workspace")).followUps[0].text, "Send the security guide");

  const docsConfig = await configure({
    MIA_AGENT_LLM_PROVIDER: "openai", MIA_AGENT_LLM_MODEL: "gpt-4o", MIA_AGENT_LLM_KEY_SOURCE: "user",
    MIA_DOCS_MCP_URL: env.MEETSTREAM_BASE_URL + "/docs-mcp", MIA_DOCS_MCP_TOOL: "search_docs",
    MIA_DOCS_MCP_QUERY_FIELD: "keywords", MIA_DOCS_MCP_TOKEN: "docs-token",
  });
  assert.equal(docsConfig.status, 200);
  assert.equal((await docsConfig.text()).includes("docs-token"), false);
  const docsTest = await post("/api/settings/test-docs", {});
  assert.equal(docsTest.status, 200);
  assert.deepEqual(await docsTest.json(), { tool: "search_docs" });
  assert.equal(docsQueries.length, 0);
  const assistantStart = await start("mia", true);
  assert.equal(assistantStart.status, 200);
  const assistant = await assistantStart.json();
  assert.equal(assistant.lensEnabled, false);
  assert.equal((await patch("/api/sessions/" + assistant.id + "/lens", { enabled: true })).status, 409);
  assert.equal(agentConfig.mode, "pipeline");
  assert.equal(agentConfig.model.provider, "openai");
  assert.equal(agentConfig.model.model, "gpt-4o");
  assert.ok(agentConfig.agent.custom_functions.some(tool => tool.name === "search_product_docs"));
  assert.equal(agentConfig.agent.speak_only_when_asked, true);
  assert.equal(agentConfig.wake_word.enabled, true);
  assert.equal(bots[1].agent_config_id, "assistant-config");
  assert.ok(bots[2].live_transcription_required.webhook_url);
  const ask = (bot) => post("/mia-tools/get_client_context", {}, { Authorization: "Bearer test-secret", "X-Bot-ID": bot });
  assert.equal((await ask(bots[1].id)).status, 200);
  assert.equal((await ask(bots[2].id)).status, 404);
  const askDocs = (bot) => post("/mia-tools/search_product_docs", { query: " SAML SSO " }, { Authorization: "Bearer test-secret", "X-Bot-ID": bot });
  assert.equal((await askDocs(bots[2].id)).status, 404);
  assert.deepEqual(await (await askDocs(bots[1].id)).json(), { data: { excerpts: "The Enterprise plan supports SAML SSO." } });
  assert.deepEqual(docsQueries, [{ name: "search_docs", arguments: { keywords: "SAML SSO" } }]);
  await transcript(bots[1].id, "This should not duplicate the separate transcript.");
  await transcript(bots[2].id, "Let's discuss the client requirements with our internal team.");
  const assistantReport = await (await post("/api/sessions/" + assistant.id + "/end", {})).json();
  assert.equal(assistantReport.transcript.length, 1);
  assert.deepEqual(new Set(removed), new Set(bots.map(bot => bot.id)));
});
