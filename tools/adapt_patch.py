#!/usr/bin/env python3
"""Anchor-based patch adapter for the @openclaw/feishu monitor bundle.

The reference patch is a unified diff against one exact pristine build.  For a
new build this tool re-locates every hunk by its *full old block* (context plus
removed lines), requires a unique match in the new bundle, and re-applies the
replacement.  Line numbers/fuzz are never used: if upstream changed any line
inside a hunk, the adapter fails loudly and the patch must be reviewed manually.

Usage:
  # regression: regenerate the current patched bundle from pristine and compare
  python3 tools/adapt_patch.py \
    --pristine patches/2026.10.5/original.mjs \
    --from-patch patches/2026.10.5/feishu-tool-aggregation.patch \
    --version 2026.10.5 --self-check

  # adapt to a new build (writes patches/<version>/ + manifest entry)
  python3 tools/adapt_patch.py \
    --pristine /path/to/new/monitor.account-*.mjs \
    --from-patch patches/2026.10.5/feishu-tool-aggregation.patch \
    --version 2026.11.0 --out-dir patches/2026.11.0 \
    --update-manifest --set-current

  # CI: check a fetched pristine bundle without local original/patched files
  python3 tools/adapt_patch.py \
    --pristine "$TARGET" --from-patch patches/2026.10.5/feishu-tool-aggregation.patch \
    --version 2026.10.5 --out-dir "$RUNNER_TEMP/adapted" \
    --expect-sha <patched_sha_from_MANIFEST> --no-manifest
"""
import argparse
import difflib
import hashlib
import json
import pathlib
import re
import sys

HUNK_RE = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
ROOT = pathlib.Path(__file__).resolve().parents[1]


def sha256_bytes(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def parse_hunks(patch_text: str):
    lines = patch_text.splitlines()
    hunks = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if not line.startswith("@@ "):
            i += 1
            continue
        m = HUNK_RE.match(line)
        if not m:
            raise ValueError(f"invalid hunk header: {line}")
        header = line
        old_start = int(m.group(1))
        i += 1
        old_lines, new_lines = [], []
        while i < len(lines):
            cur = lines[i]
            if cur.startswith("@@ ") or cur.startswith("--- ") or cur.startswith("+++ "):
                break
            if cur.startswith("\\ No newline"):
                i += 1
                continue
            prefix, body = cur[:1], cur[1:]
            if prefix == " ":
                old_lines.append(body)
                new_lines.append(body)
            elif prefix == "-":
                old_lines.append(body)
            elif prefix == "+":
                new_lines.append(body)
            elif cur == "":
                # Empty context line in a hand-written diff is treated as context.
                old_lines.append("")
                new_lines.append("")
            else:
                raise ValueError(f"unexpected diff line at hunk {header!r}: {cur!r}")
            i += 1
        hunks.append({
            "header": header,
            "old_start": old_start,
            "old": old_lines,
            "new": new_lines,
        })
    if not hunks:
        raise ValueError("no hunks found in reference patch")
    return hunks


def find_unique(work, block):
    if not block:
        return []
    n = len(block)
    matches = []
    for i in range(0, len(work) - n + 1):
        if work[i:i + n] == block:
            matches.append(i)
    return matches


def adapt(pristine_text: str, reference_patch: str):
    hunks = parse_hunks(reference_patch)
    work = pristine_text.splitlines()
    for idx, hunk in enumerate(hunks, 1):
        old_block = hunk["old"]
        if not old_block:
            raise ValueError(f"hunk {idx} has no old block: {hunk['header']}")
        matches = find_unique(work, old_block)
        if len(matches) != 1:
            raise ValueError(
                f"hunk {idx} anchor not unique: {len(matches)} match(es) "
                f"for {hunk['header']} (old block lines={len(old_block)}). "
                "Upstream changed this block; review manually."
            )
        pos = matches[0]
        work[pos:pos + len(old_block)] = hunk["new"]
    patched_text = "\n".join(work) + "\n"
    return patched_text, hunks


def make_patch(pristine_text: str, patched_text: str) -> str:
    diff = difflib.unified_diff(
        pristine_text.splitlines(), patched_text.splitlines(),
        fromfile="original.mjs", tofile="patched.mjs", lineterm="",
    )
    return "\n".join(diff) + "\n"


def load_manifest(path: pathlib.Path):
    if path.exists():
        return json.loads(path.read_text(encoding="utf-8"))
    return {"schema": 1, "current": None, "versions": []}


def update_manifest(manifest_path: pathlib.Path, entry, set_current: bool):
    manifest = load_manifest(manifest_path)
    versions = [v for v in manifest.get("versions", []) if v.get("version") != entry["version"]]
    versions.append(entry)
    versions.sort(key=lambda v: v["version"])
    manifest["versions"] = versions
    if set_current:
        manifest["current"] = entry["version"]
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")


def main():
    ap = argparse.ArgumentParser(description="Anchor-based patch adapter")
    ap.add_argument("--pristine", required=True)
    ap.add_argument("--from-patch", required=True)
    ap.add_argument("--version", required=True)
    ap.add_argument("--out-dir", default=None)
    ap.add_argument("--manifest", default=str(ROOT / "patches" / "MANIFEST.json"))
    ap.add_argument("--expect-sha", default=None)
    ap.add_argument("--self-check", action="store_true")
    ap.add_argument("--update-manifest", action="store_true")
    ap.add_argument("--set-current", action="store_true")
    ap.add_argument("--no-manifest", action="store_true")
    args = ap.parse_args()

    pristine_path = pathlib.Path(args.pristine)
    patch_path = pathlib.Path(args.from_patch)
    if not pristine_path.is_file():
        raise SystemExit(f"pristine not found: {pristine_path}")
    if not patch_path.is_file():
        raise SystemExit(f"reference patch not found: {patch_path}")

    pristine_bytes = pristine_path.read_bytes()
    pristine_text = pristine_bytes.decode("utf-8")
    if "\r\n" in pristine_text:
        raise SystemExit("CRLF is not supported; use an LF bundle")
    reference_patch = patch_path.read_text(encoding="utf-8")

    patched_text, hunks = adapt(pristine_text, reference_patch)
    patched_bytes = patched_text.encode("utf-8")
    new_patch = make_patch(pristine_text, patched_text)
    orig_sha = sha256_bytes(pristine_bytes)
    patched_sha = sha256_bytes(patched_bytes)
    patch_sha = sha256_bytes(new_patch.encode("utf-8"))

    if args.self_check:
        expected = pathlib.Path(ROOT / "patches" / args.version / "patched.mjs")
        if not expected.is_file():
            raise SystemExit(f"self-check expected patched bundle missing: {expected}")
        expected_sha = sha256_bytes(expected.read_bytes())
        if patched_sha != expected_sha:
            raise SystemExit(f"self-check FAILED: regenerated={patched_sha} expected={expected_sha}")
        print(f"self-check PASS: {len(hunks)} hunks, patched sha {patched_sha}")

    if args.expect_sha and patched_sha != args.expect_sha:
        raise SystemExit(f"expected-sha FAILED: generated={patched_sha} expected={args.expect_sha}")

    out_dir = pathlib.Path(args.out_dir) if args.out_dir else ROOT / "patches" / args.version
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "original.mjs").write_bytes(pristine_bytes)
    (out_dir / "patched.mjs").write_bytes(patched_bytes)
    patch_file = out_dir / ("feishu-tool-aggregation.patch" if args.version == "2026.10.5" else "feishu-tool-aggregation.patch")
    patch_file.write_text(new_patch, encoding="utf-8", newline="\n")

    print(f"version   = {args.version}")
    print(f"hunks     = {len(hunks)}")
    print(f"original  = {orig_sha}")
    print(f"patched   = {patched_sha}")
    print(f"patch     = {patch_sha}")
    print(f"out       = {out_dir}")

    if args.update_manifest and not args.no_manifest:
        entry = {
            "version": args.version,
            "original_sha256": orig_sha,
            "patched_sha256": patched_sha,
            "patch_sha256": patch_sha,
            "patch": f"{args.version}/{patch_file.name}",
            "tests": "tests/run-all.mjs",
            "adapter": "anchor-rebase-v1",
            "status": "supported",
        }
        update_manifest(pathlib.Path(args.manifest), entry, args.set_current)
        print(f"manifest  = {args.manifest}")

    print(f'install line: "{args.version} {orig_sha} {patched_sha} $HERE/patches/{args.version}/{patch_file.name}"')


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"ADAPTER FAILED: {exc}", file=sys.stderr)
        sys.exit(1)
