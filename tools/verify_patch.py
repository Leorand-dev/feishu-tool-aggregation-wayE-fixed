#!/usr/bin/env python3
"""Standalone unified-diff applier/verifier (no git/patch available).

Parses a single-file unified diff (@@ -a,b +c,d @@ / context / - / + /
"\\ No newline at end of file"), applies it strictly with bounded offset search,
and reports per-hunk offsets/fuzz. Supports --reverse.

Usage:
  python apply_patch.py --file <patch> <base-file> <expected-output> [--reverse]
  python apply_patch.py --all <repo>/patches     # verify all 3 version dirs
Exit code 0 = ok, 1 = mismatch/error.
"""
import sys, re, hashlib, os

class DiffError(Exception):
    pass

def read_bytes(path):
    with open(path, 'rb') as f:
        return f.read()

def split_lines(data):
    """Return list of (content_bytes_without_nl, has_trailing_newline)."""
    out = []
    i = 0
    n = len(data)
    while i < n:
        j = data.find(b'\n', i)
        if j < 0:
            out.append((data[i:], False))
            break
        out.append((data[i:j], True))
        i = j + 1
    return out

HUNK_RE = re.compile(rb'^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@')

def parse_patch(data):
    raw = data.split(b'\n')
    if raw and raw[-1] == b'':
        raw.pop()
    hunks = []
    headers = []          # ('---'|'+++', name)
    malformed = []
    i = 0
    cur = None
    while i < len(raw):
        line = raw[i]
        if line.startswith(b'--- ') or line.startswith(b'+++ '):
            kind = line[:3].decode()
            headers.append((kind, line[4:].split(b'\t')[0].decode(errors='replace')))
            cur = None
            i += 1
            continue
        m = HUNK_RE.match(line)
        if m:
            old_start = int(m.group(1))
            old_cnt = int(m.group(2)) if m.group(2) is not None else 1
            new_start = int(m.group(3))
            new_cnt = int(m.group(4)) if m.group(4) is not None else 1
            cur = {'old_start': old_start, 'old_cnt': old_cnt,
                   'new_start': new_start, 'new_cnt': new_cnt,
                   'entries': [], 'header': line.decode(errors='replace')}
            hunks.append(cur)
            i += 1
            continue
        if cur is None:
            # preamble / unknown lines between files are tolerated
            i += 1
            continue
        if line.startswith(b'\\'):
            if not cur['entries']:
                malformed.append('No-newline marker with no preceding line in hunk ' + cur['header'])
            else:
                tag, content, _ = cur['entries'][-1]
                cur['entries'][-1] = (tag, content, True)
            i += 1
            continue
        if line.startswith(b'@'):
            malformed.append('second @@ on one hunk line: ' + line.decode(errors='replace'))
            cur = None
            i += 1
            continue
        if line[:1] == b' ':
            cur['entries'].append((' ', line[1:], False))
        elif line[:1] == b'-':
            cur['entries'].append(('-', line[1:], False))
        elif line[:1] == b'+':
            cur['entries'].append(('+', line[1:], False))
        elif line == b'':
            # blank line inside hunk (some editors strip the leading space): context, empty
            cur['entries'].append((' ', b'', False))
        else:
            malformed.append('unparseable line %d in hunk %s: %r' %
                             (i + 1, cur['header'], line[:80]))
        i += 1
    # validate declared counts against actual lines
    for h in hunks:
        o = sum(1 for t, _, _ in h['entries'] if t in ' -')
        n = sum(1 for t, _, _ in h['entries'] if t in ' +')
        if o != h['old_cnt']:
            malformed.append('%s: old count declared %d actual %d' % (h['header'], h['old_cnt'], o))
        if n != h['new_cnt']:
            malformed.append('%s: new count declared %d actual %d' % (h['header'], h['new_cnt'], n))
    return headers, hunks, malformed

def apply_diff(data, hunks, reverse=False, window=200):
    orig = split_lines(data)
    out = []
    pos = 0
    diags = []
    for idx, h in enumerate(hunks):
        old_start = h['new_start'] if reverse else h['old_start']
        old_seq = []   # (content, no_nl_marker)
        for tag, content, nonl in h['entries']:
            eff = tag
            if reverse:
                eff = {'+': '-', '-': '+', ' ': ' '}[tag]
            if eff in (' ', '-'):
                old_seq.append((content, nonl))
        expected = old_start - 1
        if expected < pos:
            raise DiffError('hunk %d: expected %d < already consumed %d (overlap)' %
                            (idx + 1, expected, pos))
        def matches(p):
            if p < 0 or p + len(old_seq) > len(orig):
                return False
            for k, (content, nonl) in enumerate(old_seq):
                oc, onl = orig[p + k]
                if oc != content:
                    return False
                # marker means: this line has no trailing newline
                if nonl and onl:
                    return False
                if not nonl and not onl:
                    return False
            return True
        lo = max(pos, expected - window)
        hi = min(len(orig) - len(old_seq), expected + window)
        found = None
        if matches(expected):
            found = expected
        else:
            for p in range(expected + 1, hi + 1):
                if matches(p):
                    found = p
                    break
            if found is None:
                for p in range(expected - 1, lo - 1, -1):
                    if matches(p):
                        found = p
                        break
        if found is None:
            raise DiffError('hunk %d %s: old text not found within +/-%d lines of line %d (actual file lines %d)' %
                            (idx + 1, h['header'], window, old_start, len(orig)))
        offset = found - expected
        out.extend(orig[pos:found])
        q = found
        for tag, content, nonl in h['entries']:
            eff = tag
            if reverse:
                eff = {'+': '-', '-': '+', ' ': ' '}[tag]
            if eff == ' ':
                out.append(orig[q]); q += 1
            elif eff == '-':
                q += 1
            else:
                out.append((content, not nonl))
        pos = q
        diags.append({'hunk': idx + 1, 'header': h['header'], 'expected_line': old_start,
                      'applied_at': found + 1, 'offset': offset, 'fuzz': 'no' if offset == 0 else 'offset %+d' % offset})
    out.extend(orig[pos:])
    data_out = b''.join(c + (b'\n' if nl else b'') for c, nl in out)
    return data_out, diags

def sha(data):
    return hashlib.sha256(data).hexdigest()

def run_one(patch_path, base_path, expected_path, reverse=False):
    patch_data = read_bytes(patch_path)
    headers, hunks, malformed = parse_patch(patch_data)
    print('patch: %s' % patch_path)
    print('  headers: %s' % ', '.join('%s %s' % h for h in headers))
    print('  hunk_count: %d' % len(hunks))
    print('  no_newline_markers: %d' % patch_data.count(b'\n\\ No newline'))
    print('  crlf_in_patch: %s' % ('yes' if b'\r\n' in patch_data else 'no'))
    print('  malformed: %s' % (malformed if malformed else 'none'))
    base = read_bytes(base_path)
    expected = read_bytes(expected_path)
    try:
        result, diags = apply_diff(base, hunks, reverse=reverse)
    except DiffError as e:
        print('  APPLY FAILED: %s' % e)
        return False
    for d in diags:
        print('  hunk %2d %-28s expected_line=%-5d applied_at=%-5d offset=%+d%s' %
              (d['hunk'], d['header'].split('@@')[1].strip() if '@@' in d['header'] else '',
               d['expected_line'], d['applied_at'], d['offset'],
               '' if d['offset'] == 0 else '   <-- OFFSET'))
    same = result == expected
    print('  base_sha256:     %s' % sha(base))
    print('  result_sha256:   %s' % sha(result))
    print('  expected_sha256: %s' % sha(expected))
    print('  BYTE_EXACT_ROUNDTRIP: %s' % ('PASS' if same else 'FAIL'))
    if not same and len(result) == len(expected):
        for i, (a, b) in enumerate(zip(result, expected)):
            if a != b:
                print('  first_byte_diff_at: %d result=%r expected=%r' % (i, result[max(0,i-40):i+40], expected[max(0,i-40):i+40]))
                break
    ok = same and not malformed
    return ok

def all_versions(repo_patches):
    """Discover every patches/<version>/ dir with original/patched/patch files."""
    versions = []
    for name in sorted(os.listdir(repo_patches)):
        d = os.path.join(repo_patches, name)
        if not os.path.isdir(d):
            continue
        patches = sorted(f for f in os.listdir(d) if f.endswith('.patch'))
        if not patches:
            continue
        patch = os.path.join(d, patches[0])
        orig = os.path.join(d, 'original.mjs')
        patched = os.path.join(d, 'patched.mjs')
        if os.path.isfile(orig) and os.path.isfile(patched) and os.path.isfile(patch):
            versions.append((name, os.path.basename(patch)))
    if not versions:
        print('no patch version dirs found under %s' % repo_patches)
        return False
    all_ok = True
    for ver, pname in versions:
        d = os.path.join(repo_patches, ver)
        patch = os.path.join(d, pname)
        orig = os.path.join(d, 'original.mjs')
        patched = os.path.join(d, 'patched.mjs')
        print('=' * 78)
        print('VERSION %s' % ver)
        print('-' * 78)
        fwd = run_one(patch, orig, patched, reverse=False)
        print('-' * 78)
        rev = run_one(patch, patched, orig, reverse=True)
        print('  FORWARD: %s  REVERSE: %s' % ('PASS' if fwd else 'FAIL', 'PASS' if rev else 'FAIL'))
        all_ok = all_ok and fwd and rev
    print('=' * 78)
    print('ALL_VERSIONS_APPLY_REVERSE_PASS: %s' % all_ok)
    return all_ok

if __name__ == '__main__':
    args = sys.argv[1:]
    reverse = '--reverse' in args
    args = [a for a in args if a != '--reverse']
    if len(args) == 1 and args[0].startswith('--all='):
        sys.exit(0 if all_versions(args[0][len('--all='):]) else 1)
    if len(args) == 1 and os.path.isdir(args[0]):
        # convenience: --all <patches dir>
        sys.exit(0 if all_versions(args[0]) else 1)
    if len(args) != 3:
        print(__doc__)
        sys.exit(2)
    ok = run_one(args[0], args[1], args[2], reverse=reverse)
    sys.exit(0 if ok else 1)
