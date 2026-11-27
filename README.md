# <img src="public/cuelensa-mark.svg" width="32" height="32" alt="" /> Cuelensa

**Meeting transcripts and optional live coaching for client work.**

Invite a silent transcript bot or a meeting assistant that answers questions about the selected client. Use Client Lens for live coaching and review the saved report after the meeting.

[Quick start](#browser-quick-start) · [Meeting modes](#meeting-modes) · [Architecture](docs/architecture.md) · [HTTPS hosting](docs/hosting.md) · [Troubleshooting](docs/troubleshooting.md) · [Contributing](CONTRIBUTING.md)

## Browser quick start

Install Node.js 22.13 or newer, then run these commands from the project directory.

```sh
npm ci
npm start
```

1. Open [localhost:4000](http://localhost:4000), add a client, and open **Settings**.
2. Add your MeetStream key and public HTTPS callback URL.
3. In **Prepare**, choose **Meeting bot**, **Client Lens only**, or **Meeting assistant**. Enter the meeting link for the bot or assistant. For Client Lens only, open the meeting in another browser tab and share its tab audio.
4. Send the bot and admit it if the meeting requires admission. Review the transcript during the call and open the saved report afterward.

For Docker Compose 2.24 or newer, run `docker compose up --build -d` and open the same address. Follow the [HTTPS hosting guide](docs/hosting.md) for a single-user, password-protected deployment with MeetStream callbacks.

Run Cuelensa in a browser using the local or hosted setup below. The [source repository](https://github.com/ThalhaAhamed/clientluma) retains its original GitHub name, ClientLuma.

## Meeting modes

- **Meeting bot** joins silently to capture the transcript.
- **Meeting assistant** stays quiet until addressed by its wake phrase, usually **Hey MIA**. Ask about the selected client or ask it to log a follow-up. It uses its own live transcription when available and a separate silent transcript bot otherwise.
- **Client Lens only** uses on-device English speech recognition in supported desktop browsers. It shows live cues in Cuelensa without joining the meeting or saving audio, a transcript, or a report. The first run may need an English speech pack. On a separate Meeting bot call, the **Client Lens** switch enables coaching and the cue overlay opens from the live view.

In **Prepare**, approve verified technical documents for the client. A relevant technical question can then show a compact **View source** cue. The approved excerpt opens in the workspace.

Reports contain transcript-backed observations and proposed next steps. You can track a next step explicitly and export the report as Markdown. Deleting a client removes its reports and transcripts from the active Cuelensa database. Manage MeetStream’s separate recording retention in your MeetStream workspace. [Security and data handling](SECURITY.md)

## Client Website Intelligence

In **Prepare → Client → Edit client**, enter a public website and save the profile. Open **Website intelligence** to follow progress, review excerpts with their source URLs, refresh the index, or remove the website and its research. Generate a new brief after the index is ready. Website research also helps tailor live coaching questions and post-call recommendations. Call evidence still comes from the transcript.

Each client’s excerpts stay in that client’s database record. A successful refresh or removal clears the generated client brief so it can be rebuilt with current research. If a refresh fails, the previous index stays available. Saved meeting reports retain their original content. Cloud AI providers can receive relevant excerpts when selected. The crawler and its index work with local rules and require no AI API key.

CuelensaBot indexes up to eight relevant public HTML pages linked from the site. It checks robots.txt and page indexing directives, spaces out requests, and validates public DNS addresses and redirect destinations. Sites that require sign-in, render content only in JavaScript, or keep pricing private may yield limited results. The server needs outbound HTTP and HTTPS access to index websites.

## Configuration and data

Configure integrations in **Settings**, or use the environment for a managed deployment. Values set in the environment take precedence. `.env.example` lists the available settings. See [self-hosting](docs/self-hosting.md) for server configuration.

Choose the **System AI provider** for prep, coaching and reports. Configure **Meeting assistant model** separately for MIA’s spoken answers. Under **Product docs (MCP)**, save a trusted Streamable HTTP endpoint, its read-only search tool name and query field, and a bearer token if required. **Test saved connection** checks tool discovery. MIA uses that tool for product feature questions.

SQLite at `data/workspace.sqlite` is the default. In **Settings → Database**, choose a different SQLite file or PostgreSQL. For self-hosted PostgreSQL, Supabase, or Neon, paste the database connection URL and choose **Test connection**. Save and restart Cuelensa to open the selected database and create its tables. Existing records stay in their original database. See [self-hosting](docs/self-hosting.md) for environment settings and database permissions.

## Development

```sh
npm ci
npm test
npx playwright install chromium
npm run test:e2e
npm run dev
```

The server uses Node.js, Express, and WebSockets. The dashboard is plain HTML, CSS, and JavaScript. Tests run with isolated data and exercise the browser, capture callbacks, citation UI, report export, data deletion, local audio behavior, and access boundaries. See [contributing](CONTRIBUTING.md) for PostgreSQL and Windows checks.

## License

[MIT](LICENSE). [Meetpact](https://github.com/meetstream-ai/meetpact) informed the self-hosting and project documentation structure.
