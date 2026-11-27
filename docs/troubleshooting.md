# Troubleshooting

| Symptom | What to check |
| --- | --- |
| Bot does not join | Verify the meeting link and MeetStream settings. Admit the named bot or check the meeting’s guest policy. |
| Bot joins and no transcript arrives | Confirm someone is audible to other people in the meeting. Check the bot’s audio status and live transcript job in MeetStream, then verify that the callback origin still resolves to the correct listener. |
| No coaching cue | Turn on Client Lens on the live call. Cues are throttled and depend on actionable client speech. An approved product document can supply technical evidence for a relevant question. |
| No report from Client Lens only | This on-device mode produces transient cues. For a report, select Meeting bot before starting an authorized capture session. |
| Website index has few results | Check the page URL, robots restrictions, and whether the content is available in public HTML. Refresh after correcting the URL or connectivity. |
| MCP test fails | Verify the endpoint and token, then check that the tool advertises `readOnlyHint: true` and accepts the configured text query field. |
| Database change has no effect | Restart the app after saving. Environment values override settings. Existing data stays with the previous database. |
| Browser overlay is visible in shared screen | Share the meeting tab or a specific window. The optional Windows overlay requests OS capture protection. Verify the effect in your conferencing app. |

The [MeetStream diagnostics guide](https://docs.meetstream.ai/guides/help/debugging-bots) covers provider status, failure reasons, and recording artifacts. When reporting a problem, describe the symptom with a fictional reproduction and redact the meeting link, callback token, bot IDs, and transcripts.
