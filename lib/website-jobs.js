import { setTimeout as delay } from "node:timers/promises";
import { crawlWebsite, WEBSITE_PAGE_LIMIT } from "./website-index.js";

export function clearWebsiteKnowledge(client) {
  if (client.website_knowledge) invalidateBrief(client);
  delete client.website_knowledge;
  delete client.website_crawl;
}

function invalidateBrief(client) {
  delete client.kb;
  delete client.kb_engine;
  delete client.kb_at;
}

export function queueWebsiteCrawl(client, jobId) {
  client.website_crawl = { id: jobId, status: "queued", attempted: 0, indexed: 0, skipped: 0 };
}

export const websiteActive = client => ["queued", "crawling", "indexing"].includes(client.website_crawl?.status);
export const websiteState = client => ({
  website_url: client.website_url || "",
  crawl: client.website_crawl ? { ...client.website_crawl, page_limit: WEBSITE_PAGE_LIMIT } : null,
  knowledge: client.website_knowledge || null,
  kb: client.kb || null,
  kb_engine: client.kb_engine || null,
});

export function createWebsiteJobs(store, { crawl = crawlWebsite, betweenJobs = () => delay(1200) } = {}) {
  const pending = new Set();
  let current;
  let draining = false;

  async function drain() {
    draining = true;
    try {
      for (const id of pending) {
        pending.delete(id);
        const controller = new AbortController();
        current = { id, controller };
        const client = await store.updateClient(id, record => {
          if (!record?.website_url || !websiteActive(record)) return null;
          queueWebsiteCrawl(record, record.website_crawl.id);
          record.website_crawl.status = "crawling";
          return record;
        });
        if (!client || controller.signal.aborted) continue;
        const job = client.website_crawl.id;
        const edit = change => store.updateClient(id, record => {
          if (!record || record.website_url !== client.website_url || record.website_crawl?.id !== job || controller.signal.aborted) return null;
          change(record);
          return record;
        });
        try {
          const result = await crawl(client.website_url, {
            signal: controller.signal,
            progress: counts => edit(record => Object.assign(record.website_crawl, counts)),
          });
          const { sections, attempted, indexed, skipped, limited, message } = result;
          await edit(record => { record.website_crawl.status = "indexing"; });
          await edit(record => {
            invalidateBrief(record);
            record.website_knowledge = { revision: job, indexed_at: new Date().toISOString(), sections };
            record.website_crawl = { id: job, status: "ready", attempted, indexed, skipped, limited, message };
          });
        } catch (error) {
          await edit(record => {
            record.website_crawl.status = "failed";
            record.website_crawl.message = error.message;
          });
        }
        await betweenJobs();
      }
    } finally {
      current = null;
      draining = false;
    }
  }

  function cancel(id) {
    pending.delete(id);
    if (current?.id === id) current.controller.abort();
  }

  function enqueue(id) {
    cancel(id);
    pending.add(id);
    if (!draining) drain().catch(error => console.error("Website index worker failed:", error.message));
  }

  return { enqueue, cancel, async resume() {
    for (const client of await store.listClients()) {
      if (websiteActive(client) && client.id !== current?.id && !pending.has(client.id)) enqueue(client.id);
    }
  } };
}
