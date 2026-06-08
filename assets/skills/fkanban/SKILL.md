---
name: fkanban
description: |
  Manage the fkanban board (the active EdgeVector task board, a kanban over
  fold_db). File, list, show, move, groom, and soft-delete cards via the
  fkanban CLI. Use when the user wants to "file an fkanban task/card", "add to
  the fkanban board", "what's on the fkanban board", "fkanban backlog", "list
  fkanban tasks", "move a card", "show card <slug>", "groom the board", or just
  says "fkanban" / "add a task" in an EdgeVector context. This is the board-CRUD
  counterpart to the fkanban-agent skill (which drives one card to a merged PR);
  use fkanban-agent — not this — to actually implement a card. Do NOT use the
  deprecated Cline `kanban` skill / :3484 board for EdgeVector work.
---

# fkanban — board management

fkanban is the **active** EdgeVector task board: a kanban stored in fold_db.
It superseded the Cline `kanban` board (`:3484`) — don't file EdgeVector work
there anymore.

- **Location / how to run:** `~/code/edgevector/fkanban`, invoked as
  `bun run src/cli.ts <command>`. There is no global `fkanban` binary on PATH
  and the repo isn't git-init'd yet, so run it from inside that directory.
  (If a global `fkanban` shim appears later, prefer it.)
- **Where the data lives:** the board records live on the **port-9001 brain**
  (node `http://127.0.0.1:9001`, schema_service prod us-east-1). The CLI talks
  to the node over **HTTP**, so it's fast and does *not* hit the Sled
  identity-lock stall that the `folddb` CLI has.
- **Columns:** `backlog → todo → doing → review → done`.

Before doing anything non-trivial, sanity-check the setup:

```bash
cd ~/code/edgevector/fkanban
bun run src/cli.ts doctor      # config present, node reachable, schemas loaded
```

## Commands

Run all of these from `~/code/edgevector/fkanban`:

```bash
bun run src/cli.ts list --json                 # whole default board
bun run src/cli.ts list --board <b> --column todo   # filter
bun run src/cli.ts show <slug> --json          # one card in detail
bun run src/cli.ts add <slug> [flags]          # create OR update a card
bun run src/cli.ts move <slug> <column> [--position N]
bun run src/cli.ts rm <slug>                   # soft-delete
bun run src/cli.ts board create <slug> --title ... --columns a,b,c
bun run src/cli.ts board list
```

`add` flags: `--title --board --column --assignee --tags --body`. Re-running
`add` with the same slug **updates** the card (upsert), so it's safe to edit a
card by re-adding it. Default column for a fresh card is `backlog`; for a task
you want worked soon, pass `--column todo`.

### ⚠️ Filing a card with a real body — write the body to a file first

The card body is usually a multi-paragraph spec. **Do not** inline it with a
nested heredoc (`--body "$(cat <<'EOF' ... EOF)"`) — that mangles and can
silently produce an empty card, especially if the command is backgrounded.
Instead write the body to a temp file and read it back, in the **foreground**:

```bash
# 1. write the spec
cat > /tmp/card-body.md <<'EOF'
...full markdown body...
EOF
# 2. file the card (foreground, so you SEE the confirmation/error)
cd ~/code/edgevector/fkanban
bun run src/cli.ts add my-slug \
  --title "Short imperative title" \
  --column todo --tags "fold,cli,perf" \
  --body "$(cat /tmp/card-body.md)"
# 3. verify it landed
bun run src/cli.ts show my-slug | head -8
```

`add` also reads the body from **stdin**, which sidesteps quoting entirely:

```bash
bun run src/cli.ts add my-slug --title "..." --column todo < /tmp/card-body.md
```

Always confirm with `show <slug>` after writing — the `add` is only successful
if the card actually reads back.

## The card brief is the spec — and must trigger the agent

A card that's meant to be implemented should carry, in its `--body`:

1. **A header so the agent picks it up and drives it to merge** (fkanban does
   not auto-spawn agents and finished cards don't reach `done` on their own):

   > **Follow the fkanban-agent skill — drive this through to a MERGED PR.
   > A card is only `done` when its code is actually in the repo.**

2. **A work header telling the agent where to work** (there is no `repo` field
   on the schema, so it goes in the body):

   ```
   Repo: EdgeVector/fold      # owner/name or absolute local path
   Base: main                 # base branch
   Branch: fkanban/<slug>     # optional; defaults to fkanban/<slug>
   ```

3. **The spec itself:** GOAL / CONTEXT / STEPS / VERIFY (exact commands that
   must pass) / DONE WHEN (PR merged into <base>) / OUT OF SCOPE.

Verify the facts you put in a brief against `origin/main` before filing —
local checkouts lag, so `git fetch` and read `origin/<base>:<file>` rather
than describing stale "current state".

## Grooming / triage

- "What's on the board" → `list --json`, then summarize by column.
- "What's stuck" → look for cards long in `review` (PR open, not merged) or
  `doing` (claimed, no PR). Surface them; don't silently re-drive — that's the
  fkanban-agent reconcile pass's job.
- Superseded / wrong card → `rm <slug>` (soft delete), or re-`add` to fix it.
- A card in `done` means its PR **merged** — that's the normal terminal state,
  not a kill.

## Guardrails (EdgeVector standing rules)

- **Never kill the port-9001 brain** or any folddb_server you didn't start —
  the board lives on it. If `doctor` says the node is unreachable, surface it;
  don't restart things blindly.
- **Dev, not prod** for any work a card describes that touches a prod surface
  or an in-flight design — note that in the brief.
- This skill only **manages** the board. To actually implement a card, hand off
  to the **fkanban-agent** skill (or tell the user it's ready to be worked).
```
