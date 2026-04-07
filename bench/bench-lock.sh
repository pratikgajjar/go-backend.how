#!/bin/bash
# bench-lock.sh — coordinate with other agents running benchmarks on the mac mini
# Usage:
#   bench-lock.sh acquire "task description"   # wait until lock is free, then claim
#   bench-lock.sh release                       # drop the lock
#   bench-lock.sh status                        # show current holder

LOCK=/tmp/bench-me
ME="temporal-blog-agent"

case "$1" in
  acquire)
    DESC="${2:-unknown}"
    # wait up to 5 minutes for the lock
    for i in $(seq 1 300); do
      if [[ ! -f $LOCK ]]; then
        echo "{\"agent\":\"$ME\",\"ts\":\"$(date -Iseconds)\",\"task\":\"$DESC\"}" > $LOCK
        echo "✓ acquired: $DESC"
        exit 0
      fi
      HOLDER=$(cat $LOCK 2>/dev/null)
      if [[ $i -eq 1 ]]; then
        echo "Waiting for lock (held by): $HOLDER"
      fi
      sleep 1
    done
    echo "✗ timeout waiting for lock"
    exit 1
    ;;
  release)
    if [[ -f $LOCK ]]; then
      HOLDER=$(cat $LOCK 2>/dev/null)
      if echo "$HOLDER" | grep -q "\"$ME\""; then
        rm -f $LOCK
        echo "✓ released"
      else
        echo "✗ lock held by another agent, not removing: $HOLDER"
        exit 1
      fi
    else
      echo "(no lock)"
    fi
    ;;
  status)
    if [[ -f $LOCK ]]; then
      cat $LOCK
    else
      echo "(free)"
    fi
    ;;
  *)
    echo "usage: $0 {acquire|release|status} [description]"
    exit 2
    ;;
esac
