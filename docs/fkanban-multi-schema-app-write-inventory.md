# fkanban Multi-Schema App Write Inventory

This inventory is for `milestone-fkanban-stop-multi-schema-app-writes`.
It distinguishes product-level multi-schema app writes from LastDB secondary
index mechanics. Same product plus different lookup keys remains a valid
multi-key shape: keep both keys addressable, share payload fields through
proteins/field mappers, and rebuild keyed tips with a background reindex.

## Summary

| Product change | Schemas touched by app code | Classification | Risk |
|---|---|---|---|
| Card create/update/move | `Card`, `BoardCards`, `CardListIndex` only when not retired; `MilestoneCards` delete-only retirement | Protein candidate; BoardCards already acts as the hot-path primary projection for milestone folds | Medium: Card + BoardCards are still both app-written payloads, so a future Card/BoardCards protein fold must not keep both full writes active |
| Card delete | `Card`, `CardListIndex` only when not retired, `BoardCards`, `MilestoneCards` | Different operation shape; delete fan-out is expected cleanup, not payload double-write | Low: key cleanup must stay address-based and delete-only |
| Milestone create/update/state change | `Milestone`, `BoardMilestones` | Protein candidate | Medium: fat milestone plus BoardMilestones are both app-written payloads |
| Milestone delete | `Milestone`, `BoardMilestones` | Different operation shape; delete fan-out is expected cleanup | Low |
| Milestone index heal / reconcile | `BoardMilestones`, `MilestoneCards` from fat `Milestone` / card truth | Repair-only backfill | Medium if reused on the hot path; acceptable as a bounded reindex operator |
| Board create/update/delete | `Board`, `CardListIndex` `all_boards` row | Different product shape / bounded rollup | Low: not the Card/BoardCards/MilestoneCards payload-dual issue |
| BoardCards heal | `BoardCards`, sometimes Card point-read truth | Repair-only backfill | Medium if promoted into routine hot path; acceptable for groom/heal |
| Legacy CardListIndex `all_cards` | `CardListIndex` | Already retired when BoardCards is bound | Low if it stays retired |

## Hot Card Path

The card writer still writes the fat `Card` record first, then updates legacy
`CardListIndex` only when that rollup has not been retired, then states
membership:

- `src/record.ts:3815` creates `Card`, patches `CardListIndex`, and writes
  membership.
- `src/record.ts:3852` updates `Card`, patches `CardListIndex`, and writes
  membership.
- `src/record.ts:3842` defines `writeCardMembership`.

Current membership behavior is already partially protein-primary:

- `src/record.ts:3830` documents the intended protein-primary multi-key path.
- `src/record.ts:3848` writes `BoardCards` with the thin payload.
- `src/record.ts:3849` retires obsolete `MilestoneCards` tips only.
- `src/milestone-cards.ts:153` states that hot-path MilestoneCards behavior is
  delete-only retirement; full MilestoneCards payload writes are reserved for
  heal/backfill.

Classification:

- `Card` plus `BoardCards` is still an app-level payload multi-write for one
  card product change. It is the primary migration candidate.
- `MilestoneCards` is already in the desired hot-path direction: Mini can fold
  shared fields from `BoardCards`, while the app deletes superseded keys.
- `CardListIndex` is not a live payload multi-write once BoardCards supersedes
  it. `src/card-list-index.ts:239` exits early when `cardListIndexIsSuperseded`
  is true.

Double-write risk:

- The main risk is stacking a future fold from `Card` to `BoardCards` while
  leaving `upsertBoardCard` active on `createCardRecord` / `updateCardRecord`.
  That would write the same thin BoardCards payload both from fkanban and from
  LastDB fold.
- Migration must choose one payload owner. After fold coverage is proven,
  fkanban should stop app-writing BoardCards payloads and retain only key
  cleanup that cannot be produced by the fold.

## BoardCards

`src/board-cards.ts:675` is the app payload writer for `BoardCards`. It writes
the destination row before retiring superseded rows, using the destination
board as hash key and `column#position#slug` as range key.

Classification:

- Protein candidate for shared Card/BoardCards fields.
- Keep BoardCards as a distinct multi-key view keyed by board. Do not collapse
  it into Card, and do not rewrite its hash field to another lookup key.

Follow-up migration:

- `fkanban-protein-primary-card-boardcards-shared-fields` should retire the
  full app payload write only after fold/backfill proof exists.

## MilestoneCards

The hot path no longer full-writes MilestoneCards. `src/milestone-cards.ts:163`
deletes stale membership tips after BoardCards has been written. The repair
path remains full dual-write:

- `src/milestone-cards.ts:226` is `upsertMilestoneCard`, explicitly documented
  as heal / one-shot backfill.
- `src/commands/milestone_indexes_heal.ts:112` rebuilds reverse indexes from
  fat Milestone rows and card truth.
- `src/commands/milestone_indexes_heal.ts:220` applies MilestoneCards repairs
  through milestone reconcile.

Classification:

- Already protein-primary on the card mutation hot path.
- Repair-only full writes are valid foreground reindex operators until Mini owns
  a first-class resumable reindex worker.

Double-write risk:

- Do not call `upsertMilestoneCard` from `writeCardMembership`.
- Do not add a routine that runs unbounded MilestoneCards repair on every card
  mutation; keep repair budgeted and explicit.

Follow-up migration:

- `fkanban-boardcards-milestonecards-no-double-write` should prove the hot path
  stays fold-only for MilestoneCards and that repair commands remain bounded.

## Milestones and BoardMilestones

Milestone mutation is the second clear payload multi-write:

- `src/record.ts:3573` upserts the fat `Milestone`.
- `src/record.ts:3585` upserts `BoardMilestones`.
- `src/board-milestones.ts:131` writes `BoardMilestones` and then retires
  superseded keyed rows.

Classification:

- Protein candidate for shared Milestone/BoardMilestones fields.
- Same-product multi-key shape: keep `Milestone` keyed by slug and
  `BoardMilestones` keyed by board/state-position-slug.

Double-write risk:

- A Milestone to BoardMilestones fold must disable the app full payload write
  in `upsertMilestoneRecord`; otherwise every milestone state change writes the
  same BoardMilestones payload twice.

Follow-up migration:

- `fkanban-protein-primary-milestone-boardmilestones` should move shared
  Milestone/BoardMilestones payload fields to protein-primary ownership with
  a separate BoardMilestones key backfill.

## Board Rollup

Board writes use a bounded `all_boards` rollup:

- `src/commands/board.ts` writes/deletes fat `Board` records.
- `src/card-list-index.ts:311` patches `all_boards` with CAS and retries.

Classification:

- Different product shape. This is not the Card/BoardCards/MilestoneCards
  payload-dual migration.
- Keep it out of the protein-primary milestone unless a later card targets
  board-list indexing directly.

## Repair and Heal Paths

Repair paths intentionally rebuild projections from source-of-truth records:

- `src/commands/board_cards_heal.ts` repairs BoardCards from Card truth.
- `src/commands/milestone_indexes_heal.ts:112` repairs BoardMilestones and
  MilestoneCards from fat Milestones and card truth.
- `scripts/backfill-board-cards.ts` is a one-shot BoardCards backfill helper.

Classification:

- Repair-only backfill / reindex operators, not hot-path app writes.
- Keep them available until Mini provides the equivalent background reindex.
- They must remain explicit, bounded where possible, and must not become part
  of ordinary card or milestone mutation.

## Short Scan of Other EdgeVector Apps

Scoped search used:

```bash
rg -n "BoardCards|MilestoneCards|BoardMilestones|board_cards|milestone_cards|board_milestones|schemaHashes|createRecord|updateRecord|deleteRecord" \
  /Users/tomtang/code/edgevector/lastgit \
  /Users/tomtang/code/edgevector/last-stack \
  /Users/tomtang/code/edgevector/brain \
  /Users/tomtang/code/edgevector/situations \
  /Users/tomtang/code/edgevector/routines \
  /Users/tomtang/code/edgevector/fold \
  --glob '!**/node_modules/**' --glob '!**/vendor/**' --glob '!**/.git/**'
```

Only `lastgit` was a concrete checkout among those paths during this inventory.
The others were portals, so the scan observed no source files there.

LastGit has a multi-schema admin status publisher:

- `/Users/tomtang/code/edgevector/lastgit/src/publish-status.ts:21` declares
  three status schema keys: snapshot, repo, and ciRed.
- `/Users/tomtang/code/edgevector/lastgit/src/publish-status.ts:295` declares
  schemas, then writes the snapshot, repo rows, and recent CI red rows.

Classification:

- Different product shape. It writes separate admin reporting entities, not
  multiple keyed views of one product record.
- No BoardCards/MilestoneCards-style app+fold double-write risk was found in
  the short scan.

## Follow-Up Migration Slugs

This inventory unblocks these existing milestone children:

- `fkanban-align-boardcards-milestonecards-field-identity`: align shared field
  identity before payload ownership changes.
- `fkanban-boardcards-milestonecards-no-double-write`: keep MilestoneCards
  fold-only on the hot card path and repair-only elsewhere.
- `fkanban-heal-protein-aware-no-full-multi-write`: make heals explicit about
  protein ownership and avoid accidental full multi-schema payload upserts.
- `fkanban-protein-primary-card-boardcards-shared-fields`: retire app payload
  writes from Card to BoardCards after fold/backfill proof.
- `fkanban-protein-primary-milestone-boardmilestones`: retire app payload writes
  from Milestone to BoardMilestones after fold/backfill proof.
- `fkanban-ban-multi-schema-payload-write-regression`: add CI guards once the
  migrations above land.

## Non-Goals

- Do not delete BoardCards, MilestoneCards, or BoardMilestones. They are valid
  keyed views.
- Do not rewrite key layouts in place.
- Do not treat field mappers as key backfill. Keyed tips still need a reindex
  or a proven fold/backfill path.
- Do not move repair-only full writes into the mutation hot path.
