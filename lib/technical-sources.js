import { createHash } from "node:crypto";

export const sourceId = (doc) => doc.id || createHash("sha256")
  .update(JSON.stringify([doc.name, doc.added_at, doc.text])).digest("hex").slice(0, 24);

const ignored = new Set("about after before could does from have into just like need over should tell that their them then there these they this those want were what when where which while will with would your".split(" "));
const terms = (text) => new Set((text.toLowerCase().match(/[a-z0-9_-]{3,}/g) || [])
  .filter((word) => !ignored.has(word)));
const technical = /\b(api|saml|sso|oauth|soc\s*2|security|authentication|encrypted|encryption|webhooks?|integration|salesforce|hubspot|compliance|residency|retention|permissions|audit|deployment|latency|rate limits?)\b/i;
// Meeting transcripts can end a question with a period or leave off punctuation.
const question = /\?|(?:^|[.!?]\s+)(?:(?:also|so|and|just to clarify)[, ]+)*(?:can|could|would|do|does|is|are|will|how|what|where|which|when|who)\b|\b(can you|do you|does your|how does|whether)\b/i;

export function findTechnicalSource(client, utterances) {
  const docs = (client.documents || []).filter((doc) => doc.approved_technical === true);
  if (!docs.length) return null;
  for (const line of [...utterances].reverse()) {
    if (line.role !== "client" || !technical.test(line.text) || !question.test(line.text)) continue;
    const query = terms(line.text);
    let best = null;
    let score = 1;
    for (const doc of docs) {
      for (const sentence of doc.text.split(/(?<=[.!?])\s+|\n+/)) {
        const quote = sentence.trim();
        if (quote.length < 16 || quote.length > 500 || !technical.test(quote)) continue;
        const overlap = [...terms(quote)].filter((word) => query.has(word)).length;
        if (overlap <= score) continue;
        score = overlap;
        best = { id: sourceId(doc), name: doc.name, quote };
      }
    }
    if (best) return { question: line.text, sources: [best] };
  }
  return null;
}
