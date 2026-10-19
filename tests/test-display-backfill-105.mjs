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
ok("status element only when enabled / position configurable", /element_id: "status"/.test(src) && /this\.statusElementEnabled && this\.statusPosition === "top"/.test(src) && /this\.statusElementEnabled && this\.statusPosition !== "top"/.test(src));
ok("session has updateStatus", /async updateStatus\(text\) \{/.test(src));
ok("status element endpoint used", /`\/\$\{this\.state\.cardId\}\/elements\/status\/content`/.test(src));
ok("status write uses shared sequence/uuid", /uuid: `st_\$\{this\.state\.cardId\}_\$\{this\.state\.sequence\}`/.test(src));
ok("status update failure marks unavailable", /this\.statusUnavailable = true;/.test(src));
ok("status failure falls back into content", /!statusElementEnabled \|\| streaming\?\.isStatusUnavailable\?\.\(\) === true \? buildStatusText\(\) : ""/.test(src));
ok("close deletes status element (fallback zero-width)", /async deleteStatusElement\(\) \{/.test(src) && /const deleted = await this\.deleteStatusElement\(\)\.catch\(\(\) => false\);/.test(src));
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
ok("narration max configurable and default 80", /const configured = Number\(account\.config\?\.narrationMaxChars\);\s*return Number\.isFinite\(configured\) && configured >= 40 && configured <= 500 \? configured : 80;/.test(src));
ok("status lines use single newline", /return truncateDisplayText\(lines\.join\("\\n"\), STATUS_MAX_CHARS\)/.test(src));
ok("waiting line has last-tool detail", /SHOW_LAST_TOOL_LABEL && lastToolLabel/.test(src) && /const details = \[\];/.test(src));
ok("waiting line has elapsed detail", /SHOW_TOOL_ELAPSED && toolPhaseStartedAt > 0/.test(src) && /formatElapsedDuration\(elapsedMs\)/.test(src));
ok("elapsed refresh timer configurable, default 15s", /toolElapsedRefreshMs/.test(src) && /configured >= 5e3 && configured <= 6e4 \? configured : 15e3/.test(src) && /if \(!SHOW_TOOL_ELAPSED \|\| waitingRefreshTimer/.test(src) && /scheduleWaitingRefresh\(\);/.test(src));
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

// ---------- 6) display batch 2: status position, reasoning cap/final hide, final summary ----------
ok("status position config exists", /cardStatusPosition === "top" \? "top" : "bottom"/.test(src));
ok("status position passed to session", /statusPosition \}/.test(src) && /this\.statusPosition = options\.statusPosition === "top" \? "top" : "bottom";/.test(src));
ok("reasoning max lines configurable (default 12)", /reasoningMaxLines/.test(src) && /configured >= 2 && configured <= 100 \? configured : 12/.test(src));
ok("reasoning preview adds ellipsis when capped", src.includes("lines.length > REASONING_MAX_LINES") && src.includes("Math.max(1, REASONING_MAX_LINES - 1)"));
ok("final hides reasoning by default", /HIDE_REASONING_IN_FINAL = account\.config\?\.hideReasoningInFinal !== false;/.test(src) && /const finalReasoningText = HIDE_REASONING_IN_FINAL && finalizedAnswerText\.trim\(\) \? "" : finalizedReasoningText;/.test(src));
ok("optional final tool summary (default off)", /FINAL_TOOL_SUMMARY = account\.config\?\.finalToolSummary === true;/.test(src) && /finalToolSummary/.test(src));
{
  const fmtBody = extractArrow(src, "formatReasoningPrefix");
  const fmt = new Function(`
const REASONING_MAX_LINES = 12;
${fmtBody}
return formatReasoningPrefix;
`)();
  const input = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join("\n");
  const out = fmt(input);
  const bodyLines = out.split("\n").filter((l) => l.startsWith("> ") && !l.includes("Thinking"));
  ok("reasoning preview capped to 12 lines", bodyLines.length === 12, `lines=${bodyLines.length}`);
  ok("reasoning preview ends with ellipsis", bodyLines.at(-1) === "> …", JSON.stringify(bodyLines.slice(-2)));
  ok("reasoning preview keeps first lines", out.includes("line 1") && !out.includes("line 30"));
}

// ---------- 7) block payloads are merged, never blindly appended ----------
ok("block delivery uses dedupe merge", /if \(info\?\.kind === "block"\) queueStreamingBlockUpdate\(text\);/.test(src));
{
  const start = src.indexOf("function mergeStreamingText(");
  const end = src.indexOf("\n}\n", start) + 3;
  const mergeFn = new Function(`${src.slice(start, end)}\nreturn mergeStreamingText;`)();
  const full = "完整回答：这是最终内容";
  const prefix = full.slice(0, 8);
  ok("shorter prefix copy is dropped", mergeFn(full, prefix) === full, JSON.stringify(mergeFn(full, prefix)));
  ok("longer extension replaces prefix", mergeFn(prefix, full) === full);
  ok("genuinely new block still appends", mergeFn("block A", "block B") === "block Ablock B");
}

finish("2026.10.5 display/backfill/session");
