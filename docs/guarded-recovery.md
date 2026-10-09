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

The client requires one of the proved node builds
(`0.23.3-2328-g369ad6cd6`, `0.23.3-2375-ga7bac36f1`,
`0.23.3-2588-g24334db75`) and a successful
handshake. It checks declared payload fields and key layouts before
any mutation. The response must confirm durable acknowledgement. Unsupported
builds, incompatible schemas, conflicts, and uncertain acknowledgement fail
without an unguarded retry. A failed acknowledgement can still mean the batch
committed. The caller must read canonical state before any guarded retry.

The client sends no later projection write, Card write, or completion hook.
After the batch commits, a guarded `move` makes one best-effort cleanup pass. It
deletes the card's BoardCards rows at every other address, and only after a
partition read sees the destination row. A cleanup failure prints a warning
and does not fail the move. The result states `membership_cleanup: "purged"`
when the pass ran delete attempts and `"deferred"` when it ran none. Guarded
`set` and `mark` do not move the card and always state `"deferred"`.

## Limits and costs

- The assignee comparison is atomic. The column check is a point read.
- An owner can identify several executions. This is not a unique execution CAS.
- A concurrent same-owner edit to a projected field can conflict with the full
  projection payload. Body edits survive because the batch omits body.
- Guarded `move` retires old source memberships after the batch. When that pass
  fails, or the destination row stays invisible for its wait budget, prior rows
  remain: raw column lists show them until a repeat of the move or
  `kanban groom board-cards-heal`. Measured all-column list selects the latest
  state.
- A stale doing row left by a failed cleanup pass can conservatively block
  pickup-v2 or direct overlap after PARK. Bounded recovery retries do not bypass
  this block.
- A future node build needs the same proof before allowlist expansion. The node
  does not yet advertise this specific batch capability.
- A normal one-BoardCards mutation adds one version handshake, two schema metadata
  reads in parallel, and one durable batch request. The client can cache its handshake.
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

## Evidence, 2026-09-27

Build `0.23.3-2328-g369ad6cd6` aged out of the fleet. Tom's primary node runs
build `0.23.3-2375-ga7bac36f1`, 45 commits ahead, and every guarded batch call
against it failed with `guarded_batch_unsupported` — the allowlist had never
been re-proved for a later build. This blocked Loom's PARK retry path on a
live card and stalled the `lastgit-era-3-primary-migration` North Star.

Re-ran the full 2026-09-25 recipe against build `0.23.3-2375-ga7bac36f1` on a
fresh synthetic node (a new `--data-dir`, the primary's exact `lastdbd`
binary, no clone, no primary socket). The proof passed unchanged: 12 cases,
10 persisted Card states, at least one batch committed before a concurrent
foreign takeover, all foreign owner/tags/body/column/hold values survived
takeover, the one foreign-owner rejection left its destination absent. A
SIGKILL and restart of that same synthetic node, then `--verify-restart`,
confirmed all 10 persisted states unchanged. `bun test` passed 2301 tests
(0 failures) and `bun run typecheck` passed. Added the build to
`GUARDED_CARD_BATCH_BUILDS` alongside the 2026-09-25 entry rather than
replacing it, since the comment on that constant only requires each listed
build to carry its own proof, not that the list stay a single element.


## Evidence, 2026-10-08

Build `0.23.3-2588-g24334db75` passed the official production wrapper on a fresh
synthetic home. The proof used the exact installed binary, three checked published
schemas, and a synthetic default Board. It used no primary copy or primary socket.
The wrapper passed 12 cases. Seven batches committed before a foreign takeover.
The foreign owner, tags, body, column, and hold survived each takeover. A refused
batch left the destination absent. A concurrent same-owner body mark survived.

An argv check restricted the SIGKILL and restart to that synthetic node. A new
node instance returned all ten expected Card states. The final argv check and
SIGTERM stopped the synthetic node. These results support the exact build entry.
The client still refuses unproved builds, failed handshakes, incompatible schemas,
and uncertain durable acknowledgements. Schema metadata reads run in parallel;
the client checks every result before the batch.
