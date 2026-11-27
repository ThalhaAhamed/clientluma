# Contributing

Use the Node.js 22 release line. Run `npm ci`, then `npm run dev` for local iteration. See the [code of conduct](CODE_OF_CONDUCT.md) and use fictional data for examples and bug reports.

| Check | Command |
| --- | --- |
| Unit, integration and hosted authorization | `npm test` |
| Browser, responsive layouts and automated accessibility | `npx playwright install chromium`, then `npm run test:e2e` |
| PostgreSQL | Set `CUELENSA_TEST_POSTGRES_URL` to an isolated loopback database named `cuelensa_test_*`, then run `npm run test:postgres` |
| Windows desktop | `npm ci --prefix overlay`, then `npm run desktop:smoke` |
| Windows package | `npm run desktop:build` |
| Container | `docker compose config` and `docker build -t cuelensa:local .` |
| Hosted HTTPS | `npm run test:hosted -- cuelensa:local` starts isolated app and Caddy containers on loopback |

Describe the tested workflow, app version, operating system, and any checks that require a real account. When changing meeting capture, verify the workspace, cue overlay, and saved report. Never use production data in the test runners.
