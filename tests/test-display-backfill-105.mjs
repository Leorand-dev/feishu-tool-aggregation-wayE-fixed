// 2026.10.5 — latest-state backfill + dual card element / status fallback wiring.
import { loadBundle, makeCounter } from "./_harness.mjs";

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
ok("status budget configured", /STATUS_MAX_CHARS = 600;/.test(src));

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
const STATUS_MAX_CHARS = 600;
${src.slice(truncateStart, src.indexOf("\n\t};", truncateStart) + 4)}
${src.slice(statusStart, statusEnd)}
return buildStatusText;
`)();
ok("status order: waiting/narration/item/compaction", statusFn() === "waiting\n\nnarration\n\nitem\n\ncompact", JSON.stringify(statusFn()));

finish("2026.10.5 display/backfill/session");
