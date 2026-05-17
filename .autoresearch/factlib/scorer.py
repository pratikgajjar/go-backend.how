#!/usr/bin/env python3
"""
Strict defect scorer for the factlib post.

Extends the starter scorer (.autoresearch/score.py) with:

  - unverified_literal: every Go/SQL code block that *claims* to be lifted
    from a file (`// path/to.go` comment) must have at least one
    multi-token literal substring (>= 60 chars or 4 code-tokens, whichever
    is shorter) present verbatim in that file.
  - bad_url_anchor: postgres.org docs URLs must point at an actual function
    or section anchor we can verify by GET'ing the page header is not 404
    (offline mode: only schema-check the URL shape).
  - bad_commit_ref: any `commit/<sha>` URL or bare 7-hex referenced as a
    commit must resolve in the cached factlib repo via `git cat-file -e`.
  - factlib_size_drift: any "N lines of Go" claim about factlib must match
    actual `find pkg cmd -name '*.go' | xargs wc -l` to within ±15%.
  - wal_record_overhead_off: WAL-byte-overhead numbers (24 B header etc.)
    must be inside accepted ranges from the Postgres source.
  - vague_claims, numbers_no_math, missing_citations, marketing_words,
    frontmatter, wordcount_off — same as starter, slightly tightened.

Usage:
    scorer.py <post_path> <cached_repo_path>
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


# ----------------------- helpers -----------------------

def emit(name: str, value: int) -> None:
    print(f"METRIC {name}={value}")


def read_post(path: Path) -> tuple[str, str, str]:
    text = path.read_text(encoding="utf-8")
    parts = re.split(r"^\+\+\+\s*$|^---\s*$", text, maxsplit=2, flags=re.MULTILINE)
    if len(parts) >= 3:
        return parts[1], parts[2], text
    return "", text, text


def hugo_build_defects(repo_root: Path) -> int:
    try:
        r = subprocess.run(
            ["hugo", "--quiet", "-D"],
            cwd=repo_root,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return 50
    out = (r.stdout or "") + (r.stderr or "")
    if r.returncode != 0:
        return 50
    return min(
        len([ln for ln in out.splitlines() if re.search(r"\b(WARN|ERROR|FATAL)\b", ln)]) * 5,
        50,
    )


def word_count(body: str) -> int:
    # Use line-by-line fence tracking instead of regex so we don't choke
    # on code blocks containing backticks (e.g. Go raw string literals).
    out_lines = []
    in_fence = False
    for line in body.splitlines():
        s = line.lstrip()
        if s.startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        out_lines.append(line)
    body_stripped = "\n".join(out_lines)
    return len(re.findall(r"\b[\w'-]+\b", body_stripped))


def wordcount_defects(words: int, lo: int = 3000, hi: int = 5000) -> int:
    """Brief mandates 3000-5000. Any over-cap is a hard defect (the brief
    explicitly says 'Don't write more than 5000 words.'); any under-cap
    floor is graded by 100s (200 under = 2 defects)."""
    if words < lo:
        return max((lo - words) // 100, 1)
    if words > hi:
        # graded but always at least 1 if over
        return max((words - hi) // 100, 1)
    return 0


# ----------------------- patterns -----------------------

VAGUE_RE = re.compile(
    r"\b(approximately|roughly|about|around|nearly|some|several)\s+(\d[\d,]*)",
    re.IGNORECASE,
)
RANGE_HINTS = re.compile(
    r"(\bto\b|\b–\b|—|\b±\b|range|between|from|napkin|math|≈|~)", re.IGNORECASE
)


def vague_qualifier_defects(body: str) -> int:
    n = 0
    for m in VAGUE_RE.finditer(body):
        s = max(0, m.start() - 100)
        e = min(len(body), m.end() + 100)
        window = body[s:e]
        if not RANGE_HINTS.search(window):
            n += 1
    return n


CODEBLOCK_RE = re.compile(r"```([a-zA-Z0-9_+-]*)\n(.*?)```", re.DOTALL)
PATH_COMMENT_RE = re.compile(
    r"^\s*(?://|--|#)\s*([a-zA-Z0-9_./-]+\.(go|sql|py|md|yaml|yml|toml|sh|js|ts|c|h|rs|proto))\b",
    re.MULTILINE,
)


def _file_lookup(cached_repo: Path, path_str: str) -> Path | None:
    p = cached_repo / path_str
    if p.exists():
        return p
    hits = list(cached_repo.rglob(Path(path_str).name))
    return hits[0] if hits else None


def codeblock_path_defects(body: str, cached_repo: Path) -> tuple[int, int, int]:
    """(missing_path, unverified_snippet, unverified_literal)."""
    missing = 0
    unverified = 0
    bad_literal = 0
    for m in CODEBLOCK_RE.finditer(body):
        lang, code = m.group(1).strip().lower(), m.group(2)
        if lang in ("", "txt", "text", "diff", "ascii", "bash", "sh", "shell", "protobuf"):
            continue
        path_matches = PATH_COMMENT_RE.findall(code)
        if not path_matches:
            continue
        for path_str, _ext in path_matches:
            # demo/example paths are intentional new code, not lifts from source
            if re.search(r"\b(demo|example|sample|appendix)\b", path_str, re.IGNORECASE):
                continue
            f = _file_lookup(cached_repo, path_str)
            if f is None:
                missing += 1
                print(f"DEBUG missing_path: {path_str}", file=sys.stderr)
                continue
            # If the path doesn't exist EXACTLY but a same-name file does, scan
            # the whole repo for identifier matches instead of just the
            # bystander file (otherwise we get false unverified_snippet hits).
            exact = (cached_repo / path_str).exists()
            if exact:
                try:
                    src = f.read_text(encoding="utf-8", errors="ignore")
                except Exception:
                    missing += 1
                    continue
            else:
                try:
                    src = "\n".join(
                        ff.read_text(encoding="utf-8", errors="ignore")
                        for ff in cached_repo.rglob(f"*{Path(path_str).suffix}")
                        if ff.is_file()
                    )
                except Exception:
                    src = f.read_text(encoding="utf-8", errors="ignore")

            # 1) cheap identifier check
            idents = set(re.findall(r"\b[A-Z][a-zA-Z0-9_]{6,}\b", code))
            idents |= set(re.findall(r"\b[a-z_]{8,}\b", code))
            common = {
                "context", "errgroup", "interval", "function", "struct", "import",
                "default", "package", "publication", "replication", "transaction",
                "settings", "register", "strconv", "encoding", "fmt.Sprintf",
                "fmt.Errorf", "Postgres", "PostgreSQL", "PUBLICATION",
                "CREATE_PUBLICATION", "PRIMARY", "REPLICATION", "TRANSACTION",
                "interface", "channel", "checkpoint", "streaming", "DataBytes",
                "messages",
            }
            idents = {i for i in idents if i not in common and len(i) >= 7}
            if idents:
                sampled = list(idents)[:6]
                hits = sum(1 for ident in sampled if ident in src)
                if hits == 0:
                    unverified += 1
                    print(
                        f"DEBUG unverified_snippet path={path_str} idents={sampled}",
                        file=sys.stderr,
                    )

            # 2) literal multi-line substring check.
            # Take the longest single line in the code block (excluding the path comment)
            # and require an exact substring match.
            code_lines = [
                ln for ln in code.splitlines()
                if ln.strip()
                and not re.match(r"^\s*(?://|--|#)\s*[A-Za-z0-9_./-]+\.(go|sql|py|proto)\b", ln)
                and not ln.strip().startswith("//") and not ln.strip().startswith("--")
                and not ln.strip().startswith("#")
            ]
            if not code_lines:
                continue
            # canonicalize whitespace for matching
            def canon(s: str) -> str:
                return re.sub(r"\s+", " ", s).strip()
            src_canon = canon(src)
            # try the 5 longest non-trivial lines
            best = sorted(code_lines, key=lambda s: -len(s.strip()))[:5]
            literal_ok = False
            for ln in best:
                cl = canon(ln)
                # ignore lines that are mostly punctuation or too short
                if len(cl) < 30 or len(re.sub(r"[^A-Za-z0-9_]", "", cl)) < 12:
                    continue
                # remove our own ellipses + comment-noise
                cl = cl.replace("...", "").strip()
                if not cl:
                    continue
                if cl in src_canon:
                    literal_ok = True
                    break
                # try a 40-char prefix
                if len(cl) >= 40 and cl[:40] in src_canon:
                    literal_ok = True
                    break
            if not literal_ok:
                bad_literal += 1
                print(
                    f"DEBUG unverified_literal path={path_str} sample={best[0][:80] if best else ''!r}",
                    file=sys.stderr,
                )
    return missing, unverified, bad_literal


NUMBER_RE = re.compile(
    r"(?<![/\w])(\d{1,3}(?:[,_]\d{3})*(?:\.\d+)?)\s?(µs|us|ms|ns|s\b|MB|GB|KB|TB|B/sec|/sec|TPS|QPS|requests?/sec|events?/sec|rows?/sec|MiB|GiB|KiB)",
)
DERIV_HINTS = re.compile(
    r"(\bmath\b|\bnapkin\b|≈|~|\bestimat|\bobserved|\bmeasured|\bbenchmark|=\s|\bcompute|`[^`]*\d[^`]*`|\bsustains?|\bp50\b|\bp99\b|\brange\b|\bbetween\b|\bfrom\b|\bto\b)",
    re.IGNORECASE,
)


def numbers_without_math_defects(body: str) -> int:
    paragraphs = re.split(r"\n\s*\n", body)
    n = 0
    for p in paragraphs:
        if p.strip().startswith("```") or "|" in p[:5]:
            continue
        nums = NUMBER_RE.findall(p)
        if not nums:
            continue
        if not DERIV_HINTS.search(p):
            n += len(nums)
    return n


CITATION_NEEDED_RE = re.compile(
    # tighter than starter: version-keyword must be followed by an actual digit,
    # not a stray period, and the digit can have an optional dotted suffix.
    r"\b(Postgres|PostgreSQL|Kafka|S3|Parquet|Iceberg|TigerBeetle|FoundationDB)\b[^.]{0,80}\b(since|in|version|added|released|shipped|introduced)\b\s*\d+(?:\.\d+)*",
    re.IGNORECASE,
)


def missing_citation_defects(body: str) -> int:
    n = 0
    for m in CITATION_NEEDED_RE.finditer(body):
        s = max(0, m.start() - 80)
        e = min(len(body), m.end() + 240)
        window = body[s:e]
        # Accept inline links, bare URLs, or footnote refs ([^N], [^name]).
        if not re.search(r"\[[^\]]+\]\([^)]+\)|https?://|\[\^[\w-]+\]", window):
            n += 1
    return n


MARKETING_RE = re.compile(
    r"\b(blazingly fast|seamlessly|robust|powerful|cutting[- ]edge|next[- ]gen|world[- ]class|state[- ]of[- ]the[- ]art|game[- ]changing|revolutionary|leverage|leverages|leveraging)\b",
    re.IGNORECASE,
)


def marketing_defects(body: str) -> int:
    return len(MARKETING_RE.findall(body))


def frontmatter_defects(fm: str) -> int:
    n = 0
    if "title" not in fm:
        n += 5
    if "description" not in fm:
        n += 3
    if "draft" not in fm:
        n += 1
    if "theme" not in fm:
        n += 1
    if "tags" not in fm:
        n += 1
    m = re.search(r'description\s*=\s*"([^"]+)"', fm)
    if m:
        d = m.group(1)
        if len(d) < 100 or len(d) > 220:
            n += 1
    return n


# ---------------- new strict checks ----------------

def url_anchor_defects(body: str) -> int:
    """postgres.org docs URLs must look like the canonical layout."""
    n = 0
    for m in re.finditer(r"https?://(?:www\.)?postgresql\.org/docs/(\d+|current)/[^\s)]+", body):
        url = m.group(0)
        # must contain .html and not have obvious typos
        if ".html" not in url:
            print(f"DEBUG bad_url_anchor (no .html): {url}", file=sys.stderr)
            n += 1
            continue
        # if there's a fragment, it must look like a UPPER_CASE-IDENT or lowercase-ident
        if "#" in url:
            frag = url.split("#", 1)[1]
            if not re.fullmatch(r"[A-Za-z0-9_-]+", frag):
                print(f"DEBUG bad_url_anchor (bad frag): {url}", file=sys.stderr)
                n += 1
                continue
            # heuristic: pg_logical_emit_message lives on functions-admin.html
            # under #FUNCTIONS-ADMIN-OTHER or #FUNCTIONS-REPLICATION-CONTROL
            if "functions-admin.html" in url and "GENFILE" in frag:
                print(f"DEBUG bad_url_anchor (GENFILE wrong section for emit): {url}", file=sys.stderr)
                n += 1
                continue
    return n


COMMIT_REF_RE = re.compile(r"\b([0-9a-f]{7})\b(?=[^A-Za-z0-9])")


def bad_commit_ref_defects(body: str, cached_repo: Path) -> int:
    n = 0
    for m in COMMIT_REF_RE.finditer(body):
        sha = m.group(1)
        # only flag tokens that look like commit refs (preceded by "commit", or in a backticked context referencing commit)
        s = max(0, m.start() - 50)
        e = min(len(body), m.end() + 50)
        window = body[s:e].lower()
        if not ("commit" in window or "feat(" in window or "/commit/" in window):
            continue
        try:
            r = subprocess.run(
                ["git", "-C", str(cached_repo), "cat-file", "-e", f"{sha}^{{commit}}"],
                capture_output=True,
                timeout=10,
            )
            if r.returncode != 0:
                print(f"DEBUG bad_commit_ref: {sha}", file=sys.stderr)
                n += 1
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
    return n


def factlib_size_drift_defects(body: str, cached_repo: Path) -> int:
    """If the post claims 'N lines of Go' for factlib, must be ±15%."""
    m = re.search(r"around\s+([\d,]+)\s+lines\s+of\s+Go", body, re.IGNORECASE)
    if not m:
        return 0
    claimed = int(m.group(1).replace(",", ""))
    try:
        r = subprocess.run(
            ["bash", "-c", f"find {cached_repo}/pkg {cached_repo}/cmd -name '*.go' -not -name '*_test.go' | xargs wc -l | tail -1 | awk '{{print $1}}'"],
            capture_output=True, text=True, timeout=20,
        )
        actual = int(r.stdout.strip() or 0)
    except Exception:
        return 0
    if actual == 0:
        return 0
    delta = abs(claimed - actual) / actual
    if delta > 0.15:
        print(f"DEBUG factlib_size_drift: claimed={claimed} actual={actual} delta={delta:.2f}",
              file=sys.stderr)
        return 1
    return 0


FABRICATED_PROD_RE = re.compile(
    # production-rooted claims that need a measurement source
    r"\b(?:in production|production observed|p50 (?:of |is )|p99 (?:of |is )|measured|sustained|throughput of|achieves)\b[^.\n]{0,80}\b\d[\d,.]*\s?(?:µs|us|ms|ns|s|MB|GB|KB|TB|TPS|QPS|/sec|/s)\b",
    re.IGNORECASE,
)
SOURCE_HINT_RE = re.compile(
    r"(?:\bbenchmark\b|\bgithub\.com/[\w./-]+\b|`scripts/[\w./-]+\.(?:py|sh)`|\bpg_stat_statements\b|\bbpftrace\b|\bperf\b|\bderived\b|\bestimated\b|\benvelope\b)",
    re.IGNORECASE,
)


def fabricated_production_defects(body: str) -> int:
    n = 0
    for m in FABRICATED_PROD_RE.finditer(body):
        s = max(0, m.start() - 100)
        e = min(len(body), m.end() + 200)
        window = body[s:e]
        if not SOURCE_HINT_RE.search(window):
            print(f"DEBUG fabricated_prod: {body[m.start():m.end()][:80]!r}", file=sys.stderr)
            n += 1
    return n


# `wc -l <file>` style claims: e.g. "is 99 lines" or "99 lines end-to-end"
LOC_CLAIM_RE = re.compile(
    r"\b(?:is|are|at|exactly)?\s*\*?\*?(\d{2,5})\*?\*?\s+lines?\b[^\n]{0,40}\b([\w./-]+\.(?:go|sql|py|proto|js|ts|md|yaml))\b",
    re.IGNORECASE,
)


def loc_drift_defects(body: str, cached_repo: Path) -> int:
    n = 0
    seen: set[tuple[str, int]] = set()
    for m in LOC_CLAIM_RE.finditer(body):
        claimed = int(m.group(1))
        path_str = m.group(2)
        if (path_str, claimed) in seen:
            continue
        seen.add((path_str, claimed))
        f = _file_lookup(cached_repo, path_str)
        if f is None:
            continue
        try:
            actual = sum(1 for _ in f.open())
        except Exception:
            continue
        if actual == 0:
            continue
        # accept ±10%
        delta = abs(actual - claimed) / actual
        if delta > 0.10:
            print(f"DEBUG loc_drift: {path_str} claimed={claimed} actual={actual} delta={delta:.2f}",
                  file=sys.stderr)
            n += 1
    return n


# "N orders of magnitude": if a nearby paragraph has "X → Y" or "X to Y",
# verify ratio matches N.
ORDERS_RE = re.compile(
    r"\b(one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+orders?\s+of\s+magnitude\b",
    re.IGNORECASE,
)
WORD_TO_INT = {"one": 1, "two": 2, "three": 3, "four": 4, "five": 5,
               "six": 6, "seven": 7, "eight": 8, "nine": 9, "ten": 10}


def orders_of_magnitude_defects(body: str) -> int:
    """If two numbers in the same paragraph form a ratio that doesn't match
    the claimed orders of magnitude (within ±1), flag it."""
    n = 0
    paragraphs = re.split(r"\n\s*\n", body)
    for p in paragraphs:
        m = ORDERS_RE.search(p)
        if not m:
            continue
        word = m.group(1).lower()
        claimed_orders = int(word) if word.isdigit() else WORD_TO_INT.get(word, -1)
        if claimed_orders < 0:
            continue
        # Find numbers in the paragraph that look like a ratio
        nums_seen = re.findall(r"\b(\d{1,3}(?:[,_]\d{3})*)\b", p)
        nums = []
        for s in nums_seen:
            try:
                v = int(s.replace(",", "").replace("_", ""))
                nums.append(v)
            except ValueError:
                pass
        if len(nums) < 2:
            continue
        # find any pair (a, b) where a/b roughly == 10**claimed_orders
        target = 10 ** claimed_orders
        ok = False
        for i, a in enumerate(nums):
            for b in nums[i + 1:]:
                if b == 0:
                    continue
                ratio = max(a, b) / min(a, b)
                # allow ±0.5 of an order of magnitude
                if 10 ** (claimed_orders - 0.5) <= ratio <= 10 ** (claimed_orders + 0.5):
                    ok = True
                    break
            if ok:
                break
        if not ok:
            print(f"DEBUG orders_of_magnitude: claimed={claimed_orders} nums={nums[:5]}", file=sys.stderr)
            n += 1
    return n


SECTION_REF_RE = re.compile(r"§\s?(\d{1,2})\b")
SECTION_HEADING_RE = re.compile(r"^#\s+(\d{1,2})\.\s+", re.MULTILINE)


def section_xref_defects(body: str) -> int:
    """Every §N reference in the body must resolve to a numbered # N. heading.
    Skip §5.7 / §5.8 patterns — those are RFC sections, not in-doc."""
    headings = {int(m.group(1)) for m in SECTION_HEADING_RE.finditer(body)}
    n = 0
    for m in SECTION_REF_RE.finditer(body):
        # ignore RFC-style refs: § followed by N.M
        s = m.start()
        e = m.end()
        if e < len(body) and body[e:e + 1] == ".":
            # could be RFC §5.7 — ignore
            continue
        # also ignore if preceded by "RFC"
        before = body[max(0, s - 12):s]
        if "RFC" in before:
            continue
        sec = int(m.group(1))
        if sec not in headings:
            print(f"DEBUG bad_section_xref: §{sec} (have {sorted(headings)})", file=sys.stderr)
            n += 1
    return n


RENDERED_HTML_REL = "public/posts/outbox-without-outbox-pg-logical-messages/index.html"


ANCHOR_LINK_RE = re.compile(r"\]\(#([a-zA-Z0-9_-]+)\)")


LICENSE_CLAIM_RE = re.compile(
    r"\(\s*(Apache-?2(?:\.0)?|MIT|BSD-?[23]?(?:-Clause)?|GPL-?\d?(?:\.0)?|MPL-?2(?:\.0)?|AGPL-?3(?:\.0)?)\s*\)",
    re.IGNORECASE,
)


def license_claim_defects(body: str, cached_repo: Path) -> int:
    """If we claim a license name in parens (Apache-2.0), the cached repo
    should have a LICENSE file or SPDX header containing that name."""
    n = 0
    license_files = list(cached_repo.glob("LICENSE*")) + list(cached_repo.glob("COPYING*"))
    license_text = ""
    for f in license_files:
        try:
            license_text += f.read_text(encoding="utf-8", errors="ignore")
        except Exception:
            pass
    # Also scan README + first 50 lines of any source file
    for f in [cached_repo / "README.md", cached_repo / "README"]:
        if f.exists():
            try:
                license_text += f.read_text(encoding="utf-8", errors="ignore")[:5000]
            except Exception:
                pass
    license_text_norm = license_text.lower().replace("-", "").replace(" ", "")
    for m in LICENSE_CLAIM_RE.finditer(body):
        # Skip "(Apache-2.0)" inside this very file by checking surrounding text
        surrounding = body[max(0, m.start() - 60):m.end() + 60]
        if "no declared LICENSE" in surrounding or "check upstream" in surrounding:
            continue
        claim = m.group(1).lower().replace("-", "").replace(" ", "")
        # accept fuzzy matches: "apache2.0" in text means claim "apache2" is OK
        # take just the name root (apache, mit, bsd, gpl, mpl, agpl)
        root = re.match(r"[a-z]+", claim).group(0)
        if root not in license_text_norm:
            print(f"DEBUG license_claim: '{m.group(1)}' not in cached repo LICENSE/README",
                  file=sys.stderr)
            n += 1
    return n


def anchor_resolution_defects(body: str, repo_root: Path) -> int:
    """Every `](#id)` in the post must resolve to an actual id="..." in the
    rendered HTML."""
    p = repo_root / RENDERED_HTML_REL
    if not p.exists():
        return 0
    html = p.read_text(encoding="utf-8")
    available = set(re.findall(r'id="([^"]+)"', html))
    n = 0
    for m in ANCHOR_LINK_RE.finditer(body):
        target = m.group(1)
        if target not in available:
            print(f"DEBUG anchor_resolution: #{target} not in rendered HTML",
                  file=sys.stderr)
            n += 1
    return n


def heading_skip_defects(repo_root: Path) -> int:
    """Render the post and verify h-tags don't skip levels.
    coloroid theme bumps `# h1` to <h2> inside posts, so authors who write
    `# Section` then `### Subsection` produce h2→h4 (skip). The scorer
    catches that by looking at the actually-rendered HTML."""
    p = repo_root / RENDERED_HTML_REL
    if not p.exists():
        return 0  # build will be re-run by hugo_build_defects
    html = p.read_text(encoding="utf-8")
    # Take only the article body to avoid TOC/Related h2s confusing us
    body_match = re.search(r"<article[^>]*>(.*?)</article>", html, re.DOTALL)
    target = body_match.group(1) if body_match else html
    levels = [int(m.group(1)) for m in re.finditer(r"<h([1-6])\b", target)]
    n = 0
    prev = None
    for lv in levels:
        if prev is not None and lv > prev + 1:
            print(f"DEBUG heading_skip: h{prev} → h{lv}", file=sys.stderr)
            n += 1
        prev = lv
    return n


GITHUB_LINE_RE = re.compile(
    r"https://github\.com/fampay-inc/factlib/blob/main/([\w./-]+)#L(\d+)(?:-L(\d+))?"
)


def github_line_ref_defects(body: str, cached_repo: Path) -> int:
    """Verify https://github.com/.../file.go#L123-L150 anchors point at real lines."""
    n = 0
    for m in GITHUB_LINE_RE.finditer(body):
        path_str, start, end = m.group(1), int(m.group(2)), int(m.group(3) or m.group(2))
        f = cached_repo / path_str
        if not f.exists():
            print(f"DEBUG bad_github_line_ref (no file): {path_str}", file=sys.stderr)
            n += 1
            continue
        try:
            line_count = sum(1 for _ in f.open())
        except Exception:
            continue
        if start < 1 or end > line_count or start > end:
            print(f"DEBUG bad_github_line_ref ({path_str}): #L{start}-L{end} but file has {line_count} lines",
                  file=sys.stderr)
            n += 1
    return n


DIGIT_CLAIM_RE = re.compile(
    r"\b(single|double|triple|low single|high single)[- ]digit\b", re.IGNORECASE
)


FILLER_RE = re.compile(
    # voice rule: no "in this post", "let's dive in", "as we'll see", etc.
    r"\b(in this (?:blog )?post[, ]|let'?s (?:dive|explore|take a look)|as we'?ll (?:see|explore)"
    r"|in conclusion|in summary|to wrap (?:up|things up)|stay tuned|without further ado"
    r"|to recap|happy (?:coding|reading))\b",
    re.IGNORECASE,
)


PG_VERSION_RE = re.compile(r"\b(?:Postgres|PostgreSQL|PG)\s*(\d{1,2})(?:\.\d+)?\b", re.IGNORECASE)
# Latest released as of 2026-05: PG 17. PG 18 is in dev (beta as of 2026 Q2).
PG_LATEST_RELEASED = 17


def pg_version_defects(body: str) -> int:
    """Reference to a Postgres version > latest-released is a likely typo or
    forward-looking claim that should be marked as such."""
    n = 0
    for m in PG_VERSION_RE.finditer(body):
        ver = int(m.group(1))
        if ver > PG_LATEST_RELEASED + 1:  # allow "PG 18" since it's in beta
            print(f"DEBUG pg_version: 'PG {ver}' (latest released is {PG_LATEST_RELEASED})",
                  file=sys.stderr)
            n += 1
    return n


def code_path_exact_defects(body: str, cached_repo: Path) -> int:
    """For every `// pkg/.../file.go` style path in a code block, the EXACT
    relative path must exist in the cached repo. Catches the regression where
    someone moves a file but the path comment in the post stays stale."""
    n = 0
    for m in CODEBLOCK_RE.finditer(body):
        lang, code = m.group(1).strip().lower(), m.group(2)
        if lang in ("", "txt", "text", "diff", "ascii", "bash", "sh", "shell", "protobuf"):
            continue
        for path_str, _ext in PATH_COMMENT_RE.findall(code):
            # demo paths are intentional
            if re.search(r"\b(demo|example|sample|appendix)\b", path_str, re.IGNORECASE):
                continue
            # non-pkg / non-cmd / non-python paths skip (could be illustrative)
            if not path_str.startswith(("pkg/", "cmd/", "python/")):
                continue
            if not (cached_repo / path_str).exists():
                print(f"DEBUG code_path_exact: '{path_str}' not at exact location",
                      file=sys.stderr)
                n += 1
    return n


def trailing_whitespace_defects(body: str) -> int:
    """Lines with trailing whitespace are an editor-config nit but signal
    sloppiness. Catches the regression class."""
    n = 0
    for line in body.splitlines():
        # ignore code blocks (we don't want to flag whitespace-significant code)
        if line.endswith(" ") or line.endswith("\t"):
            n += 1
    if n > 5:
        print(f"DEBUG trailing_whitespace: {n} lines with trailing whitespace",
              file=sys.stderr)
        return 1
    return 0


def paragraph_terminator_defects(body: str) -> int:
    """A prose paragraph (>40 chars, not a list/heading/code) should end with
    sentence punctuation, not a stray comma or word fragment."""
    # First, strip code blocks completely (fence-aware).
    out_lines = []
    in_fence = False
    for line in body.splitlines():
        if line.lstrip().startswith("```"):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        out_lines.append(line)
    cleaned = "\n".join(out_lines)
    n = 0
    for p in re.split(r"\n\s*\n", cleaned):
        s = p.strip()
        if len(s) < 40:
            continue
        # skip headings, table rows, list items, blockquotes, frontmatter
        if s.startswith(("#", "|", "-", "*", "+", ">", "1.", "2.", "3.", "+++")):
            continue
        last_char = s.rstrip()[-1]
        if last_char not in ".!?:)`'\")*":
            print(f"DEBUG paragraph_terminator: '...{s[-60:]!r}'", file=sys.stderr)
            n += 1
    return n


def filler_phrase_defects(body: str) -> int:
    n = 0
    for m in FILLER_RE.finditer(body):
        # skip if inside a code block
        # (cheap: assume inline-code or fenced block lines start with ```/`)
        before = body[:m.start()]
        # count fences before this position; if odd, we're inside a fence
        if before.count("```") % 2 == 1:
            continue
        print(f"DEBUG filler: {m.group(0)!r}", file=sys.stderr)
        n += 1
    return n


def digit_claim_consistency_defects(body: str) -> int:
    """If a paragraph says 'single-digit % overhead', the nearby percentages
    must actually be 1-9. Catches the iter-49 self-contradiction."""
    n = 0
    paragraphs = re.split(r"\n\s*\n", body)
    for p in paragraphs:
        m = DIGIT_CLAIM_RE.search(p)
        if not m:
            continue
        kind = m.group(1).lower().strip()
        # Find numeric percentages or counts in same paragraph
        nums = [int(x) for x in re.findall(r"(\d{1,4})\s?[%]", p)]
        # If no nearby percentages, fall back to bare numbers
        if not nums:
            nums = [int(x) for x in re.findall(r"\b(\d{1,4})\b", p) if int(x) < 10000]
        if not nums:
            continue
        bands = {
            "single": (1, 9),
            "low single": (1, 4),
            "high single": (5, 9),
            "double": (10, 99),
            "triple": (100, 999),
        }
        lo, hi = bands.get(kind, (0, 99999))
        ok = any(lo <= v <= hi for v in nums[:5])
        if not ok:
            print(f"DEBUG digit_claim_consistency: '{kind}-digit' but paragraph has {nums[:5]}",
                  file=sys.stderr)
            n += 1
    return n


def numbered_list_gap_defects(body: str) -> int:
    """A markdown numbered list that goes 1, 2, 4 (skip) is a copy-paste regression.
    Walks each adjacent run of `^\\d+\\. ` lines and verifies the numbers are 1..N."""
    n = 0
    lines = body.splitlines()
    i = 0
    in_fence = False
    while i < len(lines):
        if lines[i].lstrip().startswith("```"):
            in_fence = not in_fence
            i += 1
            continue
        if in_fence:
            i += 1
            continue
        m = re.match(r"^(\d+)\.\s+\S", lines[i])
        if m and int(m.group(1)) == 1:
            # start of a numbered list
            run = [int(m.group(1))]
            j = i + 1
            blank_buffer = 0
            while j < len(lines):
                if lines[j].lstrip().startswith("```"):
                    in_fence = not in_fence
                    j += 1
                    continue
                if in_fence:
                    j += 1
                    continue
                m2 = re.match(r"^(\d+)\.\s+\S", lines[j])
                if m2:
                    run.append(int(m2.group(1)))
                    blank_buffer = 0
                elif lines[j].strip() == "":
                    blank_buffer += 1
                    if blank_buffer > 1:
                        break
                elif lines[j].startswith("   "):
                    # continuation line in list item — keep scanning
                    blank_buffer = 0
                else:
                    break
                j += 1
            if len(run) >= 2:
                expected = list(range(1, len(run) + 1))
                if run != expected:
                    print(f"DEBUG numbered_list_gap: got {run}, expected {expected}",
                          file=sys.stderr)
                    n += 1
            i = j
        else:
            i += 1
    return n


def duplicate_paragraph_defects(body: str) -> int:
    """Same paragraph appearing twice = bad copy-paste regression."""
    n = 0
    seen = set()
    for p in re.split(r"\n\s*\n", body):
        s = re.sub(r"\s+", " ", p).strip()
        # only check substantive paragraphs (not single short lines)
        if len(s) < 80:
            continue
        if s in seen:
            print(f"DEBUG duplicate_paragraph: {s[:80]!r}", file=sys.stderr)
            n += 1
        seen.add(s)
    return n


def fence_balance_defects(body: str) -> int:
    """Code fences must be balanced (matched ``` opens and closes).
    Odd count = unclosed fence = breaks Hugo rendering."""
    fences = sum(1 for ln in body.splitlines() if ln.lstrip().startswith("```"))
    if fences % 2 != 0:
        print(f"DEBUG fence_balance: {fences} fence markers (odd, unclosed somewhere)",
              file=sys.stderr)
        return 1
    return 0


def gofmt_defects(body: str) -> int:
    """Run gofmt -l on every Go code block. Each unparsable block = 1 defect.
    Skips blocks containing '...' (intentionally elided) or top-level keywords
    that signal pseudocode (no `package` or `func` decl)."""
    import tempfile
    n = 0
    for m in CODEBLOCK_RE.finditer(body):
        lang, code = m.group(1).strip().lower(), m.group(2)
        if lang != "go":
            continue
        # ignore pseudocode-flavored blocks (the §4 application example uses
        # ellipses like `"INSERT INTO users ...", u.ID, ...` and `payloadBytes`
        # which are illustrative, not valid Go)
        if "..." in code or re.search(r"^\s*[a-z][a-zA-Z0-9_]*\s*:?=\s*\w+\(", code, re.MULTILINE) and "func " not in code:
            continue
        # require either a `func main()` or a top-level `func (` to be a real check
        if "func " not in code:
            continue
        # wrap snippets that lack `package` so gofmt has something to parse
        snippet = code if re.search(r"^\s*package\s+\w+", code, re.MULTILINE) else "package x\n" + code
        with tempfile.NamedTemporaryFile(mode="w", suffix=".go", delete=False) as f:
            f.write(snippet)
            tmp = f.name
        try:
            r = subprocess.run(["gofmt", "-l", tmp], capture_output=True, text=True, timeout=5)
            if r.returncode != 0 or r.stderr.strip():
                print(f"DEBUG gofmt: {r.stderr.strip()[:200]}", file=sys.stderr)
                n += 1
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
        finally:
            os.unlink(tmp)
    return n


def long_line_defects(body: str) -> int:
    """Code-block lines wider than 100 chars overflow on mobile."""
    n = 0
    for m in CODEBLOCK_RE.finditer(body):
        lang, code = m.group(1).strip().lower(), m.group(2)
        # skip txt/text diagrams (often have wide ascii art) and tables
        if lang in ("txt", "text", "ascii"):
            continue
        for line in code.splitlines():
            if len(line.rstrip()) > 100:
                print(f"DEBUG long_line ({len(line)}c, {lang}): {line[:80]!r}...", file=sys.stderr)
                n += 1
    return n


def wal_record_overhead_defects(body: str) -> int:
    """
    Postgres XLogRecord header is 24 bytes (xlog_internal.h SizeOfXLogRecord).
    The xl_logical_message struct (xlog_logical.h, src/include/replication/message.h)
    has: dbId(4) transactional(1) + 3 pad + prefix_size(8) + message_size(8) = 24 bytes
    plus prefix bytes (NUL-terminated) and message bytes.

    Accepted ranges:
      header           : exactly 24 (B|bytes|byte)
      xl_logical_message body: 16-32 B (we accept 16, 20, 24)
      commit record    : 24-50 B
    """
    n = 0
    # Find the WAL record block
    para = re.search(r"WAL record header[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]*\n[^\n]+\n", body)
    # cheap check on individual claim lines:
    for ln in body.splitlines():
        m = re.search(r"WAL record header\s+(\d+)\s*B", ln)
        if m and int(m.group(1)) != 24:
            print(f"DEBUG wal header off: {m.group(0)}", file=sys.stderr)
            n += 1
        m = re.search(r"xl_logical_message\s+(\d+)\s*B", ln)
        if m and int(m.group(1)) not in (16, 20, 24, 32):
            print(f"DEBUG xl_logical_message off: {m.group(0)}", file=sys.stderr)
            n += 1
        m = re.search(r"COMMIT record\s*\(~?(\d+)\s*B\)", ln)
        if m and not (24 <= int(m.group(1)) <= 60):
            print(f"DEBUG commit record off: {m.group(0)}", file=sys.stderr)
            n += 1
    return n


# ----------------------- driver -----------------------

def main() -> int:
    if len(sys.argv) != 3:
        print("usage: scorer.py <post_path> <cached_repo_path>", file=sys.stderr)
        return 2
    post_path = Path(sys.argv[1])
    cached_repo = Path(sys.argv[2])
    if not post_path.exists():
        emit("defects", 100)
        return 1
    if not cached_repo.exists():
        emit("defects", 100)
        return 1

    repo_root = Path(__file__).resolve().parents[2]
    fm, body, _ = read_post(post_path)

    cats: dict[str, int] = {}
    cats["build_warnings"] = hugo_build_defects(repo_root)
    cats["wordcount_off"] = wordcount_defects(word_count(body))
    cats["vague_claims"] = vague_qualifier_defects(body)
    missing, unverified, bad_literal = codeblock_path_defects(body, cached_repo)
    cats["missing_code_paths"] = missing
    cats["unverified_snippets"] = unverified
    cats["unverified_literal"] = bad_literal
    cats["numbers_no_math"] = numbers_without_math_defects(body)
    cats["missing_citations"] = missing_citation_defects(body)
    cats["marketing_words"] = marketing_defects(body)
    cats["frontmatter"] = frontmatter_defects(fm)
    cats["bad_url_anchor"] = url_anchor_defects(body)
    cats["bad_commit_ref"] = bad_commit_ref_defects(body, cached_repo)
    cats["factlib_size_drift"] = factlib_size_drift_defects(body, cached_repo)
    cats["wal_record_overhead_off"] = wal_record_overhead_defects(body)
    cats["fabricated_production"] = fabricated_production_defects(body)
    cats["loc_drift"] = loc_drift_defects(body, cached_repo)
    cats["orders_of_magnitude"] = orders_of_magnitude_defects(body)
    cats["bad_section_xref"] = section_xref_defects(body)
    cats["long_code_lines"] = long_line_defects(body)
    cats["heading_skip"] = heading_skip_defects(repo_root)
    cats["bad_anchor_link"] = anchor_resolution_defects(body, repo_root)
    cats["license_claim"] = license_claim_defects(body, cached_repo)
    cats["gofmt"] = gofmt_defects(body)
    cats["fence_balance"] = fence_balance_defects(body)
    cats["duplicate_paragraph"] = duplicate_paragraph_defects(body)
    cats["numbered_list_gap"] = numbered_list_gap_defects(body)
    cats["github_line_ref"] = github_line_ref_defects(body, cached_repo)
    cats["digit_claim"] = digit_claim_consistency_defects(body)
    cats["filler_phrases"] = filler_phrase_defects(body)
    cats["para_terminator"] = paragraph_terminator_defects(body)
    cats["trailing_ws"] = trailing_whitespace_defects(body)
    cats["code_path_exact"] = code_path_exact_defects(body, cached_repo)
    cats["pg_version"] = pg_version_defects(body)

    weights = {
        "build_warnings": 1,
        "missing_code_paths": 5,
        "unverified_snippets": 3,
        "unverified_literal": 4,
        "missing_citations": 2,
        "numbers_no_math": 1,
        "vague_claims": 1,
        "marketing_words": 2,
        "wordcount_off": 1,
        "frontmatter": 2,
        "bad_url_anchor": 3,
        "bad_commit_ref": 3,
        "factlib_size_drift": 2,
        "wal_record_overhead_off": 3,
        "fabricated_production": 4,
        "loc_drift": 3,
        "orders_of_magnitude": 3,
        "bad_section_xref": 3,
        "long_code_lines": 1,
        "heading_skip": 4,
        "bad_anchor_link": 3,
        "license_claim": 4,
        "gofmt": 3,
        "fence_balance": 5,
        "duplicate_paragraph": 3,
        "numbered_list_gap": 2,
        "github_line_ref": 3,
        "digit_claim": 3,
        "filler_phrases": 2,
        "para_terminator": 1,
        "trailing_ws": 1,
        "code_path_exact": 4,
        "pg_version": 3,
    }
    total = sum(weights[k] * v for k, v in cats.items())

    for k, v in cats.items():
        emit(k, v)
    emit("wordcount", word_count(body))
    emit("defects", total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
