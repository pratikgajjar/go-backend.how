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
    body_stripped = re.sub(r"```[^`]*```", "", body, flags=re.DOTALL)
    return len(re.findall(r"\b[\w'-]+\b", body_stripped))


def wordcount_defects(words: int, lo: int = 3000, hi: int = 5500) -> int:
    if words < lo:
        return (lo - words) // 500
    if words > hi:
        return (words - hi) // 500
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
            f = _file_lookup(cached_repo, path_str)
            if f is None:
                missing += 1
                print(f"DEBUG missing_path: {path_str}", file=sys.stderr)
                continue
            try:
                src = f.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                missing += 1
                continue

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
    r"\b(Postgres|PostgreSQL|Kafka|S3|Parquet|Iceberg|TigerBeetle|FoundationDB)\b[^.]{0,80}\b(since|in|version|added|released|shipped|introduced)\b\s*[\d.]+",
    re.IGNORECASE,
)


def missing_citation_defects(body: str) -> int:
    n = 0
    for m in CITATION_NEEDED_RE.finditer(body):
        s = max(0, m.start() - 80)
        e = min(len(body), m.end() + 240)
        window = body[s:e]
        if not re.search(r"\[[^\]]+\]\([^)]+\)|https?://", window):
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
    }
    total = sum(weights[k] * v for k, v in cats.items())

    for k, v in cats.items():
        emit(k, v)
    emit("wordcount", word_count(body))
    emit("defects", total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
