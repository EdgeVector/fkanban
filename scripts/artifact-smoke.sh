#!/usr/bin/env bash
# Smoke check for the built `dist/` tree. Run by the `publish` job build-command
# (and by .lastgit/ci.sh) right after `bun run build`. A failure fails the job,
# so a bundle that installs cleanly but cannot run is never published.
set -euo pipefail
cd "$(dirname "$0")/.."

# Every binary the app manifest links onto PATH must exist and be executable
# (~/.local/bin/{kanban,fkanban,kanban-mcp,fkanban-mcp}).
for b in kanban fkanban kanban-mcp fkanban-mcp; do
  test -x "dist/$b" || {
    echo "expected an executable at dist/$b" >&2
    exit 1
  }
done

# CLIs answer --help. The MCP servers are stdio servers with no --help contract,
# so only check that they exist.
if [ "${GITHUB_ACTIONS:-}" = true ]; then
  : "${RUNNER_TEMP:?GitHub must supply the owned temporary directory}"
  export KANBAN_CONFIG="$RUNNER_TEMP/fkanban-artifact-help-absent.json"
  export FKANBAN_CONFIG="$KANBAN_CONFIG"
  export FOLDDB_SOCKET_PATH="$RUNNER_TEMP/fkanban-artifact-help-absent.sock"
  export LASTDB_HOME="$RUNNER_TEMP/fkanban-artifact-help-absent-home"
  test ! -e "$KANBAN_CONFIG"
  test ! -e "$FOLDDB_SOCKET_PATH"
  test ! -e "$LASTDB_HOME"
fi
dist/kanban --help >/dev/null
dist/fkanban --help >/dev/null

echo "fkanban artifact smoke PASSED"
