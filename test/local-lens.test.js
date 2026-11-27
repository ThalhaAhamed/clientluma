import assert from "node:assert/strict";
import { test } from "node:test";
import { startLocalLens } from "../public/local-lens.js";

test("Client Lens only uses the shared tab audio locally and stops capture on exit", async () => {
  let instance;
  class Recognition {
    static available() {}
    static install() {}
    set processLocally(value) { this.local = value; }
    constructor() { instance = this; }
    start(track) {
      assert.equal(this.local, true);
      assert.equal(track, audio);
      this.started = true;
    }
    abort() { this.stopped = true; }
  }
  const video = { stop() { this.stopped = true; }, getSettings() { return { displaySurface: "browser" }; } };
  const audio = Object.assign(new EventTarget(), { stop() { this.stopped = true; } });
  const browser = { SpeechRecognition: Recognition, navigator: { mediaDevices: {
    async getDisplayMedia({ audio: captureAudio, video: captureVideo }) {
      assert.equal(captureAudio, true);
      assert.equal(captureVideo.displaySurface, "browser");
      return { getVideoTracks: () => [video], getAudioTracks: () => [audio], getTracks: () => [video, audio] };
    },
  } } };
  const cues = [];
  const controller = new AbortController();
  let stops = 0;
  await startLocalLens({ browser, signal: controller.signal, onCue: cue => cues.push(cue), onStop: () => stops++ });
  assert.equal(video.stopped, true);
  assert.equal(instance.started, true);
  const result = Object.assign([{ transcript: "Our budget is ten thousand dollars." }], { isFinal: true });
  instance.onresult({ resultIndex: 0, results: [result] });
  assert.deepEqual(cues, [{ title: "Clarify the budget", text: "Ask what budget range they planned for." }]);
  controller.abort();
  assert.equal(audio.stopped, true);
  assert.equal(instance.stopped, true);
  assert.equal(instance.onresult, null);
  assert.equal(stops, 1);
});
