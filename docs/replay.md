# Replay a recording

Replay runs local coaching rules as a video plays at its original pace. Pausing the video pauses transcript delivery. Each line becomes available at its end timestamp. The replay report is saved separately from client memory.

1. Save a client in the dashboard. Find its ID at [localhost:4000/api/clients](http://localhost:4000/api/clients).
2. Prepare a local MP4 or WebM and a JSON transcript like [this fictional example](../examples/replay-transcript.json). Times are in seconds. Use `client` for the buyer, `rep` for the presenter, `agent` for a speaking assistant, and `unknown` if the role is unclear.
3. Import from the project root.

```sh
npm run replay:import -- CLIENT_ID "/path/to/video.mp4" "/path/to/transcript.json"
```

4. Reload the client in the dashboard, select **Recording replay**, and start live analysis. Select **Play recording** and open **Overlay** to see the cues.

The import command registers the video in place and sorts transcript segments by end time. The video stays on disk at the path you provide. Generate the transcript with a tool you trust, review its speaker roles, and check that every segment ends within the video duration. The import accepts one recording per client.
