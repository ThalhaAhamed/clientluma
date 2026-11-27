import { setTimeout as delay } from "node:timers/promises";
import { parse } from "parse5";
import robotsParser from "robots-parser";
import { BOT_NAME, fetchWebsiteResource, websiteUrl } from "./website-fetch.js";

const CATEGORIES = {
  overview: /\b(?:about(?: us)?|company|mission|who we are|overview)\b/i,
  products: /\b(?:products?|services?|solutions?|platform|features|what we do)\b/i,
  pricing: /\b(?:pricing|plans and pricing|subscription plans|price per)\b|[$€£]\s*\d/i,
  audience: /\b(?:industries|who we serve|built for|designed for|use cases|ideal for|customer segments|sectors|our customers)\b/i,
  case_studies: /\b(?:case stud(?:y|ies)|customer stor(?:y|ies)|success stor(?:y|ies)|testimonials?|customer success)\b|\/customers(?:\/|$)/i,
  faqs: /\b(?:faqs?|frequently asked questions|common objections|common concerns)\b/i,
  competitors: /\b(?:competitors?|competitive comparison|alternatives? to|vs\.?\s|compare with)\b/i,
  integrations: /\b(?:integrations?|integrates? with|connects? (?:to|with))\b/i,
};

export const WEBSITE_PAGE_LIMIT = 8;
const OMIT_TAGS = new Set(["script", "style", "template", "noscript", "svg", "form", "iframe"]);
const HEADINGS = /^h[1-6]$/;
const EXCERPT_TAGS = new Set(["p", "li", "dt", "dd", "tr", "blockquote", "summary"]);
const normalize = text => text.replace(/\s+/g, " ").trim();
const categories = text => Object.keys(CATEGORIES).filter(key => CATEGORIES[key].test(text.replace(/[-_]/g, " ")));
const attr = (node, name) => node.attrs?.find(item => item.name === name)?.value;
const indexRule = /(?:^|[\s,])(?:noindex|none)(?=$|[\s,])/i;
const followRule = /(?:^|[\s,])(?:nofollow|none)(?=$|[\s,])/i;

function excluded(node) {
  return OMIT_TAGS.has(node.tagName) || attr(node, "hidden") !== undefined ||
    attr(node, "aria-hidden") === "true" ||
    /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\b/i.test(attr(node, "style") || "");
}

function readPage(html, url, headers) {
  const nodes = [{ node: parse(html), chrome: false }];
  const links = [];
  const excerpts = [];
  let title = "";
  let description = "";
  const sections = [];
  let headerAgent = "";
  const directives = String(headers["x-robots-tag"] || "").split(",").flatMap(part => {
    const scoped = part.match(/^\s*([\w-]+)\s*:\s*(.*)$/);
    if (scoped) headerAgent = scoped[1].toLowerCase();
    return !headerAgent || headerAgent === BOT_NAME.toLowerCase() ? [scoped?.[2] || part] : [];
  });
  const pageCategories = categories(url.pathname);
  const content = node => excluded(node) ? "" : node.value ?? (node.childNodes || []).map(content).join(node.tagName === "tr" ? " " : "");
  while (nodes.length) {
    const { node, chrome } = nodes.pop();
    if (excluded(node)) continue;
    const siteChrome = chrome || ["nav", "footer", "aside"].includes(node.tagName);
    if (node.tagName === "meta") {
      const name = attr(node, "name")?.toLowerCase();
      if (name === "description") description = normalize(attr(node, "content") || "");
      if (name === "robots" || name === BOT_NAME.toLowerCase()) directives.push(attr(node, "content") || "");
    }
    if (node.tagName === "title") title = normalize(content(node)).slice(0, 180);
    if (node.tagName === "a" && links.length < 300 && !followRule.test(attr(node, "rel") || "")) {
      const href = attr(node, "href");
      if (href) links.push({ href, label: normalize(content(node)).slice(0, 180) });
    }
    const heading = HEADINGS.test(node.tagName);
    if (!siteChrome && heading) {
      const level = Number(node.tagName[1]);
      sections.length = level;
      sections[level - 1] = categories(normalize(content(node)));
    }
    const leaf = node.tagName === "div" && node.childNodes?.every(child => !child.tagName || ["span", "a", "strong", "em", "b", "sup", "br"].includes(child.tagName));
    if (!siteChrome && (EXCERPT_TAGS.has(node.tagName) || heading || leaf) && excerpts.length < 100) {
      const text = normalize(content(node));
      const pricingAmount = /[$€£]\s*\d/.test(text);
      if ((text.length >= 24 || pricingAmount) && !/^(?:accept cookies|privacy policy|all rights reserved|cookie settings)\b/i.test(text)) {
        excerpts.push({ text: text.slice(0, 420), categories: [...new Set([...categories(text), ...sections.flat()])] });
      }
    }
    for (let i = (node.childNodes?.length || 0) - 1; i >= 0; i--) nodes.push({ node: node.childNodes[i], chrome: siteChrome });
  }
  const rules = directives.join(" ");
  return {
    title: title || url.hostname,
    excerpts: indexRule.test(rules) ? [] : excerpts,
    description: indexRule.test(rules) ? "" : description.slice(0, 420),
    links: followRule.test(rules) ? [] : links,
    pageCategories: [...new Set([...pageCategories, ...categories(title)])],
  };
}

function addPage(index, page, url, isHome) {
  const byCategory = new Map();
  for (const excerpt of page.excerpts) {
    for (const key of [...new Set([...excerpt.categories, ...page.pageCategories])]) {
      if (!byCategory.has(key)) byCategory.set(key, []);
      if (byCategory.get(key).length < 3) byCategory.get(key).push(excerpt.text);
    }
  }
  if ((isHome || page.pageCategories.includes("overview")) && (page.description || page.excerpts.length)) {
    byCategory.set("overview", [page.description, ...(byCategory.get("overview") || page.excerpts.slice(0, 2).map(item => item.text))].filter(Boolean));
  }
  for (const [key, texts] of byCategory) {
    const entries = index[key] ||= [];
    for (const text of texts) {
      if (entries.length >= 5) break;
      if (!entries.some(item => item.text.toLowerCase() === text.toLowerCase())) entries.push({ text, url: url.href, title: page.title });
    }
  }
}

class CrawlRestriction extends Error {}
const redirects = new Set([301, 302, 303, 307, 308]);
const scope = url => url.hostname.replace(/^www\./, "");

export async function crawlWebsite(start, { progress, signal, fetchResource = fetchWebsiteResource, pause = delay } = {}) {
  const home = websiteUrl(start);
  signal = signal ? AbortSignal.any([signal, AbortSignal.timeout(75_000)]) : AbortSignal.timeout(75_000);
  const rules = new Map();
  const requested = new Set();
  const pages = new Set();
  const indexed = {};
  const candidates = new Map([[home.href, { url: home, rank: 100, hints: [] }]]);
  const root = new URL("/", home);
  if (root.href !== home.href) candidates.set(root.href, { url: root, rank: 90, hints: [] });
  let nextRequest = 0;
  let lastRequest = 0;
  let requests = 0;
  let attempted = 0;
  let skipped = 0;
  let firstRestriction;

  async function fetchPage(initial, robots = false) {
    let url = initial;
    for (let hop = 0; hop <= 5; hop++) {
      signal.throwIfAborted();
      if (!robots) {
        const rulesUrl = new URL("/robots.txt", url);
        if (!rules.has(rulesUrl.href)) {
          const loadRules = async () => {
            const result = await fetchPage(rulesUrl, true);
            if ([404, 410].includes(result.status)) return robotsParser(rulesUrl.href, "");
            if (result.status !== 200 || result.body === null || /^\s*<(?:!doctype|html)/i.test(result.body)) {
              throw new CrawlRestriction("Could not verify this website’s robots.txt restrictions.");
            }
            return robotsParser(rulesUrl.href, result.body);
          };
          rules.set(rulesUrl.href, loadRules());
        }
        const policy = await rules.get(rulesUrl.href);
        if (policy.isAllowed(url.href, BOT_NAME) !== true) throw new CrawlRestriction("The website’s robots.txt blocks crawling this page.");
        const crawlDelay = policy.getCrawlDelay(BOT_NAME);
        if (crawlDelay > 12) throw new CrawlRestriction("The website requests a crawl delay beyond the indexing limit.");
        if (crawlDelay > 0) nextRequest = Math.max(nextRequest, lastRequest + crawlDelay * 1000);
        if (requested.has(url.href)) return { status: 0, body: null, url };
        requested.add(url.href);
      }
      if (++requests > 24) throw new CrawlRestriction("The website exceeded the crawl request limit.");
      const wait = nextRequest - Date.now();
      if (wait > 0) await pause(wait, undefined, { signal });
      lastRequest = Date.now();
      nextRequest = lastRequest + 1200;
      const result = await fetchResource(url, { signal, robots });
      if (!redirects.has(result.status)) return { ...result, url };
      let target;
      try { target = websiteUrl(new URL(result.headers.location, url).href); } catch {}
      if (!target || !result.headers.location || scope(target) !== scope(home) || (url.protocol === "https:" && target.protocol !== "https:")) {
        throw new CrawlRestriction("The website redirects outside the allowed site.");
      }
      url = target;
    }
    throw new CrawlRestriction("The website has too many redirects.");
  }
  const priority = candidate => candidate.rank + candidate.hints.filter(key => !indexed[key]).length * 4;
  while (attempted < WEBSITE_PAGE_LIMIT && candidates.size && !signal.aborted) {
    const { url, hints } = [...candidates.values()].sort((a, b) => priority(b) - priority(a))[0];
    candidates.delete(url.href);
    if (requested.has(url.href)) continue;
    attempted++;
    try {
      const result = await fetchPage(url);
      if (result.status === 429 || result.status === 503) {
        firstRestriction ||= "The website is limiting requests. Try refreshing later.";
        skipped++;
        break;
      }
      if (result.status !== 200 || result.body === null) {
        skipped++;
      } else {
        const page = readPage(result.body, result.url, result.headers);
        page.pageCategories = [...new Set([...page.pageCategories, ...hints])];
        addPage(indexed, page, result.url, result.url.pathname === "/" || attempted === 1);
        if (Object.values(indexed).some(entries => entries.some(entry => entry.url === result.url.href))) pages.add(result.url.href);
        for (const { href, label } of page.links) {
          try {
            const link = websiteUrl(new URL(href, result.url).href);
            if (link.origin !== result.url.origin || requested.has(link.href) || candidates.has(link.href) || candidates.size >= 150 ||
                /\.(?!html?$)[a-z\d]{2,7}$/i.test(link.pathname) || /\b(?:login|sign[- ]?in|logout|careers?|legal|privacy|terms|cart|checkout)\b/i.test(link.pathname)) continue;
            const linkHints = categories(link.pathname + " " + label);
            if (linkHints.length) candidates.set(link.href, { url: link, rank: linkHints.length, hints: linkHints });
          } catch { /* Ignore malformed or unsupported links. */ }
        }
      }
    } catch (error) {
      skipped++;
      if (error instanceof CrawlRestriction) firstRestriction ||= error.message;
    }
    await progress?.({ attempted, indexed: pages.size, skipped });
  }
  if (!pages.size) throw new Error(firstRestriction || (signal.aborted
    ? "The website crawl timed out. Try refreshing later."
    : "No public business information could be indexed. Check the URL or try a public About or Products page."));
  return { sections: indexed, attempted, indexed: pages.size, skipped,
    limited: Boolean(firstRestriction || signal.aborted), message: firstRestriction || (signal.aborted ? "The crawl timed out after indexing some pages." : "") };
}

export const websiteRevision = client => client?.website_knowledge?.revision || null;
