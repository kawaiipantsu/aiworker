#!/bin/sh
# Copy already installed, operator-updated CLIs; do not mutate a running binary.
set -eu
install -m 755 /root/.local/bin/codex /opt/aiworker/bin/codex.new
install -m 755 /root/.local/bin/claude /opt/aiworker/bin/claude.new
install -m 755 /root/.codex/packages/standalone/current/bin/codex-code-mode-host /opt/aiworker/bin/codex-code-mode-host.new
mv /opt/aiworker/bin/codex-code-mode-host.new /opt/aiworker/bin/codex-code-mode-host
mv /opt/aiworker/bin/codex.new /opt/aiworker/bin/codex
mv /opt/aiworker/bin/claude.new /opt/aiworker/bin/claude
printf '%s\n' 'CLI binaries updated for subsequent launches.'
