const TOPICS = {
  overview: { name: "company positioning", question: "Has the company’s positioning changed since the website was last updated?" },
  products: { name: "products and services", question: "Which of your product or service lines should we focus on first?" },
  audience: { name: "customer segments", question: "Which customer segments are the highest priority for your team this quarter?" },
  case_studies: { name: "customer outcomes", question: "Which outcomes from your public customer stories best reflect what you want to achieve here?" },
  pricing: { name: "public pricing", question: "How does your public pricing or packaging affect the workflow we’re discussing?" },
  faqs: { name: "customer questions", question: "Which questions or objections do your customers bring up most often?" },
  competitors: { name: "competitive positioning", question: "Which alternatives matter most for the decision we’re discussing?" },
  integrations: { name: "integrations", question: "Which integrations on your website are relevant to the workflow we’re discussing?" },
};

const spokenTopics = {
  integrations: /\b(?:integrat\w+|crm|api|sync|mcp|model context protocol)\b/i,
  competitors: /\b(?:competit\w+|alternatives?|incumbent|vendors?|shortlist|compar(?:e|ing)|ga4)\b/i,
  pricing: /\b(?:pric\w+|budget|pricey|packaging|expensive|subscription|plans?|per month)\b/i,
  audience: /\b(?:customer segments?|industries|vertica(?:l|ls)|target markets?)\b/i,
  case_studies: /\b(?:case studies|case study|customer stories|customer outcomes)\b/i,
  faqs: /\b(?:faqs?|common questions|common objections)\b/i,
  products: /\b(?:products?|services?|solutions?|platforms?)\b/i,
  overview: /\b(?:positioning|company strategy|business model)\b/i,
};

export function websiteQuestions(client) {
  const sections = client.website_knowledge?.sections || {};
  const used = new Set();
  const questions = [];
  const add = (key, makeQuestion) => {
    if (questions.length === 3 || used.has(key)) return;
    for (const { text, url, title } of sections[key] || []) {
      if (!text || !/^https?:\/\//i.test(url) || /\b(?:ignore|disregard|override)\b.{0,40}\b(?:instructions?|prompt|system)\b/i.test(text)) continue;
      const question = makeQuestion(text);
      if (!question || questions.some(item => item.source.excerpt === text)) continue;
      questions.push({ topic: key, question, source: { url, title, excerpt: text } });
      used.add(key);
      break;
    }
  };

  add("competitors", text => {
    const alternative = text.match(/^[^:!?]{1,65}\b(?:vs\.?|versus)\s+([\p{L}\p{N}][\p{L}\p{N} .&-]{0,39})(?=\s*[:|–—]|$)/iu)?.[1]?.trim();
    return alternative && `Your website compares your offering with ${alternative}. Which trade-offs matter most to customers weighing the two?`;
  });
  add("integrations", text => /\bMCP server\b/i.test(text) && /\bassistant\b.{0,65}\b(?:stats|metrics|analytics)\b/i.test(text)
    ? "Your site says the MCP server lets an AI assistant request website stats. What questions do customers most often want it to answer?" : null);
  add("integrations", text => {
    const integration = text.match(/\b(?:[Ii]ntegrates?(?: directly)? with|[Cc]onnect(?:s|ed)? (?:to|with))\s+([A-Z][\w.-]*(?: (?:[A-Z][\w.-]*|\d+)){0,3})/)?.[1]?.replace(/\.$/, "");
    return integration && `Your website mentions connecting to ${integration}. What data or workflows do customers need that integration to handle?`;
  });
  add("pricing", text => {
    const price = text.match(/^([\$€£]\s*\d[\d.,]*)\s*(?:\/|per\s+)(month|year)\b/i);
    return price && `Your site lists ${price[1].replace(/\s/g, "")} per ${price[2].toLowerCase()}. What usage or support needs should we confirm when discussing that price with a customer?`;
  });

  for (const [key, topic] of Object.entries(TOPICS)) {
    add(key, text => {
      const sentence = text.match(/^.{30,135}?[.!](?=\s|$)/u)?.[0];
      if (!sentence || /^(?:learn|click|read more|sign up|try|contact|subscribe|visit|check out)\b|https?:\/\//i.test(sentence)) return null;
      return `Your site says “${sentence}” ${topic.question}`;
    });
  }
  return questions;
}

export function websiteDiscussionTopic(client, text) {
  const sections = client.website_knowledge?.sections;
  const match = sections && Object.keys(spokenTopics).find(key => sections[key]?.length && spokenTopics[key].test(text));
  return match ? { key: match, ...TOPICS[match] } : null;
}

export function websiteCallCue(client, utterances, recent = []) {
  const questions = websiteQuestions(client);
  for (const utterance of utterances) {
    if (utterance.role !== "client" || utterance.substantive === false) continue;
    const topic = websiteDiscussionTopic(client, utterance.text);
    const research = questions.find(item => item.topic === topic?.key);
    if (!research || recent.some(item => item.text === research.question)) continue;
    if (topic.key === "integrations" && /\bMCP server\b/i.test(research.source.excerpt) &&
      !/\b(?:mcp|model context protocol)\b/i.test(utterance.text)) continue;
    return { kind: "question", title: `Ask about ${topic.name}`, text: research.question,
      why: utterance.text, priority: "high", sources: [{ type: "website", name: research.source.title || "Client website",
        quote: research.source.excerpt, url: research.source.url }] };
  }
  return null;
}

export function websiteContext(client, perTopic = 2) {
  const sections = client.website_knowledge?.sections;
  if (!sections) return "";
  const data = Object.fromEntries(Object.entries(TOPICS).filter(([key]) => sections[key]?.length).map(([key]) => [
    key, sections[key].slice(0, perTopic).map(({ text, url }) => ({ text: text.slice(0, 300), url: url.slice(0, 400) })),
  ]));
  // Keep scraped text within a serialized data block, including any apparent closing tags.
  const json = JSON.stringify(data).replace(/[<>&]/g, char => "\\u" + char.charCodeAt(0).toString(16).padStart(4, "0"));
  return `<untrusted_public_website_evidence>\n${json}\n</untrusted_public_website_evidence>`;
}
