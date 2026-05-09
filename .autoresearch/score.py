#!/usr/bin/env python3
"""
Defect scorer for go-backend.how blog posts.
Goal: maximum correctness + napkin-math grounding.

Usage:
    score.py <post_path> <cached_repo_path>

Outputs `METRIC name=number` lines on stdout (autoresearch convention).
Primary metric is `defects` — the sum of all category counts.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


def section(name: str, value: int) -> None:
    print(f"METRIC {name}={value}")


def read_post(path: Path) -> tuple[str, str, str]:
    text = path.read_text(encoding="utf-8")
    # split frontmatter (TOML +++ or YAML ---)
    parts = re.split(r"^\+\+\+\s*$|^---\s*$", text, maxsplit=2, flags=re.MULTILINE)
    if len(parts) >= 3:
        return parts[1], parts[2], text
    return "", text, text


def hugo_build_defects(repo_root: Path) -> int:
    """Run hugo --quiet -D in repo root; count WARN/ERROR lines."""
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
    # Count any WARN/ERROR
    warn_lines = [
        ln for ln in out.splitlines() if re.search(r"\b(WARN|ERROR|FATAL)\b", ln)
    ]
    return min(len(warn_lines) * 5, 50)


def word_count(body: str) -> int:
    # strip code fences
    body_stripped = re.sub(r"```[^`]*```", "", body, flags=re.DOTALL)
    return len(re.findall(r"\b[\w'-]+\b", body_stripped))


def wordcount_defects(words: int, lo: int = 3000, hi: int = 5500) -> int:
    if words < lo:
        return (lo - words) // 500
    if words > hi:
        return (words - hi) // 500
    return 0


# Vague qualifier patterns: word + number with no near-by bound/range
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
        # window: 100 chars before + 100 after
        s = max(0, m.start() - 100)
        e = min(len(body), m.end() + 100)
        window = body[s:e]
        if not RANGE_HINTS.search(window):
            n += 1
    return n


# Code blocks: detect file-path comments and verify path exists in cached repo
CODEBLOCK_RE = re.compile(r"```([a-zA-Z0-9_+-]*)\n(.*?)```", re.DOTALL)
PATH_COMMENT_RE = re.compile(
    r"^\s*(?://|--|#)\s*([a-zA-Z0-9_./-]+\.(go|sql|py|md|yaml|yml|toml|sh|js|ts|c|h|rs))\b",
    re.MULTILINE,
)


def codeblock_path_defects(body: str, cached_repo: Path) -> tuple[int, int, int]:
    """Return (missing_path_count, unverified_snippet_count, weak_snippet_count).

    `weak_snippet` (NEW): snippets where no 25-char body line substring-
    matches the source file. Catches paraphrased code that hides behind
    a real path comment.
    """
    missing = 0
    unverified = 0
    weak = 0
    for m in CODEBLOCK_RE.finditer(body):
        lang, code = m.group(1).strip().lower(), m.group(2)
        if lang in ("", "txt", "text", "diff", "ascii", "bash", "sh", "shell"):
            continue
        # find file path comments in the code block
        path_matches = PATH_COMMENT_RE.findall(code)
        if not path_matches:
            continue
        for path_str, _ext in path_matches:
            full = cached_repo / path_str
            if not full.exists():
                # also try walking up — author may have written `pkg/...` or `internal/...`
                hit = list(cached_repo.rglob(Path(path_str).name))
                if not hit:
                    missing += 1
                    print(
                        f"DEBUG missing_path: {path_str} (not in {cached_repo.name})",
                        file=sys.stderr,
                    )
                    continue
                full = hit[0]
            # NEW: line-level substring check. At least one trimmed body
            # line of length >=25 must appear verbatim in the source file.
            try:
                src = full.read_text(encoding="utf-8", errors="replace")
            except Exception:
                src = ""
            line_hit = False
            for raw in code.splitlines():
                line = raw.strip()
                if len(line) < 25:
                    continue
                # First try the full line (preserves trailing comments
                # that are themselves in the source). Then fall back to
                # comment-stripped form.
                if line in src:
                    line_hit = True
                    break
                stripped = re.sub(r"\s*//.*$", "", line).strip()
                if len(stripped) < 25:
                    continue
                if stripped in src:
                    line_hit = True
                    break
            if not line_hit:
                weak += 1
                print(
                    f"DEBUG weak_snippet (path={path_str}): no 25+ char line matches source",
                    file=sys.stderr,
                )
            # verify any distinctive identifier (CamelCase or snake_case 8+ chars)
            idents = set(re.findall(r"\b[A-Z][a-zA-Z0-9_]{6,}\b", code))
            idents |= set(re.findall(r"\b[a-z_]{8,}\b", code))
            # filter out common Go/SQL words
            common = {
                "context",
                "errgroup",
                "interval",
                "function",
                "struct",
                "import",
                "default",
                "package",
                "publication",
                "replication",
                "transaction",
                "publication",
                "settings",
                "register",
                "strconv",
                "encoding",
                "fmt.Sprintf",
                "fmt.Errorf",
                "Postgres",
                "PostgreSQL",
                "Postgres'",
                "PUBLICATION",
                "CREATE_PUBLICATION",
                "PRIMARY",
                "REPLICATION",
                "TRANSACTION",
                "interface",
                "context",
                "channel",
                "checkpoint",
                "streaming",
            }
            idents = {i for i in idents if i not in common and len(i) >= 7}
            if not idents:
                continue
            # Pick up to 5 idents to verify
            sampled = list(idents)[:5]
            verified = 0
            for ident in sampled:
                # cheap grep
                try:
                    r = subprocess.run(
                        ["rg", "-l", "-uu", ident, str(cached_repo)],
                        capture_output=True,
                        text=True,
                        timeout=10,
                    )
                    if r.stdout.strip():
                        verified += 1
                except (subprocess.TimeoutExpired, FileNotFoundError):
                    pass
            if verified == 0:
                unverified += 1
                print(
                    f"DEBUG unverified_snippet (path={path_str}, idents={sampled}): no match",
                    file=sys.stderr,
                )
    return missing, unverified, weak


# Numbers with units that lack near-by derivation
NUMBER_RE = re.compile(
    r"(?<![/\w])(\d{1,3}(?:[,_]\d{3})*(?:\.\d+)?)\s?(µs|us|ms|ns|s\b|MB|GB|KB|TB|B/sec|/sec|TPS|QPS|requests?/sec|events?/sec|rows?/sec|MiB|GiB|KiB)",
)
DERIV_HINTS = re.compile(
    r"(\bmath\b|\bnapkin\b|≈|~|\bestimat|\bobserved|\bmeasured|\bbenchmark|=\s|\bcompute|`[^`]*\d[^`]*`)",
    re.IGNORECASE,
)


def numbers_without_math_defects(body: str) -> int:
    """Each unit-bearing number must have derivation hints in same paragraph."""
    paragraphs = re.split(r"\n\s*\n", body)
    n = 0
    for p in paragraphs:
        # Skip code blocks
        if p.strip().startswith("```") or "|" in p[:5]:
            continue
        nums = NUMBER_RE.findall(p)
        if not nums:
            continue
        if not DERIV_HINTS.search(p):
            n += len(nums)
    return n


# Statements about external systems that need a citation
CITATION_NEEDED_RE = re.compile(
    r"\b(Postgres|PostgreSQL|Kafka|S3|Parquet|Iceberg|TigerBeetle|FoundationDB)\b[^.]{0,80}\b(since|in|version|added|released|shipped|introduced)\b\s*[\d.]+",
    re.IGNORECASE,
)


def missing_citation_defects(body: str) -> int:
    n = 0
    for m in CITATION_NEEDED_RE.finditer(body):
        s = max(0, m.start() - 50)
        e = min(len(body), m.end() + 200)
        window = body[s:e]
        if not re.search(r"\[[^\]]+\]\([^)]+\)|https?://", window):
            n += 1
    return n


# Marketing language defects
MARKETING_RE = re.compile(
    r"\b(blazingly fast|seamlessly|robust|powerful|cutting[- ]edge|next[- ]gen|world[- ]class|state[- ]of[- ]the[- ]art|game[- ]changing|revolutionary|leverage|leverages|leveraging)\b",
    re.IGNORECASE,
)


def marketing_defects(body: str) -> int:
    return len(MARKETING_RE.findall(body))


# Frontmatter sanity
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
    # description length: 100-200 chars is sweet spot
    m = re.search(r'description\s*=\s*"([^"]+)"', fm)
    if m:
        d = m.group(1)
        if len(d) < 100 or len(d) > 220:
            n += 1
    return n


# Hedge words that hide imprecision
HEDGE_RE = re.compile(
    r"\b(essentially|basically|fairly|pretty much|more or less|kind of|sort of|obviously|clearly|of course|trivially|practically speaking|in essence|in practice(?:,|\s\w+ is)|simply put|needless to say)\b",
    re.IGNORECASE,
)


def hedge_defects(body: str) -> int:
    return len(HEDGE_RE.findall(body))


# `~N <unit>` without derivation in same paragraph
TILDE_NUM_RE = re.compile(
    r"~\s?\d+(?:[.,]\d+)?\s?(µs|us|ms|ns|s\b|MB|GB|KB|TB|MiB|GiB|KiB|%|×|x\b|/sec)",
)


def tilde_no_math_defects(body: str) -> int:
    paragraphs = re.split(r"\n\s*\n", body)
    n = 0
    for p in paragraphs:
        if p.strip().startswith("```") or "|" in p[:5]:
            continue
        hits = TILDE_NUM_RE.findall(p)
        if not hits:
            continue
        if not DERIV_HINTS.search(p):
            n += len(hits)
    return n


# Ratio claims like "3× faster", "20× the throughput" need a citation
RATIO_RE = re.compile(
    r"\b(\d+(?:[.,]\d+)?)\s?[×x]\s+(faster|slower|smaller|bigger|larger|cheaper|the\s+\w+|throughput|latency|memory)",
    re.IGNORECASE,
)


def ratio_no_citation_defects(body: str) -> int:
    paragraphs = re.split(r"\n\s*\n", body)
    n = 0
    for p in paragraphs:
        if "|" in p[:5]:  # tables exempted
            continue
        hits = RATIO_RE.findall(p)
        if not hits:
            continue
        # accept if there's a hyperlink or measured/benchmark/per repo
        if re.search(r"\[[^\]]+\]\([^)]+\)|https?://|\bmeasur|\bbenchmark|\bcommit\s+`[\dA-Fa-f]{6,}`|\bcommit\s+[\dA-Fa-f]{6,}", p):
            continue
        n += len(hits)
    return n


# Percent claims need derivation in same paragraph
PERCENT_RE = re.compile(r"(?<![\w\d])(\d{1,3}(?:\.\d+)?)\s?%")


def percent_no_math_defects(body: str) -> int:
    paragraphs = re.split(r"\n\s*\n", body)
    n = 0
    for p in paragraphs:
        if p.strip().startswith("```") or "|" in p[:5]:
            continue
        hits = PERCENT_RE.findall(p)
        if not hits:
            continue
        if not DERIV_HINTS.search(p):
            n += len(hits)
    return n


# Placeholder URLs / values that shouldn't ship in a published post.
# Note: `localhost:NNNN` is a real dev address (MinIO, Postgres, etc.),
# not a placeholder, so it is intentionally excluded.
PLACEHOLDER_URL_RE = re.compile(
    r"https?://(?:example\.com|foo\.com|bar\.com|test\.com|TODO\b|FIXME\b)"
    r"|<your[- _][\w-]+>"
    r"|YOUR_[A-Z_]{3,}"
    r"|EXAMPLE_[A-Z_]{3,}"
    r"|\bTODO\([^)]*\)|\bFIXME\([^)]*\)",
    re.IGNORECASE,
)


def placeholder_url_defects(body: str) -> int:
    return len(PLACEHOLDER_URL_RE.findall(body))


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: score.py <post_path> <cached_repo_path>", file=sys.stderr)
        return 2
    post_path = Path(sys.argv[1])
    cached_repo = Path(sys.argv[2])
    if not post_path.exists():
        print(f"post not found: {post_path}", file=sys.stderr)
        section("defects", 100)
        return 1

    repo_root = Path(__file__).resolve().parent.parent
    fm, body, _full = read_post(post_path)

    cats: dict[str, int] = {}
    cats["build_warnings"] = hugo_build_defects(repo_root)
    cats["wordcount_off"] = wordcount_defects(word_count(body))
    cats["vague_claims"] = vague_qualifier_defects(body)
    missing, unverified, weak = codeblock_path_defects(body, cached_repo)
    cats["missing_code_paths"] = missing
    cats["unverified_snippets"] = unverified
    cats["weak_snippets"] = weak
    cats["numbers_no_math"] = numbers_without_math_defects(body)
    cats["tilde_no_math"] = tilde_no_math_defects(body)
    cats["percent_no_math"] = percent_no_math_defects(body)
    cats["ratio_no_citation"] = ratio_no_citation_defects(body)
    cats["missing_citations"] = missing_citation_defects(body)
    cats["marketing_words"] = marketing_defects(body)
    cats["hedge_words"] = hedge_defects(body)
    cats["placeholder_urls"] = placeholder_url_defects(body)
    cats["frontmatter"] = frontmatter_defects(fm)

    # Weights: code-correctness > math-grounding > polish
    weights = {
        "build_warnings": 1,
        "missing_code_paths": 5,
        "unverified_snippets": 3,
        "weak_snippets": 4,
        "missing_citations": 2,
        "numbers_no_math": 1,
        "tilde_no_math": 1,
        "percent_no_math": 1,
        "ratio_no_citation": 2,
        "vague_claims": 1,
        "marketing_words": 2,
        "hedge_words": 1,
        "placeholder_urls": 5,
        "wordcount_off": 1,
        "frontmatter": 2,
    }
    total = sum(weights[k] * v for k, v in cats.items())

    for k, v in cats.items():
        section(k, v)
    section("wordcount", word_count(body))
    section("defects", total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
