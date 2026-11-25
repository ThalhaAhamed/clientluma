import { generateAgentTurn } from "./ai.js";
import { personaParams } from "./mia-agent.js";

export const AI_PRESENTER = "Alex (AI presenter)";
const TURN_COUNT = 10;
const TURN_GAP = 2200;
const LAST_CUE_WINDOW = 10000;

export function playAgentTest(session, { ready = () => true, speak } = {}) {
  const buyer = personaParams({ client: session.client, repName: AI_PRESENTER });
  const speakers = [
    {
      speaker: AI_PRESENTER,
      role: "rep",
      instructions: `You are Alex, a sales presenter for ${buyer.offering}, meeting ${buyer.persona_name} from ${buyer.company}.
Ask one question at a time and follow up on what the buyer actually said. Discover their current process before pitching.
Connect the offering to their needs. Ask about fit, concerns, and a possible next step. Avoid unsupported product claims, prices, or promises.`,
    },
    {
      speaker: `${buyer.persona_name} (AI buyer)`,
      role: "client",
      instructions: `You are ${buyer.persona_name}, ${buyer.persona_role} at ${buyer.company}.
Use this private buyer background:\n${buyer.persona_brief}\nReveal specifics when asked and raise a realistic objection as the presenter explains the offering.
Respond directly to the presenter's last question. Consider a next step if the offering addresses a concrete problem.`,
    },
  ];
  let turn = 0;
  let timer;
  let stopped = false;
  const dialogue = [];
  const deadline = Date.now() + 10 * 60_000;

  const active = () => !stopped && session.status === "live";
  const finish = () => Promise.all([session.end(), session.removeBots()]).catch((error) => console.error("[mia] agent test report failed:", error));
  const fail = (label, message) => {
    session.botStatus = { label, message, failed: true };
    session.emit("bot", session.botStatus);
    if (session.transcript.length || session.hold) return finish();
    session.discard();
    session.removeBots();
    session.emit("cancelled", session.botStatus);
  };
  const next = async () => {
    if (!active()) return;
    if (!ready()) {
      if (Date.now() >= deadline) return fail("AI test timed out waiting for the meeting bots", "Start another test after joining the meeting.");
      timer = setTimeout(next, 1000);
      return;
    }
    const { speaker, role, instructions } = speakers[turn % speakers.length];
    const text = await generateAgentTurn({ instructions, transcript: dialogue, wrapUp: turn >= TURN_COUNT - 2 });
    if (!active()) return;
    if (!text) return fail(`AI test stopped while generating ${speaker}'s turn`, "Check the configured AI provider and try again.");
    const utterance = { speaker, role, text };
    try {
      if (speak) await speak(utterance, active);
      else session.addUtterance(utterance);
    } catch (error) {
      if (active()) fail(`Could not play ${speaker}'s turn`, error.message);
      return;
    }
    if (!active()) return;
    dialogue.push(utterance);
    turn++;
    timer = setTimeout(turn < TURN_COUNT ? next : finish, turn < TURN_COUNT ? TURN_GAP : LAST_CUE_WINDOW);
  };

  timer = setTimeout(next, 800);
  return () => { stopped = true; clearTimeout(timer); };
}
