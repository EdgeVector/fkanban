# Guarded original-execution recovery

This contract supports a bounded Loom retry under its existing owner and execution.
It does not create a claim or authorize a replacement worker.

## Commands

```sh
kanban show CARD --canonical --json
kanban set CARD --block-status none --block-reason '' --expect-assignee OWNER --json
kanban move CARD doing --from backlog --expect-assignee OWNER --json
```

Use the same guard to restore a hold or PARK into backlog. The caller must verify
its original execution, lease, claim, and latest body marker before and after
admission. A released or foreign owner on the canonical read refuses recovery.

Guarded set accepts hold fields only. Guarded move accepts backlog and doing only,
requires `--from`, and rejects force or reassignment. Same-column retries retain
the current position unless an explicit position is supplied.

## Atomic and durable boundary

The client submits one update-only batch. It contains the Card owner comparison
and each configured BoardCards write. Every operation requests durable mode.
All shared field values agree. The Card body is absent from the payload, so a
concurrent execution marker or progress line survives.

The client requires the exact proved node build `0.23.3-2328-g369ad6cd6` and a
successful handshake. It checks declared payload fields and key layouts before
any mutation. The response must confirm durable acknowledgement. Unsupported
builds, incompatible schemas, conflicts, and uncertain acknowledgement fail
without an unguarded retry. A failed acknowledgement can still mean the batch
committed. The caller must read canonical state before any guarded retry.

The client performs no later projection write, cleanup delete, or completion
hook. The result states `membership_cleanup: "deferred"`.

## Limits and costs

- The assignee comparison is atomic. The column check is a point read.
- An owner can identify several executions. This is not a unique execution CAS.
- A concurrent same-owner edit to a projected field can conflict with the full
  projection payload. Body edits survive because the batch omits body.
- Old source memberships remain. Measured all-column list selects the latest
  state. Raw column lists retain prior rows.
- A stale doing row can conservatively block pickup-v2 or direct overlap after
  PARK. Bounded recovery retries do not bypass this block.
- A future node build needs the same proof before allowlist expansion. The node
  does not yet advertise this specific batch capability.
- A normal one-BoardCards mutation adds one version handshake, two schema metadata
  reads, and one durable batch request. The client can cache its handshake.
  Existing command preflight reads remain. List/search read budgets stay unchanged.

Follow-up records remain open:

- `papercut-lastdb-guarded-batch-capability-unadvertised-20260925`
- `papercut-kanban-guarded-recovery-defers-membership-cleanup-20260925`
- `papercut-kanban-wide-projection-overwrites-concurrent-card-state-20260925`

## Evidence, 2026-09-25

The fresh synthetic node used build `0.23.3-2328-g369ad6cd6`. It used no primary
copy. The production wrapper proof covered 12 cases. Seven batches committed
before a concurrent foreign takeover. All foreign owner, tags, body, column,
and hold values remained after takeover. One foreign-owner rejection left the
absent destination absent. The proof starts takeover at the batch submission
boundary, after version and schema preflight.

The body preservation case inserted a new same-owner execution marker before
batch apply. The marker survived. An independent canonical-read fixture covered
foreign and released owners with the same timestamp as a stale doing row.

A SIGKILL and restart changed the synthetic node instance. Ten expected Card
states survived. Source membership residue remained explicit. The full suite
passed 2256 tests with zero failures; the typecheck and architecture checks passed.

Run `scripts/probe-recovery-batch.ts` with an explicit synthetic configuration and
`PROBE_EVIDENCE` path under `/tmp/fkanban-owner-probe-`. Start a fresh node first.
Run it again with `--verify-restart` after a restart of that synthetic node only.
Keep the evidence file between invocations. Never use the default primary-clone
helper or a primary socket for this proof.
