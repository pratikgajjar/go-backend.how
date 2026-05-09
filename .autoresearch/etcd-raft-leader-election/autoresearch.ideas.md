# Deferred ideas — etcd-raft leader election post

## Done in this session

- ✅ Iter 1: drop `// TODO(xiangli)` lines from snippets, rename `T_election` / `tickInterval` / `Propose()` for ident-consistency, fix demo file path comment, fix `[TODO]` link label.
- ✅ Iter 2: relabel node.Tick snippet from raft.go to node.go, add hyperlinks for unbacked-claim measured paragraphs, derive 100 ns/200 ns proto encode comparison.
- ✅ Iter 3: M1 → M3 Max factual fix, refresh bench with 3 runs, replace 99.9999% with 1.5 s / 1.5 µs ratio.
- ✅ Iter 4: tie title 200 µs to a 3-row regime table (CPU 1.8 µs / localhost 200 µs / production 1-2 s).
- ✅ Iter 5: drop unverifiable CockroachDB/TiKV claims; tighten Pre-Vote-default observation to library-internal facts.
- ✅ Iter 6: 200 µs derivation made structural (12 channel ops × 10 µs).
- ✅ Iter 7: bpftrace/dtrace + `go tool trace` one-liners.
- ✅ Iter 8: required_sections.json sidecar locks in the brief's seven sections.
- ✅ Iter 9: CheckQuorum cost was wrong (no extra heartbeats; right cost is one map walk per electionTimeout).
- ✅ Iter 10: split-vote pair-collision was off by 2× (1/4 → 1/5).
- ✅ Iter 11: demo snippet did not compile (gogoproto.nullable migration), now runs in /tmp checkout.
- ✅ Iter 12: `tla/raft.tla` 404; pointed at the real `Traceetcdraft.tla`.

## Open / deferred

- **Real localhost wall-clock measurement.** The 200 µs in the title is napkin
  math (1.8 µs CPU + ~12 channel ops + Storage.Append + Ready alloc).
  A real `go test -trace` run on the demo snippet would either confirm
  or refute it. Adding that measurement here would close the gap, but
  requires writing a clean trace harness and a tiny program that
  parses the trace JSON. ~1 hour of work; not done because the order-
  of-magnitude argument is already strong.
- **bcastAppend overhead estimate.** I claim "becomeLeader + appendEntry"
  is ≈ 500 ns. That covers `r.reset(r.Term)`, an empty `appendEntry`,
  and the self-MsgAppResp enqueue. The bcastAppend that immediately
  follows isn't in the table — it's a 2× MsgApp send. Rough cost
  ≈ 200 ns more. Could fold this in for completeness.
- **Compare with hashicorp/raft.** The other big Go Raft library
  (used by Consul, Vault, etc.) has different defaults (e.g. always
  uses Pre-Vote, different lease semantics). A compare-and-contrast
  table would strengthen the "defaults matter" argument.
- **The `ForgetLeader` path.** Recently added (commit `1159466`). It's
  the third campaign type alongside `campaignElection` and
  `campaignTransfer`. Worth a short paragraph if the post grows.
- **Full bpftrace one-liner against a production binary.** I gestured
  at it; an actual recipe with `bpftrace -e 'uprobe:.../becomeCandidate { ... }'`
  + sample output would make Stretch goal #1 from the brief stronger.
  Skipped because we're on macOS and the validation roundtrip is high.
- **Pre-Vote and CheckQuorum interaction.** When both are enabled, the
  inLease check in Step + the explicit two-round PreVote together
  almost completely defang the disruptive-server problem. A small
  paragraph quantifying how many PRs in etcd's history were either
  fixes or tests for this combo would tie it back to "defaults matter".

## Pruned (deliberate scope cut)

- ~~Multi-Raft / range coalescing detail~~ — CockroachDB-specific,
  out of scope for a single-Raft-library post.
- ~~Joint consensus / conf-change walk~~ — different subsystem; the
  post is leader-election only.
- ~~Snapshot path~~ — reasonable to mention briefly; explicit walk
  would double the post length.
