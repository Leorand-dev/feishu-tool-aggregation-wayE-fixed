// Shared helpers for the 2026.10.5 test suites.
import fs from "node:fs";

export function loadBundle(argv = process.argv) {
  const file = argv[2] || process.env.BUNDLE || "../patches/2026.10.5/patched.mjs";
  return fs.readFileSync(file, "utf8");
}

/** Extract `const name = (...) => { ... };` verbatim (closing line must be "\t};"). */
export function extractArrow(src, name) {
  const head = `const ${name} = (`;
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`missing function: ${name}`);
  const end = src.indexOf("\n\t};", start);
  if (end < 0) throw new Error(`unterminated function: ${name}`);
  return src.slice(start, end + 4);
}

export function extractAsyncArrow(src, name) {
  const head = `const ${name} = async (`;
  const start = src.indexOf(head);
  if (start < 0) throw new Error(`missing async function: ${name}`);
  const end = src.indexOf("\n\t};", start);
  if (end < 0) throw new Error(`unterminated async function: ${name}`);
  return src.slice(start, end + 4);
}

export function extractOnIdleBody(src) {
  const m = src.match(/onIdle: \(\) => \{([\s\S]*?)\n\t\t\},/);
  if (!m) throw new Error("onIdle not found");
  return m[1];
}

export function extractBareToolLabels(src) {
  const m = src.match(/const BARE_TOOL_LABELS = [\s\S]*?\]\);/);
  if (!m) throw new Error("BARE_TOOL_LABELS not found");
  return m[0];
}

export function extractNarrationPrefix(src) {
  const m = src.match(/const TOOL_NARRATION_TEXT_PREFIX = [^\n]+/);
  if (!m) throw new Error("TOOL_NARRATION_TEXT_PREFIX not found");
  return m[0];
}

/** One-line `const NAME = ...;` declaration (e.g. prefix, alias map, max chars). */
export function extractConstLine(src, name) {
  const m = src.match(new RegExp(`const ${name} = [^\\n]+`));
  if (!m) throw new Error(`${name} line not found`);
  return m[0];
}

/** Closure preamble needed to execute the tool-summary parsers. */
export function buildParserEnv(src) {
  return [
    extractConstLine(src, "TOOL_NARRATION_TEXT_PREFIX"),
    extractConstLine(src, "TOOL_LABEL_ALIASES"),
    extractArrow(src, "normalizeToolLabel"),
    extractConstLine(src, "TOOL_SUMMARY_MAX_CHARS"),
    extractArrow(src, "getToolSummaryText"),
  ].join("\n");
}

export function count(src, needle) {
  return src.split(needle).length - 1;
}

export function makeCounter() {
  let pass = 0;
  let fail = 0;
  const ok = (name, cond, detail = "") => {
    if (cond) {
      pass += 1;
      console.log("PASS  " + name);
    } else {
      fail += 1;
      console.log("FAIL  " + name + (detail ? " — " + detail : ""));
    }
  };
  const finish = (label = "") => {
    console.log(`\n${pass} passed, ${fail} failed${label ? " (" + label + ")" : ""}`);
    process.exit(fail === 0 ? 0 : 1);
  };
  return { ok, finish };
}
