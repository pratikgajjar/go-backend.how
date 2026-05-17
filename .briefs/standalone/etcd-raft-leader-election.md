# Brief — 🐢 etcd Raft in 200 µs — One Leader Election, Traced

FIRST read /Users/pratikgajjar/ambitious/go-backend.how/.briefs/standalone/_common.md (which redirects to _voice.md).

## Subject
🐢 etcd Raft in 200 µs — One Leader Election, Traced — code archaeology, standalone post (does NOT build on existing posts).

## Source location (read deeply before drafting)
- Cached repo: /Users/pratikgajjar/.cache/checkouts/github.com/etcd-io/raft
- ls and find your way around. Read README, top-level docs, and the files relevant to this post.
- Use git log --oneline -50 in the cached repo to find the optimisation journey through commit messages.

## Title
🐢 etcd Raft in 200 µs — One Leader Election, Traced

## Slug & output path
- Slug: etcd-raft-leader-election
- Output: /Users/pratikgajjar/ambitious/go-backend.how/content/posts/etcd-raft-leader-election/index.md
- Theme: ocean
- Tags: ["raft", "etcd", "consensus", "distributed-systems", "leader-election", "golang"]

## Required focus
Read raft.go, log.go, node.go. Walk the campaign() path: tickElection → MsgHup → becomeCandidate → MsgVote/MsgVoteResp → becomeLeader. Cover Pre-Vote (CheckQuorum), the read-index path (lease vs strict), and the heartbeat tick. Run the example/raftexample with 3 nodes, kill the leader, time leader-election with go test -trace and bpftrace.

## Required sections (rename allowed, can't drop)
1. The hook — what's surprising or wrong-feeling about this system. One number or contradiction.
2. The problem this system was built to solve — first principles, not vendor pitch.
3. The architecture in 200 words — diagram in ASCII or markdown table.
4. The byte-by-byte / line-by-line walk through the most interesting subsystem (the source dive).
5. Real numbers — benchmark ON YOUR MACHINE if possible; otherwise napkin math with the working shown.
6. Tradeoffs — what this system is bad at, named explicitly.
7. What I'd build differently — concrete suggestions, with cost.

## Stretch
- bpftrace / strace one-liner that gives you visibility into the hot path.
- A 50-line code snippet a reader can copy-paste to reproduce one finding.

## Stop conditions
- 3000-5500 words.
- All 7 sections.
- Hugo build clean.
- Then announce DRAFT READY, switch to autoresearch mode (see _common.md), and loop forever lowering defects.
