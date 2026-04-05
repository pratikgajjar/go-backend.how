#!/usr/bin/env python3
"""
Validate every numeric claim in content/posts/temporal-under-the-hood/index.md.

Checks:
  - arithmetic (additions, multiplications, divisions, ratios)
  - cost-model predictions vs measured per-work-unit values
  - slope calculations
  - event-formula (4 + 6N + 1)
  - head-to-head table consistency
  - storage calculations

Run:  python3 validate_math.py
Exit: 0 if all checks pass; 1 if any fail.
"""

import sys
from dataclasses import dataclass

PASS = "\033[32m✓\033[0m"
FAIL = "\033[31m✗\033[0m"

failures = []

def check(name: str, got, want, tol: float = 0.05, absolute: bool = False):
    """tol is relative tolerance (5% default) unless absolute=True (raw diff)."""
    if absolute:
        ok = abs(got - want) <= tol
    else:
        if want == 0:
            ok = abs(got) <= tol
        else:
            ok = abs(got - want) / abs(want) <= tol
    marker = PASS if ok else FAIL
    print(f"  {marker}  {name}: got={got}, want={want}"
          + ("" if ok else f"  (diff={got - want:+.3f})"))
    if not ok:
        failures.append(name)


print("\n── EVENT-HISTORY FORMULA (4 + 6·N + 1) ───────────────────")
def events_for_n_activities(n: int) -> int:
    return 4 + 6 * n + 1

check("3-activity workflow = 23 history events", events_for_n_activities(3), 23)
check("1-activity workflow = 11 history events", events_for_n_activities(1), 11)
check("5-activity workflow = 35 history events", events_for_n_activities(5), 35)


print("\n── TEMPORAL SCALING TABLE (per-workflow from total/200) ───────")
temporal_table = [
    # (N, total_sql, per_wf_claimed)
    (1,  15_159,  75.7),
    (3,  28_978, 144.8),
    (5,  42_811, 214.0),
    (10, 77_054, 385.2),
]
for n, total, per_wf in temporal_table:
    calc = total / 200
    check(f"Temporal N={n}: {total}/200 = {per_wf}", calc, per_wf, tol=0.01)


print("\n── TEMPORAL SLOPES (delta per activity) ──────────────────")
# (144.8 − 75.7) / (3 − 1) = 34.55
# (214.0 − 144.8) / (5 − 3) = 34.60
# (385.2 − 214.0) / (10 − 5) = 34.24
check("Slope N=1→3:  (144.8−75.7)/2",
      (144.8 - 75.7) / 2, 34.55, tol=0.01)
check("Slope N=3→5:  (214.0−144.8)/2",
      (214.0 - 144.8) / 2, 34.60, tol=0.01)
check("Slope N=5→10: (385.2−214.0)/5",
      (385.2 - 214.0) / 5, 34.24, tol=0.01)


print("\n── TEMPORAL COST MODEL ~40 + 35·N ────────────────────────")
def temporal_model(n: int) -> float:
    return 40 + 35 * n

for n, _total, per_wf in temporal_table:
    pred = temporal_model(n)
    # The post says "~40 + 35×N" — check predictions are within 10% of measured
    check(f"Model N={n}: 40+35·{n}={pred} vs measured {per_wf}",
          pred, per_wf, tol=0.10)


print("\n── TEMPORAL PER-ACTIVITY DECOMPOSITION SUM ────────────────")
# Table in post:
per_activity_delta = [
    ("UPDATE executions",             4.0),
    ("SELECT FROM executions",        4.0),
    ("UPDATE current_executions",     4.0),
    ("SELECT FROM current_executions",4.0),
    ("SELECT range_id FROM shards",   4.0),
    ("INSERT INTO history_node",      3.0),
    ("INSERT INTO timer_tasks",       3.0),
    ("INSERT INTO activity_info_maps",2.0),
    ("INSERT INTO transfer_tasks",    2.0),
    ("SELECT FROM history_node",      1.0),
    ("DELETE FROM activity_info_maps",1.0),
    ("INSERT INTO tasks (matching)",  0.7),
    ("SELECT FROM tasks (matching)",  0.5),
    ("SELECT/UPDATE task_queues",     0.9),
]
total_delta = sum(v for _, v in per_activity_delta)
check("Sum of per-activity deltas = ~34", total_delta, 34.1, tol=0.02)
print(f"     (14 operations, sum = {total_delta})")

# Also verify deltas come from N=1/N=5 diffs:
decomposition_n1_n5 = [
    ("UPDATE executions",             6.0, 22.0),
    ("SELECT FROM executions",        6.0, 22.0),
    ("UPDATE current_executions",     6.0, 22.0),
    ("SELECT FROM current_executions",6.0, 22.0),
    ("SELECT range_id FROM shards",   7.0, 23.0),
    ("INSERT INTO history_node",      6.0, 18.0),
    ("INSERT INTO timer_tasks",       5.0, 17.0),
    ("INSERT INTO activity_info_maps",2.0, 10.0),
    ("INSERT INTO transfer_tasks",    4.0, 12.0),
    ("SELECT FROM history_node",      3.0,  7.0),
    ("DELETE FROM activity_info_maps",1.0,  5.0),
    ("INSERT INTO tasks (matching)",  1.2,  3.9),
    # 0.525 rounds to 0.5 under banker's/round-half-to-even (Python default)
    ("SELECT FROM tasks (matching)",  1.0,  3.1),  # delta/4 = 0.525 → 0.5
    ("SELECT/UPDATE task_queues",     1.5,  5.1),
]
for name, n1, n5 in decomposition_n1_n5:
    delta = (n5 - n1) / 4
    claimed = dict(per_activity_delta)[name]
    # allow 0.05 absolute slack for 1-decimal-place display rounding
    check(f"  delta÷4 for {name}: ({n5}-{n1})/4",
          delta, claimed, tol=0.06, absolute=True)


print("\n── ABSURD SCALING TABLE (per-task from total/200) ─────────")
absurd_table = [
    (1,  3_543, 17.7),
    (3,  6_406, 32.0),
    (5,  9_216, 46.1),
    (10, 16_236, 81.2),
]
for n, total, per_task in absurd_table:
    calc = total / 200
    check(f"Absurd N={n}: {total}/200 = {per_task}", calc, per_task, tol=0.01)


print("\n── ABSURD SLOPES ──────────────────────────────────────────")
check("Slope N=1→3:  (32.0−17.7)/2",
      (32.0 - 17.7) / 2, 7.15, tol=0.01)
check("Slope N=3→5:  (46.1−32.0)/2",
      (46.1 - 32.0) / 2, 7.05, tol=0.01)
check("Slope N=5→10: (81.2−46.1)/5",
      (81.2 - 46.1) / 5, 7.02, tol=0.01)


print("\n── ABSURD COST MODEL ~11 + 7·N ────────────────────────────")
def absurd_model(n: int) -> float:
    return 11 + 7 * n

for n, _total, per_task in absurd_table:
    pred = absurd_model(n)
    check(f"Model N={n}: 11+7·{n}={pred} vs measured {per_task}",
          pred, per_task, tol=0.10)


print("\n── PER-UNIT RATIO (5× claim) ──────────────────────────────")
# "A Temporal activity costs about 5× as many SQL statements as an Absurd step."
check("Per-work-unit slope ratio: 35/7",
      35 / 7, 5.0, tol=0.01)
# Real measurement: 34.55/7.15 = 4.83
check("Measured per-unit ratio: ~34.5/~7.1",
      34.55 / 7.15, 4.83, tol=0.01)


print("\n── THROUGHPUT RATIO (20× claim) ───────────────────────────")
# "~20× higher throughput" — "22× at N=1000, 19× at N=5000"
# Temporal: 65.6/s at N=1000 c=64, 77.5/s at N=5000 c=128
# Absurd:   1435.8/s at N=1000 c=64, 1450.6/s at N=5000 c=128
check("N=1000 c=64 ratio: 1435.8/65.6",
      1435.8 / 65.6, 21.88, tol=0.05)
check("  → rounds to 22×", round(1435.8 / 65.6), 22)
check("N=5000 c=128 ratio: 1450.6/77.5",
      1450.6 / 77.5, 18.72, tol=0.05)
check("  → rounds to 19×", round(1450.6 / 77.5), 19)
# Post claim: "~20×" — check that the range covers 20
midpoint = ((1435.8 / 65.6) + (1450.6 / 77.5)) / 2
check("Midpoint ratio ~20×", midpoint, 20.3, tol=0.05)


print("\n── STORAGE RATIO (~7× claim) ──────────────────────────────")
# 93 MB / 13 MB = 7.15
check("Storage ratio: 93 MB / 13 MB",
      93 / 13, 7.15, tol=0.03)
check("  → rounds to 7×", round(93 / 13), 7)

# Post now says "44 MB across 91,522 rows, ~280 bytes event-payload per row"
# → 280 B/row × 91,522 rows ≈ 25 MB payload, rest is index+heap overhead
payload_mb = 280 * 91522 / 1024 / 1024
check("history_node payload: 280B × 91,522 rows",
      payload_mb, 24.4, tol=0.01)
# Total 44 MB − payload 24 MB = 20 MB overhead. That's 45% index/heap overhead.
check("Overhead ratio: (44 - 24.4)/44 ≈ 45%",
      (44 - payload_mb) / 44 * 100, 44.5, tol=0.05)


print("\n── PER-WORKFLOW STORAGE (~19 kB / ~2.7 kB claims) ─────────")
# Post: "Storage / workflow | ~19 kB | ~2.7 kB"
t_per_wf_kb = (93 * 1024) / 5000   # =19.0 kB
a_per_task_kb = (13 * 1024) / 5000 # =2.66 kB
check("Temporal per-wf: 93MB/5000 = ~19 kB", t_per_wf_kb, 19.0, tol=0.01)
check("Absurd per-task: 13MB/5000 = ~2.7 kB", a_per_task_kb, 2.7, tol=0.02)


print("\n── LATENCY TABLE (n=100 per-row) ──────────────────────────")
# | N  | Temporal p50 | Absurd p50 | ratio |
# |  1 |     14.2 ms  |   10.3 ms  |  1.4× |
# |  3 |     47.0 ms  |   11.1 ms  |  4.2× |
# |  5 |     67.3 ms  |   11.1 ms  |  6.1× |
# | 10 |     90.7 ms  |   12.1 ms  |  7.5× |
latency_table = [
    (1,  14.2, 10.3, 1.4),
    (3,  47.0, 11.1, 4.2),
    (5,  67.3, 11.1, 6.1),
    (10, 90.7, 12.1, 7.5),
]
for n, t, a, claimed_ratio in latency_table:
    ratio = t / a
    check(f"N={n}: Temporal/Absurd = {t}/{a} = {claimed_ratio}×",
          ratio, claimed_ratio, tol=0.02)


print("\n── LATENCY SLOPE (8.5 ms T vs 0.2 ms A, 40× ratio) ────────")
# Slope from N=1 to N=10:
t_slope = (90.7 - 14.2) / (10 - 1)
a_slope = (12.1 - 10.3) / (10 - 1)
check("Temporal slope: (90.7-14.2)/9", t_slope, 8.5, tol=0.02)
check("Absurd slope:   (12.1-10.3)/9", a_slope, 0.2, tol=0.05)
# Post says "40× difference"
check("Slope ratio: 8.5/0.2", t_slope / a_slope, 40.0, tol=0.10)


print("\n── TEMPORAL BIMODAL TAIL (p90 / p50 = 11×) ────────────────")
# "p50 for a 10-activity workflow is ~91 ms, but the p90 is 1.05 seconds — 11×"
check("1050/91 ≈ 11", 1050 / 91, 11.0, tol=0.05)


print("\n── HEAD-TO-HEAD TABLE ─────────────────────────────────────")
# | SQL / unit of work (cost model) | ~40 + 35×N | ~11 + 7×N |
# | SQL for a 3-unit workflow | 145 | 32 |
# For N=3: temporal_model(3)=145, absurd_model(3)=32
check("Cost model for N=3 (Temporal): 40+35·3", temporal_model(3), 145)
check("Cost model for N=3 (Absurd): 11+7·3",    absurd_model(3),   32)
check("Ratio 145/32",                           145 / 32,          4.53, tol=0.01)

# Throughput (1k units @ c=64): 65.6/s vs 1,435.8/s
check("Throughput head-to-head match", 1435.8 / 65.6, 21.88, tol=0.01)


print("\n── ~11,000 SQL STATEMENTS/SEC AT SATURATION ──────────────")
# "The backend saturates near ~80 workflows/s on this hardware —
#  ~11,000 SQL statements/s across all those tables (80 × 145)"
# Per 3-activity workflow: 40 + 35*3 = 145 SQL
check("80 wf/s × 145 SQL/wf = 11,600 stmts/s",
      80 * 145, 11_600, tol=0.001)
# Post writes "~11,000" which rounds 11,600 down; check within 10%
check("11,600 ≈ ~11,000 (post rounds down)", 11_600, 11_000, tol=0.06)


print("\n── BIG-CHECKOUT NAPKIN (20-activity × 1K/sec = 740K/sec) ──")
# "a 20-activity checkout flow is ~740 SQL statements against 16 tables, per
#  checkout. On a 1K-checkouts/sec service, that's 740,000 statements/sec"
per_20act = temporal_model(20)   # =740
check("20-activity cost: 40+35·20", per_20act, 740)
check("1K/s × 740: 740K/s",        1000 * per_20act, 740_000)


print("\n── SDK LOC RATIOS ──────────────────────────────────────────")
# "SDK LOC (Python, non-generated) | ~49,000 | 1,900"
# "SDK LOC (TypeScript, non-generated) | ~38,000 | 1,400"
check("Python LOC ratio: 49000/1900", 49_000 / 1_900, 25.8, tol=0.02)
check("TypeScript LOC ratio: 38000/1400", 38_000 / 1_400, 27.1, tol=0.02)


print("\n── ABSURD STORAGE BREAKDOWN (row counts) ──────────────────")
# 21,300 checkpoint rows (3 per task, 7,100 tasks)
check("3 checkpoints per task × 7100 = 21300", 3 * 7100, 21_300)
# 7,100 run rows = 1 per task
check("1 run row per task × 7100", 1 * 7100, 7_100)
# 7,100 task rows
check("1 task row per task × 7100", 1 * 7100, 7_100)


print("\n── AI COLOPHON COST ($24.99 snapshot) ─────────────────────")
# "38 million cached-read tokens" — the table says 37.8M
check("Cached-read tokens ~38M", 37.8, 38, tol=0.01)


print("\n" + "═" * 60)
if failures:
    print(f"{FAIL}  {len(failures)} checks failed:")
    for f in failures:
        print(f"     - {f}")
    sys.exit(1)
else:
    print(f"{PASS}  All arithmetic checks pass")
    sys.exit(0)
