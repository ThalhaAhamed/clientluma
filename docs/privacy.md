# Privacy and data handling

| Mode or feature | Where the data goes |
| --- | --- |
| Meeting bot | MeetStream processes the meeting media. Cuelensa stores transcript-backed reports and related client data in the configured database. |
| Meeting assistant | MeetStream handles the assistant’s audio and model pipeline. The assistant’s workspace tools are scoped to the client on that call. |
| Client Lens only | Shared tab audio is processed by the browser’s on-device recognition. This mode creates no server session, saved transcript, or report. |
| Optional cloud analysis | The configured Gemini or Claude provider receives the conversation and relevant client context used for analysis. |
| Website Intelligence | The server fetches public pages and stores excerpts on the selected client’s record. Cuelensa may send relevant excerpts to the selected cloud analysis provider. |
| Product docs MCP | The configured documentation service receives search queries from the meeting assistant. |

## Access and retention

Keep the app on loopback or behind the authenticated [HTTPS deployment](hosting.md). Expose only the token-protected callbacks and assistant tools your setup needs. Restrict access to the database, local settings, and backups.

Deleting a client removes its associated records from the active workspace database. Handle exported reports, backups, older database files, and MeetStream media separately. Refreshing website research updates the client’s active index and can invalidate its generated brief. Existing reports retain their original content.

Keep recordings, client profiles, private links, and credentials out of screenshots, issues, logs, and commits. Use the [security policy](../SECURITY.md) for private reporting.
