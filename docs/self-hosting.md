# Self-hosting

ClientLuma is designed for a single user and a single server process. The dashboard has no account system. Run it on loopback with Node or use the included Compose configuration, which publishes the dashboard port on loopback.

## Source installation

Run `npm ci` and `npm start` from the project root on Node.js 22.13 or newer. The default address is <http://localhost:4000>. Use `PORT` for a different port and `MIA_DATA_DIR` for a different storage directory.

## Docker

Run `docker compose up --build -d`. The named `clientluma-data` volume holds clients and reports. `docker compose logs -f` shows server output. Stop the service before copying the data directory or volume for a consistent backup. For a remote server, access the dashboard over an SSH port forward.

The desktop overlay runs on the computer where you want to see it. Run `npm ci --prefix overlay` and `npm run overlay` there. Set `MIA_SERVER_URL` if the locally forwarded server uses a different port.

## AI providers

Copy `.env.example` to `.env` and set `GEMINI_API_KEY` or `ANTHROPIC_API_KEY`. Set `MIA_PROVIDER` to select a provider when both are configured. Set the model overrides if your account uses different model identifiers. Restart the server after changing settings. Set `MIA_OFFLINE=1` to use local rules for text analysis.

## MeetStream integration

1. Set `MEETSTREAM_API_KEY` and create a strong `MIA_WEBHOOK_SECRET`.
2. Set `PUBLIC_URL` to the HTTPS address of a tunnel or reverse proxy that can reach the local server. For a short test with Cloudflare installed, `npm run tunnel` can create a quick tunnel. Its URL can change after restart.
3. Select a client, choose **MeetStream bot**, enter your meeting display name and link, and start the call. Admit the bot when the platform requests it.

The HTTP callback routes are `POST /webhooks/meetstream/transcript`, `POST /webhooks/meetstream/status`, and `POST /mia-tools/:name`. The two-agent Meet test also needs the authenticated WebSocket upgrade at `/meet-voice`. Restrict the public reverse proxy to these paths. Keep the dashboard and its WebSocket `/ws` on loopback.

Hosted voice modes consume the MeetStream configuration and keys in `.env.example`. If the MIA configuration uses your own model key, add that key in MeetStream Integrations. The two-agent Meet test uses installed Windows speech voices on Windows, or the Gemini speech API on other systems. The scripted demo and recording replay work without these services.

## Storage

The data directory contains client profiles and documents, session reports, replay manifests, and hosted agent configuration IDs. Keep it outside version control. A recording manifest references a media file by absolute path. If you move the file or restore onto another host, reimport the replay using its new path. In a container, that path must exist inside the container.
