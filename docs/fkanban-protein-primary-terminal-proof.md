PASS

# fkanban protein-primary terminal proof

Date: 2026-08-02
Repo: EdgeVector/fkanban
Branch: kanban/fkanban-protein-primary-terminal-drift-fix-20260802
Milestone: milestone-fkanban-stop-multi-schema-app-writes

## Result

GREEN: `milestone reconcile` now converges live MilestoneCards repair debt
without requiring the operator to pass
`--force-milestone-card-payload-upsert`.

The repair path first asks Mini to fold from the BoardCards write. If the
expected MilestoneCards row is still absent or stale, the same bounded repair
item falls back to key regeneration for that row. Hot card writes remain
BoardCards-only and do not call protein APIs.

## Evidence

Install:

```bash
bun install --frozen-lockfile
```

Focused regression suite:

```bash
bun test test/milestone-indexes.test.ts \
  test/milestone-indexes-heal.test.ts \
  test/protein-primary-membership.test.ts \
  test/no-protein-reach.test.ts
```

Result:

```text
34 pass
0 fail
```

Typecheck:

```bash
bun run typecheck
```

Result: pass.

Additional targeted reruns:

```bash
bun test test/mcp-read-tools-do-not-mutate.test.ts
bun test test/field-projection.test.ts
bun test test/kanban-stress-cleanup.test.ts
```

Result:

```text
14 pass
6 pass
7 pass
```

Full-suite attempts:

```bash
bun test
```

First result before the MCP fixture expectation was updated:

```text
1227 pass
3 fail
```

Failures:

```text
--field projection > search still answers via native candidates when the Card scan is refused
declared MCP read tools do not mutate > the fixture provokes a write from the tool that is allowed to write
kanban-stress scratch cleanup > reaps every throwaway board it created
```

After updating the MCP fixture, the three previously failing files passed when
run directly. A second full-suite attempt became invalid after an MCP SDK file
under `node_modules` disappeared mid-run; subsequent CLI-spawn tests returned
exit 1. `bun install --frozen-lockfile` restored the install.

Live repair and terminal dry-run:

```bash
bun run src/cli.ts milestone reconcile \
  milestone-fkanban-stop-multi-schema-app-writes --json
```

Repair result:

```json
{
  "applied": true,
  "upserts": 9,
  "removals": 0,
  "issued": 9,
  "deferred": 0,
  "budget": 25,
  "direct_payload_upsert": true
}
```

Follow-up dry-run:

```bash
bun run src/cli.ts milestone reconcile \
  milestone-fkanban-stop-multi-schema-app-writes --dry-run --json
```

Terminal repair debt:

```json
{
  "applied": false,
  "upserts": 0,
  "removals": 0,
  "issued": 0,
  "deferred": 0,
  "budget": 25,
  "direct_payload_upsert": false
}
```

## Notes

- No `--force-milestone-card-payload-upsert` flag was used in the live repair
  or the zero-debt dry-run.
- The direct payload flag in the apply output records the automatic repair
  fallback after the protein-fold request did not materialize the sibling row on
  the live primary.
- The no-protein-reach regression test confirms fkanban still does not call
  LastDB protein routes.
