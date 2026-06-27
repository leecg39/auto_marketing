#!/bin/sh
set -eu

tmux kill-session -t marketing-automation-demo 2>/dev/null || true
tmux kill-session -t marketing-automation-crm 2>/dev/null || true
tmux kill-session -t marketing-automation-downstream 2>/dev/null || true

printf '%s\n' 'Marketing automation local servers stopped.'
