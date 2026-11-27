import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dataDir, child, provider, origin, dispatch;

test.beforeAll(async () => {
  dataDir = await mkdtemp(join(tmpdir(), "cuelensa-browser-"));
  provider = createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/bots/create_bot") {
      dispatch = JSON.parse(raw);
      return res.end(JSON.stringify({ bot_id: "browser-fixture-bot" }));
    }
    if (req.url === "/bots/browser-fixture-bot/remove_bot") return res.end("{}");
    res.writeHead(404).end("{}");
  });
  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  child = spawn(process.execPath, ["server.js"], {
    stdio: ["ignore", "pipe", "inherit"],
    env: {
      PATH: process.env.PATH, SystemRoot: process.env.SystemRoot,
      PORT: "0", MIA_DATA_DIR: dataDir, MIA_PROVIDER: "offline", MIA_LISTEN_HOST: "127.0.0.1",
      PUBLIC_URL: "https://callback.example.test", MEETSTREAM_API_KEY: "fixture-only",
      MEETSTREAM_BASE_URL: `http://127.0.0.1:${provider.address().port}`,
      MIA_STITCH_MS: "25", MIA_ANALYZE_EVERY: "1",
    },
  });
  origin = await new Promise((resolve, reject) => {
    let output = "";
    child.stdout.on("data", part => {
      output += part;
      const match = output.match(/running at http:\/\/localhost:(\d+)/);
      if (match) resolve(`http://127.0.0.1:${match[1]}`);
    });
    child.once("error", reject);
    child.once("exit", code => reject(Error(`Preview exited with code ${code}.`)));
  });
});

test.afterAll(async () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    const closed = once(child, "close");
    child.kill();
    await closed;
  }
  if (provider?.listening) await new Promise(resolve => provider.close(resolve));
  if (dataDir) await rm(dataDir, { recursive: true, force: true });
});

test("all main routes fit desktop, tablet, and mobile and pass automated accessibility checks", async ({ page }) => {
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(origin);
  const nav = page.getByRole("navigation", { name: "Application" });
  for (const width of [1440, 768, 320]) {
    await page.setViewportSize({ width, height: 800 });
    for (const [link, view] of [["Workspace", "home"], ["Prepare", "prep"], ["Live call", "live"], ["Reports", "report"], ["Settings", "settings"]]) {
      const target = nav.getByRole("link", { name: link, exact: true });
      await target.click();
      await expect(target).toHaveAttribute("aria-current", "page");
      await expect(page.locator(`#view-${view}`)).toBeVisible();
      const widthDelta = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(widthDelta, `${link} at ${width}px`).toBeLessThanOrEqual(1);
      if (width === 1440) {
        const report = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
        expect.soft(report.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) })), link).toEqual([]);
      }
    }
  }
  expect(errors).toEqual([]);
});

test("profile, brief, document, toggle, compact overlay, report, and deletion work together", async ({ page, request }) => {
  await page.goto(origin + "/#view-prep");
  await page.getByRole("button", { name: "+ New", exact: true }).click();
  await page.getByRole("textbox", { name: "Contact name", exact: true }).fill("Fictional Contact");
  await page.getByRole("textbox", { name: "Company", exact: true }).fill("Browser Test Company");
  await page.getByRole("button", { name: "Save client", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Browser Test Company", exact: true })).toBeVisible();
  await page.getByRole("button", { name: /^(Generate|Regenerate) brief$/ }).click();
  await expect(page.getByText("What prompted you to look at this now?", { exact: true }).first()).toBeVisible();
  const [client] = await (await request.get(origin + "/api/clients")).json();
  await page.locator("#fileInput").setInputFiles({
    name: "Fictional security guide.txt", mimeType: "text/plain", buffer: Buffer.from("Our SSO integration uses SAML authentication."),
  });
  await page.getByRole("button", { name: "Approve source for Fictional security guide.txt" }).click();
  await expect(page.getByText("Approved source", { exact: true })).toBeVisible();
  await page.getByRole("textbox", { name: "Meeting link", exact: true }).fill("https://meet.google.com/abc-defg-hij");
  await page.getByRole("textbox", { name: "Your meeting name", exact: true }).fill("Demo Presenter");
  await page.getByRole("button", { name: "Send bot", exact: true }).click();
  const lens = page.getByRole("switch", { name: "Client Lens", exact: true });
  await expect(lens).not.toBeChecked();
  await lens.check();
  await expect(lens).toBeChecked();
  const overlayEvent = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open cue overlay" }).click();
  const overlay = await overlayEvent;
  await expect(overlay.getByRole("heading", { name: "Browser Test Company", exact: true })).toBeVisible();
  await overlay.setViewportSize({ width: 360, height: 420 });
  expect(dispatch.audio_required).toBe(true);
  const callback = new URL(dispatch.live_transcription_required.webhook_url);
  const webhook = await request.post(origin + callback.pathname + callback.search, {
    data: { bot_id: "browser-fixture-bot", speakerName: "Fictional Contact", utterance: "Does your SSO integration use SAML authentication?" },
  });
  expect(webhook.ok()).toBeTruthy();
  const sourceButton = overlay.getByRole("link", { name: "View source", exact: true });
  await expect(sourceButton).toBeVisible();
  await expect(overlay.locator("#sayText")).toBeHidden();
  const detailsEvent = overlay.waitForEvent("popup");
  await sourceButton.click();
  const details = await detailsEvent;
  await expect(details.getByRole("dialog")).toContainText("Our SSO integration uses SAML authentication.");
  await details.close();
  await page.getByRole("button", { name: "End call & build report" }).click();
  await expect(page.getByRole("button", { name: "Download report" })).toBeVisible();
  await expect(page.locator(".report-narrative")).toContainText("1-turn call with Browser Test Company");
  await expect(page.getByRole("heading", { name: "Technical sources", exact: true })).toBeVisible();
  const reportAxe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
  expect(reportAxe.violations.map(({ id, nodes }) => ({ id, targets: nodes.map(node => node.target) }))).toEqual([]);
  const reportId = new URL(page.url()).searchParams.get("session");
  expect(reportId).toBeTruthy();
  const downloaded = page.waitForEvent("download");
  await page.getByRole("button", { name: "Download report" }).click();
  expect((await downloaded).suggestedFilename()).toMatch(/\.md$/);
  const deletion = await request.delete(`${origin}/api/clients/${client.id}`);
  expect(deletion.ok()).toBeTruthy();
  expect((await request.get(`${origin}/api/meetings/${reportId}`)).status()).toBe(404);
});

test("settings preserve saved secrets and show database and MCP connection feedback", async ({ page, request }) => {
  await page.goto(origin + "/#view-settings");
  await page.getByRole("button", { name: "Test saved connection", exact: true }).click();
  await expect(page.locator("#docsStatus")).toContainText("Save the MCP endpoint");
  await page.getByLabel("SQLite filename", { exact: true }).fill("qa-workspace.sqlite");
  await page.getByLabel("Bearer token", { exact: true }).fill("fictional-browser-fixture");
  await page.getByRole("button", { name: "Save settings", exact: true }).click();
  await expect(page.locator("#settingsStatus")).toContainText("Restart Cuelensa");
  await expect(page.locator("#databaseStatus")).toContainText("qa-workspace.sqlite");
  await expect(page.getByLabel("Bearer token", { exact: true })).toHaveValue("");
  const settings = await (await request.get(origin + "/api/settings")).json();
  expect(settings.configured.MIA_DOCS_MCP_TOKEN).toBeTruthy();
  expect(JSON.stringify(settings)).not.toContain("fictional-browser-fixture");
});
