# F-Kanban multi-key schemas

A kept source with field mappings requires `app_schema_private_mapper_conversion_v1`.
The node checks private molecule UUIDs, selected-source closure, and different key roles before the request pause.
Direct aliases stay outside the kept-source set. Published targets must have no field mappings.

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
The normal request path no longer uses the old membership schemas, payload copies, list rollups, or repair queues.
Fresh setup declares Card, Board, Milestone, and flow-event records only.
An existing home keeps the five historical layouts as separate owned schemas during conversion.
Their records can differ from the current source records. They do not become alternate keys.

## Operational check

The `groom parity-check` command reads named keys and primary values twice.
It compares the Card all key, the board keys, and the milestone keys named by those records.
It reports stable differences separately from concurrent changes.
An incomplete request fails the command. An unknown board also fails.
The report names its addressed scope. It does not claim a count of unaddressed database data.
This check does not write data or request an old payload repair.

## Existing installations

A home with F-Kanban schemas from an older release needs the explicit conversion.
The conversion copies the current values into schema-owned Card, Board, and Milestone records.
It also preserves installed BoardCards, MilestoneCards, BoardMilestones, CardListIndex, and ColumnHeadAtom records.
It keeps their primary keys and every existing primary member. It does not infer record correspondence.
Repeated setup keeps their saved runtime addresses, definition identities, and field aliases.
An unknown or ambiguous app schema requires owner review before the converter pauses requests.
A home with no F-Kanban schemas does not need it. `kanban init` declares the owned schemas directly.

### Required LastDB releases

| Release | Source | API version | Use |
|---|---|---|---|
| Compatible | The first LastDB release that contains lastdb#793 | 12 | Run the conversion here. |
| Removal | The first LastDB release that contains lastdb#803 | 13 | Open the home only after the conversion is complete. |

The compatible node reports these `GET /api/version` capabilities:
`app_schema_conversion_v1`, `owned_app_schemas_v1`, `compound_alternate_keys_v1`, and `independent_hash_range_v1`.
The converter refuses a node without `app_schema_conversion_v1`.
Alias retirement also requires `app_schema_alias_retirement_v1`.
The node checks actual runtime molecules, field types, and key roles before the request pause.
It refuses an alias with unique values, transforms, or fields outside one audited source.
Init refuses a node without the two key capabilities.
The removal release refuses unconverted shared-value schemas at startup. It cannot do the conversion for an old home.

### Order

1. Install the compatible LastDB release.
2. On a format 4 or 5 home, stop the daemon and run `lastdb db enable-alternate-keys`. Then start the daemon.
3. Install the F-Kanban release that contains this converter.
4. Run `kanban multi-key-convert` to read the plan. This step writes nothing.
5. Run `kanban multi-key-convert --apply --maintenance` to convert the data and write the config.
6. Run `kanban doctor`. It checks the owner, the fields, and the named key layout of each owned schema.
7. Upgrade LastDB to the removal release.

Use `--apply --maintenance` only for an explicit request pause and config cutover.
The command does not run during init or an ordinary mutation.

The node freezes requests, copies the current atom references and author clocks, creates the named keys, and retires reviewed legacy aliases.
A body field identifies a Card, Board, or Milestone member.
The converter refuses unique source values without a selected member. It does not infer membership from a shared key field.

Before the request pause, the command saves the exact source config, target config, schema requests, and alias retirements.
It binds the returned change identity to that durable scope. A different scope cannot resume or abort the job.
The command writes the config to disk before the node resumes requests.
Init and other config writes cannot replace an active conversion scope.
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
The historical layouts require complete key, value, current atom, and author checks across conversion and reopen.
Physical database size may decrease. Logical record counts must remain correct.
The primary does not participate in this check.
