# Development

Use the Node.js 22 release line or a newer supported release. Install dependencies with `npm ci`, then start local iteration with `npm run dev`. The workspace defaults to <http://localhost:4000>. Use an isolated `MIA_DATA_DIR` for debugging and fictional profiles for screenshots or reproduction steps.

## Checks

| Area | Command |
| --- | --- |
| Unit and API integration | `npm test` |
| Browser and accessibility | `npx playwright install chromium`, then `npm run test:e2e` |
| PostgreSQL | Set `CUELENSA_TEST_POSTGRES_URL` to an isolated loopback database named `cuelensa_test_*`, then run `npm run test:postgres` |
| Container | `docker compose config --quiet` and `docker build -t cuelensa:local .` |
| Hosted HTTPS | `npm run test:hosted -- cuelensa:local` |

The hosted smoke test starts isolated app and Caddy containers on loopback. Browser and API tests create temporary workspaces and use provider fixtures. If PostgreSQL is absent, the default test run skips that integration.

For changes to capture, verify a real MeetStream call separately. Check that speech appears in the live transcript, that a relevant source can be opened from the cue, and that the report reflects the saved transcript. Use a consented test call and keep its identifiers and artifacts private.

## GitHub Actions

[CI](../.github/workflows/ci.yml) runs on pushes and pull requests. It checks Linux and Windows, covers PostgreSQL with a dedicated service, validates the Docker configurations, exercises hosted HTTPS, and scans dependencies, container packages, and Git history. See [Contributing](../CONTRIBUTING.md) before opening a pull request.
