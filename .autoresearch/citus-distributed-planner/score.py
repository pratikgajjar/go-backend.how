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


def wordcount_defects(words: int, lo: int = 3000, hi: int = 5000) -> int:
    """Brief: 3000–5000 prose words. Each 500-word excess/deficit is 1 defect."""
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
            # Require ≥2 distinct ≥25-char body lines to substring-match
            # the source. Catches snippets where exactly one line is real
            # and the rest is paraphrased.
            matched_lines = 0
            need = 2
            seen_match: set[str] = set()
            for raw in code.splitlines():
                line = raw.strip()
                if len(line) < 25:
                    continue
                key = line
                hit = False
                # First try the full line (preserves trailing comments
                # that are themselves in the source). Then fall back to
                # comment-stripped form.
                if line in src:
                    hit = True
                else:
                    stripped = re.sub(r"\s*//.*$", "", line).strip()
                    if len(stripped) >= 25 and stripped in src:
                        hit = True
                        key = stripped
                if hit and key not in seen_match:
                    seen_match.add(key)
                    matched_lines += 1
                    if matched_lines >= need:
                        break
            line_hit = matched_lines >= need
            # If snippet has < `need` distinct ≥25-char lines, accept any single
            # match (e.g. a 3-line struct with comments).
            total_long = sum(
                1
                for raw in code.splitlines()
                if len(raw.strip()) >= 25
            )
            if total_long < need and matched_lines >= 1:
                line_hit = True
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


# Distinctive identifiers in prose backticks must exist in the cached source.
# Allowlist: Postgres-style names + common units/keywords + small set of known
# Postgres internals that won't appear in wal-cake's source.
PG_ALLOWLIST = {
    # Postgres catalogs / functions / settings (verifiable in postgresql docs)
    "pg_publication", "pg_replication_slots", "pg_stat_replication",
    "pg_stat_user_indexes", "pg_stat_statements", "pg_total_relation_size",
    "idx_scan", "idx_tup_fetch", "n_live_tup", "n_dead_tup",
    "pg_current_wal_lsn", "pg_create_logical_replication_slot",
    "pg_database", "pg_toast_*", "pg_wal", "pg_wal/", "pg_toast_",
    "confirmed_flush_lsn", "wal_level", "wal_writer", "wal_senders",
    "max_replication_slots", "max_wal_senders",
    "replay_lag", "write_lag", "flush_lag",
    "REPLICA IDENTITY", "REPLICA IDENTITY FULL", "REPLICA IDENTITY DEFAULT",
    "ALTER TABLE", "CREATE PUBLICATION", "CREATE TABLE",
    "FOR ALL TABLES", "FOR UPDATE SKIP LOCKED", "ON CONFLICT",
    "commit_delay", "fdatasync", "fsync", "fdatasync()", "fsync()",
    "io_uring", "O_DSYNC", "TRUNCATE",
    # Parquet / Arrow knobs
    "BYTE_ARRAY", "DELTA_BINARY_PACKED", "PLAIN", "RLE_DICTIONARY",
    "JSONLogicalType", "TIMESTAMP_MICROS", "UTF8", "JSON",
    "page index", "row group", "ZSTD", "ZSTD-3", "snappy", "gzip",
    "AthenaInfo",  # placeholder
    # Standard libs / tools that won't be in wal-cake source
    "encoding/json", "json.Marshal", "ParseInt", "ParseFloat",
    "MSCK REPAIR TABLE", "ADD PARTITION",
    # Generic CDC / SDK terms
    "outbox", "outbox_unprocessed_idx",
    "AWS_ENDPOINT", "AWS_ENDPOINT_URL", "AWS_REGION",
    "S3 PUT", "S3 Standard", "S3-Express",
    # Misc
    "p99", "p50", "OLTP", "TPS",
    # Go stdlib reference types (mentioned in prose for comparison)
    "sync.Mutex", "sync.Map", "sync.Pool", "sync.WaitGroup",
    "sync.RWMutex", "sync.Once", "sync.Cond",
    "atomic.Int64", "atomic.Int32", "atomic.Uint64", "atomic.Pointer",
    # Postgres protocol commands (verifiable in postgresql docs, not wal-cake source)
    "START_REPLICATION", "IDENTIFY_SYSTEM", "CREATE_REPLICATION_SLOT",
}


# Looks for `IDENT` in prose; filters out common Go keywords and short tokens.
# Captures CamelCase and snake_case identifiers, dotted method refs, struct fields.
PROSE_IDENT_RE = re.compile(
    r"`([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*(?:\(\))?|"
    r"[a-z_]{3,}\.[A-Za-z_][A-Za-z0-9_]*)`"
)
# Common Go/SDK/general words to skip
COMMON_PROSE_WORDS = {
    "context", "ctx", "ok", "err", "nil", "true", "false", "if", "for",
    "range", "go", "return", "switch", "case", "default", "func", "interface",
    "struct", "map", "chan", "type", "var", "const", "package", "import",
    "byte", "string", "int", "int64", "uint64", "uint32", "any",
    "make", "len", "cap", "append", "close", "delete", "new",
    "select", "Send", "Recv", "Get", "Set", "Add", "Process", "Close",
    "Start", "Stop", "Open", "Read", "Write",
    "Postgres", "PostgreSQL",
}


def identifier_consistency_defects(body: str, cached_repo: Path) -> int:
    """Each distinctive `IDENT` in prose must appear in cached source or allowlist."""
    # Strip code fences first; we only check prose.
    prose = re.sub(r"```[^\n]*\n.*?```", "", body, flags=re.DOTALL)
    # Build set of file basenames in the cached repo (so prose can name them
    # without a self-referential code search hit).
    file_basenames = {p.name for p in cached_repo.rglob("*") if p.is_file()}
    seen: dict[str, bool] = {}
    candidates: list[str] = []
    for m in PROSE_IDENT_RE.finditer(prose):
        tok = m.group(1)
        if tok in COMMON_PROSE_WORDS or tok in PG_ALLOWLIST:
            continue
        if len(tok) < 5:
            continue
        # Must look distinctive: have either CamelCase or _ or .
        if not re.search(r"[A-Z]|_|\.", tok):
            continue
        # Skip pure numeric or single-letter chains
        if re.fullmatch(r"\d[\d.]*", tok):
            continue
        # Skip pg_/WAL prefixes (Postgres-internal — tracked via allowlist for the common ones)
        if tok.startswith(("pg_", "WAL", "wal_", "max_wal", "max_replication")):
            continue
        # Skip common SDK module paths
        if tok.startswith(("github.com/", "golang.org/", "go.opentelemetry.io/")):
            continue
        if tok in seen:
            continue
        seen[tok] = True
        candidates.append(tok)
    n = 0
    for tok in candidates:
        # accept if the token is a real filename in the cached repo
        # (e.g., prose may mention `tuple_decoder.go` even though no
        # source file literally references the filename string)
        if tok in file_basenames:
            continue
        # cheap grep — fixed-string for safety
        try:
            r = subprocess.run(
                ["rg", "-l", "-uu", "-F", tok, str(cached_repo)],
                capture_output=True,
                text=True,
                timeout=10,
            )
            if not r.stdout.strip():
                n += 1
                print(
                    f"DEBUG inconsistent_ident: `{tok}` not found in cached source",
                    file=sys.stderr,
                )
        except (subprocess.TimeoutExpired, FileNotFoundError):
            pass
    return n


_NUM_PAT = r"\d[\d,_]*(?:\.\d+)?"
# SI/binary multipliers on a bare number. Lowercase `k` is universal for
# thousand in casual prose; uppercase K|M|G|B are accepted; `Mi`/`Gi`/`Ki`
# are binary IEC.
_SUF_PAT = r"(?:Mi|Gi|Ki|K|M|G|B|k)?"

# A <op> B [= ≈] C, where each side may be wrapped in backticks and may have
# trailing units. Captures the *bare numbers* and verifies they balance.
MATH_EQ_RE = re.compile(
    r"(?<![\w.])"                                # left boundary
    rf"({_NUM_PAT})({_SUF_PAT})\s*"              # A, A_suf
    r"([×x*/+\-])\s*"                            # op
    rf"({_NUM_PAT})({_SUF_PAT})\s*"              # B, B_suf
    r"(?:µs|us|ms|ns|s|MB|GB|KB|TB|GiB|MiB|KiB|×|x)?\s*"  # opt unit
    r"(=|≈)\s*"                                  # eq / approx
    rf"({_NUM_PAT})({_SUF_PAT})"                 # C, C_suf
    r"(?![\d,.])"                                # right boundary
)

_SCALE = {
    "": 1, "k": 1e3, "K": 1e3, "M": 1e6, "G": 1e9, "B": 1e9,
    "Ki": 1024, "Mi": 1024**2, "Gi": 1024**3,
}


def _parse_num(s: str) -> float:
    return float(s.replace(",", "").replace("_", ""))


def _scale(s: str) -> float:
    return _SCALE.get(s, 1.0)


def math_equality_defects(body: str) -> int:
    """Verify A op B = C / ≈ C inside the post."""
    n = 0
    for m in MATH_EQ_RE.finditer(body):
        a, asu, op, b, bsu, eq, c, csu = m.groups()
        try:
            A = _parse_num(a) * _scale(asu)
            B = _parse_num(b) * _scale(bsu)
            C = _parse_num(c) * _scale(csu)
        except ValueError:
            continue
        if op in ("×", "x", "*"):
            got = A * B
        elif op == "/":
            if B == 0:
                continue
            got = A / B
        elif op == "+":
            got = A + B
        elif op == "-":
            got = A - B
        else:
            continue
        # tolerance: 0.1% for `=`, 10% for `≈`
        tol = 0.001 if eq == "=" else 0.10
        if C == 0:
            ok = abs(got) <= tol
        else:
            ok = abs(got - C) / max(abs(C), 1e-9) <= tol
        if not ok:
            n += 1
            print(
                f"DEBUG math_off: {a} {op} {b} {eq} {c}  computed={got}  expected={C}",
                file=sys.stderr,
            )
    return n


# Dollar amounts with rate (e.g. "$20/month") need derivation in same paragraph
DOLLAR_RE = re.compile(r"\$\s?\d[\d,_.]*\s?(?:/(?:month|year|day|hour|sec))?")


def dollar_no_math_defects(body: str) -> int:
    paragraphs = re.split(r"\n\s*\n", body)
    n = 0
    for p in paragraphs:
        if p.strip().startswith("```") or "|" in p[:5]:
            continue
        hits = DOLLAR_RE.findall(p)
        if not hits:
            continue
        if not DERIV_HINTS.search(p):
            n += len(hits)
    return n


# In-doc anchors: every (#fragment) must point to an existing slug.
def slugify(s: str) -> str:
    s = s.lower().strip()
    s = re.sub(r"[^\w\s-]", "", s)
    s = re.sub(r"[\s_]+", "-", s)
    return s.strip("-")


def anchor_check_defects(body: str) -> int:
    """Inline links that go to '#slug' must match an existing header slug."""
    headers = re.findall(r"^#{1,6}\s+(.+?)\s*$", body, flags=re.MULTILINE)
    slugs = {slugify(h) for h in headers}
    # also allow footnote anchors like fnref:1
    n = 0
    for m in re.finditer(r"\]\(#([\w-]+)\)", body):
        slug = m.group(1)
        if slug.startswith(("fn", "fnref")):
            continue
        if slug not in slugs:
            n += 1
            print(f"DEBUG bad_anchor: #{slug} (no header matches)", file=sys.stderr)
    return n


def defaults_consistency_defects(body: str, cached_repo: Path) -> int:
    """Verify post claims about config defaults (`name=value`) against config.go."""
    cfg = cached_repo / "internal" / "config" / "config.go"
    if not cfg.exists():
        return 0
    src = cfg.read_text(encoding="utf-8", errors="replace")
    # Extract flag.IntVar / DurVar / StringVar defaults: 3rd positional after the var/key.
    int_defaults = {
        k.lower(): v
        for k, v in re.findall(
            r'flag\.IntVar\(&cfg\.(\w+),\s*"[^"]*",\s*(\d+)', src
        )
    }
    # Pick up "flush-interval" -> "30s" via flag.StringVar(&flush, "flush-interval", "30s", ...)
    str_explicit = {
        k.lower(): v
        for k, v in re.findall(
            r'flag\.StringVar\(&\w+,\s*"([^"]+)",\s*"([^"]+)"', src
        )
    }
    n = 0
    # Strip fenced code blocks; we only want prose backticks
    prose = re.sub(r"```[^\n]*\n.*?```", "", body, flags=re.DOTALL)
    # For each backticked group, parse all `name=value` pairs inside it.
    # value pattern only matches numeric-like tokens (so we don't try to
    # validate prose-y pairs like `name=something fancy`).
    pairs: list[tuple[str, str]] = []
    for outer in re.finditer(r"`([^`]+)`", prose):
        inner = outer.group(1)
        for pm in re.finditer(r"\b(\w+)\s*=\s*([\d,_.]+\w*)", inner):
            pairs.append((pm.group(1), pm.group(2)))
    for var, val in pairs:
        val = val.strip().rstrip(",.")
        val_norm = val.replace(",", "").replace("_", "")
        # Try int defaults
        if var.lower() in int_defaults:
            expected = int_defaults[var.lower()]
            if expected != val_norm:
                n += 1
                print(
                    f"DEBUG default_mismatch: prose says `{var}={val}` "
                    f"but config.go default is {expected}",
                    file=sys.stderr,
                )
            continue
        # Try string default by kebab-case (e.g. flush-interval)
        kebab = re.sub(r"(?<!^)(?=[A-Z])", "-", var).lower()
        if kebab in str_explicit:
            expected = str_explicit[kebab]
            if expected != val:
                n += 1
                print(
                    f"DEBUG default_mismatch: prose says `{var}={val}` "
                    f"but config.go default is {expected}",
                    file=sys.stderr,
                )
    return n


def range_bounds_defects(body: str) -> int:
    """A range A–B (en-dash) or A-B (hyphen between numbers) must have A ≤ B (after suffix scaling)."""
    # Strip fenced code blocks (ASCII traces, etc.) and inline URLs.
    prose = re.sub(r"```[^\n]*\n.*?```", "", body, flags=re.DOTALL)
    prose = re.sub(r"https?://\S+", "", prose)
    # Match `N[suf]–M[suf]` with same/different unit
    pat = re.compile(
        rf"(?<!\w)({_NUM_PAT})({_SUF_PAT})\s*[–-]\s*({_NUM_PAT})({_SUF_PAT})"
        r"\s*(µs|us|ms|ns|s|MB|GB|KB|TB|GiB|MiB|KiB|/sec|/min|/hr|%|×|x)?"
    )
    n = 0
    for m in pat.finditer(prose):
        a, asu, b, bsu, _u = m.groups()
        try:
            A = _parse_num(a) * _scale(asu)
            B = _parse_num(b) * _scale(bsu)
        except ValueError:
            continue
        if A > B:
            n += 1
            print(
                f"DEBUG range_inverted: {a}{asu}–{b}{bsu}  ({A} > {B})",
                file=sys.stderr,
            )
    return n


CLAIM_RE = re.compile(
    r"\b(measured|observed|benchmarked|profiled|empirically)\b",
    re.IGNORECASE,
)


HTTP_RE = re.compile(r"\bhttp://(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^\s\)\>]+")


def http_not_https_defects(body: str) -> int:
    """External http:// URLs should be https:// (except local dev addresses)."""
    return len(HTTP_RE.findall(body))


def commit_ref_defects(body: str, cached_repo: Path) -> int:
    """Each `commit \\`HASH\\`` reference must exist in the cached repo's git log."""
    refs = set(
        re.findall(r"commit\s+`?([0-9a-fA-F]{6,40})`?", body)
    )
    if not refs:
        return 0
    try:
        r = subprocess.run(
            ["git", "-C", str(cached_repo), "log", "--all", "--format=%H"],
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return 0
    if r.returncode != 0:
        return 0
    hashes = r.stdout.split()
    n = 0
    for ref in refs:
        if not any(h.startswith(ref) or ref.startswith(h) for h in hashes):
            n += 1
            print(f"DEBUG bad_commit_ref: `{ref}` not in cached repo", file=sys.stderr)
    return n


def required_sections_defects(body: str) -> int:
    """Brief for citus-distributed-planner specified 7 sections that must be
    present (renamed allowed). Match by keyword set within section headings."""
    headers = [
        h.lower() for h in re.findall(r"^#{1,3}\s+(.+?)\s*$", body, flags=re.MULTILINE)
    ]
    required = [
        # (label, list of keywords; any keyword match in any header is OK)
        ("the hook", ["hook", "surprise", "contradiction"]),
        ("the problem", ["problem", "first principles"]),
        ("architecture in 200 words", ["architecture"]),
        ("source dive", ["source dive", "byte-by-byte", "line-by-line", "walk through"]),
        ("real numbers / benchmark", ["real numbers", "benchmark", "explain", "napkin"]),
        ("tradeoffs", ["tradeoff", "bad at", "limitation"]),
        ("what i'd build differently", ["build differently", "what i'd change", "what i would"]),
    ]
    n = 0
    for label, keywords in required:
        if not any(any(k in h for k in keywords) for h in headers):
            n += 1
            print(f"DEBUG missing_section: {label!r}", file=sys.stderr)
    return n


def cross_post_link_defects(body: str, repo_root: Path) -> int:
    """Verify https://backend.how/posts/SLUG/[#anchor] links against the actual
    post files in content/posts/."""
    posts_dir = repo_root / "content" / "posts"
    n = 0
    for m in re.finditer(
        r"https?://backend\.how/posts/([\w-]+)/?(?:#([\w-]+))?", body
    ):
        slug, anchor = m.group(1), m.group(2)
        # find the post file
        candidates = [
            posts_dir / slug / "index.md",
            posts_dir / f"{slug}.md",
        ]
        path = next((c for c in candidates if c.exists()), None)
        if path is None:
            n += 1
            print(f"DEBUG broken_post_link: /posts/{slug}/ has no file", file=sys.stderr)
            continue
        if anchor is None:
            continue
        # check anchor against headers of the target post
        try:
            target = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        headers = re.findall(r"^#+\s+(.+?)\s*$", target, flags=re.MULTILINE)
        slugs = {slugify(h) for h in headers}
        if anchor not in slugs:
            n += 1
            print(
                f"DEBUG broken_post_anchor: /posts/{slug}/#{anchor} "
                f"(not among {len(slugs)} headers)",
                file=sys.stderr,
            )
    return n


def heading_hierarchy_defects(body: str) -> int:
    """h1 → h2 → h3 should not skip levels (no h1 followed directly by h3)."""
    n = 0
    prev = 0
    for m in re.finditer(r"^(#{1,6})\s", body, flags=re.MULTILINE):
        lvl = len(m.group(1))
        if prev and lvl > prev + 1:
            n += 1
            print(
                f"DEBUG heading_skip: jumped from h{prev} to h{lvl} at offset {m.start()}",
                file=sys.stderr,
            )
        prev = lvl
    return n


def claim_audit_defects(body: str) -> int:
    """Words like 'measured/observed/benchmarked' assert first-hand evidence —
    they must be backed by a hyperlink, footnote ref, or `commit <hash>`
    within the same paragraph (or in a quoted/cited surrounding sentence)."""
    paragraphs = re.split(r"\n\s*\n", body)
    n = 0
    for p in paragraphs:
        if p.strip().startswith("```") or "|" in p[:5]:
            continue
        hits = CLAIM_RE.findall(p)
        if not hits:
            continue
        # accept any of: hyperlink, footnote ref, "commit <hex>", "in <ref-post>"
        if re.search(
            r"\[[^\]]+\]\([^)]+\)|https?://|\[\^[\w-]+\]|commit\s+`?[\dA-Fa-f]{6,}|"
            r"\bbench/|\bautoresearch\b",
            p,
        ):
            continue
        n += len(hits)
        for h in hits:
            print(
                f"DEBUG unbacked_claim: '{h}' in paragraph without citation",
                file=sys.stderr,
            )
    return n


def footnote_balance_defects(body: str) -> int:
    """Every [^name] reference must have a matching [^name]: definition."""
    refs = set(re.findall(r"\[\^([\w-]+)\](?!:)", body))
    defs = set(re.findall(r"^\[\^([\w-]+)\]:", body, flags=re.MULTILINE))
    orphan_refs = refs - defs
    orphan_defs = defs - refs
    if orphan_refs:
        print(f"DEBUG orphan footnote refs: {sorted(orphan_refs)}", file=sys.stderr)
    if orphan_defs:
        print(f"DEBUG orphan footnote defs: {sorted(orphan_defs)}", file=sys.stderr)
    return len(orphan_refs) + len(orphan_defs)


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

    # This scorer lives at .autoresearch/citus-distributed-planner/score.py;
    # the Hugo project root is two levels up.
    repo_root = Path(__file__).resolve().parent.parent.parent
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
    cats["inconsistent_idents"] = identifier_consistency_defects(body, cached_repo)
    cats["footnote_balance"] = footnote_balance_defects(body)
    cats["math_off"] = math_equality_defects(body)
    cats["dollar_no_math"] = dollar_no_math_defects(body)
    cats["bad_anchors"] = anchor_check_defects(body)
    cats["defaults_mismatch"] = defaults_consistency_defects(body, cached_repo)
    cats["range_inverted"] = range_bounds_defects(body)
    cats["unbacked_claims"] = claim_audit_defects(body)
    cats["http_not_https"] = http_not_https_defects(body)
    cats["heading_skip"] = heading_hierarchy_defects(body)
    cats["broken_post_links"] = cross_post_link_defects(body, repo_root)
    cats["missing_sections"] = required_sections_defects(body)
    cats["bad_commit_refs"] = commit_ref_defects(body, cached_repo)
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
        "inconsistent_idents": 3,
        "footnote_balance": 4,
        "math_off": 5,
        "dollar_no_math": 1,
        "bad_anchors": 3,
        "defaults_mismatch": 5,
        "range_inverted": 3,
        "unbacked_claims": 2,
        "http_not_https": 2,
        "heading_skip": 2,
        "broken_post_links": 4,
        "missing_sections": 4,
        "bad_commit_refs": 4,
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
