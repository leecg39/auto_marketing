#!/bin/sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
KIT_ROOT=$(CDPATH= cd -- "$SCRIPT_DIR/.." && pwd)
WORKSPACE_ROOT=$(CDPATH= cd -- "$KIT_ROOT/.." && pwd)

tmux kill-session -t marketing-automation-demo 2>/dev/null || true
tmux kill-session -t marketing-automation-crm 2>/dev/null || true
tmux kill-session -t marketing-automation-downstream 2>/dev/null || true

tmux new-session -d -s marketing-automation-demo -c "$WORKSPACE_ROOT" \
  'python3 -u -m http.server 8081 --bind 127.0.0.1'

tmux new-session -d -s marketing-automation-downstream -c "$KIT_ROOT" \
  'PORT=8792 node server/downstream-crm-simulator.mjs'

tmux new-session -d -s marketing-automation-crm -c "$KIT_ROOT" \
  'PORT=8791 DOWNSTREAM_CRM_WEBHOOK_URL=http://127.0.0.1:8792/crm/downstream DOWNSTREAM_CRM_API_KEY=local-dev-key node server/crm-event-receiver.mjs'

printf '%s\n' 'Marketing automation local servers started.'
printf '%s\n' 'Demo: http://127.0.0.1:8081/marketing-automation-kit/examples/demo-store.html?crm=http://127.0.0.1:8791/crm/events'
printf '%s\n' 'CRM:  http://127.0.0.1:8791'
printf '%s\n' 'Downstream simulator: http://127.0.0.1:8792'
