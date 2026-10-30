# F-Kanban multi-key schemas

New installations declare independent record values. Canonical fields still reuse their definitions.
Named keys belong to the source record schema. A mutation updates the record and its keys in one native request.

Card uses board and milestone keys. Each range contains the column, the padded position, and the slug.
An all-cards key supplies the slugs for complete body reads. The app reads those records in bounded batches.
Milestone uses a board key. Board uses an all-boards key.
The normal path no longer writes membership records or cached list heads.
The column view derives its display window from the current named-key records.
Milestone reconcile and detail read the named milestone key. They do not repair separate copies.
The CLI and MCP return the same child status, ready frontier, and proof verdict.
Read failures stop the command. An incomplete read cannot report an empty milestone.
Doctor checks the schema owner, primary key, fields, and complete named key layout.
Ordinary CLI and MCP requests require the converted config. The explicit converter can read the old config.
Board create writes one Board record. Board removal reads the named board key and removes Card records in bounded batches.
The default-board and external-dependency guards remain. A remaining Card record prevents removal of the Board record.
Card body reads collect primary keys first. Each batch contains at most 16 bodies.
Already loaded bodies stay unchanged. Soft-deleted records do not enter the result.
Milestone body pages contain at most 16 records. The page size does not reduce the overall record limit.
The old membership schemas, payload copies, list rollups, packed-summary prototype, and repair queues are removed.
The app declares Card, Board, Milestone, and flow-event records. Only the explicit converter names retired schemas.

## Operational check

The `groom parity-check` command reads named keys and primary values twice.
It compares the Card all key, the board keys, and the milestone keys named by those records.
It reports stable differences separately from concurrent changes.
An incomplete request fails the command. An unknown board also fails.
The report names its addressed scope. It does not claim a count of unaddressed database data.
This check does not write data or request an old payload repair.

## Existing installations

Run `kanban multi-key-convert` to read the plan.
Use `--apply --maintenance` only for an explicit request pause and config cutover.
The command does not run during init or an ordinary mutation.

The node freezes requests, copies the current atom references and author clocks, creates the named keys, and retires reviewed legacy aliases.
A body field identifies a Card, Board, or Milestone member.
The converter refuses unique source values without a selected member. It does not infer membership from a shared key field.

The command writes the config to disk before the node resumes requests.
Repeat the same command after an interruption.
Before publication, `--apply --maintenance --abort` removes the unpublished copy and restores the old state.
After publication, resume forward. The node keeps requests blocked until completion.

The converter requires healthy counters, ordinary source schemas, no kept history, no molecule generations, no database catalog membership, and no registered logical peers.
It refuses mapped source authorities and unknown older schema shapes.
Those states require a separate reviewed conversion.

Older app declarations refuse converted schemas. A ranged mutation cannot silently address an independent hash-only record.
New mutations and the column view require the explicit cutover.
The converter remains available for an older installation.

## CI comparison

The linked LastDB CI run compares the exact app revisions across the app and daemon cutover.
The control release converts an old app home before the candidate daemon opens it.
The workload uses generated data on owned CI homes.
It checks logical record membership, order, bodies, updates, and cursors.
Physical database size may decrease. Logical record counts must remain correct.
The primary does not participate in this check.
