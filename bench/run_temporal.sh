#!/bin/bash
# run_temporal.sh — run the temporal benchmark on the mac mini
# Args: <total_workflows> <concurrency> <wait_bool>
set -e

N=${1:-200}
C=${2:-32}
WAIT=${3:-true}

# Start/restart the Temporal worker in tmux
MM=../mm.sh

bash $MM "tmux kill-session -t tw 2>/dev/null || true"
bash $MM "tmux new-session -d -s tw 'cd ~/bench/temporal-blog/code && export PATH=\$HOME/bench/temporal-blog/go/bin:\$PATH && go run ./temporal_worker 2>&1 | tee /tmp/tw.log'"
sleep 5  # wait for worker to register + compile

# Reset pg_stat_statements
bash $MM "/opt/podman/bin/podman exec postgres psql -U myuser -d temporal -c 'SELECT pg_stat_statements_reset();'" > /dev/null 2>&1

# Run the driver
echo "=== Temporal: N=$N C=$C wait=$WAIT ==="
bash $MM "cd ~/bench/temporal-blog/code && export PATH=\$HOME/bench/temporal-blog/go/bin:\$PATH && go run ./temporal_driver -n $N -c $C -wait=$WAIT"

# Kill worker
bash $MM "tmux kill-session -t tw 2>/dev/null || true"
