# feishu-tool-aggregation-wayE

A source patch for the OpenClaw Feishu channel plugin that folds tool-call
progress into a single bounded chat card and stops interleaved assistant
narration from leaking out as separate message bubbles.

This is a **new, self-contained** patch set. It supersedes the earlier
aggregation experiments and packages the final behaviour as one patch against a
pristine plugin bundle.

> **Repository scope.** This repository ships the **patch, installer, tests,
> anchor adapter and documentation** only. It does not redistribute the
> upstream `@openclaw/feishu` bundle. Apply the patch to your own installed
> 2026.10.5 bundle, then point the tests at that file.

## What it fixes

When the agent runs several tools in a row, the Feishu plugin used to emit one
line per tool and let mid-turn narration escape as its own bubble. Users saw a
wall of separate messages instead of one tidy status card.

Observed symptoms:

- A multi-tool turn produced many standalone bubbles (one per tool or label).
- Assistant narration written between tool calls appeared as extra bubbles.

## Root cause (from live gateway data)

The plugin routes two very different payloads through the same `kind:"tool"`
delivery path:

| payload | keys | example |
| --- | --- | --- |
| a genuine tool-summary event | `[text, mediaUrls]` — the **`mediaUrls` key is present, value `undefined`** | `🛠️ Exec` |
| assistant prose / narration | `[text]` — **no `mediaUrls` key at all** | `💬 let me run a burst` |

The original parser only checked "starts with an emoji + single line + ≤240
chars", so short narration was miscounted as a tool, and anything that failed the
shape check fell through to a standalone reply. The discriminating signal is
**presence of the `mediaUrls` key**, not its value:

- `Array.isArray(undefined)` is `false`, so a value-based check wrongly rejects
  real tool events (this is what an earlier, rejected revision did).

## The patch (23 hunks)

1. **Parser discriminator** — accept `kind:"tool"` only when an own `mediaUrls`
   key exists and its value is `undefined` or an empty array; ignore its empty
   value; stop treating narration as a tool.
2. **Narration-only delivery guard** — only provable mid-turn narration
   (`{text:"💬 …"}` with no media/presentation keys) is intercepted. Media-bearing
   tool results, MCP/custom tool payloads, verbose output and raw-mode progress
   keep legacy delivery, so real content is never silently swallowed.
3. **Narration ticker (option B)** — mid-turn narration is shown inside the card
   as a single rolling line (`💬 …`): latest narration only, whitespace collapsed,
   truncated to 120 chars by default (`narrationMaxChars`, 40–500), refreshed on every narration and cleared when final /
   assistant text starts. Narration never becomes a standalone bubble.
4. **Tool-summary parser for real emitter shapes** — accepts bare labels
   (`Exec`, `Bash`) and the actual 2026.10.5 verbose shapes (`Read: from …`,
   `Web Fetch: from …`, `Apply Patch`, `Session Settings`): labels are
   lower-cased, spaces/hyphens normalised to underscores, known label aliases
   mapped (`session_settings → sessions`), detail ignored for counting, and the
   text cap raised to 400 chars so normal detail payloads still count.
5. **Waiting-only progress line (compact status element)** — the card shows a
   compact status area in a dedicated markdown status element
   (`element_id: "status"`): a primary line
   `⏳ 已执行 N 个工具 · 最后：Read · 12s` (last tool + elapsed, refreshed every
   15s by default via `toolElapsedRefreshMs`, 5–60s) plus at most one
   secondary line with the latest narration. Status lines
   use single `\n` separators, a 160-char cap per line and a 400-char total
   budget, so progress/narration updates never rewrite the answer content
   element and never grow into a multi-paragraph block.
6. **Status-line ownership** — while a tool batch is active, per-item tool /
   command / patch / search / api progress lines and compaction lines do not
   overwrite the waiting line. The waiting line now persists through assistant
   message starts/segments (only transient item/compaction/narration lines are
   cleared) and is removed only on final delivery or card close, so it updates
   continuously instead of blinking out between tools.
7. **Card hold across a tool batch** — keep the streaming card open while tools
   accumulate. The close deadline is the remaining hold window (default 8s,
   configurable via `cardIdleHoldMs` 2–30s) measured from the latest tool
   activity; the timer is `unref()`ed and is cancelled/re-armed by new activity.
8. **Terminal release** — a terminal non-text outcome (including a failed
   reply) releases the card immediately; a tool-only turn ends with
   `✅ 已执行 N 个工具` instead of an empty card. A prewarmed card that never
   receives visible content (silent/skip turns) is discarded instead of leaving
   an empty card in the chat.
9. **Mid-turn block fold** — a `kind:"block"` narration emitted mid tool-batch
   folds into the active card instead of a new bubble.
10. **Listener lifecycle & race guards** — the hold timer is cleared on stream
    close, reset and reply start; `onIdle` returns the idle-finalization promise;
    narration refreshes the 8s hold window; a render-epoch guard drops
    narration/waiting-line writes that resolve after a final/assistant-start
    clear (post-await race); and the `onAssistantMessageStart` / compaction
    progress callbacks keep their original `false` return semantics.
11. **Display pipeline V1/V2** — early card prewarm (`prewarmCard`, card is
    ready before tools start) with an immediate `⏳ 已收到，正在处理…` status so the
    warm card is never blank while the model/agent thinks; latest-state backfill
    (queued updates render the latest state *after* the card starts, coalesced
    while starting), a dedicated CardKit status element with automatic content
    fallback if the element update is rejected, and structured status
    priority/budget. The initial status is kept through assistant message starts
    until the first token/tool/narration, eliminating the second blank window.
12. **Config, i18n & observability V3** — `cardIdleHoldMs`,
    `progressTexts` (waiting/completed/compacting/processing strings),
    `narrationMaxChars`, `showLastToolLabel`, `showToolElapsed`,
    `toolElapsedRefreshMs`, `cardStatusElement`, `cardStatusPosition`,
    `prewarmCard`; 15s start-failure
    backoff; card-start latency logs; running tool total (no per-event reduce)
    and surrogate-safe truncation.
14. **Display polish batch 2** — `cardStatusPosition: top|bottom` A/B switch,
    reasoning preview capped at `reasoningMaxLines` (default 12) with an
    ellipsis, thinking hidden from the final card by default
    (`hideReasoningInFinal`), and an optional compact final tool summary
    (`finalToolSummary`, default off). Elapsed refresh is now 15s by default
    and configurable via `toolElapsedRefreshMs`; disabling `showToolElapsed`
    skips the refresh timer entirely.
13. **Cleanup** — earlier port leftovers (`markVisibleReplySent`,
    `buildAggregatedToolSummaryLine`, `aggregatedToolSummaryLine`,
    `backfillTotal`, the card/tool backfill block) are removed.

## Version table

| plugin build | patch file | pristine sha256 | patched sha256 |
| --- | --- | --- | --- |
| `@openclaw/feishu` 2026.10.5 | `patches/2026.10.5/feishu-tool-aggregation.patch` | `72a0a198…3bfe` | `1d9eb846…f3e8` |

This repository starts with **one supported initial build**. New builds are not
silently fuzzy-patched: the installer compares SHA-256 against the known
pristine/patched hashes and refuses an unknown build. Adding a build means
re-running the anchor adapter and appending a row + manifest entry.

## Install

```sh
# point at the installed monitor bundle (glob resolves per install)
TARGET=$(ls ~/.openclaw/npm/projects/*/node_modules/@openclaw/feishu/dist/.setup/monitor.account-*.mjs | head -1)
./install.sh "$TARGET"
# then restart the gateway
```

The installer detects the target build by hash, backs up the original, applies
the matching patch, and verifies the result hash. It is idempotent — running it
twice reports `already patched`.

## Verify

```sh
sha256sum -c SHA256SUMS
cd tests
# TARGET = the patched bundle (installed path or local patched.mjs)
node run-all.mjs "$TARGET"

# individual suites
V="$TARGET"
node test-wayD-105.mjs $V        # parser / narration guard / media preservation
node test-wayB-105.mjs $V        # waiting line + aggregation
node test-wayC-105.mjs $V        # mid-turn block fold + status-line ownership
node exec-agg-105.mjs $V         # execution harness (deliver decisions)
node test-idle-release-105.mjs $V  # hold timer / release lifecycle
node test-narration-ticker-105.mjs $V  # option-B narration ticker
node test-display-backfill-105.mjs $V  # backfill + status element
node audit-agg-105.mjs $V        # structural audit
```

`run-all.mjs` runs every 2026.10.5 suite; the suites read the bundle path from
`argv[2]` (or `BUNDLE`), so you can point them at an installed file to audit the
live copy. CI runs the same matrix against a freshly fetched npm bundle.

## Revert

```sh
TARGET=$(ls ~/.openclaw/npm/projects/*/node_modules/@openclaw/feishu/dist/.setup/monitor.account-*.mjs | head -1)
cp -p "$(ls -t "$(dirname "$TARGET")"/.monitor.backup-*.mjs | head -1)" "$TARGET"
```

Or reinstall the plugin to restore the pristine bundle.

## 2026.10.5: waiting-only progress line

The 2026.10.5 port changes what the card shows. Earlier implementations folded per-tool
lines into a summary such as `🛠️ 3 tools: 🛠️ Exec ×3`. That summary is gone; the
card now carries a compact progress area:

```
⏳ 已执行 3 个工具 · 最后：Read · 12s
💬 正在检查配置…
```

The first line is the waiting line (with last tool and elapsed time when
enabled, refreshed every 15s by default); the second line is the latest narration. Both are capped so they
stay close to two visual lines instead of growing into paragraphs.

Mid-turn narration (`💬 …`) is displayed inside the same card as a single
rolling ticker line: only the latest narration is kept (whitespace collapsed,
truncated to 120 chars by default), each new narration replaces the previous
one, and the line is cleared as soon as the assistant answer starts streaming
or a final payload arrives. Narration never becomes a standalone bubble. Feishu cards have
no native scroll container, so this is a content-refresh ticker rather than an
animated scrollbar.

While a tool batch is active the aggregator owns the card progress line:
per-tool labels/counts are not rendered, and per-item tool/phase lines are
suppressed so they cannot overwrite the waiting line. The chat surface is: no
narration bubbles outside the card, one waiting line inside it.

Non-aggregatable real tool content (media-bearing tool results, MCP/custom tool
payloads, verbose output, raw-mode progress) keeps the legacy delivery path
instead of being dropped — content safety comes before "zero bubbles".

### Card display config (optional)

| config key | default | effect |
| --- | --- | --- |
| `prewarmCard` | `true` | start the streaming card at reply start (when preview streaming is on) |
| `cardStatusElement` | `true` | use a dedicated CardKit `status` element; `false` merges status into content |
| `cardIdleHoldMs` | `8000` | tool-batch hold window (2–30s) |
| `progressTexts.toolWaiting` | `⏳ 已执行 {count} 个工具` | waiting line template |
| `progressTexts.toolCompleted` | `✅ 已执行 {count} 个工具` | tool-only completion line |
| `progressTexts.compacting` | `📦 **Compacting context...**` | compaction line |
| `showLastToolLabel` | `true` | append `（最后：Read）`-style detail to the waiting line |
| `showToolElapsed` | `true` | append elapsed seconds (e.g. `12s`) to the waiting line; disabling skips the refresh timer |
| `toolElapsedRefreshMs` | `15000` | elapsed refresh interval (5–60s) |
| `narrationMaxChars` | `120` | max code points for the narration ticker (40–500) |
| `progressTexts.processing` | `✍️ 正在生成回复…` | fallback status when assistant starts before first token/tool |
| `progressTexts.prewarm` | `⏳ 已收到，正在处理…` | initial status on a prewarmed blank card |
| `cardStatusPosition` | `bottom` | status element position: `bottom` (current) or `top` for always-visible progress (A/B) |
| `reasoningMaxLines` | `12` | max reasoning preview lines (2–100), followed by `…` |
| `hideReasoningInFinal` | `true` | hide thinking from the final card when an answer exists |
| `finalToolSummary` | `false` | append `> ✅ N 个工具 · 12s` to a mixed final answer |

> **Plugin schema note.** OpenClaw's `openclaw.plugin.json` currently rejects
> unknown Feishu config keys (`must not have additional properties`). The config
> table below documents the **code defaults / reserved keys** implemented by this
> patch; setting them in `channels.feishu` makes the config invalid until a
> schema adapter is added. Treat them as compiled defaults for now.

### Requires `verboseLevel: on`

This is the one hard prerequisite. With `verboseLevel: off` tool events never
reach the plugin's `deliver` / `onItemEvent` hooks, so nothing is aggregated and
no progress line appears. Enable it per session:

```sh
openclaw gateway call sessions.patch \
  --params '{"key":"agent:main:main","verboseLevel":"on"}'
```

That override is **per session**. New sessions fall back to the default.

### Initial 2026.10.5 behavior

This repository starts at the 2026.10.5 build. The sections below describe that
initial behavior; no older plugin builds are shipped.

### Bare-label payloads

The real 2026.10.5 emitter sends tool summaries as `kind:"tool"` payloads with
an own `mediaUrls` key (`{text, mediaUrls: undefined}`). Verbose shapes are:

- `exec` / `bash` / `shell` → bare labels (`Exec`, `Bash`, `Shell`);
- most other tools → `Label: detail` (e.g. `Read: from /a`,
  `Web Fetch: from https://…`, `Web Search: for "…"`);
- some tools → multi-word labels (`Apply Patch`, `Session Settings`).

The parser lower-cases labels, normalises spaces/hyphens to `_`, maps known
aliases (`session_settings → sessions`), ignores the detail part, and accepts
`Label: detail` shapes up to 400 chars. Only labels in this whitelist are
counted, so short prose is never miscounted as a tool:

```
exec bash shell read write edit apply_patch grep glob ls browser
web_fetch web_search image view_image process sessions message
task todo memory node canvas
```

**Known limitation:** tools outside the normalised whitelist (MCP servers,
plugin-provided tools) are not counted in the waiting line. If such a payload is
otherwise deliverable (media result, plugin payload, verbose output) it keeps the
legacy delivery path and is never silently dropped; add the label (plus an alias
if the live label differs) to `BARE_TOOL_LABELS` to count it. In
`verboseLevel: full`, shell summaries are emitted as detail-only text (for
example `ls -la` without a label), so they also keep legacy delivery rather than
being counted.

**Status element validation:** CardKit rejects empty element content
(HTTP 400 / `99992402 field validation failed`), so clearing the status uses a
zero-width-space marker. A direct CardKit API probe verified create/update/clear
for the `status` element in streaming mode. If a live call still fails, the
session marks status unavailable and automatically falls back to rendering
status inside the content element. Set `cardStatusElement: false` to force the
content-only path.

**Ticker limitation:** the narration ticker is a single content-refreshed line
inside the card — Feishu cards provide no native scroll container, so there is
no animation and no history. Only the latest narration is visible; if full
narration history is required, a collapsible card panel would be needed
(not implemented by this patch).

### Card/tool race

Local commands finish in well under a second while card creation takes seconds.
The patch now prewarms the card at reply start (when preview streaming is
enabled), and queued card updates carry render functions instead of captured
strings: after `streamingStartPromise` resolves, the queue renders the **latest**
display state (waiting line, narration, answer, status element). Updates issued
while the card is starting are coalesced into one pending flush, so the first
frame already shows the current state instead of replaying stale intermediate
frames.

The old `backfillTotal` snippet is intentionally not restored: tool delivery is
serialized and counts are only available after the card exists, so a
count-based backfill block could never fire. Early prewarm + latest-state
backfill is the correct replacement.

### Review fixes folded in

| issue | fix |
| --- | --- |
| `onToolResult` returned `{visible:true}` but core never consumes it | removed (dead code) |
| `markVisibleReplySent()` polluted delivery bookkeeping | removed |
| bare-label regex accepted any letter string | replaced with whitelist |
| delivery guard swallowed every non-error `kind:"tool"` payload | narrowed to provable narration only; media/MCP/raw-mode content keeps legacy delivery |
| real emitter emits `Read: from …` / `Web Fetch: …` and labels with spaces, so only shell-family payloads were counted | parser accepts label+detail shapes, normalises spaces/hyphens and maps aliases; tests use real emitter fixtures |
| narration/waiting line could be resurrected by a write that resolved after a final/assistant-start clear | render-epoch guard; stale post-await writes are dropped |
| narration did not refresh the idle-hold window | narration updates `lastToolActivityAt` and cancels the pending close timer |
| `onAssistantMessageStart` / compaction callbacks lost their `false` return | restored `return updateStreamingStatusLine(...)` / `return false` |
| `failed` reply outcome could still hold the card for 8s | `terminalQuiet` includes `failed` |
| card was created lazily after the first tool/narration, leaving a 1–2s blank window | early prewarm at reply start (`prewarmCard`) |
| updates issued during card creation replayed stale captured text | latest-state backfill via render providers + coalesced pending flush |
| every status/narration update rewrote the whole answer markdown | dedicated status element + automatic content fallback |
| single `statusLine` string allowed one writer to clobber another | structured fields with priority/budget |
| start-failure backoff was 60s and produced repeated legacy bubbles | 15s backoff + card-start latency logs |
| prewarmed silent turns could leave an empty card | empty/no-tool/no-narration cards are discarded |
| `onIdle` dropped the idle-finalization promise; timer callback had no `catch` | promise returned from `onIdle`; timer callback `.catch`ed |
| hold deadline restarted from the first idle and was not re-armed | deadline is the remaining 8s window from latest activity; activity cancels/re-arms |
| 15s timer without `unref` (earlier draft) | `unref?.()`, 8s window, cleared on close/reset/reply start |
| duplicated `midTurnBlockFold` condition | simplified |

## Upgrading to a new plugin build

Upgrading OpenClaw or `@openclaw/feishu` rewrites `dist/` and reverts the patch.
After an upgrade:

```sh
grep -c parseCollapsibleToolSummary ~/.openclaw/npm/projects/*/node_modules/@openclaw/feishu/dist/.setup/monitor.account-*.mjs
```

`0` means the patch is gone. Fetch/re-derive it for the new build:

1. **Extract the new pristine bundle** (`npm pack @openclaw/feishu@<new>`).
2. **Run the anchor adapter** against the previous reference patch:

   ```sh
   python3 tools/adapt_patch.py      --pristine "$NEW_BUNDLE"      --from-patch patches/2026.10.5/feishu-tool-aggregation.patch      --version <new-version>      --out-dir patches/<new-version>      --update-manifest --set-current
   ```

   It re-locates every hunk by its **full old block** (context + removed
   lines), requires a unique match, and never uses line numbers or fuzz. If
   upstream changed a block, it fails loudly; review the diff manually instead
   of forcing it.

3. **Review/rebase** the generated diff, then:
   - add the printed install line to `install.sh`;
   - append the version to `.github/workflows/verify.yml` matrix;
   - run `python3 tools/verify_patch.py --all` and the full test suite;
   - canary deploy, check card create/status/close logs, then commit.

The installer always applies only an **exact pristine hash**, creates a backup,
and verifies the post-patch hash; failure restores the backup. An unknown build
is refused rather than patched with fuzz.

## Layout

```
README.md                       project overview, install, verify, adapter workflow
VERIFICATION.md                 local verification + sanitized live-test record
LICENSE                         MIT
install.sh                      exact-build installer: hash select, backup, rollback
SHA256SUMS                      patch + installer hashes
.github/workflows/verify.yml    CI matrix: fetch pristine → adapter check → tests
patches/
  MANIFEST.json                 supported version hashes/status (source of truth)
  2026.10.5/
    feishu-tool-aggregation.patch    current initial patch
tests/
  run-all.mjs                 suite runner
  test-wayD-105.mjs           parser / narration guard / media preservation
  test-wayB-105.mjs           waiting line + aggregation
  test-wayC-105.mjs           mid-turn block fold + status-line ownership
  exec-agg-105.mjs            execution harness (deliver decisions)
  test-idle-release-105.mjs   hold timer / release lifecycle
  test-narration-ticker-105.mjs narration ticker (option B)
  test-display-backfill-105.mjs latest-state backfill + status element
  audit-agg-105.mjs           structural audit
tools/
  adapt_patch.py              anchor-based rebase adapter
  verify_patch.py             strict patch applier/verifier
```

The upstream plugin bundles (`original.mjs` / `patched.mjs`) are not
redistributed in the GitHub repository; apply the diff to your local installed
build. The old 2026.10.1/2026.10.2 versions are intentionally not included.

## License

MIT — see `LICENSE`.
