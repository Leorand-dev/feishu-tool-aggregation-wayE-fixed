// 2026.10.5 — latest-state backfill + dual card element / status fallback wiring.
import { loadBundle, extractArrow, makeCounter } from "./_harness.mjs";

const src = loadBundle();
const { ok, finish } = makeCounter();

// ---------- 1) queueFeishuStreamingUpdate: providers are evaluated after card start ----------
const qStart = src.indexOf("function queueFeishuStreamingUpdate(params) {");
const qEnd = src.indexOf("\n}", qStart) + 2;
ok("queueFeishuStreamingUpdate found", qStart > 0 && qEnd > qStart);
const queueSrc = src.slice(qStart, qEnd);
const queueFn = new Function(`${queueSrc}\nreturn queueFeishuStreamingUpdate;`)();

let providerCalls = 0;
let statusProviderCalls = 0;
let latest = "state-before-start";
let latestStatus = "status-before-start";
let resolveStart;
const startPromise = new Promise((resolve) => { resolveStart = resolve; });
const calls = [];
const session = {
  isActive: () => true,
  update: (text) => { calls.push(["content", text]); return Promise.resolve(); },
  updateStatus: (text) => { calls.push(["status", text]); return Promise.resolve(true); }
};
const pending = queueFn({
  queue: Promise.resolve(),
  session,
  generation: 1,
  startPromise,
  content: () => { providerCalls += 1; return latest; },
  status: () => { statusProviderCalls += 1; return latestStatus; },
  statusElement: true,
  accountId: "acct",
  runtime: { error: () => void 0 },
  onStatusUnavailable: () => { calls.push(["unavailable"]); }
});
await new Promise((resolve) => setTimeout(resolve, 0));
ok("providers not evaluated before card start", providerCalls === 0 && statusProviderCalls === 0);
latest = "latest-content";
latestStatus = "latest-status";
resolveStart();
await pending;
ok("content rendered from latest state after start", calls.some(([k, v]) => k === "content" && v === "latest-content"), JSON.stringify(calls));
ok("status rendered from latest state after start", calls.some(([k, v]) => k === "status" && v === "latest-status"));
ok("provider evaluated only after start", providerCalls === 1 && statusProviderCalls === 1);

// ---------- 2) status-element failure triggers content fallback callback ----------
let statusFailed = false;
const session2 = {
  isActive: () => true,
  update: () => Promise.resolve(),
  updateStatus: () => Promise.resolve(false)
};
const pending2 = queueFn({
  queue: Promise.resolve(),
  session: session2,
  generation: 1,
  startPromise: null,
  content: () => "content",
  status: () => "status",
  statusElement: true,
  accountId: "acct",
  runtime: { error: () => void 0 },
  onStatusUnavailable: () => { statusFailed = true; }
});
await pending2;
ok("status failure invokes fallback callback", statusFailed === true);

// ---------- 3) structural: dual element + status API + fallback + configs ----------
ok("card JSON includes status element", /element_id: "status"/.test(src));
ok("status element only when enabled", /if \(this\.statusElementEnabled\) elements\.push\(\{\s*tag: "markdown",\s*content: "",\s*element_id: "status"/.test(src));
ok("session has updateStatus", /async updateStatus\(text\) \{/.test(src));
ok("status element endpoint used", /`\/\$\{this\.state\.cardId\}\/elements\/status\/content`/.test(src));
ok("status write uses shared sequence/uuid", /uuid: `st_\$\{this\.state\.cardId\}_\$\{this\.state\.sequence\}`/.test(src));
ok("status update failure marks unavailable", /this\.statusUnavailable = true;/.test(src));
ok("status failure falls back into content", /!statusElementEnabled \|\| streaming\?\.isStatusUnavailable\?\.\(\) === true \? buildStatusText\(\) : ""/.test(src));
ok("close clears status element with zero-width marker", /this\.statusSentText !== "\\u200B"\) \{\s*this\.statusSentText = "\\u200B";\s*await this\.writeStatusContent\("\\u200B"\)/.test(src));
ok("empty status maps to zero-width marker", /CardKit rejects empty element content/.test(src) && /const safeText = typeof text === "string" && text\.trim\(\) !== "" \? text : "\\u200B";/.test(src));
ok("updateStatus normalizes empty text", /const safeText = text\.trim\(\) !== "" \? text : "\\u200B";/.test(src));
ok("status updates throttled", /schedulePendingStatusFlush/.test(src) && /statusLastUpdateTime/.test(src));
ok("status element can be disabled", /cardStatusElement !== false/.test(src));
ok("content/status flush is coalesced while starting", /cardFlushPending/.test(src));
ok("early card prewarm configured", /prewarmCard !== false/.test(src));
ok("start latency logged", /streaming card ready in \$\{Date\.now\(\) - cardStartAt\}ms/.test(src));
ok("backoff reduced to 15s", /STREAMING_START_FAILURE_BACKOFF_MS = 15e3;/.test(src));
ok("hold window configurable", /cardIdleHoldMs/.test(src));
ok("progress text overrides configurable", /progressTexts/.test(src));
ok("compact status budget configured", /STATUS_LINE_MAX_CHARS = 160;/.test(src) && /STATUS_MAX_CHARS = 400;/.test(src));

// ---------- 3b) prewarm keeps the card non-blank ----------
ok("prewarm status requested at reply start", /prewarmRequested = true;\s*startStreaming\(\);/.test(src));
ok("prewarm status rendered when card becomes ready", src.includes('resolveProgressText("prewarm"') && src.includes('prewarmStatusLine = resolveProgressText'));
ok("prewarm status clears on first content/waiting/narration", /const clearPrewarmStatus = \(\) => \{/.test(src) && (src.match(/clearPrewarmStatus\(\);/g) || []).length >= 5);
ok("waiting line replaces prewarm status", /prewarmStatusLine = "";\s*waitingLine = nextWaitingLine;/.test(src));
ok("prewarm text configurable", /progressTexts\?\.\[key\]/.test(src) || /progressTexts/.test(src));

// ---------- 4) status fallback text renderer ordering ----------
const truncateStart = src.indexOf("const truncateDisplayText = (text, max) => {");
const statusStart = src.indexOf("const buildStatusText = () => {");
const statusEnd = src.indexOf("\n\t};", statusStart) + 4;
const statusFn = new Function(`
let waitingLine = "waiting"; let narrationLine = "narration"; let itemStatusLine = "item"; let compactionLine = "compact";
const STATUS_LINE_MAX_CHARS = 160;
const STATUS_MAX_CHARS = 400;
${src.slice(truncateStart, src.indexOf("\n\t};", truncateStart) + 4)}
${src.slice(statusStart, statusEnd)}
return buildStatusText;
`)();
ok("compact status: waiting + one secondary line", statusFn() === "waiting\nnarration · item · compact", JSON.stringify(statusFn()));

// ---------- 5) display batch 1: compact status, elapsed/last tool, narration cap, timer ----------
ok("narration max configurable and default 120", /const configured = Number\(account\.config\?\.narrationMaxChars\);\s*return Number\.isFinite\(configured\) && configured >= 40 && configured <= 500 \? configured : 120;/.test(src));
ok("status lines use single newline", /return truncateDisplayText\(lines\.join\("\\n"\), STATUS_MAX_CHARS\)/.test(src));
ok("waiting line has last-tool detail", /SHOW_LAST_TOOL_LABEL && lastToolLabel/.test(src) && /const details = \[\];/.test(src));
ok("waiting line has elapsed detail", /SHOW_TOOL_ELAPSED && toolPhaseStartedAt > 0/.test(src) && /formatElapsedDuration\(elapsedMs\)/.test(src));
ok("elapsed refresh timer 5s", /TOOL_ELAPSED_REFRESH_MS = 5e3;/.test(src) && /scheduleWaitingRefresh\(\);/.test(src));
ok("elapsed timer cleared on final/close/reply", (src.match(/clearWaitingRefreshTimer\(\);/g) || []).length >= 4);
ok("assistant start keeps initial status when blank", /else \{[\s\S]{0,400}if \(!prewarmStatusLine && !waitingLine\) \{\s*prewarmStatusLine = resolveProgressText\("processing"/.test(src));
{
  const fmt = extractArrow(src, "formatElapsedDuration");
  const f = new Function(`${fmt}\nreturn formatElapsedDuration;`)();
  ok("format elapsed seconds", f(0) === "0s" && f(59_000) === "59s");
  ok("format elapsed minutes", f(60_000) === "1m00s" && f(125_000) === "2m05s");
}
{
  const fmtBody = extractArrow(src, "formatElapsedDuration");
  const bwl = extractArrow(src, "buildWaitingLine");
  const fn = new Function(`
let waitingLine = "", lastToolLabel = "Read", toolPhaseStartedAt = 0;
const SHOW_LAST_TOOL_LABEL = true, SHOW_TOOL_ELAPSED = true;
const resolveProgressText = (key, fallback) => fallback;
${fmtBody}
${bwl}
return { build: buildWaitingLine, start: (ms) => { toolPhaseStartedAt = Date.now() - ms; } };
`)();
  ok("waiting line includes last tool", fn.build(3) === "⏳ 已执行 3 个工具 · 最后：Read", fn.build(3));
  fn.start(12_000);
  const line = fn.build(3);
  ok("waiting line includes elapsed", /12s/.test(line) && line.includes("最后：Read"), line);
}

finish("2026.10.5 display/backfill/session");
