#!/usr/bin/env bash
# Artifact producer for the `artifact-release` LastGit context.
#
# `artifacts.json` declares that this repo publishes `dist/`, and Host Track
# installs fkanban/kanban from that published bundle
# (fkanban.app.json: install_mode=artifact, artifact_channel=stable). But
# nothing ever produced it: ci-required builds `dist/` and throws it away with
# the temp checkout, and this repo had no artifact-release script at all — only
# lastseek did.
#
# The result was silent. On 2026-08-08 a green merge to main left
# `host-track refresh fkanban` reporting
#
#   host-track: fkanban main tip 357db84e0956 not yet green+published;
#               keeping channel=stable
#
# and reinstalling the PREVIOUS oid, exit 0. The board CLI every agent runs
# stayed on old code while main had moved, and the only signal was one line in
# a refresh nobody reads. A merge that cannot reach the installed binary is not
# a merge that shipped.
#
# NOTE: this script is only half the fix. It runs when a watcher for the
# artifact-release context is watching this repo:
#
#   lastgit ci watch --repo fkanban --context artifact-release \
#     --ref refs/heads/main --keep-alive
#
# lastseek has such a watcher running; fkanban does not yet. Until one is
# supervised, publication still has to be driven by hand.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ "${LASTGIT_CI_CONTEXT:-artifact-release}" != "artifact-release" ]; then
  echo "artifact-release.sh must run as the artifact-release LastGit context" >&2
  exit 2
fi

# The watcher builds each commit in a fresh temp checkout, so dependencies are
# never already present.
bun install --frozen-lockfile

bun run build

# `dist/` is what artifacts.json publishes. Verify every binary the app manifest
# links onto PATH actually exists and runs — a bundle that installs cleanly and
# then cannot execute is the silent-useless-artifact case, and these four are
# what `~/.local/bin/{kanban,fkanban,kanban-mcp,fkanban-mcp}` point at.
for b in kanban fkanban kanban-mcp fkanban-mcp; do
  test -x "dist/$b" || {
    echo "expected an executable at dist/$b" >&2
    exit 1
  }
done

# CLIs answer --help; the MCP servers are stdio servers with no --help contract,
# so asserting one would fail for a perfectly good binary. Check what each kind
# actually promises.
dist/kanban --help >/dev/null
dist/fkanban --help >/dev/null

echo "fkanban artifact release PASSED"
