# Configuration

Cuelensa reads `.env` on startup. Environment values take precedence over values saved in **Settings**. Copy [`.env.example`](../.env.example) when configuring a deployment. For an ordinary local install, defaults are enough to open the workspace and use local analysis.

## Workspace and callbacks

| Variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `4000` | Browser app port |
| `MIA_LISTEN_HOST` | `127.0.0.1` | Workspace bind address. Keep loopback for a local install. |
| `MIA_CALLBACK_PORT` | Unset | Separate loopback listener for MeetStream callbacks and authenticated assistant tools |
| `PUBLIC_URL` | Unset locally | Public HTTPS callback origin. The hosted stack uses the workspace origin by default. |
| `MIA_WEBHOOK_SECRET` | Random per start | Callback and assistant-tool authentication. Set a stable random secret for a managed deployment. |
| `MIA_PUBLIC_HOST`, `MIA_HOST_USER`, `MIA_HOST_PASSWORD_HASH`, `MIA_PROXY_TOKEN` | Required for hosted Compose | HTTPS hostname, sign-in credentials, and Caddy-to-app authentication |

See the [HTTPS hosting guide](hosting.md) to configure the hosted stack or the [MeetStream integration](integrations.md#meetstream) for a callback-only tunnel.

## AI and documentation

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIA_PROVIDER` | `auto` | Use Gemini, Claude, or local coaching rules |
| `GEMINI_API_KEY`, `ANTHROPIC_API_KEY` | Unset | Enable the corresponding cloud analysis provider |
| `MIA_AGENT_LLM_PROVIDER`, `MIA_AGENT_LLM_MODEL`, `MIA_AGENT_LLM_KEY_SOURCE` | Google, Gemini 2.5 Flash, user key | Control the separate MeetStream meeting assistant |
| `MIA_DOCS_MCP_URL`, `MIA_DOCS_MCP_TOOL` | Unset | Select a trusted documentation search endpoint and tool |
| `MIA_DOCS_MCP_QUERY_FIELD` | `query` | Tool field that accepts the search text |
| `MIA_DOCS_MCP_TOKEN` | Unset | Optional bearer token for documentation search |

Use the cloud provider of your choice or set `MIA_PROVIDER=offline` for local rules. Each provider's model overrides appear in [`.env.example`](../.env.example). See [Integrations](integrations.md) for setup and [Privacy](privacy.md) for provider data boundaries.

## Storage

| Variable | Default | Purpose |
| --- | --- | --- |
| `MIA_DATA_DIR` | `./data` | Local workspace data and settings directory |
| `MIA_DATABASE_PROVIDER` | `sqlite` | Choose `sqlite` or `postgresql` |
| `MIA_DATABASE_NAME` | `workspace.sqlite` | SQLite filename under the data directory |
| `MIA_DATABASE_PATH` | Derived from directory and filename | Host override for the SQLite path |
| `MIA_DATABASE_URL` | Unset | PostgreSQL connection URL |

Use **Settings → Database** to test a PostgreSQL connection. Save and restart to switch databases. Existing records stay in the original database. [Storage setup](self-hosting.md#storage)
