// 2026.10.5 — execution harness for deliver decisions (aggregate / suppress / deliver).
import { loadBundle, extractArrow, extractBareToolLabels, buildParserEnv, makeCounter } from "./_harness.mjs";

const src = loadBundle();
const { ok, finish } = makeCounter();

const emojiBody = extractArrow(src, "parseCollapsibleToolSummary");
const bareBody = extractArrow(src, "parseBareToolLabel");
const narrationBody = extractArrow(src, "isToolNarrationPayload");
const closurePreamble = `${extractBareToolLabels(src)}\n${buildParserEnv(src)}`;
const parseEmoji = new Function("payload", "info", `${closurePreamble}\n${emojiBody}\nreturn parseCollapsibleToolSummary(payload, info);`);
const parseBare = new Function("payload", "info", `${closurePreamble}\n${bareBody}\nreturn parseBareToolLabel(payload, info);`);
const isNarration = new Function("payload", "info", `${closurePreamble}\n${narrationBody}\nreturn isToolNarrationPayload(payload, info);`);

/** Mirror of the deliver() decision order in the patched bundle. */
const runDeliver = (payload, info, aggregateResult) => {
  const entry = parseEmoji(payload, info) ?? parseBare(payload, info);
  if (entry && aggregateResult) return { action: "aggregated", entry };
  if (isNarration(payload, info)) return { action: "suppressed" };
  return { action: "deliver" };
};

const live = { text: "🛠️ Exec", mediaUrls: undefined };
const bare = { text: "Exec", mediaUrls: undefined };
const narration = { text: "💬 running a deliberate narration burst" };

ok("live summary aggregates", runDeliver(live, { kind: "tool" }, true).action === "aggregated");
ok("bare label aggregates", runDeliver(bare, { kind: "tool" }, true).action === "aggregated");

const realAggregated = [
  "Read: `from /home/u/a.txt`",
  "Write: `to /home/u/out.txt`",
  "Edit: `in /home/u/a.txt`",
  "Browser: `https://example.com`",
  'Web Search: `for "notes"`',
  "Web Fetch: `from https://example.com/doc`",
  "View Image: `/home/u/pic.png`",
  "Grep: `foo`",
  "Glob: `**/*.mjs`",
  "Ls: `/home`",
  "Process: `s1`",
  "Image: `a cat`",
  "Message: `user:1`",
  "Apply Patch",
  "Session Settings"
];
for (const text of realAggregated) {
  ok(`real emitter shape aggregates: ${text}`, runDeliver({ text, mediaUrls: undefined }, { kind: "tool" }, true).action === "aggregated");
}
ok("narration suppressed", runDeliver(narration, { kind: "tool" }, false).action === "suppressed");
ok("narration suppressed even if aggregate would succeed", runDeliver(narration, { kind: "tool" }, true).action === "suppressed");
ok("narration + mediaUrls falls back to legacy delivery", runDeliver({ text: "💬 hi", mediaUrls: undefined }, { kind: "tool" }, true).action === "deliver");

const delivers = [
  ["media tool result", { text: "🛠️ Exec", mediaUrls: ["https://x/a.png"] }],
  ["bare media result", { text: "image", mediaUrls: ["https://x/i.png"] }],
  ["extra-key payload", { text: "🛠️ Exec", mediaUrls: undefined, toolName: "exec" }],
  ["MCP label", { text: "mcp__foo__bar", mediaUrls: undefined }],
  ["tool error", { text: "🛠️ Exec", mediaUrls: undefined, isError: true }],
  ["verbose multi-line output", { text: "🛠️ Exec\n```txt\noutput\n```", mediaUrls: undefined }],
];
for (const [name, payload] of delivers) {
  const result = runDeliver(payload, { kind: "tool" }, true);
  ok(`${name} -> legacy delivery`, result.action === "deliver", result.action);
}

// aggregate failure must fall through, never silently drop the payload
ok("recognized tool + aggregate failure -> deliver", runDeliver(live, { kind: "tool" }, false).action === "deliver");
ok("recognized bare tool + aggregate failure -> deliver", runDeliver(bare, { kind: "tool" }, false).action === "deliver");

// non-tool payloads are untouched
ok("final payload -> deliver", runDeliver({ text: "hello" }, { kind: "final" }, false).action === "deliver");
ok("block payload -> deliver", runDeliver({ text: "hello" }, { kind: "block" }, false).action === "deliver");

// deliver() must call the aggregation path before the narration guard
const deliverStart = src.indexOf("deliver: async (inputPayload, info) => {");
const deliverEnd = src.indexOf("onError: handleDeliveryError", deliverStart);
ok("deliver block found", deliverStart > 0 && deliverEnd > deliverStart);
const deliverBody = src.slice(deliverStart, deliverEnd);
ok("aggregation before narration guard", deliverBody.indexOf("aggregateCollapsibleToolSummary") < deliverBody.indexOf("isToolNarrationPayload"));
ok("no blanket tool drop", !/kind === "tool" && inputPayload\?\.isError !== true\) return noVisibleFeishuReplyDelivery/.test(deliverBody));

finish("2026.10.5 execution harness");
