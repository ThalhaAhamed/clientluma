# Self-hosting

Cuelensa is designed for a single user and a single server process. Use Node or the default Compose configuration for loopback access. For an internet-facing workspace protected by password sign-in, use the [HTTPS hosting guide](hosting.md).

## Source installation

Run `npm ci` and `npm start` from the project root on Node.js 22.13 or newer. The default address is <http://localhost:4000>. Use `PORT` for a different port and `MIA_DATA_DIR` for a different storage directory.

## Docker

Run `docker compose up --build -d`. The named `clientluma-data` volume holds clients and reports. `docker compose logs -f` shows server output. Stop the service before copying the data directory or volume for a consistent backup. For a remote server, access the dashboard over an SSH port forward.

For a Meeting bot call, turn on **Client Lens** in the live view to reveal the cue overlay link.

## AI providers

Copy `.env.example` to `.env` and set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`. Set `MIA_PROVIDER` to select a provider when both are configured. Set the model overrides if your account uses different model identifiers. Restart the server after changing settings. Set `MIA_OFFLINE=1` to use local rules for text analysis.

## MeetStream integration

1. Set `MEETSTREAM_API_KEY` and create a strong `MIA_WEBHOOK_SECRET`.
2. Set `PUBLIC_URL` to the HTTPS address of your tunnel or reverse proxy. For a local workspace, point the tunnel at the separate listener configured by `MIA_CALLBACK_PORT`.
3. Select a client and choose **Meeting bot** or **Meeting assistant**. Enter the meeting link and your display name, then admit the bot if the platform requests it.

For **Client Lens only**, open Cuelensa in desktop Chrome with on-device English speech recognition and share the meeting tab’s audio. The feature runs in the browser and produces live cues without creating a server session, saving a transcript, or generating a report. It does not use MeetStream.

Expose only the authenticated transcript and status callbacks and the bearer-token-protected `/mia-tools/:name` routes. Keep the dashboard and its WebSocket `/ws` private.

For local development with Cloudflare, set `MIA_CALLBACK_PORT=4043` in `.env`, start Cuelensa, then run `npm run tunnel` in another terminal. The script verifies the callback-only boundary before opening the tunnel. A quick tunnel’s URL can change, so restart the affected call after a tunnel restart.

Choose the assistant’s model in **Settings** or use the MeetStream model configuration in `.env.example`. Add your model key in MeetStream Integrations when using your own credentials. To enable product feature lookup, connect a trusted Streamable HTTP MCP search tool under **Product docs (MCP)**.

## Storage

Choose the provider in **Settings → Database**, save, and restart Cuelensa. Switching connects future workspace operations to the selected database. Existing records stay in the original database and reappear when you switch back.

- **SQLite** stores clients, documents, reports, and follow-ups in `data/workspace.sqlite` by default. Choose a different filename in Settings or use the host override `MIA_DATABASE_PATH`.
- **PostgreSQL** works with a standard database connection URL, including a [Supabase direct or session-pooler URL](https://supabase.com/docs/guides/database/connecting-to-postgres), a [Neon connection URL](https://neon.com/docs/connect/connect-from-any-app), or a self-hosted server. Create the database first and use a role that can create and write the `cuelensa` schema. **Test connection** checks connectivity without creating tables. The schema and tables are initialized when Cuelensa starts with this provider.

Set `MIA_DATABASE_PROVIDER=postgresql` and `MIA_DATABASE_URL` to manage the connection through the host environment. Remote PostgreSQL connections require verified TLS. Use `NODE_EXTRA_CA_CERTS` if your database requires a private CA. For a local PostgreSQL instance on the same machine, a loopback URL can use `sslmode=disable`. Keep local service settings and credentials outside version control.
