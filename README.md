# ClientLuma

**Live coaching for client calls you host yourself.**

ClientLuma gives you a brief before the call, a compact overlay during it, and a report afterward. Try the fictional demo without an account or API key. Connect MeetStream for live meetings, or replay a recording with its timestamped transcript and see which cues would have appeared.

## Windows desktop app

Download the `clientluma-windows` artifact from the latest successful [CI run](https://github.com/ThalhaAhamed/clientluma/actions/workflows/ci.yml), extract the desktop ZIP, and open `ClientLuma.exe`. Choose **Try the demo** to watch the live overlay, open the completed report, and track a follow-up without any keys. Open **Settings** to connect an AI provider or MeetStream for your own calls. See the [desktop guide](docs/desktop.md) for setup and recording import.

To run and package the desktop app from source on Windows, install Node.js 22.13 or newer and run:

```sh
npm ci
npm ci --prefix overlay
npm run desktop
npm run desktop:build
```

The build writes the desktop ZIP under `dist/`.

## Browser and self-hosted quick start

Install Node.js 22.13 or newer, then run these commands from the project directory.

```sh
npm ci
npm start
```

1. Open [localhost:4000](http://localhost:4000) and select **Northwind Freight**, the fictional client.
2. Choose **Simulated call** and select **Start live analysis**.
3. Open **Overlay** to see the current suggestion, the last buyer quote, and the latest signal. The scripted call saves a report automatically.

For Docker Compose 2.24 or newer, run `docker compose up --build -d` and open the same address. See [self-hosting](docs/self-hosting.md) for persistence, configuration, and webhooks.

## What you can do

| Before | During | After |
| --- | --- | --- |
| Save client notes, stakeholders, PDFs, DOCX files, or text. Build a brief with questions, objections, and call goals. | Watch for pain points, objections, requirements, buying signals, questions, and risks. Mark individual coaching cues as used or dismissed. | Review evidence and next steps, export a Markdown report, and carry real-call findings forward into client memory. |

| Source | What you need |
| --- | --- |
| **Simulated call** | A built-in fictional transcript and local coaching rules. |
| **Recording replay** | A local MP4 or WebM and a timestamped transcript. The video clock controls when text reaches the local coaching engine. [Import a replay](docs/replay.md). |
| **Microphone** | A browser that supports Web Speech Recognition, such as Chrome or Edge. Choose your speaker role as you talk. You can also enter transcript lines manually. |
| **MeetStream bot** | Your MeetStream key and a public HTTPS callback URL. The silent bot streams transcript updates from Google Meet, Zoom, or Teams. |
| **Practice call with an AI client** | MeetStream and its hosted MIA configuration. You speak with a buyer persona while a silent bot transcribes. |
| **Two-agent test** | A configured Gemini or Claude provider. Two role prompts generate a local practice exchange. The **in Meet** mode also requires MeetStream and a public HTTPS callback URL. |
| **MIA agent** | MeetStream and its hosted MIA configuration. The voice agent answers questions from client context when addressed and can record commitments. |

## Desktop overlay

```sh
npm ci --prefix overlay
npm run overlay
```

The Electron window follows the newest active call. Use **Ctrl+Shift+M** to show or hide it and **Ctrl+Shift+L** to toggle click-through. Use **Command** instead of **Ctrl** on macOS. The tray menu also has these controls.

ClientLuma requests screen-capture protection through Electron. Capture behavior depends on the operating system and sharing tool. Verify it with your own setup. The browser overlay is visible when its tab or window is shared.

## Configuration and data

Configure integrations in **Settings**, or use the environment for a managed deployment. Values set in the environment take precedence. `.env.example` lists the available settings. See [self-hosting](docs/self-hosting.md) for server configuration.

Client and meeting files are stored under `data/` by default. Recording replay uses local rules and produces a standalone report. For other call sources, the **Use local rules for this client** option routes text analysis through local rules. Browser speech and MeetStream have their own processing paths. For the data flow by source, see [architecture](docs/architecture.md).

## Development

```sh
npm ci
npm test
npm run dev
```

The server uses Node.js, Express, and WebSockets. The dashboard is plain HTML, CSS, and JavaScript. The tests boot an isolated instance and check the offline call, report retention, replay timing, and local-access boundary. See [contributing](CONTRIBUTING.md) and [security](SECURITY.md).

## License

[MIT](LICENSE). [Meetpact](https://github.com/meetstream-ai/meetpact) informed the self-hosting and project documentation structure.
