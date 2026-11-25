// Fictional demo data: a seed client and a scripted discovery call, used by "Simulate call".
export const DEMO_CLIENT = {
  id: "cli_demo_northwind",
  name: "Priya Raman",
  company: "Northwind Freight (fictional)",
  industry: "Logistics / 3PL",
  deal: "Mid-market, ~120 seats, inbound demo request",
  offering: "Fictional conversation intelligence platform with call analysis, CRM sync, and coaching dashboards",
  contacts: [
    { name: "Priya Raman", role: "VP of Sales" },
    { name: "Daniel Okafor", role: "CFO" },
    { name: "Mei Lin", role: "Head of IT" },
  ],
  notes: `Northwind Freight is a mid-sized freight and warehousing company with 3 regional sales teams (about 120 reps).
Priya requested a demo after a webinar on sales coaching. Their win rate has dropped from 28% to 21% over the last year.
Managers review calls manually and only cover maybe 5% of calls. Reps log notes into HubSpot by hand and the data is patchy.
They are looking for better visibility into why deals stall. They currently use a basic call recorder bundled with their phone system.
The CFO is cost-conscious after a tough quarter. IT will care about data security and where call recordings are stored.`,
  documents: [],
  profile: null,
  meetings: [],
};

const R = "Alex (rep)";
const P = "Priya Raman";
const D = "Daniel Okafor";

export const DEMO_SCRIPT = [
  [R, "rep", "Thanks for making the time, Priya and Daniel. To start, what prompted you to look at conversation intelligence now?"],
  [P, "client", "Honestly our win rate has dropped from 28 to 21 percent this year and we don't know why deals are stalling."],
  [P, "client", "My managers review calls manually and it takes forever, they cover maybe five percent of calls at best."],
  [R, "rep", "That's a big gap. How are reps capturing what happens on calls today?"],
  [P, "client", "They type notes into HubSpot by hand, so the data is patchy and frankly a bit of a headache for forecasting."],
  [D, "client", "I'll be upfront, after the quarter we had, budget is tight and this feels a bit expensive for us right now."],
  [R, "rep", "Totally understand. Can I ask what a lost mid-size deal is worth to you on average?"],
  [D, "client", "Somewhere around forty thousand a year in contract value."],
  [P, "client", "We already have a call recorder that came with our phone system, so I'd need to justify switching."],
  [R, "rep", "Makes sense. The recorder captures audio, but does it tell your managers why a deal stalled?"],
  [P, "client", "No, not at all. That's exactly the blind spot, we can't see which objections are killing deals."],
  [P, "client", "We need it to sync automatically with HubSpot, that's non-negotiable for us."],
  [D, "client", "And our IT lead will ask about security, where recordings are stored, and whether you're SOC 2 compliant."],
  [R, "rep", "Good questions, we're SOC 2 Type II and can keep data in-region. I'll send the security pack."],
  [P, "client", "That's great. If it could coach new reps automatically, that would really help, we hire about 30 people a year."],
  [P, "client", "We're also looking at one other vendor, so we're comparing options this month."],
  [D, "client", "What does pricing look like for around 120 users, and how long does implementation usually take?"],
  [R, "rep", "Typically two to three weeks. I can put together a proposal for 120 seats with a pilot option."],
  [P, "client", "A pilot with one regional team would be ideal. When can we get started?"],
  [D, "client", "I'd need to run it by our CEO before we sign anything though."],
];

/** Play the script into a session with natural pacing. Returns a stop() function. */
export function playDemo(session, { speedMs = 3500 } = {}) {
  let i = 0;
  let timer;
  const tick = () => {
    if (session.status !== "live") return;
    if (i === DEMO_SCRIPT.length) {
      session.end().catch((error) => console.error("Demo report failed:", error));
      return;
    }
    const [speaker, role, text] = DEMO_SCRIPT[i++];
    session.addUtterance({ speaker, role, text });
    timer = setTimeout(tick, speedMs + Math.min(2500, text.length * 15));
  };
  timer = setTimeout(tick, 800);
  return () => clearTimeout(timer);
}
