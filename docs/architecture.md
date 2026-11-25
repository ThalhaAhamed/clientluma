# Architecture

```text
Manual lines · fictional demo · replay clock · MeetStream webhooks
                               |
                      In-memory call session
                        /          |          \
           Local rules or AI    WebSocket     JSON report
                  |           dashboard and        |
            Coaching cue       overlay        Client memory
```

- `server.js` owns routes and event delivery. The browser dashboard and Electron overlay subscribe to the same call session.
- `lib/session.js` collects speaker-labelled utterances, batches live analysis, applies a cue cooldown, and writes completed reports.
- `lib/ai.js` selects local rules, Gemini, or Claude. The selected model receives the relevant context and transcript for model-backed calls. Replay always uses local rules.
- `lib/meetstream.js` handles meeting-capture bots and callback payloads. `lib/mia-agent.js` handles hosted voice personas and tools. `lib/meet-voice.js` speaks generated practice dialogue through MeetStream’s control socket.
- `lib/replay.js` releases local transcript segments at the video position reported by the player.
- `lib/store.js` persists JSON documents and reports. Live session state is in memory, so a server restart interrupts any active session.

## Data flow

The fictional demo and replay can run without credentials when local rules are enabled. Browser speech recognition may send audio to the browser vendor. MeetStream receives live meeting media when you deploy a bot and can retain recording artifacts according to your MeetStream settings. If Gemini or Claude is enabled for analysis, that provider receives the client context and transcript needed for the task. Hosted voice integrations and the in-Meet agent test have their own provider paths.
