#!/bin/bash
# mm.sh — SSH to Mac mini 2 with keepalive
# PATH is set inside the remote invocation so that brew-installed tools (tmux, etc.) and podman resolve.
sshpass -p 'macmini2' ssh -o StrictHostKeyChecking=no -o PreferredAuthentications=password -o PubkeyAuthentication=no -o ServerAliveInterval=60 -o ServerAliveCountMax=10 macmini2@Macs-Mac-mini-2.local "export PATH=/opt/homebrew/bin:/opt/podman/bin:\$HOME/bench/temporal-blog/go/bin:\$PATH; $@"
