---
name: fkanban-agent
description: |
  Drive a single fkanban card all the way to a MERGED PR — a card only reaches
  `done` when its code is actually in the repo. Two entry modes: WORK (you were
  pointed at one card slug — implement it, open a PR, enable auto-merge, move the
  card to `review`, then EXIT) and RECONCILE (a scheduled sweep woke you — check
  every in-flight card, nudge stuck PRs, and move merged ones to `done`).
  Triggered when the user or a wake prompt says "follow the fkanban-agent skill",
  names an fkanban card to work, or says "reconcile the fkanban board".
---

# fkanban — agent handbook

fkanban is a kanban over [fold_db](https://folddb.com) (CLI + MCP). It does not
spawn agents and has no built-in PR watcher, so finished cards never reach
`done` on their own. This skill closes that gap: an agent owns a card through
merge, but **without becoming a long-lived process**. It uses an
*exit-and-rewatch* model — do a unit of work, then exit; a scheduled routine
re-enters this skill to make progress on the next wake. A card reaches `done`
only when its PR is verified merged.

> Why not stay resident until merge? Long-lived agents that wait inside a single
> invocation tend to wedge and leak resources. Every invocation of this skill
> must terminate in bounded time. Waiting happens *between* invocations, not
> inside one.

Run board writes via the CLI (`fkanban …` if you ran `bun link`, else
`bun src/cli.ts …` from your checkout).

## Columns

`backlog → todo → doing → review → done`

| Column | Meaning |
|---|---|
| `backlog` / `todo` | not yet picked up |
| `doing` | an agent is implementing; PR not open yet |
| `review` | PR is open with auto-merge enabled — waiting on CI / human / merge |
| `done` | PR is **merged** (terminal; set only after verifying merge) |

## The card brief (read it as your spec)

The card body is the specification. By convention it carries a header that tells
you **where** to work (there is no `repo` field on the schema):

```
Repo: owner/name               # GitHub owner/name, or an absolute local path
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

If `Repo:`/`Base:` are missing or ambiguous, **do not guess** — move the card to
`review`, append a one-line note explaining what's missing, and exit.

## Which mode am I in?

- You were given (or your cwd implies) **one specific card** → **WORK MODE**.
- You were woken to "reconcile" / sweep the board → **RECONCILE MODE**.

---

## WORK MODE — implement one card, open the PR, exit

1. **Claim it.** `fkanban show <slug> --json`. If it's already in `review`/`done`,
   stop — someone landed it. Otherwise `fkanban move <slug> doing`.
2. **Set up an isolated worktree** (never edit a shared checkout in place, and
   never `stash`/`reset` — other agents may share these repos):
   ```bash
   cd <target-repo-root>
   git fetch origin <base>
   git worktree add ~/.fkanban/worktrees/<slug> -b fkanban/<slug> origin/<base>
   cd ~/.fkanban/worktrees/<slug>
   ```
3. **Do the work** described in the brief. Match the repo's `CLAUDE.md` and
   existing style. Honor OUT OF SCOPE — keep the PR atomic.
4. **Verify locally** — run the brief's exact VERIFY commands. Green tests are
   not sufficient if the brief says to run the app — do that too.
5. **Land it:**
   ```bash
   git commit -am "<msg>"
   git push -u origin HEAD
   gh -R <repo> pr create --fill --base <base>
   gh -R <repo> pr merge <n> --auto --squash   # see "Merge strategy" below
   ```
6. **Hand off:** `fkanban move <slug> review` and **exit cleanly**. Do **not**
   move it to `done` — merge isn't verified yet; the reconcile pass owns that.
   The branch is `fkanban/<slug>`, so the reconciler finds the PR by head branch.

If you hit a genuine blocker (ambiguous spec, needs a human decision, depends on
unmerged work): leave the branch clean, move the card to `review`, append a short
`BLOCKED: <why>` note to the body, and exit. Don't spin.

---

## RECONCILE MODE — sweep in-flight cards, advance or fix, then exit

Run once per wake, then exit. Sweep **every card not already in `done`** — not
just `doing`/`review` (a card can be merged while still sitting in `todo` if a
human did the work, so don't restrict by column). Skip a card only if it has no
`Repo:` header. For each candidate:

1. **Find its PR.** Prefer an explicit `PR:` line / URL in the body (work landed
   outside WORK mode won't use the `fkanban/<slug>` branch). Fall back to the
   head-branch lookup when no URL is present:
   ```bash
   gh -R <repo> pr view <n> --json number,state,mergedAt,mergeStateStatus,reviewDecision,statusCheckRollup
   # or by convention branch:
   gh -R <repo> pr list --head fkanban/<slug> --state all \
     --json number,state,mergedAt,mergeStateStatus,reviewDecision,statusCheckRollup
   ```
2. **Decide from PR state:**
   - **Merged** (`state=MERGED` / `mergedAt` set) → `fkanban move <slug> done`.
   - **No PR found** and card is in `doing` → the worker hasn't opened one yet
     (or died mid-work). If a `fkanban/<slug>` branch exists with commits, finish
     WORK MODE step 5 for it; else leave it for a worker. Don't thrash.
   - **CI red** (`statusCheckRollup` failing) → enter the worktree, read the
     failing job logs (`gh run view --log-failed`), fix, re-run VERIFY, push.
   - **Behind base / conflicts** (`mergeStateStatus` = BEHIND/DIRTY) →
     `git fetch origin <base>`, rebase onto `origin/<base>`, resolve, re-verify,
     force-push with lease.
   - **Changes requested** (`reviewDecision=CHANGES_REQUESTED`) → read the review
     comments, address them, push, reply briefly. (This loop just happens across
     wakes.)
   - **Clean + approved but not merging** → re-assert auto-merge
     (`gh pr merge <n> --auto …`); if a required check is stuck, surface it, don't
     force-merge.
   - **Pending** (CI running, awaiting review) → leave it; re-checked next wake.
3. **Give-up guard:** if a card has been in `review` with no forward progress for
   a long time (or hits a human-only blocker), append `STALLED: <why>` to the
   body and leave it in `review` for a human — never silently loop forever and
   never auto-merge around a failing gate.

Always fix inside `~/.fkanban/worktrees/<slug>` on branch `fkanban/<slug>`. Reuse
the existing worktree if present; create it (WORK MODE step 2) if not.

## Merge strategy

- Most repos (no merge queue) → **`gh pr merge <n> --auto --squash`** (the
  strategy flag is required).
- A merge-queue repo → bare **`gh pr merge <n> --auto`** (NO `--squash`); it
  reports `autoMergeRequest: null` and `isInMergeQueue: true` — that's normal,
  not a dropped auto-merge.

When unsure, check the repo's `CLAUDE.md`/README before picking a flag.

## Guardrails

- **Don't edit a shared checkout in place** — use `git worktree add`; never
  `stash`/`reset`/`clean` a repo other agents may share.
- **Don't wait inside an invocation.** Waiting is the gap *between* invocations
  (the routine's schedule), not a watch loop inside one.
- Keep PRs atomic; honor OUT OF SCOPE; don't spawn sibling agents — if work
  splits, describe the split and let a human add cards.

## The watcher that re-enters this skill

RECONCILE MODE is meant to be driven by a **scheduled routine** that simply runs
this skill and exits each fire (inline worktree → fix → push → exit; no spawned
agents). Wire or adjust it with the `schedule` skill; a cadence of ~10–20 min is
plenty (CI and human review move on that scale).
