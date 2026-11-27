const language = { langs: ["en-US"], processLocally: true };

function speechRecognition(browser) {
  const Recognition = browser.SpeechRecognition || browser.webkitSpeechRecognition;
  if (!Recognition?.available || !Recognition.install || !("processLocally" in Recognition.prototype) ||
      !browser.navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("On-device Client Lens is unavailable here. Open Cuelensa in a desktop Chrome browser with local speech recognition.");
  }
  return Recognition;
}

export const lensAvailability = (browser = window) => speechRecognition(browser).available(language);
export const installLensLanguage = (browser = window) => speechRecognition(browser).install(language);

const cues = [
  [/\b(budget|pricing|expensive|cost|afford)\b/i, "Clarify the budget", "Ask what budget range they planned for."],
  [/\b(security|compliance|soc 2|saml|sso|privacy)\b/i, "Confirm the security requirement", "Ask which control or standard they need."],
  [/\b(integration|integrate|api|webhook|salesforce)\b/i, "Identify the integration", "Ask what system and workflow they need to connect."],
  [/\b(approval|approve|decision.maker|sign.off|procurement)\b/i, "Map the approval process", "Ask who signs off and what they need to see."],
  [/\b(timeline|deadline|next steps|follow.up|next week|by friday)\b/i, "Confirm the next step", "Agree on an owner and a date before moving on."],
];

export async function startLocalLens({ onCue, onStop, signal, browser = window }) {
  const Recognition = speechRecognition(browser);
  const recognition = new Recognition();
  recognition.lang = language.langs[0];
  recognition.processLocally = true;
  recognition.continuous = true;
  recognition.interimResults = false;
  const stream = await browser.navigator.mediaDevices.getDisplayMedia({
    video: { displaySurface: "browser" }, audio: true, selfBrowserSurface: "exclude",
    monitorTypeSurfaces: "exclude", surfaceSwitching: "exclude", systemAudio: "exclude", windowAudio: "exclude",
  });
  let stopped = false;
  let lastCueAt = -Infinity;
  let lastTitle;
  function stop(message) {
    if (stopped) return;
    stopped = true;
    signal?.removeEventListener("abort", cancel);
    recognition.onresult = recognition.onerror = recognition.onend = null;
    try { recognition.abort(); } catch { /* already stopped */ }
    for (const track of stream.getTracks()) track.stop();
    onStop(message);
  }
  const cancel = () => stop();
  const [video] = stream.getVideoTracks();
  const [audio] = stream.getAudioTracks();
  if (signal?.aborted) { stop(); return null; }
  if (video?.getSettings().displaySurface !== "browser" || !audio) {
    for (const track of stream.getTracks()) track.stop();
    throw new Error("Choose the meeting’s browser tab and enable tab audio sharing.");
  }
  video.stop();
  audio.addEventListener("ended", () => stop("Tab audio sharing ended."), { once: true });
  signal?.addEventListener("abort", cancel, { once: true });
  recognition.onresult = event => {
    if (stopped || Date.now() - lastCueAt < 20_000) return;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i];
      if (!result.isFinal) continue;
      const match = cues.find(([pattern]) => pattern.test(result[0]?.transcript || ""));
      if (!match || match[1] === lastTitle) continue;
      lastCueAt = Date.now();
      lastTitle = match[1];
      onCue({ title: lastTitle, text: match[2] });
      break;
    }
  };
  recognition.onerror = event => {
    if (event.error !== "no-speech") stop("On-device speech recognition stopped. Start Client Lens again to retry.");
  };
  recognition.onend = () => {
    if (stopped) return;
    try { recognition.start(audio); }
    catch { stop("On-device speech recognition ended."); }
  };
  try {
    recognition.start(audio);
    return stop;
  } catch {
    stop();
    throw new Error("Could not start on-device speech recognition for this tab.");
  }
}
