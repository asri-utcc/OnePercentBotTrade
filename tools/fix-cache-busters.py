#!/usr/bin/env python3
"""
FIX-2026-09-01 audit H9: normalize all cache-busters in public/*.html.

Strategy: pick a single canonical stamp `2026-09-01-h9` (the audit-fix
release tag) and apply it everywhere a /js/ or /css/ asset is referenced
without one. Also rewrite specific known-bad stamps to the canonical form.

After running this script, the cacheBusterConsistency test should pass.

Run: python tools/fix-cache-busters.py
"""
import os
import re
import sys

PUBLIC_DIR = os.path.join(os.path.dirname(__file__), '..', 'public')
CANONICAL_STAMP = '2026-09-01-h9'

# Map of (path substring, old query) → new query for specific files that need
# a stamp reflecting their most recent change (not the audit-fix stamp).
SPECIFIC_REWRITES = {
    # masterConfigModal.js had `fix-master-auto-timing-20260831` in bots.html
    # but no stamp in another page — standardize to audit stamp.
    ('/js/partials/masterConfigModal.js', 'v=fix-master-auto-timing-20260831'):
        f'v={CANONICAL_STAMP}',
}

# Files whose cache-buster is known-bad format and must be rewritten to CANONICAL.
# (path, old query) → new query
KNOWN_BAD_REWRITES = {
    ('/css/app.css', 'v=2026-08-30-fix1'): f'v={CANONICAL_STAMP}',
    ('/js/ws-client.js', 'v=2026-08-29-fix3'): f'v={CANONICAL_STAMP}',
    ('/js/pages/autoTiming.js', 'v=2026-08-30-ux5-fix3'): f'v={CANONICAL_STAMP}',
    ('/js/pages/autoTiming.js', 'v=2026-09-01-pnl-strip'): f'v={CANONICAL_STAMP}',
    ('/js/partials/autoTimingTile.js', 'v=2026-08-30'): f'v={CANONICAL_STAMP}',
    ('/js/pages/chat.js', 'v=2026-09-01-v5'): f'v={CANONICAL_STAMP}',
    ('/js/pages/settings.js', 'v=2026-08-30-autoTiming'): f'v={CANONICAL_STAMP}',
    ('/js/pages/trade-analysis.js', 'v=2026-08-30-heat5'): f'v={CANONICAL_STAMP}',
    ('/js/pages/chart-monitor.js', 'v=2026-08-30-fix1'): f'v={CANONICAL_STAMP}',
}


def fix_file(path):
    with open(path, 'r', encoding='utf-8') as f:
        src = f.read()
    orig = src

    # Pattern 1: <script src="/js/foo.js"> (no query) → <script src="/js/foo.js?v=CANONICAL">
    # Match <script src="/js/..."> or <script src='/js/...'> with no ? in URL.
    def add_query_to_local(m):
        url = m.group(1)
        # Only touch /js/ and /css/ assets
        if not (url.startswith('/js/') or url.startswith('/css/')):
            return m.group(0)
        if '?' in url:
            return m.group(0)  # already has a query
        # Add the canonical cache-buster
        return m.group(0).replace(url, f'{url}?v={CANONICAL_STAMP}')
    src = re.sub(r'<script\s+src=["\'](/js/[^"\']+|/css/[^"\']+)["\']', add_query_to_local, src)
    # Match <link href="/css/foo.css"> without ?
    def add_query_to_css(m):
        url = m.group(1)
        if '?' in url:
            return m.group(0)
        return m.group(0).replace(url, f'{url}?v={CANONICAL_STAMP}')
    src = re.sub(r'<link\s+href=["\'](/css/[^"\']+)["\']', add_query_to_css, src)

    # Pattern 2: rewrite known-bad stamps
    for (path_substr, old_query), new_query in {**KNOWN_BAD_REWRITES, **SPECIFIC_REWRITES}.items():
        old_url_form = f'{path_substr}?{old_query}'
        new_url_form = f'{path_substr}?{new_query}'
        if old_url_form in src:
            src = src.replace(old_url_form, new_url_form)

    if src != orig:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(src)
        return True
    return False


def main():
    changed = []
    for fname in sorted(os.listdir(PUBLIC_DIR)):
        if not fname.endswith('.html'):
            continue
        full = os.path.join(PUBLIC_DIR, fname)
        if fix_file(full):
            changed.append(fname)
    print(f'Updated {len(changed)} files:')
    for c in changed:
        print(f'  {c}')


if __name__ == '__main__':
    main()
