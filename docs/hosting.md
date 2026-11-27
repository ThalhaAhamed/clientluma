# Host the browser app

The app runs as one Node process for one workspace. Use normal Compose for localhost, or use `compose.hosted.yaml` to run the app behind a Caddy HTTPS proxy with password sign-in. Keep one app instance because active calls and their WebSocket connections are held in memory.

## Configure your server

1. Point a DNS hostname such as `calls.example.com` at the server and allow ports 80 and 443 for Caddy.
2. Copy `.env.example` to `.env` on the host. Set `MIA_PUBLIC_HOST` to the DNS hostname and `MIA_HOST_USER` to your login name.
3. Generate a bcrypt password hash with `docker run --rm -it caddy:2-alpine caddy hash-password`. Put the output in `MIA_HOST_PASSWORD_HASH` in single quotes to preserve the dollar signs in the hash.
4. Generate a separate 32-byte secret with `openssl rand -hex 32` and put it in `MIA_PROXY_TOKEN`. Caddy passes this token to the app after verifying the browser login.
5. Run `docker compose -f compose.hosted.yaml up --build -d` and open your HTTPS hostname. Set MeetStream and AI provider credentials in **Settings** or the host environment. Leave the callback URL blank to use the workspace's HTTPS origin.

Caddy publishes the HTTPS endpoint. The app container port is private. The workspace, report APIs and browser WebSocket pass through password sign-in. MeetStream's webhook and assistant-tool routes use their own callback tokens.

The app image runs as UID 1000 to maintain access to existing workspace volumes. Its runtime includes Node.js and production dependencies without a package manager or shell. Use `docker compose logs` for diagnostics. The bundled Caddy proxy serves HTTP/1.1 and HTTP/2 over TCP.

For a local workspace, set `MIA_CALLBACK_PORT` and point the HTTPS tunnel only at that port. This listener accepts authenticated MeetStream transcript and status callbacks and assistant tool requests. Set the tunnel origin in **Settings** and open the browser on the separate app port.

## Database

SQLite starts automatically. In Compose, `/app/data/workspace.sqlite` and other workspace files live in the `clientluma-data` volume. If you configure `MIA_DATABASE_PATH`, put it on a persistent disk. The default SQLite database imports legacy `clients/` and `meetings/` JSON files on first startup. To use PostgreSQL, see the [provider settings](self-hosting.md#storage).

For a consistent backup, stop the app and back up the entire volume, then restart the app. This preserves the database and service settings.
