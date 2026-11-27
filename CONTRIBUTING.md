# Contributing to Cuelensa

## Before you start

Read the [Code of Conduct](CODE_OF_CONDUCT.md). For a bug report, identify the affected route or workflow, include reproduction steps with fictional data, and omit meeting links and identifiers. Report security issues privately using the [security policy](SECURITY.md).

## Set up

Use the Node.js 22 release line. Run `npm ci`, then `npm run dev` for local iteration. See [Development](docs/development.md) for the full test matrix.

| Check | Command |
| --- | --- |
| Unit, integration and hosted authorization | `npm test` |
| Browser, responsive layouts and automated accessibility | `npx playwright install chromium`, then `npm run test:e2e` |

## Open a pull request

Describe the changed workflow and the verification you ran. List any checks that require a real account or environment. For capture changes, verify the live transcript, cue overlay, and saved report in a consented test meeting. Review the files in your diff before pushing.
