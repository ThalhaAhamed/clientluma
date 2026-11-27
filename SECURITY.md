# Security

Use [GitHub private vulnerability reporting](https://github.com/ThalhaAhamed/clientluma/security/advisories/new) when available. If private reporting is disabled, ask the maintainer for a private channel before sharing details. Include the version, affected configuration, expected impact, and a redacted reproduction. Omit live credentials, callback URLs, bot IDs, client records, and recordings.

## Deployment boundary

Cuelensa is a single-user workspace. Run the dashboard on loopback or behind the documented authenticated HTTPS proxy. Keep the app port private and expose only the callback routes your MeetStream modes require. Use independent random values for the webhook and proxy secrets. Keep reverse-proxy and tunnel logs free of request queries and credentials.

Settings entered in the app are stored locally as configuration. Use an operating-system protected workspace directory or environment-based secrets. Limit access to your database and backups. Postgres connections outside loopback require verified TLS. Use a trusted MCP endpoint and a credential scoped to documentation search.

## Data lifecycle

- A meeting bot sends media to MeetStream. An enabled cloud AI provider receives the selected client context and transcript used for analysis.
- Client Lens only works in the browser with on-device recognition and does not create a saved call.
- Deleting a client removes its profiles, documents, website index, follow-ups, transcripts, and reports from the active application database. Backups, exported files, replaced databases, and MeetStream recordings have separate retention. SQLite and PostgreSQL also manage physical storage reclamation independently.
- Keep production data and configuration out of development, issue reports, pull requests, build contexts, and release archives.

If a credential was exposed, revoke or rotate it and review its use. Removing a value from the current branch leaves older copies in Git history and external clones.

## Container scan notes

The November 2026 review found no fixable high or critical vulnerabilities in the slim application image. The scanner still reports two OpenSSL QUIC advisories against its Debian package. This deployment serves plain HTTP inside the proxy network and does not enable QUIC in Node. [CVE-2026-107494](https://security-tracker.debian.org/tracker/CVE-2026-107494) · [CVE-2026-124709](https://security-tracker.debian.org/tracker/CVE-2026-124709)

The stock Caddy image also reports advisory entries for a JWK parser and the Go HTML parser. The bundled proxy uses Basic authentication and forwards traffic without enabling JWK authentication or processing HTML. Reassess these findings when changing proxy modules and update to patched upstream images as they become available. [Go JOSE advisory](https://github.com/advisories/GHSA-mgcc-cww5-fp2q) · [Go HTML advisory](https://pkg.go.dev/vuln/GO-2026-6860)
