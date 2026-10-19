// 2026.10.5 — idle-hold timer lifecycle and terminal card content.
import { loadBundle, extractArrow, extractOnIdleBody, makeCounter } from "./_harness.mjs";

const src = loadBundle();
const { ok, finish } = makeCounter();

const clearBody = extractArrow(src, "clearIdleCloseTimer");
const schedBody = extractArrow(src, "scheduleIdleCloseTimer");
const idleBody = extractOnIdleBody(src);

const sandbox = new Function(`
let idleCloseTimer;
const CARD_IDLE_HOLD_MS = 8000;
let lastToolActivityAt = 0;
let streamText = "";
let reasoningText = "";
let visibleReplySent = false;
const deliveredFinalTexts = new Set();
let replyOutcome;
let aggregatedToolTotal = 0;
let streaming = null;
let finalDeliverySeen = false;
let timers = [];
let clearedTimers = 0;
let queued = 0;
let rejectQueued = false;
const errors = [];
const params = { runtime: { error: (m) => errors.push(m) } };
const account = { accountId: "acct" };
const setTimeout = (fn, ms) => { const t = { fn, ms, unrefCalled: false, cleared: false, unref() { t.unrefCalled = true; } }; timers.push(t); return t; };
const clearTimeout = (t) => { clearedTimers += 1; if (t) t.cleared = true; };
const queueIdleSideEffects = () => { queued += 1; if (rejectQueued) return Promise.reject(new Error("close failed")); return Promise.resolve("ok"); };
${clearBody}
${schedBody}
const onIdle = () => {${idleBody}};
return {
  onIdle,
  clearIdleCloseTimer,
  timers: () => timers,
  queued: () => queued,
  cleared: () => clearedTimers,
  errors: () => errors,
  getTimer: () => idleCloseTimer,
  setActivity: (msAgo) => { lastToolActivityAt = Date.now() - msAgo; },
  addTool: () => { aggregatedToolTotal += 1; },
  clearTools: () => { aggregatedToolTotal = 0; },
  setText: (v) => { streamText = v; },
  setReasoning: (v) => { reasoningText = v; },
  setVisible: () => { visibleReplySent = true; },
  resetVisible: () => { visibleReplySent = false; },
  setOutcome: (o) => { replyOutcome = o; },
  addFinalText: (v) => deliveredFinalTexts.add(v),
  setReject: (v) => { rejectQueued = v; },
  setActiveStreaming: (v) => { streaming = { isActive: () => v }; },
  setFinalSeen: (v) => { finalDeliverySeen = v; }
};
`)();

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

(async () => {
  // 1) hold: recent tool activity + tool batch + no content
  sandbox.addTool();
  sandbox.setActivity(100);
  const holdResult = sandbox.onIdle();
  ok("holds with recent tool activity", holdResult === undefined);
  ok("one hold timer scheduled", sandbox.timers().length === 1);
  const delay = sandbox.timers()[0]?.ms ?? -1;
  ok("remaining window is ~7.9s", delay > 7800 && delay <= 8000, `delay=${delay}`);
  ok("hold timer is unref'd", sandbox.timers()[0]?.unrefCalled === true);
  ok("hold does not queue idle effects yet", sandbox.queued() === 0);

  // 2) repeated idle must not stack timers
  sandbox.onIdle();
  ok("repeated idle reuses timer", sandbox.timers().length === 1);

  // 3) timer fires -> idle effects queued once
  sandbox.timers()[0].fn();
  await tick();
  ok("timer queues idle effects", sandbox.queued() === 1);
  ok("timer cleared after firing", sandbox.getTimer() === undefined);

  // 4) timer close failure is caught, not unhandled
  sandbox.setReject(true);
  sandbox.addTool();
  sandbox.setActivity(50);
  sandbox.onIdle();
  sandbox.timers().at(-1).fn();
  await tick();
  ok("timer close failure reported via runtime.error", sandbox.errors().length === 1, JSON.stringify(sandbox.errors()));
  sandbox.setReject(false);

  // 5) no tool batch -> immediate queue
  sandbox.clearTools();
  sandbox.setActivity(10);
  const noBatch = sandbox.onIdle();
  ok("no tool batch queues immediately", await Promise.resolve(noBatch) === "ok");
  ok("no timer left when queueing", sandbox.getTimer() === undefined);

  // 6) visible content / terminal outcomes release immediately
  sandbox.addTool();
  sandbox.setActivity(10);
  sandbox.setText("answer");
  ok("text releases card", (await Promise.resolve(sandbox.onIdle())) === "ok");
  sandbox.setText("");
  sandbox.setReasoning("thinking");
  ok("reasoning releases card", (await Promise.resolve(sandbox.onIdle())) === "ok");
  sandbox.setReasoning("");
  sandbox.setVisible();
  ok("visible reply releases card", (await Promise.resolve(sandbox.onIdle())) === "ok");

  sandbox.setVisible(); // harmless for silent path
  sandbox.setOutcome({ kind: "skipped", reason: "silent" });
  ok("silent terminal releases card", (await Promise.resolve(sandbox.onIdle())) === "ok");
  sandbox.setOutcome({ kind: "suppressed", reason: "channel_transform" });
  ok("suppressed terminal releases card", (await Promise.resolve(sandbox.onIdle())) === "ok");

  // 7) window is measured from latest activity
  sandbox.setOutcome(undefined);
  sandbox.resetVisible();
  sandbox.setActivity(3000);
  sandbox.onIdle();
  const delay2 = sandbox.timers().at(-1)?.ms ?? -1;
  ok("window counts from last activity (~5s)", delay2 > 4800 && delay2 <= 5000, `delay=${delay2}`);
  sandbox.clearIdleCloseTimer();
  ok("new activity can clear pending timer", sandbox.getTimer() === undefined);

  // 7b) active streaming card: hold on dispatcher idle until final/terminal
  sandbox.setActiveStreaming(true);
  sandbox.setFinalSeen(false);
  sandbox.setOutcome(undefined);
  sandbox.addTool();
  sandbox.setActivity(10);
  const queuedBeforeHold = sandbox.queued();
  const timersBeforeHold = sandbox.timers().length;
  ok("active card held on dispatcher idle (no final yet)", sandbox.onIdle() === undefined);
  ok("active card hold does not schedule close timer", sandbox.timers().length === timersBeforeHold);
  ok("active card hold does not queue idle effects", sandbox.queued() === queuedBeforeHold);
  sandbox.setFinalSeen(true);
  const finalIdle = sandbox.onIdle();
  ok("active card closes once final seen", await Promise.resolve(finalIdle) === "ok");
  ok("final idle queue increments once", sandbox.queued() === queuedBeforeHold + 1);
  sandbox.setActiveStreaming(false);
  sandbox.setFinalSeen(false);

  // 8) helpers used by close/reset/new-reply paths
  ok("performStreamingClose clears hold timer", /const performStreamingClose = async[\s\S]{0,300}clearIdleCloseTimer\(\);/.test(src));
  ok("resetStreamingState clears timer", /const resetStreamingState = \(\) => \{[\s\S]*?clearIdleCloseTimer\(\);[\s\S]*?lastToolActivityAt = 0;/.test(src));
  ok("onReplyStart clears timer", /onReplyStart: async \(\) => \{[\s\S]*?clearIdleCloseTimer\(\);[\s\S]*?lastToolActivityAt = 0;/.test(src));
  ok("aggregator clears pending timer", /aggregatedToolTotal \+= 1;[\s\S]{0,320}clearIdleCloseTimer\(\);/.test(src));

  // 9) terminal card content for tool-only turns
  const bc = extractArrow(src, "buildCombinedStreamText");
  const bcl = extractArrow(src, "buildCompletedLine");
  const rf = extractArrow(src, "resolveFinalCardText");
  const resolveSandbox = new Function(`let aggregatedToolTotal = 0; const account = { config: {} }; const resolveProgressText = (key, fallback) => fallback;${bc}\n${bcl}\n${rf}\nreturn { resolve: (r, a) => resolveFinalCardText(r, a), setTotal: (n) => { aggregatedToolTotal = n; } };`)();
  resolveSandbox.setTotal(3);
  ok("tool-only close text", resolveSandbox.resolve("", "") === "✅ 已执行 3 个工具", resolveSandbox.resolve("", ""));
  resolveSandbox.setTotal(3);
  ok("answer text preserved", resolveSandbox.resolve("", "final answer") === "final answer");
  resolveSandbox.setTotal(0);
  ok("empty without tools stays empty", resolveSandbox.resolve("", "") === "");
  ok("final card text helper wired into close", /let text = resolveFinalCardText\(finalReasoningText, finalizedAnswerText\);/.test(src));

  finish("2026.10.5 idle/timer/content");
})().catch((error) => {
  console.error("harness error:", error);
  process.exit(1);
});
