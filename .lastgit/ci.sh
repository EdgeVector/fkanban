#!/usr/bin/env bash
# LastGit merge gate for fkanban (public OSS dual-home).
set -euo pipefail
cd "$(dirname "$0")/.."
shopt -s nullglob 2>/dev/null || true

echo "== shell syntax =="
for f in .lastgit/*.sh bin/*; do
  [ -f "$f" ] || continue
  case "$f" in
    *.sh|bin/fkanban|bin/fkanban-mcp|bin/kanban|bin/kanban-mcp|bin/fkanban-worktree)
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

echo "== artifact build =="
bun run build

echo "== tests =="
bun test

echo "lastgit ci gate PASSED"
