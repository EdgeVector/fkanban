#!/usr/bin/env bash
# Merge gate for fkanban (GitHub `ci-required`, job `gate`; also runnable locally).
# The tests were deleted (Tom, 2026-10-09): this gate runs shell syntax, the
# schema-sync boundary, typecheck, and a bundle compile of the CLI and MCP
# entrypoints.
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob 2>/dev/null || true

echo "== shell syntax =="
for f in .lastgit/*.sh bin/*; do
  [ -f "$f" ] || continue
  case "$f" in
    *.sh|bin/fkanban|bin/fkanban-mcp|bin/kanban|bin/kanban-mcp|bin/registry-*|bin/kanban-registry-upgrade)
      echo "bash -n $f"
      bash -n "$f"
      ;;
  esac
done

echo "== dependencies =="
bun install --frozen-lockfile

echo "== schema-sync architecture boundary =="
bun run check:schema-sync-boundary

echo "== typecheck =="
bun run typecheck

echo "== bundle check =="
bun build src/cli.ts --target=bun --outfile=/dev/null
bun build src/mcp/main.ts --target=bun --outfile=/dev/null

echo "ci gate PASSED"
