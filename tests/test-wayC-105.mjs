// 2026.10.5 — mid-turn block fold and status-line ownership.
import { loadBundle, extractArrow, count, makeCounter } from "./_harness.mjs";

const src = loadBundle();
const { ok, finish } = makeCounter();

// --- midTurnBlockFold ---
const foldLines = src.split("\n").filter((l) => l.includes("const midTurnBlockFold ="));
ok("single midTurnBlockFold declaration", foldLines.length === 1, `${foldLines.length} found`);
ok("fold requires active tool batch", /aggregatedToolSummaryCounts\.size > 0/.test(foldLines[0]));
ok("fold no longer references removed summary line", !/aggregatedToolSummaryLine/.test(foldLines[0]));
const renderLines = src.split("\n").filter((l) => l.includes("const cardRenderingRequested ="));
ok("card rendering includes midTurnBlockFold", renderLines.length === 1 && renderLines[0].includes("midTurnBlockFold"));
ok("fold still gated off in raw mode", /renderMode !== "raw"/.test(foldLines[0] || ""));
ok("fold requires active streaming", /streaming\?\.isActive\(\) === true/.test(foldLines[0] || ""));

// --- status-line ownership helper ---
const setLine = src.match(/const AGGREGATED_PROGRESS_ITEM_KINDS = [^\n]+/);
const fnLine = src.match(/const shouldSuppressItemProgressStatusLine = [^\n]+/);
ok("work-item kind set declared", Boolean(setLine));
ok("status-line helper declared", Boolean(fnLine));
const shouldSuppress = new Function(`${setLine[0]}\n${fnLine[0]}\nreturn shouldSuppressItemProgressStatusLine;`)();
for (const kind of ["tool", "command", "patch", "search", "api"]) {
  ok(`suppresses ${kind} line during tool batch`, shouldSuppress(kind, true) === true);
}
ok("keeps plan lines", shouldSuppress("plan", true) === false);
ok("keeps approval lines", shouldSuppress("approval", true) === false);
ok("keeps unknown kinds", shouldSuppress(undefined, true) === false);
ok("no suppression when no tool batch", shouldSuppress("tool", false) === false);

// --- onItemEvent wiring order: activity bookkeeping -> guard -> legacy formatter ---
const itemMatch = src.match(/onItemEvent: previewStreamingEnabled \? \(payload\) => \{([\s\S]*?)\n\t\t\t\} : void 0,/);
ok("onItemEvent found", Boolean(itemMatch));
const itemBody = itemMatch ? itemMatch[1] : "";
ok("onItemEvent clears hold timer on activity", itemBody.includes("clearIdleCloseTimer();"));
ok("onItemEvent guards before formatting", itemBody.indexOf("shouldSuppressItemProgressStatusLine") < itemBody.indexOf("formatChannelProgressDraftLineForEntry("));
ok("onItemEvent still updates lastToolActivityAt", itemBody.includes("lastToolActivityAt = Date.now();"));

// --- compaction lines yield during a tool batch ---
ok("compaction start yields to tool batch", /onCompactionStart:[\s\S]{0,220}aggregatedToolTotal === 0/.test(src) && /compactionLine = buildCompactingLine\(\);/.test(src));
ok("compaction end clears line", /onCompactionEnd:[\s\S]{0,160}compactionLine = "";/.test(src));

// --- assistant text still owns the card ---
ok("assistant start clears transient status / keeps initial status when blank", /onAssistantMessageStart: previewStreamingEnabled \? \(\) => \{\s*renderEpoch \+= 1;\s*if \(aggregatedToolTotal > 0\) \{\s*clearTransientStatusLines\(\);\s*toolPhaseCompleted = true;\s*clearWaitingRefreshTimer\(\);\s*waitingLine = buildToolDoneLine\(aggregatedToolTotal\);/.test(src) && /const clearTransientStatusLines = \(\) => \{/.test(src));
ok("structured status fields exist", ["waitingLine", "itemStatusLine", "compactionLine", "narrationLine"].every((v) => src.includes(`let ${v} = "";`)));
ok("status renderer joins structured fields", /const primary = waitingLine \|\| itemStatusLine \|\| compactionLine \|\| narrationLine;/.test(src) && /const secondary = extras\.length > 0/.test(src));

finish("2026.10.5 block-fold/status-line");
