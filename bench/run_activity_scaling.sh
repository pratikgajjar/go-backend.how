#!/bin/bash
# run_activity_scaling.sh — run 200-workflow benchmark for 1/3/5/10 activities
# and capture per-workflow query count each time.
set -e
MM=../mm.sh
N=${1:-200}
C=${2:-32}

for WF in Var1 Var3 Var5 Var10; do
  # Reset stats
  bash $MM "/opt/podman/bin/podman exec postgres psql -U myuser -d temporal -c 'SELECT pg_stat_statements_reset();'" > /dev/null 2>&1

  # Run the driver
  RESULT=$(bash $MM "cd ~/bench/temporal-blog/code && go run ./temporal_driver_var -n $N -c $C -wf $WF" 2>&1 | tail -1)

  # Collect total statement count attributable to this workload
  TOTAL_CALLS=$(bash $MM "/opt/podman/bin/podman exec postgres psql -U myuser -d temporal -tA -c \"
    SELECT sum(calls) FROM pg_stat_statements s
    JOIN pg_database d ON s.dbid=d.oid
    WHERE d.datname='temporal'
      AND query NOT LIKE 'BEGIN%' AND query NOT LIKE 'COMMIT%'
      AND query NOT LIKE 'SET %' AND query NOT LIKE 'DEALLOCATE%'
      AND query NOT LIKE '%pg_stat_statements%'
  \"" 2>&1 | tr -d ' \r')

  PER_WF=$(echo "scale=1; $TOTAL_CALLS / $N" | bc)
  echo "wf=$WF n=$N total_sql=$TOTAL_CALLS per_wf=$PER_WF  $RESULT"
done
