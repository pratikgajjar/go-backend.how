# Voice & Style — go-backend.how

You are writing a long-form technical blog post for **go-backend.how**, the personal site of Pratik Gajjar. You MUST match the existing voice and depth.

## Required style (non-negotiable)

1. **First-principles, not survey.** Don't say "X is a popular tool." Say "X exists because Y is hard, and here's the math that proves it."
2. **Real numbers everywhere.** Throughput, latency p50/p99, allocation count, syscall count. If you don't know, say "back-of-envelope" and show the working — never wave hands.
3. **eBPF-grade observability.** Where applicable, show what `strace`, `bpftrace`, `pg_stat_statements`, or `perf` would tell you. Look at existing posts for the trace style.
4. **Code blocks that compile** (or at minimum are syntactically valid Go/SQL/bash). Reference exact symbols from the source — file path + function name.
5. **No filler.** No "in this blog post we will explore." No "let's dive in." Open with the problem or the surprise.
6. **Sentences punch.** One idea per sentence. Short paragraphs. Use blockquotes for the one-line punchlines.
7. **Indian-payments, distributed-systems sensibility.** Author works on payments at scale; reference UPI/RBI/NPCI when relevant; assume the reader is a senior backend engineer.
8. **Honest about tradeoffs.** Every win has a cost. Name it.

## Reference posts (READ THESE FIRST for voice)

Run these reads before writing:

```
Read: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/1b-payments-per-day/index.md
Read: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/temporal-under-the-hood/index.md
Read: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/fdyno-dynamodb-on-foundationdb/index.md
Read: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/the-tiger-style/index.md
```

Specifically copy:
- The opening hook style (a number or a contradiction).
- The use of `> blockquote` for thesis statements.
- The eBPF/syscall trace formatting (fenced code blocks with annotated output).
- The "napkin math" section pattern.
- The end-of-post tradeoffs / "what I'd change" section.

## Hugo frontmatter (required)

```toml
+++
title = "<emoji> <Title Case Title>"
description = "<150-180 chars, search-optimized but not spammy>"
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = [...]
images = []
theme = "<assigned>"
featured = false
math = false
+++
```

## Structural rules

- Headings: `#` for sections (H1 in body), `##` for subsections, `###` for sub-sub. Hugo treats the frontmatter title as the page title — H1 in body is fine and matches existing posts.
- Tables: pipe-style. Use them for benchmark numbers and tradeoff matrices.
- Code: fenced with language. Always include the file path as a comment at the top: `// internal/buffer/ring_buffer.go`.
- Length: **3000–5000 words**. Do not pad. If you finish at 2500 with everything said, ship it.
- End with a "What I'd change next" or "Tradeoffs" section. NEVER end with a marketing-style summary.

## Workflow

1. Read the brief file given to you.
2. Read the 4 reference posts above.
3. Read the source code in the cached repo (path provided in brief).
4. Read the README of the repo.
5. Write a draft to the output path (provided in brief). Mark `draft = true` initially.
6. Run `hugo --quiet -D 2>&1 | head -30` from `/Users/pratikgajjar/ambitious/go-backend.how/` to verify build.
7. Keep iterating; the reviewer (a separate Claude session) will send you feedback via the same terminal.

## Hard rules

- Never fabricate numbers. If you do napkin math, show the math. If you cite a benchmark, point at the file/function or say "estimated."
- Never cite a source that doesn't exist. If you reference RFC X, give the section.
- Never use marketing language ("powerful," "blazingly fast" without numbers, "seamlessly," "robust").
- Don't write more than 5000 words.
- Don't `git push`. Don't switch branches. Don't `git commit` until the reviewer approves.
- Stay in `/Users/pratikgajjar/ambitious/go-backend.how/` — do NOT modify cached repos under `~/.cache/checkouts/`.
