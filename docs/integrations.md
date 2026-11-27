# Integrations

## MeetStream

1. Add your `MEETSTREAM_API_KEY` in **Settings** or in the server environment.
2. Choose a callback setup. On a hosted install, use the authenticated HTTPS deployment. On a local install, set `MIA_CALLBACK_PORT` and point a public HTTPS tunnel at that listener. Set `PUBLIC_URL` or use the automatic address from Cuelensa’s Cloudflare tunnel script. [HTTPS hosting](hosting.md) · [Local tunnel](self-hosting.md#meetstream-integration)
3. Choose **Meeting bot** or **Meeting assistant** in **Prepare**. Enter the meeting URL and your display name, then admit the bot if necessary.
4. For a listening bot, confirm speaking produces lines in **Live call**. Turn on **Client Lens** to open the compact cue overlay. End the session to save its report.

Meeting assistant model and key settings control the assistant’s spoken answers. Bring your own model key in MeetStream’s **Integrations** when that model requires one. The system analysis provider is configured independently.

## System analysis

Local rules support brief generation, cues, and reports without an AI key. Select Gemini or Claude under **System AI provider** if you want cloud analysis. The selected provider receives the relevant client context and transcript needed for the requested analysis. [Configuration](configuration.md#ai-and-documentation) · [Privacy](privacy.md)

## Product documentation MCP

1. In **Settings → Product docs (MCP)**, add a trusted Streamable HTTP endpoint.
2. Specify the search tool name and the field that accepts the query string. Add a scoped bearer token if the endpoint requires it.
3. Save and use **Test saved connection** to verify tool discovery. The tool must advertise `readOnlyHint: true`.

The meeting assistant can use the tool to look up product features. For sourced cues in a Meeting bot call, upload verified technical documents in **Prepare** and explicitly approve them as sources.

## Client Website Intelligence

Add a public URL under **Prepare → Client → Edit client**. The workspace shows crawl progress, extracted sections, and their source URLs. Generate a new brief after indexing. The crawler follows a bounded set of relevant public HTML pages, applies crawling restrictions, and treats the text it retrieves as untrusted evidence. If a refresh fails, the last successful index stays available.
