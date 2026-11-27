import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { docsMcpSettings } from "./settings.js";

async function useDocsTool(run) {
  const { url, tool, queryField, token } = docsMcpSettings();
  if (!url || !tool) throw new Error("Save the MCP endpoint and search tool in Settings first.");
  const signal = AbortSignal.timeout(10_000);
  const client = new Client({ name: "Cuelensa", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(url), {
    requestInit: { headers: token ? { Authorization: `Bearer ${token}` } : {}, redirect: "error" },
    fetch: (input, init) => fetch(input, { ...init, signal: init?.signal ? AbortSignal.any([signal, init.signal]) : signal }),
  });
  try {
    await client.connect(transport, { signal });
    const { tools } = await client.listTools({}, { signal });
    const definition = tools.find(item => item.name === tool);
    const field = definition?.inputSchema.properties?.[queryField];
    if (!definition || field?.type !== "string" ||
        definition.inputSchema.required?.some(name => name !== queryField) ||
        definition.annotations?.readOnlyHint !== true || definition.annotations?.destructiveHint === true) {
      return { error: "Choose a read-only search tool in the server’s first tool list with a text query and no other required inputs." };
    }
    return await run(client, tool, queryField, signal);
  } catch {
    return { error: "The docs MCP request failed. Check the saved endpoint, token and tool." };
  } finally {
    if (transport.sessionId) await transport.terminateSession().catch(() => {});
    await client.close().catch(() => {});
  }
}

export const testDocs = () => useDocsTool((_client, tool) => ({ tool }));

export async function searchDocs(query) {
  if (typeof query !== "string" || !query.trim() || query.length > 400) {
    return { error: "Provide a product feature query of 1–400 characters." };
  }
  return useDocsTool(async (client, tool, queryField, signal) => {
    const result = await client.callTool({ name: tool, arguments: { [queryField]: query.trim() } }, undefined, { signal });
    if (result.isError) return { error: "The product docs search returned an error." };
    const text = result.content?.filter(item => item.type === "text").map(item => item.text).join("\n");
    return { excerpts: (text || JSON.stringify(result.structuredContent ?? "")).slice(0, 6000) };
  });
}
