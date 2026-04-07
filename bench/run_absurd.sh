#!/bin/bash
# run_absurd.sh — run the absurd benchmark on the mac mini
# Args: <total_tasks> <concurrency> <wait_bool> <workers>
set -e

N=${1:-200}
C=${2:-32}
WAIT=${3:-true}
W=${4:-8}

# Start the Absurd worker in tmux
MM=../mm.sh

bash $MM "tmux kill-session -t aw 2>/dev/null || true"
bash $MM "tmux new-session -d -s aw 'cd ~/bench/temporal-blog/code && export PATH=\$HOME/bench/temporal-blog/go/bin:\$PATH && go run ./absurd_worker -workers $W 2>&1 | tee /tmp/aw.log'"
sleep 5  # wait for worker to start + compile

# Reset pg_stat_statements
bash $MM "/opt/podman/bin/podman exec postgres psql -U myuser -d absurd -c 'SELECT pg_stat_statements_reset();'" > /dev/null 2>&1

# Run the driver
echo "=== Absurd: N=$N C=$C workers=$W wait=$WAIT ==="
bash $MM "cd ~/bench/temporal-blog/code && export PATH=\$HOME/bench/temporal-blog/go/bin:\$PATH && go run ./absurd_driver -n $N -c $C -wait=$WAIT"

# Kill worker
bash $MM "tmux kill-session -t aw 2>/dev/null || true"
