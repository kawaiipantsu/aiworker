#!/bin/sh
# Operator-only refresh from the existing root CLI logins; no credential output.
set -eu
install -m 600 -o aiworker -g aiworker /root/.codex/auth.json /var/lib/aiworker/.codex/auth.json
install -m 600 -o aiworker -g aiworker /root/.claude/.credentials.json /var/lib/aiworker/.claude/.credentials.json
printf '%s\n' 'Worker CLI credentials synchronized. Use Administration → Retry provider now if needed.'
