+++
title = "🐢 etcd Raft in 200 µs — One Leader Election, Traced"
description = "Reading etcd-io/raft to see where a leader election really spends its time: ≈ 1.8 µs of state-machine work, ≈ 1.3 s of randomised waiting. Why Pre-Vote and CheckQuorum exist, and what each one costs."
date = 2026-05-09T12:00:00+05:30
lastmod = 2026-05-09T12:00:00+05:30
publishDate = "2026-05-09T12:00:00+05:30"
draft = true
tags = ["raft", "etcd", "consensus", "leader-election", "golang"]
images = ["og.png"]
theme = "ocean"
featured = false
math = false
+++

# The hook

A Raft leader election is one of those operations that everyone has a
mental model for and almost nobody has measured. Ask three engineers how
long it takes and you'll get answers from "instant" to "several seconds".
Both are right, depending on what you measure (and the
[etcd-io/raft](https://github.com/etcd-io/raft/blob/main/raft.go) code
itself spells out which is which, once you read it line by line).

Here's the contradiction the [etcd-io/raft](https://github.com/etcd-io/raft)
source code actually shows you, once you read it carefully. Three
numbers describe the same election, in three different regimes:

> | Regime | What it measures | Order of magnitude |
> |---|---|---:|
> | CPU only | The state-machine transitions: `MsgHup → becomeCandidate → poll → becomeLeader`. | **≈ 1.8 µs** |
> | Localhost wall-clock | Same path, plus channel sends, goroutine wakeups, in-memory `Storage.Append`. | **≈ 200 µs** |
> | Production wall-clock | Same path, plus the randomised election timer that has to fire first. | **≈ 1 to 2 s** |
>
> The two big jumps (`200 µs / 1.8 µs ≈ 100×` and
> `1.3 s / 200 µs ≈ 6,500×`) aren't computation. They're scheduling
> and deliberate waiting, in that order.

The 200 µs in the title is the middle row: an estimated localhost
wall-clock for the *protocol itself* doing one full election round
once the campaign decision has been taken. The estimate comes from a
napkin breakdown: 1.8 µs of state-machine work, plus a Ready/Advance
loop that crosses Go's scheduler ~12 to 16 times per node (one channel
op per `Step`, per `Ready` emission, per `Advance`, plus the
fan-out to the 2 followers). At a typical Go scheduler wakeup of
`~10 µs` per channel send under contention, that is on the order of
`~12 × 10 µs ≈ 120 µs`. Add two in-memory `Storage.Append` calls
(one per follower in this pass) and the allocation-heavy `Ready` build
and you round up to `≈ 200 µs`. It's the order of magnitude you'd see
if you `bpftrace`d the `MsgHup → becomeLeader` transition on a
single-machine 3-node test — production with disk fsync and real
network adds another `~1 to 10 ms` on top.

This post is a walk through why that is. We'll trace the exact path the
state machine takes from `tickElection()` firing on a follower to
`becomeLeader()` returning on a fresh leader, count the messages, count
the syscalls, and measure the parts that can be measured. The numbers
that anchor everything come from reading
[`raft.go`](https://github.com/etcd-io/raft/blob/main/raft.go) at commit
[`26c2367`](https://github.com/etcd-io/raft/commit/26c2367) and from
running `go test -bench` against the same tree.

> Single-node `Propose → Ready → Append → Advance` round-trip:
> **1,342 ns/op** on an Apple M3 Max MacBook Pro
> (median of 3 runs, ±3%; `BenchmarkOneNode`,
> [`node_bench_test.go`](https://github.com/etcd-io/raft/blob/main/node_bench_test.go)).
>
> The election path is shorter than that — it doesn't propose a user
> entry. The election *waits* are 100× to 100,000× longer than the
> election *work*.

# The problem this code was built to solve

A Raft cluster is a set of replicas trying to agree on a single ordered
log of commands. They tolerate up to `f` failures with `2f + 1` nodes.
Three properties together make consensus hard:

1. **Asynchronous network.** Messages can be delayed, dropped, reordered.
2. **Crash-prone nodes.** Any replica can vanish at any time.
3. **No global clock.** Replicas can't agree on what "now" means without
   already having consensus.

The
[FLP](https://groups.csail.mit.edu/tds/papers/Lynch/jacm85.pdf)
impossibility result says you can't have all three plus deterministic
termination in a fully asynchronous model. Raft, like Paxos, picks
randomised timeouts to escape FLP — at any given moment progress isn't
guaranteed, but the probability of failing forever is zero.

The election protocol in [Diego Ongaro's
thesis](https://github.com/ongardie/dissertation) (Section 3.4) is two
rules and a tiebreaker:

- A follower that hasn't heard from the leader for an *election timeout*
  becomes a candidate, increments its term, and asks every voter for a
  vote.
- A voter grants exactly one vote per term, only if the candidate's log
  is **at least as up-to-date** as its own.
- If two candidates split the vote, both time out again and try a higher
  term — but the timeout is randomised in
  `[electionTimeout, 2·electionTimeout − 1]` so one usually fires first.

That third rule is the entire reason production elections are slow.
We'll see exactly where it lives in the code.

# The architecture in 200 words

etcd-raft is unusual among consensus libraries: it ships **no transport
and no storage**. The README is explicit about this — the user passes in
both, and the library is a deterministic state machine that turns
`Message` inputs into a `Ready` struct of "things you must persist and
send" outputs.

```txt
            ┌───────────────────────────────────────────────────┐
            │                  Your application                 │
            │  (transport, fsync to WAL, apply to state machine)│
            └───────────┬─────────────────────▲─────────────────┘
                        │ Step(msg)           │ Ready{Entries,
                        │ Tick()              │   Messages,
                        │ Propose(data)       │   HardState,
                        │                     │   CommittedEntries}
            ┌───────────▼─────────────────────┴─────────────────┐
            │                 raft.Node                         │  node.go
            │  goroutine select{ propc, recvc, tickc, readyc }  │
            └───────────┬─────────────────────▲─────────────────┘
                        │                     │
            ┌───────────▼─────────────────────┴─────────────────┐
            │            raft.raft (state machine)              │  raft.go
            │  Term uint64; Vote, lead uint64;                  │
            │  state ∈ {Follower, Candidate, PreCandidate,      │
            │           Leader}                                 │
            │  Step(m) error          mutates r;                │
            │                         appends to r.msgs         │
            └───────────────────────────────────────────────────┘
```

`Tick`, `Step`, `Propose` are deterministic w.r.t. the state machine
— same input plus state always produces the same outcome (modulo the
crypto/rand timer reset, which is the *only* nondeterminism in the
library). The library is intentionally built this way so the
[interaction-driven tests](https://github.com/etcd-io/raft/blob/main/interaction_test.go)
can replay sequences and the [TLA+ trace validation
machinery](https://github.com/etcd-io/raft/blob/main/tla/Traceetcdraft.tla)
(model in `etcdraft.tla`, trace harness in `Traceetcdraft.tla`) can
check refinement against real Go runs. This is the same trick
TigerBeetle uses for [deterministic
simulation](https://backend.how/posts/the-tiger-style/) — separate
"decide what to do" from "actually do it" so tests can fast-forward
time.

# The byte-by-byte walk: one election

We trace the path on a 3-node cluster `{1, 2, 3}` where node 1 is
the leader, node 1 disappears, and node 2 wins the next election.
Pre-Vote is off for the first pass; we'll add it later.

## Step 1: the election tick fires

Every `Node.Tick()` hands a logical clock pulse to the state machine.
Followers and candidates run `tickElection`; leaders run
`tickHeartbeat`. The two ticks are mirror images of each other: a leader
fires `MsgBeat` every `HeartbeatTick` ticks to keep its lease alive, and
runs `MsgCheckQuorum` every `electionTimeout` ticks to step down if the
cluster goes silent. Followers run only the election timer.

```go
// raft.go
// tickElection is run by followers and candidates after r.electionTimeout.
func (r *raft) tickElection() {
	r.electionElapsed++

	if r.promotable() && r.pastElectionTimeout() {
		r.electionElapsed = 0
		if err := r.Step(pb.Message{From: new(r.id), Type: pb.MsgHup.Enum()}); err != nil {
			r.logger.Debugf("error occurred during election: %v", err)
		}
	}
}
```

`pastElectionTimeout()` is the entire FLP-escape mechanism in two lines:

```go
// raft.go
// pastElectionTimeout returns true if r.electionElapsed is greater
// than or equal to the randomized election timeout in
// [electiontimeout, 2 * electiontimeout - 1].
func (r *raft) pastElectionTimeout() bool {
	return r.electionElapsed >= r.randomizedElectionTimeout
}

func (r *raft) resetRandomizedElectionTimeout() {
	r.randomizedElectionTimeout = r.electionTimeout + globalRand.Intn(r.electionTimeout)
}
```

Every state transition that calls `r.reset(term)` re-rolls the timeout.
That re-roll is what eventually breaks split votes.
`globalRand.Intn` here is backed by `crypto/rand` rather than
`math/rand` — defensive against adversarial environments where a
predictable PRNG could let an attacker force split votes. The cost is
~one syscall per state transition (a getentropy/getrandom call); not
hot enough to matter against the 1-second timeout it's randomising.

The default etcd configuration uses `HeartbeatTick: 1` and
`ElectionTick: 10` (see
[`doc.go`](https://github.com/etcd-io/raft/blob/main/doc.go)). With a
typical 100 ms heartbeat interval that maps to `electionTimeout` ≈
**1 second** and `randomizedElectionTimeout` uniformly in
`[1.0 s, 1.999 s]`. So the *minimum* time between leader loss and the
follower deciding to campaign is one whole second — and that's
deliberate. It's the "deliberate waiting" the hook talked about.

## Step 2: MsgHup arrives, the candidate is born

`Step` is the dispatcher. When a `MsgHup` lands, it calls `r.hup(...)`,
which checks invariants and calls `r.campaign(...)`:

```go
// raft.go
func (r *raft) hup(t CampaignType) {
	if r.state == StateLeader {
		r.logger.Debugf("%x ignoring MsgHup because already leader", r.id)
		return
	}

	if !r.promotable() {
		r.logger.Warningf("%x is unpromotable and can not campaign", r.id)
		return
	}
	if r.hasUnappliedConfChanges() {
		r.logger.Warningf("%x cannot campaign at term %d since there are still pending configuration changes to apply", r.id, r.Term)
		return
	}

	r.logger.Infof("%x is starting a new election at term %d", r.id, r.Term)
	r.campaign(t)
}
```

Three guards, each a real bug fixed long after Raft's first publication:

1. **Already-leader check.** Old versions could panic on stale
   `MsgHup` after a quiescing optimisation. Cheap and harmless to add.
2. **Promotable check.** Learners and removed nodes must not start
   elections — otherwise a removed peer that hasn't yet learned of its
   removal would keep bumping terms.
3. **Pending-conf-change check.** A new candidate that has uncommitted
   conf changes in its log might campaign with a config the cluster
   already left, splitting the vote between joint configs. The
   [in-source comment on
   `hasUnappliedConfChanges`](https://github.com/etcd-io/raft/blob/main/raft.go)
   flags the cost: scanning the unapplied tail can be expensive on a
   node that's been silent for a while, which is why the check is gated
   behind the elapsed-timeout test in the first place.

## Step 3: campaign() sends the votes

`campaign` is the orchestrator. It calls `becomeCandidate` (or
`becomePreCandidate`) for the actual state transition + term bump,
then fans `MsgVote` out to every other voter:

```go
// raft.go
// campaign transitions the raft instance to candidate state. This must only be
// called after verifying that this is a legitimate transition.
func (r *raft) campaign(t CampaignType) {
	if !r.promotable() {
		// This path should not be hit (callers are supposed to check), but
		// better safe than sorry.
		r.logger.Warningf("%x is unpromotable; campaign() should have been called", r.id)
	}
	var term uint64
	var voteMsg pb.MessageType
	if t == campaignPreElection {
		r.becomePreCandidate()
		voteMsg = pb.MsgPreVote
		// PreVote RPCs are sent for the next term before we've incremented r.Term.
		term = r.Term + 1
	} else {
		r.becomeCandidate()
		voteMsg = pb.MsgVote
		term = r.Term
	}
```

Two observations worth pausing on. First: the Pre-Vote path sends
`MsgPreVote` with a *future* term **without** incrementing `r.Term`.
This is deliberate. A flapping or partitioned node that uselessly
campaigns no longer disturbs the cluster, because its term doesn't
advance until at least a quorum has agreed it's worth advancing. We'll
return to this when we discuss tradeoffs.

Second: `becomeCandidate()` calls `reset(r.Term + 1)`, which calls
`resetRandomizedElectionTimeout()`. So even within a single split-vote
storm, every loop re-rolls the dice — which is what makes the protocol
eventually terminate.

```go
// raft.go
func (r *raft) becomeCandidate() {
	if r.state == StateLeader {
		panic("invalid transition [leader -> candidate]")
	}
	r.step = stepCandidate
	r.reset(r.Term + 1)
	r.tick = r.tickElection
	r.Vote = r.id
	r.state = StateCandidate
	r.logger.Infof("%x became candidate at term %d", r.id, r.Term)
```

Note that `r.Vote = r.id` — the candidate votes for itself before sending
anything. The self-vote isn't a network message; it's a field write
followed by a self-`MsgVoteResp` that the application replays after
fsync. That fast path is what makes single-node clusters elect a
leader in one local fsync, with no real vote round.

The fan-out walks the voter set in deterministic order (sorted ID), and
calls `r.send(...)` per voter. The self-vote takes the
`msgsAfterAppend` path; the peer votes go onto `r.msgs`:

```go
// raft.go (inside campaign)
	var ids []uint64
	{
		idMap := r.trk.Voters.IDs()
		ids = make([]uint64, 0, len(idMap))
		for id := range idMap {
			ids = append(ids, id)
		}
		slices.Sort(ids)
	}
	for _, id := range ids {
		if id == r.id {
			// The candidate votes for itself and should account for this self
			// vote once the vote has been durably persisted (since it doesn't
			// send a MsgVote to itself). This response message will be added to
			// msgsAfterAppend and delivered back to this node after the vote
			// has been written to stable storage.
			r.send(pb.Message{To: new(id), Term: new(term), Type: voteRespMsgType(voteMsg).Enum()})
			continue
		}
		last := r.raftLog.lastEntryID()
```

`msgsAfterAppend` is the slice the application drains *after* it has
fsync'd HardState — Raft's correctness rule is that you must not
acknowledge a vote before the vote is durable, including your own.

## Step 4: voters check the log, respond

When `Step` sees an incoming `MsgVote`, it asks two questions:

```go
// raft.go (inside Step, the case pb.MsgVote, pb.MsgPreVote branch)
canVote := r.Vote == m.GetFrom() ||
	// ...we haven't voted and we don't think there's a leader yet in this term...
	(r.Vote == None && r.lead == None) ||
	// ...or this is a PreVote for a future term...
	(m.GetType() == pb.MsgPreVote && m.GetTerm() > r.Term)
// ...and we believe the candidate is up to date.
lastID := r.raftLog.lastEntryID()
candLastID := entryID{term: m.GetLogTerm(), index: m.GetIndex()}
if canVote && r.raftLog.isUpToDate(candLastID) {
```

The "log up-to-date" check is the most-important guarantee in Raft: it's
what stops an old replica with a short log from being elected and
truncating committed entries on the cluster.

```go
// log.go
// isUpToDate determines if a log with the given last entry is more up-to-date
// by comparing the index and term of the last entries in the existing logs.
//
// If the logs have last entries with different terms, then the log with the
// later term is more up-to-date. If the logs end with the same term, then
// whichever log has the larger lastIndex is more up-to-date. If the logs are
// the same, the given log is up-to-date.
func (l *raftLog) isUpToDate(their entryID) bool {
	our := l.lastEntryID()
	return their.term > our.term || their.term == our.term && their.index >= our.index
}
```

Two lines. In return: an under-replicated follower can never become
leader and silently drop committed entries. A surprising number of the
"subtle Raft bugs" you'll read about — particularly around log
overwrite when a new leader takes over from a stale one — descend
from getting this check wrong or weakening it under the wrong
invariant.

## Step 5: the candidate tallies, becomes leader

Each `MsgVoteResp` arrives back through `Step` and is dispatched to
`stepCandidate`. Once a quorum says yes, `becomeLeader` runs:

```go
// raft.go (inside stepCandidate)
case myVoteRespType:
	gr, rj, res := r.poll(m.GetFrom(), m.GetType(), !m.GetReject())
	r.logger.Infof("%x has received %d %s votes and %d vote rejections", r.id, gr, m.GetType(), rj)
	switch res {
	case quorum.VoteWon:
		if r.state == StatePreCandidate {
			r.campaign(campaignElection)
		} else {
			r.becomeLeader()
			r.bcastAppend()
		}
	case quorum.VoteLost:
		// pb.MsgPreVoteResp contains future term of pre-candidate
		// m.Term > r.Term; reuse r.Term
		r.becomeFollower(r.Term, None)
	}
```

`poll()` records the vote and asks the quorum module if the result is
already known.
[`quorum/majority.go`](https://github.com/etcd-io/raft/blob/main/quorum/majority.go)
holds the actual counting, in 30 lines:

```go
// quorum/majority.go
// VoteResult takes a mapping of voters to yes/no (true/false) votes and returns
// a result indicating whether the vote is pending (i.e. neither a quorum of
// yes/no has been reached), won (a quorum of yes has been reached), or lost (a
// quorum of no has been reached).
func (c MajorityConfig) VoteResult(votes map[uint64]bool) VoteResult {
	if len(c) == 0 {
		// By convention, the elections on an empty config win. This comes in
		// handy with joint quorums because it'll make a half-populated joint
		// quorum behave like a majority quorum.
		return VoteWon
	}

	var votedCnt int //vote counts for yes.
	var missing int
	for id := range c {
		v, ok := votes[id]
		if !ok {
			missing++
			continue
		}
		if v {
			votedCnt++
		}
	}

	q := len(c)/2 + 1
	if votedCnt >= q {
		return VoteWon
	}
	if votedCnt+missing >= q {
		return VotePending
	}
	return VoteLost
}
```

`q = n/2 + 1` for an `n`-voter cluster. For `n = 3`, `q = 2` — the
candidate plus one peer is enough. The third return value
`VotePending` is the case where we have enough still-undecided voters
that *either* outcome is possible; the candidate stays in
`StateCandidate` and waits for more responses or for its election
timer to fire again.

The PreCandidate branch is the small but important detail: a successful
PreVote does *not* declare victory. It calls `r.campaign(campaignElection)`
to start a **second** vote round at the real term. So Pre-Vote is two
round-trips, not one — its win is correctness (no spurious term bumps),
not latency.

## Step 6: leader appends an empty entry

`becomeLeader` is the final state transition. The first thing a fresh
leader has to do is commit one entry in its own term, because the Raft
safety property "leaders only commit entries from their own term"
forbids advancing the commit index past earlier-term entries until at
least one current-term entry has been committed:

```go
// raft.go
func (r *raft) becomeLeader() {
	if r.state == StateFollower {
		panic("invalid transition [follower -> leader]")
	}
	r.step = stepLeader
	r.reset(r.Term)
	r.tick = r.tickHeartbeat
	r.lead = r.id
	r.state = StateLeader
```

The empty entry is appended a few lines lower:

```go
// raft.go
	traceBecomeLeader(r)
	emptyEnt := pb.Entry{Data: nil}
	if !r.appendEntry(emptyEnt) {
		// This won't happen because we just called reset() above.
		r.logger.Panic("empty entry was dropped")
	}
```

The empty entry has zero payload, so it doesn't count against the
`maxUncommittedSize` budget — a fact tested separately as
`TestPayloadSizeOfEmptyEntry`. `becomeLeader` itself doesn't broadcast
the entry: it only appends it locally and self-acks via
`msgsAfterAppend`. The `bcastAppend()` call sits one stack frame up,
in `stepCandidate` (the `case quorum.VoteWon:` branch we saw earlier);
that's what sends `MsgApp` carrying the empty entry to every follower.
Once a quorum of followers ack it, the leader's commit index advances
to the new entry's index and any pending `MsgReadIndex` requests can
finally be answered.

# Real numbers

I avoided synthesising election timings against a ticking simulated
network — the harness gets fragile fast. Instead, here are the four
numbers a careful reading of the source plus one micro-benchmark on an
Apple M3 Max give us. All numbers are derived, not waved.

## How long the state-machine work takes

`BenchmarkOneNode` exercises a *fuller* path than a leader election —
propose entry → Ready → fsync → Advance — and reports a median
**1,342 ns/op** across three runs:

```text
$ go test -v -bench=BenchmarkOneNode -run=^$ -benchtime=3s -count=3
goos: darwin
goarch: arm64
pkg: go.etcd.io/raft/v3
cpu: Apple M3 Max
BenchmarkOneNode
BenchmarkOneNode-14    2667788    1326 ns/op
BenchmarkOneNode-14    2660304    1342 ns/op
BenchmarkOneNode-14    2615948    1373 ns/op
PASS
```

Source:
[`node_bench_test.go`](https://github.com/etcd-io/raft/blob/main/node_bench_test.go).

A leader election on a 3-node cluster, in pure CPU terms, is the cost
of:

| Step | Cost (estimated, M3 Max) | Source |
|---|---:|---|
| `becomeCandidate` (state + reset) | ≈ 200 ns | one map walk, three field writes |
| Build + send 2 `MsgVote` messages | ≈ 600 ns | append to `r.msgs`, copy header |
| Self-`MsgVoteResp` enqueue | ≈ 100 ns | append to `r.msgsAfterAppend` |
| 2× `Step(MsgVoteResp)` in candidate | ≈ 400 ns | record vote, tally |
| `becomeLeader` + `appendEntry` | ≈ 500 ns | one log append, no fsync |

The numbers in that table are napkin math, anchored to
`BenchmarkOneNode`'s 1,342 ns/op for the full `Propose → Ready → fsync →
Advance` round-trip — each row is a fraction of that benchmark in
proportion to the field-write / map-walk count visible in the source.
Sum: roughly 1.8 µs of state-machine work — the same order as the
single-node benchmark above, with one `Propose` swapped out for two
vote round-trips. The rest of a wall-clock election is **wait time**
between these events: the disk persisting `HardState`, the network
delivering messages, and `Tick` ticks accumulating. Multiply 1.8 µs by
the 1+ second of waiting and you get the 6-orders-of-magnitude gap
from the hook (`1.3 s / 1.8 µs ≈ 722,000`).

## How long the wait actually is

`HeartbeatTick: 1, ElectionTick: 10` plus a 100 ms tick interval gives a
randomised election timeout uniformly distributed in
`[1.0 s, 1.999 s]`. The expected value is therefore
`(1.0 + 1.999) / 2 ≈ 1.5 s`.

A leader has just died. Every follower started its election timer at the
last heartbeat, so wall-clock-from-leader-loss to first MsgHup is
**uniformly in `[1.0 s, 1.999 s]`** per follower, independent across
followers. The fastest of `n − 1 = 2` followers fires at the order
statistic min — for `k` iid `U(a, b)`, `E[min] = a + (b − a)/(k + 1)` —
giving `1.0 s + 0.999 s / 3 ≈ 1.333 s`. Add ~one network round-trip
(~1 ms LAN) for the vote round and ~one for the post-election heartbeat
to settle, and you've spent **≈ 1.33 s on waiting and ≈ 2 ms on
protocol work**.

That's the headline of this whole post: the protocol *work* is
microseconds; the protocol *waiting* is a half to two seconds, dictated
by `ElectionTick × tick interval`. If you want faster failover, you make
ticks faster — and we'll get to why etcd doesn't do that aggressively in
the tradeoffs section.

## How many messages flow

For an `n`-node cluster, one election round costs:

| Phase | Messages | Cost rationale |
|---|---:|---|
| `MsgVote` fan-out | `n − 1` | candidate → every other voter |
| `MsgVoteResp` fan-in | `n − 1` | reply per peer |
| Empty-entry `MsgApp` fan-out | `n − 1` | new leader → followers |
| Empty-entry `MsgAppResp` fan-in | `n − 1` | followers ack |
| **Total** | `4(n − 1)` | — |

For `n = 3`, **8 messages** end-to-end. Pre-Vote doubles the vote phase,
so `2 × 2 × (n − 1) + 2 × (n − 1) = 6(n − 1)` = **12 messages**. A
real production `etcd` cluster uses `n = 3` or `n = 5`; the protocol's
message complexity is `O(n)`, not `O(n²)`, because every message
originates at or terminates at the leader/candidate.

## How big each message is

`MsgVote` is a `Message` proto with six fields populated: `type, to,
from, term, logTerm, index`. Each is a varint with a 1-byte field tag.
For a small-cluster, freshly-started election all six values fit in a
single varint byte, so wire size is `≈ 6 × (1 tag + 1 varint) = 12 bytes`,
plus a few bytes of gRPC framing. Round to **~15 to 20 bytes on the
wire** per vote message. Even a million-node cluster (which no one
actually runs) would push only `20 × 4(n − 1) ≈ 80 MB` of election
traffic per election round — and would have failed for other reasons
long before.

# Tradeoffs

Every design choice in `raft.go` is a tradeoff someone learned the hard
way. The interesting ones around leader election:

## The disruptive-server problem (and Pre-Vote's cost)

Without Pre-Vote, a node that gets partitioned away keeps bumping its
term every election timeout. When the partition heals, that node walks
back into the cluster with a higher term than the current leader. The
leader sees the higher term, steps down, and the cluster has to elect
again — even though there was nothing wrong with the leader. This is the
"disruptive server" problem.

`Step` handles it:

```go
// raft.go (Step, the m.Term > r.Term branch)
case m.GetTerm() > r.Term:
	if m.GetType() == pb.MsgVote || m.GetType() == pb.MsgPreVote {
		force := bytes.Equal(m.GetContext(), []byte(campaignTransfer))
		inLease := r.checkQuorum && r.lead != None && r.electionElapsed < r.electionTimeout
		if !force && inLease {
			// If a server receives a RequestVote request within the minimum election timeout
			// of hearing from a current leader, it does not update its term or grant its vote
```

`inLease` does the heavy lifting: a follower with `CheckQuorum` on
will reject any `MsgVote` that arrives while it still believes a
leader is alive (`r.lead != None && r.electionElapsed < r.electionTimeout`).
The message-cost of `CheckQuorum` itself is effectively zero — the
leader's heartbeats fire every `HeartbeatTick × tick interval` whether
or not `CheckQuorum` is enabled, so no extra wire traffic is added.
What `CheckQuorum` does add is *active* leader-step-down on the
leader side: every `electionTimeout`, the leader runs `MsgCheckQuorum`
and walks `r.trk.Voters` to count `RecentActive == true`. The cost is
napkin: `n` map entries × ~30 ns Go-map iter step `≈ n × 30 ns`. On a
5-node cluster that's `5 × 30 ns = 150 ns` once per `electionTimeout`,
i.e. `150 ns / 1 s ≈ 0.000015 %` of one core. Round to "free."

Pre-Vote eliminates the term bump entirely (the partitioned node never
gets a quorum to advance to the next term, so it doesn't), at the cost
of one extra round-trip per *real* election. For a cluster with
`n = 3` and an expected 1.33 s of wait time, that round-trip is on the
order of `~1 ms` LAN latency: a `1 ms / 1.33 s ≈ 0.075 %` slowdown on
the rare path, to fix a problem that otherwise breaks the cluster on
every flap. That's a great trade.

## Lease-based reads vs ReadIndex

The library supports two read-only modes: `ReadOnlySafe` (default) and
`ReadOnlyLeaseBased`.

```go
// raft.go
const (
	// ReadOnlySafe guarantees the linearizability of the read only request by
	// communicating with the quorum. It is the default and suggested option.
	ReadOnlySafe ReadOnlyOption = iota
	// ReadOnlyLeaseBased ensures linearizability of the read only request by
	// relying on the leader lease. It can be affected by clock drift.
	// If the clock drift is unbounded, leader might keep the lease longer than it
	// should (clock can move backward/pause without any bound). ReadIndex is not safe
	// in that case.
	ReadOnlyLeaseBased
)
```

`ReadOnlySafe` is one heartbeat round-trip per read: cost is dominated
by network latency, so on a `~1 ms` LAN a linearizable read costs you
about that. `ReadOnlyLeaseBased` is local — the leader trusts that no
one has elected itself in the lease window — so a linearizable read is
`O(memory access)`, on the order of `~100 ns` to read the lease
expiry. The tradeoff is *bounded* clock drift, which Raft cannot
guarantee on cloud VMs. The library's [own comment](https://github.com/etcd-io/raft/blob/main/raft.go#L62-L67)
on `ReadOnlyLeaseBased` calls this out: "If the clock drift is
unbounded, leader might keep the lease longer than it should (clock can
move backward/pause without any bound)." Etcd defaults to `ReadOnlySafe`
both in the library (the `iota` zero value) and in the
[`etcd-server`
configuration](https://github.com/etcd-io/etcd/blob/main/server/etcdserver/server.go).
You pay one heartbeat round-trip per read for not having to trust your
VM clock.

## Randomised timeout is a hack, not a fix

A 3-node cluster with both followers ticking in phase will sometimes
still split. The randomisation window is uniform over a band of
`ElectionTick` ticks. For two iid uniform draws on a band of width
`L = 10` ticks, the probability they land within one tick of each
other is `P ≈ 2/L`, i.e. `2 / 10 ≈ 0.2` of the time
(`P(|X − Y| < ε) ≈ 2ε/L − ε²/L²` for `ε ≪ L`). That works out to
roughly **once every five elections** with the default
`ElectionTick = 10`.

The protocol survives this — split votes lead to nothing changing and
all candidates re-roll — but it costs another whole election timeout
of unavailability. Production tunes `ElectionTick` down (some teams use
`ElectionTick = 5`, some go higher to mask longer GC pauses) and
accepts the split-vote tail latency.

## Tick-driven liveness is fragile

`Tick()` is called by the application. If the application blocks (a
slow disk fsync, a long GC pause, a stop-the-world rebalance), ticks
*don't* fire on schedule, and a healthy leader can be wrongly stepped
down by `CheckQuorum`. The library's defence is a single warning:

```go
// node.go
// Tick increments the internal logical clock for this Node. Election timeouts
// and heartbeat timeouts are in units of ticks.
func (n *node) Tick() {
	select {
	case n.tickc <- struct{}{}:
	case <-n.done:
	default:
		n.rn.raft.logger.Warningf("%x A tick missed to fire. Node blocks too long!", n.rn.raft.id)
	}
}
```

That `default` branch in `node.Tick` is the only signal the
application gets that its consensus loop is starving. The cost of
ignoring it is a spurious leader election. This is the type of bug that
shows up only under sustained pressure — exactly when a leader change
is most damaging.

## Pre-Vote is opt-in

`PreVote: true` is not the default in
[`Config`](https://github.com/etcd-io/raft/blob/main/raft.go) — the
zero value of `bool` is `false`, and `Config.PreVote` is just a
field assignment in `newRaft`. Library users have to remember to set
it. Any code path that constructs a `Config` without it inadvertently
ships without the disruptive-server protection. Defaults matter; this
one arguably should have flipped years ago. The
[discussion thread on
PR #70](https://github.com/etcd-io/raft/pull/70) (the data-driven
PreVote/CheckQuorum tests) makes the case for treating these together
as the cluster-correctness pair.

# What I'd build differently

Reading the source with a decade of distance from when the core was
written (the
[earliest tickElection commit](https://github.com/etcd-io/raft/commit/a17e5ac20183b7f9d848c7100ff627489d95d7ca)
is dated July 2014), three changes feel worth their cost. None of them
are novel — all three are options other Raft implementations have made.

## 1. Adaptive ticks

The current design uses a fixed tick interval. A leader with a quiet
cluster can afford to slow its heartbeat down (saves CPU and wakeups);
a leader carrying load benefits from faster ticks (faster failover for
its followers). [etcd
3.5](https://etcd.io/docs/v3.5/) ships fixed ticks, but
[CockroachDB's
multi-raft](https://github.com/cockroachdb/cockroach/tree/master/pkg/kv/kvserver)
already coalesces heartbeats across thousands of ranges to amortise the
wakeup cost.

For a single-Raft-group library, the equivalent would be: tick every
`HeartbeatTick × tick interval` while followers are responsive, fall
back to wall-clock timers if a follower hasn't replied within
`2 × HeartbeatTick`. Cost: roughly doubling `tickHeartbeat` (currently
28 lines) plus a wall-clock-timer wiring path on the application side,
say 50-80 lines end-to-end. Benefit:
say a 10 ms tick interval shrinks the election-timeout band to
`[100 ms, 199 ms]` (`= 10 ticks × 10 ms`) and the expected first-fire
to `100 ms + 100 ms / 3 ≈ 133 ms` — sub-200 ms failover on hot
ranges, longer election timeouts on idle ones.

## 2. Sub-tick leader signalling

When a leader knows it's stepping down (graceful shutdown,
`TransferLeadership`), it can send `MsgTimeoutNow` to a chosen follower,
which immediately calls `r.hup(campaignTransfer)` and skips the random
election delay. The library already has this — see
[`(*raft).sendTimeoutNow`](https://github.com/etcd-io/raft/blob/main/raft.go).
But it's only used for explicit transfer.

The improvement: have a leader that's about to fail (hit a fatal
internal error, lose its disk, etc.) emit `MsgTimeoutNow` to the
healthiest follower as part of its shutdown sequence. Cost in the
library: minimal — `sendTimeoutNow` already exists. The real cost is
the application-side detection of "about to fail" plus a fenced
shutdown sequence that won't fire if the leader is just slow; realistic
estimate ~200-500 lines per host. Benefit: bounded failover instead of
waiting one full election timeout.
There's a correctness footgun — if the "failing" leader is just slow
or merely partitioned from the application's monitor, it could
double-elect (the receiving follower's `stepFollower` calls
`r.hup(campaignTransfer)` *unconditionally*, with no lease check). The
defence has to live above the library: the application must be sure
the leader is actually going down before sending the message, e.g. by
holding a fenced lease that the failing leader can't refresh.

## 3. Fixed-layout vote messages

Right now every vote response is small but every vote response is a
separate proto message. Batching votes for multiple pending
candidate-elections at this scale is silly — there's only ever one
election in flight at a time. But pre-bundling the candidate's last
log term, last log index, and Pre-Vote bit into a fixed 24-byte struct
would skip the proto encode/decode on the hot path. Estimated savings,
napkin math: protobuf encode for the current `Message` struct is on the
order of `~200 ns`, decode similar — a fixed-layout binary struct with
`encoding/binary.PutUvarint` is roughly half that, so `~100 ns` per
message saved (`= (200 ns − 100 ns)`). Marginal at one election round
per second; listed last because it's almost not worth the churn.

# A 50-line snippet you can run

This stand-alone test follows the 3-node election from `MsgHup` on
node 1 through `becomeLeader`. It uses the library's own deterministic
test harness (`newNetwork`, `stateMachine`) so there's no real
network or disk:

```go
// drop this as election_demo_test in the etcd-io/raft tree
package raft

import (
	"fmt"
	"testing"

	pb "go.etcd.io/raft/v3/raftpb"
)

func TestElectionDemo(t *testing.T) {
	// 3-voter cluster. PreVote off, CheckQuorum off, default election timeout.
	cfg := func(c *Config) { c.PreVote = false }
	nt := newNetworkWithConfig(cfg, nil, nil, nil)

	// Trigger an election on node 1 by injecting MsgHup directly.
	// pb.Message fields became pointers after the gogoproto.nullable
	// migration (commit 26c2367), so build the message with addressable
	// locals.
	from, to := uint64(1), uint64(1)
	hup := pb.MsgHup
	nt.send(pb.Message{From: &from, To: &to, Type: &hup})

	// At this point node 1 should be StateLeader at term 1 with the
	// other two as followers, and the new leader's empty-entry MsgApp
	// should already have been delivered.
	for id := uint64(1); id <= 3; id++ {
		sm := nt.peers[id].(*raft)
		role := sm.state
		fmt.Printf("node %d role=%s term=%d lastIndex=%d\n",
			id, role, sm.Term, sm.raftLog.lastIndex())
		if id == 1 && role != StateLeader {
			t.Fatalf("node 1 expected StateLeader, got %s", role)
		}
		if id != 1 && role != StateFollower {
			t.Fatalf("node %d expected StateFollower, got %s", id, role)
		}
	}
}
```

Drop that file inside a checkout of `etcd-io/raft` and run
`go test -run TestElectionDemo -v`. You'll see all three nodes report
`role=StateLeader / StateFollower term=1 lastIndex=1` — the
`lastIndex=1` being the empty entry that `becomeLeader` appended.
`-v` will also surface the library's `Infof` lines, which mirror the
trace this whole post walked.

A caveat: the demo above uses the in-tree `network` test harness
(`newNetworkWithConfig`), which calls `Step` directly on `*raft`
without going through `*node` and the readyc/recvc channels. So a
`go tool trace` against this test will *not* show the scheduler
crossings the 200 µs estimate accounts for. To see those, trace
`BenchmarkOneNode` instead — it uses the real `Node` goroutine
(`go n.run()` from
[`StartNode`](https://github.com/etcd-io/raft/blob/main/node.go))
plus a `Storage.Append` loop, which is the closest in-tree benchmark
to a single-node election round-trip:

```shell
go test -trace=trace.out -bench=BenchmarkOneNode -run=^$ -benchtime=10x
go tool trace trace.out
```

The browser view will show the `n.run` goroutine yielding on
`readyc` between every state-machine step, plus the test goroutine
waking up on `Ready` and calling `Storage.Append`. On Linux you can
get the same data via `bpftrace` uprobes on the test binary you built
with `go test -c`; on macOS,
`dtrace -n 'pid$target::*becomeCandidate*:entry'` works against the
same binary.

# Closing

The thing the source code teaches that the [Raft
paper](https://raft.github.io/raft.pdf) glosses over is **how much of a
production election is structured waiting**. The protocol does roughly
two microseconds of state-machine work, then waits an expected 1.33
seconds (with default `ElectionTick = 10` and a 100 ms tick interval)
so it can be sure another candidate isn't doing the same thing at the
same time. If your service can't survive a one-to-two second leader
gap, the answer isn't to optimise `becomeCandidate` — it's to revisit
whether you need a single leader at all.

The other thing reading this code teaches: **defaults are policy.**
`PreVote: false` is the wrong default; `CheckQuorum: false` is the wrong
default; `ReadOnlySafe` is the right default. Each of these has shipped
this way for years, in a library that runs Kubernetes' control plane,
CockroachDB, TiDB, and a long list of other systems. The library's
correctness story is solid — that's what a decade of CI plus the more
recent TLA+ trace-validation work buys you. The defaults story is less
solid, and worth examining the next time you wire `etcd-raft` into
something new.

# Further reading

- [In Search of an Understandable Consensus
  Algorithm](https://raft.github.io/raft.pdf) — Ongaro &
  Ousterhout, USENIX ATC 2014. The paper.
- [Diego Ongaro's
  thesis](https://github.com/ongardie/dissertation) — long form,
  with proofs and Pre-Vote / CheckQuorum / leader-transfer extensions.
- [etcd-io/raft README](https://github.com/etcd-io/raft) — short, and
  honest about what's in scope (state machine) and out (transport,
  storage).
- [`design.md`](https://github.com/etcd-io/raft/blob/main/design.md) —
  the library's own design notes, especially on the Ready/Advance loop.
- [`etcd-io/etcd/contrib/raftexample`](https://github.com/etcd-io/etcd/tree/main/contrib/raftexample)
  — a runnable 3-node KV store built on this library, kill-the-leader
  demos included. The reference for "what does a user of this code
  actually look like".
- [TigerBeetle's deterministic
  simulation](https://backend.how/posts/the-tiger-style/) — same idea,
  different domain. Reading the etcd-raft test infra after TigerBeetle's
  is illuminating.
- [Diego Ongaro — Designing for
  Understandability](https://www.youtube.com/watch?v=YbZ3zDzDnrw) —
  2014 talk, the "why Raft and not Paxos" pitch from the protocol's
  author.

---

_Numbers cited as "M3 Max" came from a single Apple M3 Max MacBook Pro
running `go1.26.3` against [the etcd-io/raft tree at commit
`26c2367`](https://github.com/etcd-io/raft/commit/26c2367), via
`go test -v -bench=BenchmarkOneNode -run=^$ -benchtime=3s -count=3`
from the top-level package. The three runs reported 1,326 / 1,342 /
1,373 ns/op — within ±3% of the 1,342 ns/op median I quote in the body.
The per-step micro-estimates in the cost table are derived from reading
the code, not measured individually._

## Colophon

This post is a code-archaeology exercise: read the source, count the
state transitions, count the messages, name the tradeoffs. No
contribution to etcd-raft was made; all the credit for that codebase
belongs to its maintainers — currently
[ahrtr](https://github.com/ahrtr),
[pavelkalinnikov](https://github.com/pavelkalinnikov),
[serathius](https://github.com/serathius), and the long tail of past
contributors. The library has been in
[stable production use](https://github.com/etcd-io/raft#notable-users)
since 2014.

The autoresearch loop that polished this post measures correctness as
a defect count: missing citations, unverified code paths, hand-wavy
numbers, build warnings. Every iteration either drives that count down
or is reverted. Iteration N appears here once N is the floor.
