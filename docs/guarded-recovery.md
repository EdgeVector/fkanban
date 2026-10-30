# Guarded original-execution recovery

Recovery uses the existing owner and execution. It grants no replacement worker.
The app requires schema-owned values and the `atomic_owned_mutations_v1` capability.

## Commands

```sh
kanban show CARD --canonical --json
kanban set CARD --block-status none --block-reason '' --expect-assignee OWNER --json
kanban move CARD doing --from backlog --expect-assignee OWNER --json
```

The caller checks its original execution, lease, claim, and latest body marker before recovery.
A missing or foreign owner refuses recovery.
Guarded set accepts hold fields only. Guarded move accepts backlog and doing only.
The move requires `--from` and rejects force, reassignment, and a replacement worker.
A same-column retry retains the current position unless the caller supplies a position.

## Atomic request

The client sends one durable batch for the primary Card record.
The request compares the assignee at atomic publication.
LastDB changes the named alternate addresses in the same native request.
Recovery omits the body, so a concurrent execution marker survives.
A guarded move returns `membership_cleanup: "native"`.

Failed capability checks, conflicts, and uncertain acknowledgements refuse the operation.
The client makes no unguarded retry or later projection write.
An uncertain acknowledgement can still mean the request committed.
The caller reads the canonical state before a guarded retry.

## Limits and evidence

The assignee comparison is atomic. The source-column check uses the earlier read.
One owner can hold several executions; the assignee alone does not identify an execution.
A concurrent edit by the same owner can conflict with recovery's other fields.
The exact snapshot contract adds all 23 field guards for its finite operations.
See [the guarded Card contract](guarded-card-contract.md).

CI supplies the build and operational evidence. The primary stays outside source and CI work.
The artifact receipt identifies the compiled programs and source; it does not prove a live request.
