// 2026.10.5 — parser discriminator, narration policy and media-preservation matrix.
import { loadBundle, extractArrow, extractBareToolLabels, buildParserEnv, makeCounter } from "./_harness.mjs";

const src = loadBundle();
const { ok, finish } = makeCounter();

const emojiBody = extractArrow(src, "parseCollapsibleToolSummary");
const bareBody = extractArrow(src, "parseBareToolLabel");
const narrationBody = extractArrow(src, "isToolNarrationPayload");
const closurePreamble = `${extractBareToolLabels(src)}\n${buildParserEnv(src)}`;

const parseEmoji = new Function("payload", "info", `${closurePreamble}\n${emojiBody}\nreturn parseCollapsibleToolSummary(payload, info);`);
const parseBare = new Function("payload", "info", `${closurePreamble}\n${bareBody}\nreturn parseBareToolLabel(payload, info);`);
const normalizeLabel = new Function(`${buildParserEnv(src)}\nreturn normalizeToolLabel;`)();
const isNarration = new Function("payload", "info", `${buildParserEnv(src)}\n${narrationBody}\nreturn isToolNarrationPayload(payload, info);`);

const parseAny = (payload, info) => parseEmoji(payload, info) ?? parseBare(payload, info);
const decide = (payload, info, aggregateOk = true) => {
  if (parseAny(payload, info)) return aggregateOk ? "aggregated" : "deliver";
  if (isNarration(payload, info)) return "suppressed";
  return "deliver";
};

// --- structural invariants ---
ok("parser requires own mediaUrls key", /hasOwnProperty\.call\(payload, "mediaUrls"\)/.test(src));
ok("parser rejects non-array/non-empty mediaUrls", /payload\.mediaUrls !== void 0 && \(!Array\.isArray\(payload\.mediaUrls\) \|\| payload\.mediaUrls\.length > 0\)/.test(src));
ok("parser is null-safe", /!payload \|\| typeof payload !== "object"/.test(src));
ok("deliver guard is narration-only", /if \(isToolNarrationPayload\(inputPayload, info\)\) \{\s*await deliverNarrationToCard\(inputPayload\.text\);\s*return noVisibleFeishuReplyDelivery;/.test(src));
ok("blanket kind:tool drop removed", !/if \(info\?\.kind === "tool" && inputPayload\?\.isError !== true\) return noVisibleFeishuReplyDelivery;/.test(src));
ok("narration never parses as tool summary", /text\.startsWith\(TOOL_NARRATION_TEXT_PREFIX\)\) return void 0;/.test(src));
ok("label normalizer present", /const normalizeToolLabel = \(label\) =>/.test(src) && src.includes('replace(/[\\s-]+/g, "_")'));
ok("tool label aliases present", /TOOL_LABEL_ALIASES = .*session_settings.*sessions/.test(src));
ok("real-emitter cap present", /const TOOL_SUMMARY_MAX_CHARS = 400;/.test(src));

// --- normalisation of real openclaw 2026.10.5 labels ---
ok("normalizes 'Web Fetch' -> web_fetch", normalizeLabel("Web Fetch") === "web_fetch");
ok("normalizes 'Session Settings' -> sessions", normalizeLabel("Session Settings") === "sessions");
ok("normalizes 'Apply Patch' -> apply_patch", normalizeLabel("Apply Patch") === "apply_patch");
ok("normalizes 'view image' -> view_image", normalizeLabel("view image") === "view_image");

// --- live tool summary shapes ---
const liveTool = { text: "🛠️ Exec", mediaUrls: undefined };
const bareTool = { text: "Exec", mediaUrls: undefined };
ok("live emoji tool summary parses", parseAny(liveTool, { kind: "tool" }) !== undefined);
ok("bare tool label parses", parseAny(bareTool, { kind: "tool" }) !== undefined);
ok("mediaUrls:[] is accepted", parseAny({ text: "🛠️ Exec", mediaUrls: [] }, { kind: "tool" }) !== undefined);
ok("multi-line tool summary rejected", parseAny({ text: "🛠️ Exec\n```txt\nout\n```", mediaUrls: undefined }, { kind: "tool" }) === undefined);
ok("error tool rejected by parser", parseAny({ text: "🛠️ Exec", mediaUrls: undefined, isError: true }, { kind: "tool" }) === undefined);
ok("block kind rejected by parser", parseAny(liveTool, { kind: "block" }) === undefined);

// --- real openclaw 2026.10.5 emitter shapes (verboseLevel:on) ---
const realShapes = [
  ["Read: `from /home/u/a.txt`", "read"],
  ["Write: `to /home/u/out.txt`", "write"],
  ["Edit: `in /home/u/a.txt`", "edit"],
  ["Browser: `https://example.com`", "browser"],
  ['Web Search: `for "notes"`', "web_search"],
  ["Web Fetch: `from https://example.com/doc`", "web_fetch"],
  ["View Image: `/home/u/pic.png`", "view_image"],
  ["Grep: `foo`", "grep"],
  ["Glob: `**/*.mjs`", "glob"],
  ["Ls: `/home`", "ls"],
  ["Process: `s1`", "process"],
  ["Image: `a cat`", "image"],
  ["Message: `user:1`", "message"],
  ["Apply Patch", "apply_patch"],
  ["Session Settings", "sessions"]
];
for (const [text, label] of realShapes) {
  ok(`real emitter shape aggregates: ${label}`, parseAny({ text, mediaUrls: undefined }, { kind: "tool" }) !== undefined, JSON.stringify(text));
}
ok("long detail (≤400) still aggregates", parseAny({ text: "Read: `from " + "a".repeat(300) + "`", mediaUrls: undefined }, { kind: "tool" }) !== undefined);
ok("over-long summary rejected", parseAny({ text: "Read: `from " + "a".repeat(420) + "`", mediaUrls: undefined }, { kind: "tool" }) === undefined);
ok("short prose is not a tool summary", parseAny({ text: "Deployment complete", mediaUrls: undefined }, { kind: "tool" }) === undefined);

// --- narration policy ---
const narration = { text: "💬 let me run a burst" };
ok("narration classified as narration", isNarration(narration, { kind: "tool" }) === true);
ok("narration with mediaUrls is not narration", isNarration({ text: "💬 hi", mediaUrls: undefined }, { kind: "tool" }) === false);
ok("narration with mediaUrls is not aggregated as tool", parseAny({ text: "💬 hi", mediaUrls: undefined }, { kind: "tool" }) === undefined);
ok("narration with extra key is not narration", isNarration({ text: "💬 hi", extra: 1 }, { kind: "tool" }) === false);
ok("emoji prose without 💬 prefix is not narration", isNarration({ text: "✅ Done" }, { kind: "tool" }) === false);
ok("final payload is not narration", isNarration({ text: "💬 hi" }, { kind: "final" }) === false);
ok("null payload does not throw", (() => {
  try {
    parseAny(null, { kind: "tool" });
    isNarration(null, { kind: "tool" });
    return true;
  } catch {
    return false;
  }
})());

// --- end-to-end decision matrix (aggregate assumed successful) ---
ok("live tool -> aggregated", decide(liveTool, { kind: "tool" }) === "aggregated");
ok("bare tool -> aggregated", decide(bareTool, { kind: "tool" }) === "aggregated");
ok("narration -> suppressed", decide(narration, { kind: "tool" }) === "suppressed");
ok("narration is suppressed even without aggregation", decide(narration, { kind: "tool" }, false) === "suppressed");
ok("media-bearing tool result -> delivered", decide({ text: "🛠️ Exec", mediaUrls: ["https://x/a.png"] }, { kind: "tool" }) === "deliver");
ok("bare media result -> delivered", decide({ text: "image", mediaUrls: ["https://x/i.png"] }, { kind: "tool" }) === "deliver");
ok("extra-key tool payload -> delivered", decide({ text: "🛠️ Exec", mediaUrls: undefined, toolName: "exec" }, { kind: "tool" }) === "deliver");
ok("MCP/custom label -> delivered", decide({ text: "mcp__foo__bar", mediaUrls: undefined }, { kind: "tool" }) === "deliver");
ok("tool error -> delivered", decide({ text: "🛠️ Exec", mediaUrls: undefined, isError: true }, { kind: "tool" }) === "deliver");
ok("recognized tool with failed aggregation -> delivered (no silent loss)", decide(liveTool, { kind: "tool" }, false) === "deliver");

finish("2026.10.5 parser/delivery");
