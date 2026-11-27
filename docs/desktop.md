# Cuelensa for Windows

Build a Windows ZIP with `npm run desktop:build` after installing the workspace and overlay dependencies. A manual CI run also produces a Windows build artifact. These builds are unsigned.

Extract the full ZIP to a folder, then open `Cuelensa.exe`. Cuelensa opens the workspace and starts its local service. The tray icon reopens the workspace after you close the window and lets you show the overlay or quit.

## Prepare and run your own call

1. Click **New** under **Clients**, save the client, and add notes or source documents. Generate a knowledge base to review likely questions and objectives.
2. In **Settings**, choose local rules or add a supported AI provider key. Use the client’s **Use local rules for this client** option to keep analysis of that client on-device.
3. In **Prepare**, choose **Meeting bot** or **Meeting assistant**. Turn on **Client Lens** from the live view of a Meeting bot call.
4. For live Meet, Teams or Zoom transcription, add a MeetStream key in Settings. Set up an HTTPS tunnel to the local endpoint shown in Settings and paste its public origin in **Public callback URL**. Paste the meeting link, enter the name you use in the call, and admit the bot when it arrives. [MeetStream live transcription](https://docs.meetstream.ai/guides/transcription-recordings/live-transcription)
5. The desktop overlay opens when Client Lens is enabled. Press **Ctrl+Shift+M** to show or hide it. Use **View source** to open a citation in the workspace. End the call to save its report, then review next steps and export Markdown if needed.

New desktop workspaces live in `%APPDATA%\Cuelensa\workspace` by default. Existing installations can continue using `%APPDATA%\ClientLuma\workspace`. API keys entered in Settings are stored in the workspace folder as local configuration. Live MeetStream transcription and cloud coaching use their respective providers when selected.
