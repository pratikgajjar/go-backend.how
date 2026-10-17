#!/usr/bin/env python3
"""List Claudism candidates in one post (see docs/CLAUDISMS.md).

  uv run scripts/slop-check.py <slug>        prose + figure text for one post
  uv run scripts/slop-check.py --all         every published post, counts only

Checks the post's index.md (prose only: skips front matter, code fences and
shortcode lines) and the string literals in js/viz/<slug>.js. Hits are
candidates, not errors: a technical use ("the foot lands") is fine.
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

WORDS = [
    r"land(s|ed|ing)?", r"lanes?", r"lives (in|at|on)", r"sits?", r"shape[sd]?",
    r"surfac(e|es|ed|ing)", r"load-bearing", r"carr(y|ies|ied)", r"walks?( through)?",
    r"owns", r"settles?", r"flips?", r"survives?", r"wins?", r"gat(e|es|ed|ing)",
    r"wir(e|ed|ing)", r"drift", r"harness", r"leverag\w*", r"unlock\w*", r"empower\w*",
    r"foster\w*", r"engine", r"physics", r"story", r"beat", r"tax", r"pays? for",
    r"buys?( you)?", r"for free", r"cheap(ly)?", r"budget", r"the tell", r"the trick",
    r"the catch", r"punchline", r"verdict", r"decisive", r"delv\w*", r"journey",
    r"landscape", r"navigat\w*", r"realm", r"tapestry", r"testament", r"pivotal",
    r"crucial", r"vital", r"robust", r"seamless\w*", r"intricat\w*", r"meticulous\w*",
    r"interplay", r"nuanced?", r"genuine(ly)?", r"honest(ly)?", r"quietly", r"cleanly",
    r"crisp", r"sharp", r"really", r"actually", r"simply", r"just", r"basically",
    r"truly", r"deliberately", r"essentially", r"the real", r"the whole game",
    r"the right (question|tool|way|answer|time)", r"here'?s the thing",
    r"here'?s where", r"the point is", r"worth noting", r"this matters",
    r"that matters", r"let'?s", r"that'?s it", r"not [^.]{1,40}, but",
    r"it'?s not [^.]{1,40}, it'?s", r"you might think", r"you'?re probably",
    r"surprised me", r"keep coming back",
]
PAT = re.compile(r"\b(" + "|".join(WORDS) + r")\b", re.I)
EMDASH = re.compile("\u2014")


def prose_lines(md: Path):
    text = md.read_text().splitlines()
    fm = 0
    fence = False
    for n, line in enumerate(text, 1):
        if line.strip() == "+++":
            fm += 1
            continue
        if fm < 2:
            continue
        if line.lstrip().startswith("```"):
            fence = not fence
            continue
        if fence or line.lstrip().startswith("{{<"):
            continue
        # drop inline code and link targets
        clean = re.sub(r"`[^`]*`", "", line)
        clean = re.sub(r"\]\([^)]*\)", "]", clean)
        yield n, clean


def js_strings(js: Path):
    for n, line in enumerate(js.read_text().splitlines(), 1):
        if line.lstrip().startswith(("//", "*", "/*")):
            continue
        for m in re.finditer(r"'([^'\\]{12,})'|`([^`]{12,})`|\"([^\"\\]{12,})\"", line):
            s = next(g for g in m.groups() if g)
            if " " in s and not s.startswith(("v-", "wv", "M ", "translate")):
                yield n, s


def check(slug: str, quiet=False):
    md = ROOT / "content/posts" / slug / "index.md"
    js = ROOT / "themes/coloroid/assets/js/viz" / f"{slug}.js"
    hits = []
    for n, line in prose_lines(md):
        for m in PAT.finditer(line):
            hits.append(("md", n, m.group(0), line.strip()))
        if len(EMDASH.findall(line)) > 1:
            hits.append(("md", n, "em-dash x%d" % len(EMDASH.findall(line)), line.strip()))
    if js.exists():
        for n, s in js_strings(js):
            for m in PAT.finditer(s):
                hits.append(("js", n, m.group(0), s.strip()))
    if not quiet:
        for src, n, word, ctx in hits:
            i = ctx.lower().find(word.lower())
            snip = ctx[max(0, i - 50): i + len(word) + 50]
            print(f"{src}:{n:<5} {word!r:<18} …{snip}…")
        print(f"{len(hits)} candidates in {slug}")
    return len(hits)


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return 2
    if args[0] == "--all":
        for md in sorted((ROOT / "content/posts").glob("*/index.md")):
            if re.search(r"^draft\s*=\s*false", md.read_text(), re.M):
                print(f"{check(md.parent.name, quiet=True):5}  {md.parent.name}")
        return 0
    check(args[0])
    return 0


if __name__ == "__main__":
    sys.exit(main())
