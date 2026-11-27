import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import ipaddr from "ipaddr.js";

export const BOT_NAME = "CuelensaBot";

export function websiteUrl(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 2048) throw new Error("Enter a valid public website URL.");
  const input = value.trim();
  const url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(input) ? input : "https://" + input);
  const hostname = url.hostname.replace(/\.$/, "");
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.port ||
      isIP(hostname.replace(/^\[|\]$/g, "")) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(hostname) ||
      /\.(?:localhost|local|internal|home|lan|test|invalid|onion|arpa)$/i.test(hostname)) {
    throw new Error("Use a public HTTP or HTTPS website hostname without credentials or a custom port.");
  }
  url.hostname = hostname;
  url.hash = "";
  url.search = "";
  return url;
}

const globalV6 = ipaddr.parseCIDR("2000::/3");
const reservedV6 = ["2001::/23", "3fff::/20"].map(cidr => ipaddr.parseCIDR(cidr));

function publicAddress(address) {
  if (!isIP(address)) return false;
  const ip = ipaddr.parse(address);
  if (ip.kind() === "ipv4") return ip.range() === "unicast" && address !== "168.63.129.16";
  return ip.range() === "unicast" && ip.match(globalV6) && !reservedV6.some(range => ip.match(range));
}

export async function resolvePublicHost(hostname, resolve = lookup) {
  const addresses = await resolve(hostname, { all: true });
  if (!addresses.length || addresses.some(({ address, family }) => isIP(address) !== family || !publicAddress(address))) {
    throw new Error("The website hostname must resolve only to public addresses.");
  }
  return addresses.find(({ family }) => family === 4) || addresses[0];
}

// Connect to the validated address without another DNS lookup. Node still uses the URL hostname for Host and TLS.
export const pinnedLookup = ({ address, family }) => (_hostname, options, callback) => {
  if (options.all) callback(null, [{ address, family }]);
  else callback(null, address, family);
};

export async function fetchWebsiteResource(url, { signal, robots = false } = {}) {
  const timeout = AbortSignal.timeout(7000);
  const deadline = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const address = await new Promise((resolve, reject) => {
    const abort = () => reject(deadline.reason);
    if (deadline.aborted) return abort();
    deadline.addEventListener("abort", abort, { once: true });
    resolvePublicHost(url.hostname).then(resolve, reject).finally(() => deadline.removeEventListener("abort", abort));
  });
  const request = url.protocol === "https:" ? https.request : http.request;
  const maxBytes = robots ? 512 * 1024 : 768 * 1024;
  return new Promise((resolve, reject) => {
    const req = request(url, {
      agent: false, lookup: pinnedLookup(address), signal: deadline,
      headers: { "User-Agent": BOT_NAME, Accept: robots ? "text/plain, */*;q=0.1" : "text/html, application/xhtml+xml", "Accept-Encoding": "identity" },
    }, async response => {
      const { statusCode: status, headers } = response;
      const type = headers["content-type"] || "";
      if (status !== 200 || (!robots && !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(type))) {
        response.destroy();
        return resolve({ status, headers, body: null });
      }
      try {
        if ((headers["content-encoding"] || "identity") !== "identity") throw new Error("The website sent an unsupported response encoding.");
        if (Number(headers["content-length"]) > maxBytes) throw new Error("The page exceeds the crawl size limit.");
        const chunks = [];
        let size = 0;
        for await (const chunk of response) {
          size += chunk.length;
          if (size > maxBytes) throw new Error("The page exceeds the crawl size limit.");
          chunks.push(chunk);
        }
        resolve({ status, headers, body: Buffer.concat(chunks).toString("utf8") });
      } catch (error) {
        response.destroy();
        reject(error);
      }
    });
    req.on("error", reject);
    req.end();
  });
}
