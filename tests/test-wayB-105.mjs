// 2026.10.5 — waiting line, running total, aggregation and renderEpoch guard.
import { loadBundle, extractAsyncArrow, makeCounter } from "./_harness.mjs";

const src = loadBundle();
const { ok, finish } = makeCounter();
const aggBody = extractAsyncArrow(src, "aggregateCollapsibleToolSummary");

const makeSandbox = (deferredStart = false) => new Function(`
let streamingEnabled = true;
let renderMode = "card";
let sessionActive = true;
let renderEpoch = 0;
let aggregatedToolTotal = 0;
let lastToolLabel = "";
let toolPhaseStartedAt = 0;
const scheduleWaitingRefresh = () => {};
const clearWaitingRefreshTimer = () => {};
let lastToolActivityAt = 0;
let timerClears = 0;
const aggregatedToolSummaryCounts = new Map();
const streaming = { isActive: () => sessionActive };
let streamingStartPromise = null;
let releaseStart = () => {};
${deferredStart ? 'streamingStartPromise = new Promise((resolve) => { releaseStart = resolve; });' : ''}
const startStreaming = () => {};
const clearIdleCloseTimer = () => { timerClears += 1; };
const waitingLines = [];
const buildWaitingLine = (total) => "waiting:" + total;
const updateWaitingLine = (line) => { waitingLines.push(line); };
${aggBody}
return {
  run: aggregateCollapsibleToolSummary,
  counts: aggregatedToolSummaryCounts,
  waitingLines,
  total: () => aggregatedToolTotal,
  lastLabel: () => lastToolLabel,
  lastActivity: () => lastToolActivityAt,
  timerClears: () => timerClears,
  releaseStart: () => releaseStart(),
  bumpEpoch: () => { renderEpoch += 1; },
  setEnabled: (v) => { streamingEnabled = v; },
  setRenderMode: (v) => { renderMode = v; },
  setActive: (v) => { sessionActive = v; }
};
`)();

const e1 = { key: "k1", icon: "🛠️", label: "exec" };
const e2 = { key: "k2", icon: "🛠️", label: "read" };

(async () => {
  const factory = makeSandbox();
  ok("first tool aggregates", await factory.run(e1) === true);
  ok("second tool aggregates", await factory.run(e2) === true);
  ok("duplicate tool increments count", await factory.run(e1) === true);
  ok("two distinct groups", factory.counts.size === 2);
  ok("duplicate count is 2", factory.counts.get("k1").count === 2);
  ok("running total is 3", factory.total() === 3);
  ok("waiting line #1", factory.waitingLines[0] === "waiting:1", JSON.stringify(factory.waitingLines));
  ok("waiting line #2", factory.waitingLines[1] === "waiting:2");
  ok("waiting line #3", factory.waitingLines[2] === "waiting:3");
  ok("last tool label tracked", factory.lastLabel() === "exec", factory.lastLabel());
  ok("tool activity timestamp updated", factory.lastActivity() > 0);
  ok("tool activity clears pending idle timer", factory.timerClears() >= 3);

  factory.setEnabled(false);
  const before = factory.waitingLines.length;
  ok("disabled streaming returns false", await factory.run(e1) === false);
  ok("disabled streaming writes no line", factory.waitingLines.length === before);
  factory.setEnabled(true);
  factory.setRenderMode("raw");
  ok("raw render mode returns false", await factory.run(e1) === false);
  factory.setRenderMode("card");
  factory.setActive(false);
  ok("inactive stream returns false", await factory.run(e1) === false);

  // renderEpoch race: a clear while the card is starting must not resurrect the waiting line
  const race = makeSandbox(true);
  const raceP = race.run(e1);
  race.bumpEpoch();
  race.releaseStart();
  ok("aggregation survives epoch change", await raceP === true);
  ok("count is still recorded after clear", race.counts.get("k1").count === 1);
  ok("running total still counted", race.total() === 1);
  ok("waiting line is not resurrected after clear", race.waitingLines.length === 0, JSON.stringify(race.waitingLines));

  // structural invariants
ok("waiting template present", src.includes('resolveProgressText("toolWaiting", "\\u23F3 \\u5df2\\u6267\\u884c {count} \\u4e2a\\u5de5\\u5177")') && src.includes("const details = [];"));
  ok("running total replaces reduce", !src.includes("Array.from(aggregatedToolSummaryCounts.values()).reduce") && src.includes("aggregatedToolTotal += 1;"));
  ok("waiting line uses running total", src.includes("updateWaitingLine(buildWaitingLine(aggregatedToolTotal));"));
  ok("no dead summary builder", !src.includes("buildAggregatedToolSummaryLine"));
  ok("no dead aggregate line variable", !src.includes("aggregatedToolSummaryLine"));
  ok("no backfillTotal dead code", !src.includes("backfillTotal"));

  finish("2026.10.5 waiting-line/aggregation");
})().catch((error) => {
  console.error("harness error:", error);
  process.exit(1);
});
