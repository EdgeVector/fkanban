# F-Kanban multi-key schemas

Each schema owns its record values. Canonical fields reuse only their definitions.
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
Ordinary CLI and MCP requests require a config with the multi-key storage model. `kanban init` writes that config.
Board create writes one Board record. Board removal reads the named board key and removes Card records in bounded batches.
The default-board and external-dependency guards remain. A remaining Card record prevents removal of the Board record.
Card body reads collect primary keys first. Each batch contains at most 16 bodies.
Already loaded bodies stay unchanged. Soft-deleted records do not enter the result.
Milestone body pages contain at most 16 records. The page size does not reduce the overall record limit.
The normal request path no longer uses the old membership schemas, payload copies, list rollups, or repair queues.
Fresh setup declares Card, Board, Milestone, and flow-event records only.

## Operational check

The `groom parity-check` command reads named keys and primary values twice.
It compares the Card all key, the board keys, and the milestone keys named by those records.
It reports stable differences separately from concurrent changes.
An incomplete request fails the command. An unknown board also fails.
The report names its addressed scope. It does not claim a count of unaddressed database data.
This check does not write data or request an old payload repair.

## Existing installations

This release does not convert a home in place. It has no conversion command.
`kanban init` declares the owned schemas on a home with no F-Kanban schemas.

A home can already hold the five historical layouts as owned schemas:
BoardCards, MilestoneCards, BoardMilestones, CardListIndex, and ColumnHeadAtom.
Init keeps each one as a separate owned schema. Their records can differ from the current source records. They do not become alternate keys.
Init checks each installed historical definition exactly. A different definition stops init and leaves the config unchanged.
Repeated setup keeps their saved runtime addresses, definition identities, and field aliases.
An unknown or ambiguous app schema stops init. Init leaves it unchanged.

Init refuses a node without the `compound_alternate_keys_v1` and `independent_hash_range_v1` capabilities.
Init also refuses a node older than LastDB API 13 before it declares a schema.

## Wire format

Alternate-key declarations and owned-layout comparisons use the exact Rust wire defaults.
This keeps key fields, part order, formats, and missing-value behavior intact. Unknown properties and invalid types stop the operation.
