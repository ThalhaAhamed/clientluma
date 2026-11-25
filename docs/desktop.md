# ClientLuma for Windows

Extract the full ZIP to a folder, then open `ClientLuma.exe`. ClientLuma opens the workspace and starts its local service. The tray icon reopens the workspace after you close the window and lets you show the overlay or quit.

## Take the demo through to a report

1. Click **Try the demo**. A fictional buyer and rep have a scripted discovery call. No accounts or keys are needed.
2. Read the latest cue in the small overlay. **Used it** and **Dismiss** let you clear the cue.
3. Let the demo finish to see the report and the transcript evidence. Edit a suggested next step before choosing **Track follow-up**.
4. Return to **Workspace** to reopen the report or review your open follow-ups.

## Prepare and run your own call

1. Click **New** under **Clients**, save the client, and add notes or source documents. Generate a knowledge base to review likely questions and objectives.
2. In **Settings**, choose local rules or add a supported AI provider key. Use the client’s **Use local rules for this client** option to keep analysis of that client on-device.
3. Choose a source in **Prepare**. **Manual or microphone** accepts typed utterances in the desktop app. **Import recording replay** accepts a local MP4 or WebM and a timestamped JSON transcript. The adjacent video is played from its original location.
4. For live Meet, Teams or Zoom transcription, add a MeetStream key in Settings. Set up an HTTPS tunnel to the local endpoint shown in Settings and paste its public origin in **Public callback URL**. Choose **MeetStream bot**, paste the meeting link, enter the name you use in the call, and admit the bot when it arrives. The two-agent options also require an AI provider. [MeetStream live transcription](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription)
5. The desktop overlay opens as the call starts. Press **Ctrl+Shift+M** to show or hide it. End the call to save its report, then review next steps and export Markdown if needed.

The desktop workspace and saved service settings live under your Windows user profile in `%APPDATA%\ClientLuma\workspace` by default. API keys entered in Settings are stored in that folder as local configuration. Demo and replay analysis run locally. Live MeetStream transcription and cloud coaching use their respective providers when selected.

## Replay transcript format

Use seconds for all timestamps, and supply the speaker and role for each segment.

```json
{
  "duration": 30,
  "segments": [
    {
      "start": 2.5,
      "end": 7.0,
      "role": "client",
      "speaker": "Fictional buyer",
      "text": "We need approval from finance before the end of the quarter."
    }
  ]
}
```
