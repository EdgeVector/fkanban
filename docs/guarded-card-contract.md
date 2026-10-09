# Guarded Card contract

The factory uses an exact canonical Card snapshot for each finite write.
The public `guarded-contract --json` command returns the contract before config or node access.
The installed artifact keeps `dist/guarded-contract.json` beside the CLI and MCP programs.
That receipt binds the source commit, source file hashes, contract hash, and both program hashes.

`guarded-snapshot SLUG --json` returns the exact UTF-8 JSON bytes with a final newline.
The envelope has `version: 1`, `schema_hash`, and `fields` with all 23 stored Card fields.
Each scalar is a string. The tags, deps, and surfaces fields are string arrays.
Missing fields, nulls, extra fields, wrong keys, wrong schema pins, or invalid types refuse.
The caller computes SHA-256 on these bytes and keeps the file as its admission or proof witness.

Public writes accept `--guard-snapshot PATH --snapshot-sha256 HEX`.
Closeout writes also require `--expect-assignee OWNER`.
The path must name a bounded regular file. A symlink refuses.
The current Card must equal the supplied witness before the policy gates.
The atomic batch guards the supplied witness again at the mutation.
A new read cannot replace that witness after a failed guard.

The finite operations are:

- `mark SLUG LINE`: one bounded body line, once; owned, unheld doing or terminal Card.
- `set SLUG --pr-url URL [--branch BRANCH]`: owned, unheld doing or terminal Card.
- `set SLUG --surfaces PATHS --expect-assignee ''`: unowned, unheld backlog or todo Card.
- `move SLUG todo --from backlog --expect-assignee ''`: unowned, unheld promotion.
- `move SLUG done --from doing --expect-assignee OWNER`: owned, unheld terminal move.
- `pickup claim --claim-v2 --only-card SLUG --worker WORKER`: exact admission and claim.

The `pickup claim-v2` spelling remains valid.
Exact claim uses the raw admission witness even without caller snapshot flags.
The factory requires those flags to bind the controller admission check.
The initial claim creates an exact synthetic recovery hold in the same durable batch.
The second batch clears only that accepted hold under all 23 original accepted fields.
A human edit at either stage refuses. The exact path has no owner-only fallback writes.

The surfaces branch checks bounded repo-relative path or glob syntax.
The controller must check actual tracked paths at the exact repo and base.
The branch changes only surfaces and updated_at.
PR and branch metadata cannot combine with that branch.

Each successful write returns `next_snapshot_json` as a string with the final newline.
It also returns `next_snapshot_sha256`, `guard_snapshot_sha256`, `contract_sha256`, and `durability: durable`.
The next bytes describe the accepted intended Card and pass an exact canonical readback.
The caller uses those exact bytes for the next step.
The chain is admission, claim, proof marker, PR metadata, and terminal move.
A stale accepted witness refuses. A terminal Card permits a guarded marker retry.

MCP uses `guard_snapshot_json`, `snapshot_sha256`, and `expect_assignee`.
The snapshot tool returns `snapshot_json` and `snapshot_sha256`.
CLI and MCP use the same parser, policy gates, finite deltas, and compound writer.

Compound mode permits only Mini `0.23.3-2588-g24334db75`.
The batch has 23 canonical guards, one final Card update, and one or two BoardCards destination updates.
The maximum is 26 operations. All operations request durable acknowledgement.
An absent canonical Card refuses. An absent exact BoardCards destination may enter through the guarded update.
The writer does not create or repair a Board, delete membership, promote other Cards, or publish later unguarded effects.
Old owner-only recovery compatibility does not prove this compound contract.

If the initial claim passes durable acknowledgement and exact readback, a failed clear returns `result: error`.
The error includes `code: claim_recovery_pending`, `clear_code`, and a typed `accepted_held` receipt.
That receipt has version 1, stage `accepted-held`, exact `snapshot_json`, its `snapshot_sha256`, and durable acknowledgement.
The error does not report claimed or a success next snapshot.
The controller keeps its slot and may retry only that supplied accepted-held witness with the exact worker.
A claim without snapshot flags cannot resume a held Card.
The resume checks current canonical doing peers and excludes its own reservation.
A later overlapping peer refuses the clear and keeps the exact synthetic hold.
A changed human hold, body, GOAL, or timestamp makes the accepted witness refuse.
Unknown initial durability or failed initial readback does not expose an accepted-held receipt.

`guarded-snapshot --slugs-file PATH --json` accepts a regular JSON file with at most 256 unique slug tokens.
The MCP tool `fkanban_guarded_snapshots` accepts the same keys as its `slugs` array.
Both return version 1, the canonical `schema_hash`, and `items` in requested order.
Each item has slug, `snapshot_json`, and `snapshot_sha256`, or explicit `missing: true`.
One authenticated native `HashRangeKeys` request reads all collected keys.
The request uses the existing request and body deadline and a maximum of one page.
The body drain cancels at the 8 MiB cap.
Duplicate, foreign, sparse, malformed, unresolved, inconsistent-count, or incomplete responses refuse.
The reader does not deduplicate keys, infer rendered keys, fall back, or turn a failed read into missing truth.

The public proof helper accepts `--artifact-root PATH` for the official artifact directory.
It checks that artifact receipt against the source manifest and both program hashes before node work.
It then uses a fresh private Mini, bounded native reads, and verified private process stops.
The helper refuses unknown flags before node work.
The primary remains outside this synthetic proof.
