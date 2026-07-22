#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

rm -rf dist
mkdir -p dist

bun build src/cli.ts --compile --outfile dist/kanban
cp dist/kanban dist/fkanban

bun build src/mcp/main.ts --compile --outfile dist/kanban-mcp
cp dist/kanban-mcp dist/fkanban-mcp

chmod 755 dist/kanban dist/fkanban dist/kanban-mcp dist/fkanban-mcp
