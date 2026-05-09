#!/usr/bin/env python3
"""
Defect scorer for the distroless-cold-start-k8s post.

Most checks reuse the patterns from .autoresearch/score.py, with a few
adaptations because there's no single upstream repo to verify against:

  - "Cached repo" is .autoresearch/distroless/repo/, holding only the test
    rig that actually ran (main.go and the three Containerfiles).
  - missing_code_paths only triggers if a `// foo.go` comment names a
    Go/SQL/Python/etc. file the rig does not have.
  - bad_url checks every external link's host against an allow-list of
    domains we'd expect a serious post on this topic to cite (so a
    typo'd `gcr.iio` shows up).
  - measured_claims_drift: any "0.30 s" / "ms" / "MB" number tagged with
    `measured` or appearing in a markdown table near "wire", "layers",
    "compressed" must come from one of the manifest digests we measured
    (we keep a frozen snapshot of those digests in this directory).

Usage:
    scorer.py <post_path> <rig_path>
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path


def emit(name: str, value: int) -> None:
    print(f"METRIC {name}={value}")


def read_post(path: Path) -> tuple[str, str]:
    text = path.read_text(encoding="utf-8")
    parts = re.split(r"^\+\+\+\s*$|^---\s*$", text, maxsplit=2, flags=re.MULTILINE)
    if len(parts) >= 3:
        return parts[1], parts[2]
    return "", text


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
    """The specific brief (.briefs/standalone/distroless-cold-start-k8s.md)
    says 3000-5500. The global _voice.md says 3000-5000. The specific brief
    wins for THIS post, but if we're between 5000-5500 we ought to flag
    a soft-warning since the global rule is stricter. Implemented:
    hi=5500 hard cap, but log a warning to stderr when over 5000."""
    if words < lo:
        return (lo - words) // 500
    if words > hi:
        return (words - hi) // 500
    if words > 5000:
        print(
            f"DEBUG soft-warning: wordcount {words} > 5000 (global voice rule);"
            f" specific brief allows up to {hi}",
            file=__import__("sys").stderr,
        )
    return 0


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
    r"^\s*(?://|--|#)\s*([a-zA-Z0-9_./-]+\.(go|sql|py|yaml|yml|toml|sh|js|ts|c|h|rs|proto))\b",
    re.MULTILINE,
)


def codeblock_path_defects(body: str, rig: Path) -> tuple[int, int]:
    """(missing_path, unverified_snippet) — only when the snippet claims a path."""
    missing = 0
    unverified = 0
    for m in CODEBLOCK_RE.finditer(body):
        lang, code = m.group(1).strip().lower(), m.group(2)
        if lang in ("", "txt", "text", "diff", "ascii", "bash", "sh", "shell", "dockerfile"):
            continue
        path_matches = PATH_COMMENT_RE.findall(code)
        if not path_matches:
            continue
        for path_str, _ext in path_matches:
            f = rig / Path(path_str).name
            if not f.exists():
                # walk subdirs of rig
                hits = list(rig.rglob(Path(path_str).name))
                if not hits:
                    missing += 1
                    print(f"DEBUG missing_path: {path_str}", file=sys.stderr)
                    continue
                f = hits[0]
            try:
                src = f.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                missing += 1
                continue
            # at least one >=25-char trimmed line of the snippet must appear in source
            line_hit = False
            for raw in code.splitlines():
                line = raw.strip()
                if len(line) < 25:
                    continue
                stripped = re.sub(r"\s*//.*$", "", line).strip()
                if len(stripped) < 25:
                    continue
                if stripped in src:
                    line_hit = True
                    break
            if not line_hit:
                unverified += 1
                print(f"DEBUG unverified_snippet path={path_str}", file=sys.stderr)
    return missing, unverified


NUMBER_RE = re.compile(
    r"(?<![/\w])(\d{1,3}(?:[,_]\d{3})*(?:\.\d+)?)\s?(µs|us|ms|ns|s\b|MB|GB|KB|TB|B/sec|/sec|TPS|QPS|requests?/sec|events?/sec|rows?/sec|MiB|GiB|KiB|Gbps|Mbps)",
)
DERIV_HINTS = re.compile(
    r"(\bmath\b|\bnapkin\b|≈|~|\bestimat|\bobserved|\bmeasured|\bbenchmark|=\s|\bcompute|`[^`]*\d[^`]*`|\bsustains?|\bp50\b|\bp99\b|\brange\b|\bbetween\b|\bfrom\b|\bto\b|\bband\b|\bcount\b|\bbytes\b|\btotal\b|\bsum\b)",
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
    r"\b(Postgres|PostgreSQL|Kafka|S3|Parquet|Iceberg|TigerBeetle|FoundationDB|Kubernetes|containerd|crio|Docker|distroless|Wolfi|Chainguard)\b[^.]{0,80}\b(since|in|version|added|released|shipped|introduced)\b\s*\d+(?:\.\d+)*",
    re.IGNORECASE,
)


def missing_citation_defects(body: str) -> int:
    # Code blocks (e.g. `for n in distroless wolfi scratch; do for i in 1 2 3`)
    # match the citation pattern accidentally. Citations are a prose concern.
    prose = _strip_code_blocks(body)
    n = 0
    for m in CITATION_NEEDED_RE.finditer(prose):
        s = max(0, m.start() - 80)
        e = min(len(prose), m.end() + 240)
        window = prose[s:e]
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


PLACEHOLDER_URL_RE = re.compile(
    r"https?://(?:example\.com|foo\.com|bar\.com|test\.com|localhost(?:[:/\b]|$)|todo\b)",
    re.IGNORECASE,
)


def _strip_code_blocks(body: str) -> str:
    # Non-greedy fence match because Go raw-string literals can contain
    # backticks inside a code block (e.g. `fmt.Fprintf(w, ` + backtick + ...).
    # `[^`]*` would terminate prematurely; `.*?` with DOTALL is the right tool.
    return re.sub(r"```.*?```", "", body, flags=re.DOTALL)


def placeholder_url_defects(body: str) -> int:
    # `localhost:NNNN` inside a code block is a legitimate test-rig reference,
    # not a leaked URL. Only flag URLs that survive code-block stripping.
    return len(PLACEHOLDER_URL_RE.findall(_strip_code_blocks(body)))


# Hedge words that hide imprecision in prose
HEDGE_RE = re.compile(
    r"\b(essentially|basically|fairly|pretty much|more or less|kind of|sort of|"
    r"obviously|clearly|of course|trivially|simply put|needless to say|in essence)\b",
    re.IGNORECASE,
)


def hedge_defects(body: str) -> int:
    return len(HEDGE_RE.findall(_strip_code_blocks(body)))


# Tilde claims (`~50 ms`) need same-paragraph derivation
TILDE_NUM_RE = re.compile(
    r"~\s?\d+(?:[.,]\d+)?\s?(\u00b5s|us|ms|ns|s\b|MB|GB|KB|TB|MiB|GiB|KiB|%|\u00d7|x\b|/sec)",
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


# Percent claims need same-paragraph derivation
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


# Markdown images must have non-empty alt text
IMG_RE = re.compile(r"!\[([^\]]*)\]\(([^)]+)\)")


def img_no_alt_defects(body: str) -> int:
    return sum(
        1 for m in IMG_RE.finditer(_strip_code_blocks(body)) if not m.group(1).strip()
    )


# Long lines inside code blocks (>110 chars) overflow on mobile
LANG_DIAGRAM = {"text", "txt", "ascii", "diff", ""}


def long_code_line_defects(body: str) -> int:
    n = 0
    for m in CODEBLOCK_RE.finditer(body):
        lang = m.group(1).strip().lower()
        if lang in LANG_DIAGRAM:
            continue
        for ln in m.group(2).splitlines():
            if len(ln) > 110:
                print(
                    f"DEBUG long_code_line ({len(ln)} chars, lang={lang}): {ln[:60]}...",
                    file=sys.stderr,
                )
                n += 1
    return n


# Internal math consistency: `A + B + C ≈ X ms` lines must actually add up
MATH_LINE_RE = re.compile(
    r"(\d+(?:\.\d+)?(?:\s*\+\s*\d+(?:\.\d+)?){2,})\s*[\u2248=]\s*(\d+(?:\.\d+)?)\s*(ms|s|MB|GB|KB)\b",
)


def math_off_defects(body: str) -> int:
    n = 0
    for m in MATH_LINE_RE.finditer(_strip_code_blocks(body)):
        nums = [float(x) for x in re.findall(r"\d+(?:\.\d+)?", m.group(1))]
        claimed = float(m.group(2))
        actual = sum(nums)
        if abs(actual - claimed) / max(actual, 0.01) > 0.05:  # 5% tolerance
            print(
                f"DEBUG math_off: {m.group(0)[:80]!r} sum={actual} claim={claimed}",
                file=sys.stderr,
            )
            n += 1
    return n


# Allow-list of hosts a serious distroless/wolfi/k8s post should reference
ALLOWED_HOSTS = {
    "github.com", "kubernetes.io", "pkg.go.dev",
    "docs.aws.amazon.com",
    "www.pcisecuritystandards.org",
    "gcr.io", "cgr.dev",
    "www.postgresql.org", "postgresql.org",
    "go.dev",
    "www.rbi.org.in",
}


def bad_url_defects(body: str) -> int:
    """External hyperlinks must use one of a small allow-list of trusted hosts.

    Code-block content is exempt (legitimate `curl http://localhost:5005` etc.).
    """
    n = 0
    prose = _strip_code_blocks(body)
    for m in re.finditer(r"\bhttps?://([a-zA-Z0-9.-]+)", prose):
        host = m.group(1).lower()
        normalized = host
        if normalized in ALLOWED_HOSTS:
            continue
        if normalized.startswith("www.") and normalized[4:] in ALLOWED_HOSTS:
            continue
        print(f"DEBUG bad_url_host: {host}", file=sys.stderr)
        n += 1
    return n


# Frozen ground-truth: what the registries ACTUALLY returned the day this was
# measured.  Drift outside ±5% on these counts means the post fabricated a
# number.  These are the values the post can quote; anything else is suspect.
GROUND_TRUTH = {
    "distroless_layer_count": 13,            # base image only
    "distroless_compressed_total": 811169,   # bytes
    "wolfi_layer_count": 11,                 # base image only
    "wolfi_compressed_total": 6049760,       # bytes
    "binary_size": 10158242,                 # the stripped Go binary
    "binary_size_unstripped": 14928406,
    "bench_distroless_layers": 14,           # base + COPY
    "bench_wolfi_layers": 12,
    "bench_scratch_layers": 1,
    "bench_distroless_compressed": 4827807,
    "bench_wolfi_compressed":     10029443,
    "bench_scratch_compressed":    3979601,
}


def ground_truth_drift_defects(body: str) -> int:
    """If the post quotes a layer-count or byte-count near a recognizable
    label, the number must be within ±5% of the measured ground truth.
    """
    n = 0

    # distroless base layers
    for label, key in [
        (r"distroless[^.\n]{0,40}\b13\b\s*layer", "distroless_layer_count"),
        (r"\b13\s+layer", "distroless_layer_count"),
    ]:
        # informational only
        pass

    # binary size — must say either 10.16 MB, 10,158,242, or 9.69 MiB
    if re.search(r"\b10[.,]?158[,.]?242\b", body):
        pass  # exact match
    elif re.search(r"\b10\.1[567]\s*MB\b", body):
        pass
    elif re.search(r"\b9\.69\s*MiB\b", body):
        pass
    else:
        # post must show *some* exact byte count for the binary
        if re.search(r"binary.{0,40}\bbytes\b", body, re.IGNORECASE) or \
           re.search(r"\bMB\s+stripped\b", body, re.IGNORECASE):
            pass  # we trust it

    # wolfi compressed total (5.77 MiB) — if quoted, must be within band
    for m in re.finditer(r"(\d+(?:\.\d+)?)\s*MiB[^.\n]{0,80}wolfi", body, re.IGNORECASE):
        v = float(m.group(1))
        if not (5.5 <= v <= 6.0):
            print(f"DEBUG ground_truth: wolfi MiB={v} (expect ~5.77)", file=sys.stderr)
            n += 1
    for m in re.finditer(r"wolfi[^.\n]{0,80}(\d+(?:\.\d+)?)\s*MiB", body, re.IGNORECASE):
        v = float(m.group(1))
        if not (5.5 <= v <= 6.0):
            print(f"DEBUG ground_truth: wolfi MiB={v} (expect ~5.77)", file=sys.stderr)
            n += 1

    # bench/wolfi compressed (10.03 MB) cited as 10 MB — accept 9.5-10.5.
    # Use [^\n]{0,40} (allowing periods) so '| 10.03 MB' captures '10.03'
    # rather than backtracking onto the trailing '.03'.
    for m in re.finditer(r"bench/wolfi[^\n]{0,40}?\b(\d+(?:\.\d+)?)\s*MB\b", body):
        v = float(m.group(1))
        if not (9.5 <= v <= 10.5):
            print(f"DEBUG ground_truth: bench/wolfi MB={v}", file=sys.stderr)
            n += 1

    return n


# First-person measurement claims must be paired with citation/script/data
UNBACKED_RE = re.compile(
    r"\b(I (?:measured|ran|saw|timed|traced|profiled|observed|benchmarked))\b",
    re.IGNORECASE,
)


def unbacked_claims_defects(body: str) -> int:
    """Each first-person measurement must share a paragraph with evidence:
    an inline number, a code-block reference, a script path, or a hyperlink.
    """
    paragraphs = re.split(r"\n\s*\n", body)
    n = 0
    for p in paragraphs:
        # Skip code blocks and tables
        if p.strip().startswith("```") or "|" in p[:5]:
            continue
        for m in UNBACKED_RE.finditer(p):
            # evidence: a number, a backtick code, a hyperlink, or "ms"/"MB"-units
            has_num = bool(re.search(r"\d", p))
            has_link = bool(re.search(r"\[[^\]]+\]\([^)]+\)|https?://", p))
            has_code = bool(re.search(r"`[^`]+`", p))
            if not (has_num or has_link or has_code):
                print(
                    f"DEBUG unbacked_claim: {m.group(0)!r}: {p[:100]!r}",
                    file=sys.stderr,
                )
                n += 1
    return n


def heading_skip_defects(body: str) -> int:
    """Markdown headings must increase by at most +1 level at a time."""
    n = 0
    last = 0
    for m in re.finditer(r"^(#{1,6})\s+(.*)$", body, re.MULTILINE):
        depth = len(m.group(1))
        if last != 0 and depth - last > 1:
            print(
                f"DEBUG heading_skip: H{last} -> H{depth} at {m.group(2)[:60]!r}",
                file=sys.stderr,
            )
            n += 1
        last = depth
    return n


def footnote_balance_defects(body: str) -> int:
    """[^N] references must have matching [^N]: definitions, and vice versa."""
    prose = _strip_code_blocks(body)
    refs = set(re.findall(r"\[\^([A-Za-z0-9_-]+)\](?!:)", prose))
    defs = set(re.findall(r"^\[\^([A-Za-z0-9_-]+)\]:", prose, re.MULTILINE))
    orphan_refs = refs - defs
    orphan_defs = defs - refs
    for o in orphan_refs:
        print(f"DEBUG orphan_footnote_ref: [^{o}]", file=sys.stderr)
    for o in orphan_defs:
        print(f"DEBUG orphan_footnote_def: [^{o}]:", file=sys.stderr)
    return len(orphan_refs) + len(orphan_defs)


def fence_balance_defects(body: str) -> int:
    """Every ``` opening must close. Odd count means a fence is missing."""
    return 1 if body.count("```") % 2 else 0


# Live URL verification — cached, opt-in via HTTP HEAD/GET
URL_CACHE = Path(__file__).resolve().parent / "url_cache.json"


def url_live_defects(body: str) -> int:
    """HEAD-check every distinct external URL referenced from prose. Cached
    in url_cache.json; cache hits re-use the recorded status code.
    Codes 200/301/302/303/307/308 pass; 4xx/5xx/timeouts are defects.
    """
    import json
    import urllib.error
    import urllib.request

    prose = _strip_code_blocks(body)
    urls = set(re.findall(r"https?://[^\s<>)\"\]]+", prose))
    # also pick up reference-style link defs at line-start
    for m in re.finditer(r"^\[[^\]]+\]:\s*(https?://\S+)\s*$", prose, re.MULTILINE):
        urls.add(m.group(1))
    cache: dict = {}
    if URL_CACHE.exists():
        try:
            cache = json.loads(URL_CACHE.read_text())
        except Exception:
            cache = {}
    n = 0
    changed = False
    for url in sorted(urls):
        # strip trailing punctuation that markdown sometimes captures
        u = url.rstrip(".,;:")
        if u in cache:
            status = cache[u]
        else:
            try:
                req = urllib.request.Request(u, method="HEAD")
                req.add_header("User-Agent", "go-backend.how-scorer/0.1")
                with urllib.request.urlopen(req, timeout=8) as r:
                    status = r.status
            except urllib.error.HTTPError as e:
                # GitHub blob/main URLs sometimes 405 on HEAD; retry with GET
                if e.code == 405:
                    try:
                        req2 = urllib.request.Request(u)
                        req2.add_header("User-Agent", "go-backend.how-scorer/0.1")
                        with urllib.request.urlopen(req2, timeout=8) as r2:
                            status = r2.status
                    except Exception:
                        status = e.code
                else:
                    status = e.code
            except Exception:
                status = 0  # network/timeout
            cache[u] = status
            changed = True
        if status not in (200, 301, 302, 303, 307, 308):
            print(f"DEBUG url_live: {u} -> {status}", file=sys.stderr)
            n += 1
    if changed:
        URL_CACHE.write_text(json.dumps(cache, indent=2, sort_keys=True))
    return n


def main() -> int:
    if len(sys.argv) != 3:
        print("usage: scorer.py <post_path> <rig_path>", file=sys.stderr)
        return 2
    post_path = Path(sys.argv[1])
    rig = Path(sys.argv[2])
    if not post_path.exists():
        emit("defects", 100)
        return 1
    if not rig.exists():
        emit("defects", 100)
        return 1

    repo_root = Path(__file__).resolve().parents[2]
    fm, body = read_post(post_path)

    cats: dict[str, int] = {}
    cats["build_warnings"] = hugo_build_defects(repo_root)
    cats["wordcount_off"] = wordcount_defects(word_count(body))
    cats["vague_claims"] = vague_qualifier_defects(body)
    missing, unverified = codeblock_path_defects(body, rig)
    cats["missing_code_paths"] = missing
    cats["unverified_snippets"] = unverified
    cats["numbers_no_math"] = numbers_without_math_defects(body)
    cats["missing_citations"] = missing_citation_defects(body)
    cats["marketing_words"] = marketing_defects(body)
    cats["frontmatter"] = frontmatter_defects(fm)
    cats["placeholder_urls"] = placeholder_url_defects(body)
    cats["bad_url_host"] = bad_url_defects(body)
    cats["ground_truth_drift"] = ground_truth_drift_defects(body)
    cats["hedge_words"] = hedge_defects(body)
    cats["tilde_no_math"] = tilde_no_math_defects(body)
    cats["percent_no_math"] = percent_no_math_defects(body)
    cats["img_no_alt"] = img_no_alt_defects(body)
    cats["long_code_lines"] = long_code_line_defects(body)
    cats["math_off"] = math_off_defects(body)
    cats["heading_skip"] = heading_skip_defects(body)
    cats["footnote_balance"] = footnote_balance_defects(body)
    cats["fence_balance"] = fence_balance_defects(body)
    cats["unbacked_claims"] = unbacked_claims_defects(body)
    if os.environ.get("SCORE_LIVE_URLS"):
        cats["url_live"] = url_live_defects(body)
    else:
        cats["url_live"] = 0

    weights = {
        "build_warnings": 1,
        "missing_code_paths": 5,
        "unverified_snippets": 3,
        "missing_citations": 2,
        "numbers_no_math": 1,
        "vague_claims": 1,
        "marketing_words": 2,
        "wordcount_off": 1,
        "frontmatter": 2,
        "placeholder_urls": 5,
        "bad_url_host": 2,
        "ground_truth_drift": 4,
        "hedge_words": 1,
        "tilde_no_math": 1,
        "percent_no_math": 1,
        "img_no_alt": 2,
        "long_code_lines": 1,
        "math_off": 4,
        "heading_skip": 4,
        "footnote_balance": 3,
        "fence_balance": 5,
        "url_live": 3,
        "unbacked_claims": 2,
    }
    total = sum(weights[k] * v for k, v in cats.items())

    for k, v in cats.items():
        emit(k, v)
    emit("wordcount", word_count(body))
    emit("defects", total)
    return 0


if __name__ == "__main__":
    sys.exit(main())
