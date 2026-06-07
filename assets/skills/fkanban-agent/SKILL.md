---
name: fkanban-agent
description: |
  Drive a single fkanban card all the way to a MERGED PR — a card only
  reaches `done` when its code is actually in the repo. Two entry modes:
  WORK (you were pointed at one card slug — implement it, open a PR, enable
  auto-merge, move the card to `review`, then EXIT) and RECONCILE (the
  self-managed fkanban-watch routine woke you — sweep every in-flight card,
  nudge stuck PRs, and move merged ones to `done`). Triggered when the user
  or a spawn/wake prompt says "follow the fkanban-agent skill", names an
  fkanban card to work, or says "reconcile the fkanban board".
---

# fkanban — agent handbook

fkanban is a kanban over fold_db (CLI + MCP, `bun run src/cli.ts` in
`~/code/edgevector/fkanban`, board on the port-9001 brain). Unlike the Cline
kanban it does **not** spawn agents and has **no PR watcher** — that gap is
exactly why finished cards never reached `done`. This skill closes it: the
agent owns a card through merge, but **without becoming a long-lived process**.
It uses the *exit-and-rewatch* model — do a unit of work, then exit; a
self-managed routine re-enters this skill to make progress on the next wake.
A card reaches `done` only when its PR is verified merged.

> Why not stay resident until merge? EdgeVector already got burned by agents
> that wedge instead of exiting (2026-06-07: 124 agents / 19 GB swap). Every
> invocation of this skill must terminate in bounded time. Waiting happens
> *between* invocations, not inside one.

## Columns

`backlog → todo → doing → review → done`

| Column | Meaning |
|---|---|
| `backlog` / `todo` | not yet picked up |
| `doing` | an agent is implementing; PR not open yet |
| `review` | PR is open with auto-merge enabled — waiting on CI / human / merge |
| `done` | PR is **merged** (terminal; set only after verifying merge) |

Use the CLI for all board writes (run from `~/code/edgevector/fkanban`):

```bash
bun run src/cli.ts show <slug> --json        # read a card
bun run src/cli.ts move <slug> doing         # column transition
bun run src/cli.ts list --json               # whole board
```

(If a global `fkanban` shim exists, use it; otherwise `bun run src/cli.ts`.)

## The card brief (read it as your spec)

The card body is the specification. By convention it carries a header that
tells you **where** to work (there is no `repo` field on the schema):

```
Repo: EdgeVector/fold          # owner/name, or an absolute local path
Base: main                     # base branch to target
Branch: fkanban/<slug>         # optional; defaults to fkanban/<slug>
PR: <url>                      # written by WORK mode once the PR is open

GOAL: ...
CONTEXT: ...
STEPS: ...
VERIFY: <exact commands that must pass>
DONE WHEN: PR merged into <base>
OUT OF SCOPE: ...
```

If `Repo:`/`Base:` are missing or ambiguous, **do not guess** — move the card
to `review`, append a one-line note explaining what's missing, and exit.

---

## Which mode am I in?

- You were given (or your cwd implies) **one specific card** → **WORK MODE**.
- You were woken to "reconcile" / sweep the board (the `fkanban-watch`
  routine) → **RECONCILE MODE**.

---

## WORK MODE — implement one card, open the PR, exit

1. **Claim it.** `bun run src/cli.ts show <slug> --json`. If it's already in
   `review`/`done`, stop — someone landed it. Otherwise move it to `doing`.
2. **Set up an isolated worktree** (never edit a shared checkout in place, and
   never `stash`/`reset` — sibling agents share these repos):
   ```bash
   cd <target-repo-root>
   git fetch origin <base>
   git worktree add ~/.fkanban/worktrees/<slug> -b fkanban/<slug> origin/<base>
   cd ~/.fkanban/worktrees/<slug>
   ```
3. **Do the work** described in the brief. Match the repo's `CLAUDE.md` and
   existing style. Honor OUT OF SCOPE — keep the PR atomic.
4. **Verify locally** — run the brief's exact VERIFY commands (e.g.
   `cargo check --workspace && cargo test --workspace`). Green tests are not
   sufficient if the brief says to run the app — do that too.
5. **Land it:**
   ```bash
   git commit -am "<msg>"
   git push -u origin HEAD
   gh -R <repo> pr create --fill --base <base>
   gh -R <repo> pr merge <n> --auto --squash   # see "Merge strategy" below
   ```
6. **Hand off:** move the card to `review` and **exit cleanly**. Do **not**
   move it to `done` — merge isn't verified yet; the reconcile pass owns that.
   The branch is `fkanban/<slug>`, so the reconciler finds the PR by head
   branch — you don't need to write the PR URL onto the card.

If you hit a genuine blocker (ambiguous spec, needs a human decision, depends
on unmerged work): leave the branch clean, move the card to `review`, append a
short `BLOCKED: <why>` note to the body, and exit. Don't spin.

---

## RECONCILE MODE — sweep in-flight cards, advance or fix, then exit

Run once per wake, then exit. Sweep **every card not already in `done`** — not
just `doing`/`review`. (A card can be merged while still sitting in `todo` if a
human or another flow did the work; the dogfood found exactly this — a merged
PR whose card never advanced. That's the whole bug, so don't restrict by
column.) Skip a card only if it has no `Repo:` header (it isn't meant for this
flow). For each candidate:

1. **Find its PR.** Prefer an explicit `PR:` line / PR URL in the body — work
   landed outside WORK mode won't use the `fkanban/<slug>` branch convention
   (the dogfood's real PR was on `formula/upgrade-restart-caveat`). Fall back
   to the head-branch lookup only when no PR URL is present:
   ```bash
   # explicit URL in body:
   gh -R <repo> pr view <n> --json number,state,mergedAt,mergeStateStatus,reviewDecision,statusCheckRollup
   # else by convention branch:
   gh -R <repo> pr list --head fkanban/<slug> --state all \
     --json number,state,mergedAt,mergeStateStatus,reviewDecision,statusCheckRollup
   ```
2. **Decide from PR state:**
   - **Merged** (`state=MERGED` / `mergedAt` set) → `move <slug> done`. Done.
   - **No PR found** and card is in `doing` → the worker hasn't opened one yet
     (or died mid-work). If a `fkanban/<slug>` branch exists with commits,
     finish WORK MODE step 5 for it; else leave it for a worker. Don't thrash.
   - **CI red** (`statusCheckRollup` failing) → enter the worktree, read the
     failing job logs (`gh run view --log-failed`), fix, re-run VERIFY, push.
   - **Behind base / conflicts** (`mergeStateStatus` = BEHIND/DIRTY) →
     `git fetch origin <base>` then rebase onto `origin/<base>`, resolve,
     re-verify, force-push with lease.
   - **Changes requested** (`reviewDecision=CHANGES_REQUESTED`) → read the
     review comments, address them, push, reply briefly. (This is the
     "edit/repost until it's in" loop — it just happens across wakes.)
   - **Clean + approved but not merging** → re-assert auto-merge
     (`gh pr merge <n> --auto --squash`); if a required check is stuck, surface
     it, don't force-merge.
   - **Pending** (CI running, awaiting human review) → leave it; it'll be
     re-checked next wake.
3. **Give-up guard:** if a card has been in `review` with no forward progress
   for a long time (e.g. several days of wakes, or a hard human-only blocker),
   append `STALLED: <why>` to the body and leave it in `review` for a human —
   never silently loop forever and never auto-merge around a failing gate.

Always fix inside `~/.fkanban/worktrees/<slug>` on branch `fkanban/<slug>`.
Reuse the existing worktree if present; create it (WORK MODE step 2) if not.

---

## Merge strategy (per repo)

- `EdgeVector/fold`, `fbrain`, `fkanban` → **`gh pr merge <n> --auto --squash`**
  (strategy flag required; these are not merge-queue repos).
- A merge-queue repo → bare **`gh pr merge <n> --auto`** (NO `--squash`); it
  reports `autoMergeRequest: null` and `isInMergeQueue: true` — that's normal,
  not a dropped auto-merge.

When unsure, check the repo's `CLAUDE.md`/README before picking a flag.

## Guardrails (EdgeVector standing rules)

- **Dev, not prod.** If the work touches a prod-facing surface or the design is
  still in flight, do it on dev and leave the prod cutover for a human.
- **Never kill the port-9001 brain** or any folddb_server you didn't start;
  don't `stop` bare sessions; don't `clean`/`reset`/`stash` a shared repo —
  use `git worktree add`.
- **Don't use the Monitor tool** for waiting — it doesn't reach this
  environment. Waiting is the gap *between* invocations (the routine's
  schedule), not a watch inside one.
- Keep PRs atomic; honor OUT OF SCOPE; don't spawn sibling agents — if work
  splits, describe the split and let a human add cards.

## The watcher that re-enters this skill

The reconcile pass is meant to be driven by a **self-managed scheduled
routine** (`fkanban-watch`) — inline worktree→fix→push→exit on each fire, NO
kanban/spawned agents (per the post-pile-up routine convention). It simply
runs RECONCILE MODE and exits. To wire or adjust it, use the `schedule` skill;
cadence ~ every 10–20 min is plenty (CI + human review move on that scale).
