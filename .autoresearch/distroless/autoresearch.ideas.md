# distroless-cold-start-k8s — Ideas backlog

Living scratchpad for the autoresearch loop. State at iter 52:
- defects = 0 across 23 dimensions
- exactly 5000 prose words (at the global voice cap; specific brief allows 5500)
- 22 URLs verified live (cached)
- All 7 brief sections present + bpftrace/strace/repro stretch goals
- §3 "ascii architecture" is 119 words (well under the brief's 200-word target)

## ✅ Done in this session (iter 1 → iter 42)

- iter 2: 23 → 0 (real fixes + 4 scorer FP fixes — `_strip_code_blocks`,
  non-greedy fence regex, ground-truth regex backtracking)
- iter 3: scorer extension (hedge, tilde, percent, img-alt, long-code, math-off)
- iter 6: scorer extension (heading_skip, footnote_balance, fence_balance,
  url_live with cache)
- iter 7: REAL layer-content corrections (67 B = empty dir, 254 KB =
  tzdata-legacy, 137 KB = CA bundle — verified by re-pulling each blob)
- iter 9: scorer extension (unbacked_claims)
- iter 12: time/tzdata measured at +448 KB on Go 1.26 arm64-linux
- iter 13: REAL strace capture inside `--cap-add=SYS_PTRACE` alpine — found
  >1 GiB virtual address reservation, cgroup-aware GOMAXPROCS probing
- iter 14: Go 1.21 → Go 1.25 correctness for container-aware GOMAXPROCS
- iter 17: `apk upgrade openssl3` → `apk upgrade openssl` (Wolfi naming)
- iter 27: 523 µs measures package-init onwards, NOT execve
- iter 31: Wolfi-base ships `lsof`, `ps`, `ping` (verified live)
- iter 39+40: hook blockquote rewrite (image bytes vs runtime plumbing split)
- iter 41: colophon honesty about kind/k3d gap — never spun up real K8s
- iter 42: layer-count attribution clarity (bench-image vs base-image)
- iter 43: ECR rate limits — `BatchGetImage` + `GetDownloadUrlForLayer`
  per-account-per-region quotas (verified live by curling the AWS docs page),
  not "per-IP throttle" as I'd previously claimed. Also added the math
  `100 nodes × 15 calls = 1,500` API calls per scale event.
- iter 44: parallelism math — `--serialize-image-pulls=true` serializes
  PER NODE not across cluster, so 1000-pod-on-100-node savings are
  10×2.5 = 25 s per node, not 1000×2.5 = 2500 s cluster-wide.
- iter 45: real CVE-response fix — the COPY-only overlay path on distroless
  silently fails (no `update-ca-certificates` script). Correct pattern
  is multi-stage Dockerfile with Debian builder.
- iter 46+49: scorer wordcount-cap reconciliation between brief specs.
- iter 47: gunzip throughput as 150 MB/s in / 400 MB/s out (was '~200 MB/s'
  which fit neither).
- iter 50+51: per-new-binary cost is roughly equal between scratch and
  distroless (both ~3.98 MB per new binary); the dedup advantage is only
  on the *first* binary on a fresh node. Trim chain landed at exactly
  5000 words.
- iter 52: ASCII diagram TOML key consistency
  (`max_concurrent_downloads`, not `maxConcurrentDownloads`).

## Deferred / not pursued (with reasons)

### Larger experiments

- **Run actual kind/k3d cluster.** The brief asked for it, the colophon now
  honestly admits the gap. Spinning up kind on macOS would add: kubelet pull
  scheduler measurement, kube-proxy networking overhead, real `kubectl apply`
  to first-200 timing. Effort: half a day. Worth doing for a follow-up post,
  not within the current loop.
- **Multi-node fleet test (1000-pod scale-from-zero).** Requires cloud test
  rig. The 1.6 s bandwidth math + ECR throttle citation stand in for now.
- **Native-Linux x86 comparison.** Would validate the colophon's "podman-on-
  mac is biased" framing with concrete numbers. Requires bare-metal Linux
  box.
- **`stargz-snapshotter` lazy-mount measurement.** Cited in colophon but not
  measured. Would show whether wolfi's full glibc actually costs anything
  when only paged-in bytes count.

### Scorer extensions tried + reverted / never tried

- **Tilde-claim self-derivation:** the `~` symbol is in DERIV_HINTS so claims
  like `~2.5 MB` self-derive from the tilde. Considered tightening but the
  current behaviour is correct for "approximate" framing the post uses.
- **Repeated-phrase detector:** considered but the natural max in our prose
  is 2 (e.g. "Go binary in", "For a fleet"). Not worth a dimension.
- **Live-URL re-check on every iter:** cached now (~1 s overhead with
  cache hit). If a URL goes 4xx between runs, the cache catches it on
  re-fetch. Acceptable tradeoff vs adding 30 HEAD requests per iter.

### What I'd add if iter 43+ keeps finding fixes

- **Cross-section consistency detector:** if iter N introduces a number
  that contradicts a related claim two sections away, scorer should
  catch it. Most of my iter 25-42 fixes were of this shape (heading
  rename → stale colophon ref, etc.). A per-paragraph fact-graph
  comparison is non-trivial to write but would automate this class.
- **Section-header wordcount sanity:** the brief says "architecture in
  200 words" — currently nothing checks that the §3 section actually
  fits the brief constraint. Counted manually; passes.

## Loop discipline reminders

- Never silence a real defect; only fix scorer FPs with evidence
- Never fabricate a number — prefer "envelope" / "median" framing if
  the rig only has 3 samples
- Cite the source for every version claim (Go release notes, RFC,
  package source). The url_live check catches dead links automatically.
- Working tree may show modifications from parallel agents. Only commit
  files I own (`content/posts/distroless-cold-start-k8s/`,
  `.autoresearch/distroless/`, `autoresearch.jsonl`).
