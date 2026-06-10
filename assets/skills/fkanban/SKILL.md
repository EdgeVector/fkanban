---
name: fkanban
description: |
  Manage an fkanban board — a kanban stored in your fold_db node. File, list,
  show, move, groom, and soft-delete cards via the fkanban CLI. Use when the
  user wants to "file an fkanban card", "add to the fkanban board", "what's on
  the board", "fkanban backlog", "list cards", "move a card", "show card
  <slug>", or "groom the board". This is the board-CRUD counterpart to the
  fkanban-agent skill (which drives one card to a merged PR); use fkanban-agent
  — not this — to actually implement a card.
---

# fkanban — board management

fkanban is a kanban board stored in [fold_db](https://folddb.com). The board
records live on your fold_db **node**; the CLI just talks to it over HTTP (so
it's fast and doesn't touch the node's on-disk identity lock).

- **How to run:** from your `fkanban` checkout, `bun src/cli.ts <command>`. If
  you ran `bun link`, a global `fkanban` is on PATH — prefer it (`fkanban
  <command>`). This handbook shows the global form; substitute `bun src/cli.ts`
  if you didn't link.
- **Setup:** if the CLI can't find a node or config, run the **fkanban-setup**
  skill first (`fkanban init` + `fkanban doctor`).
- **Columns:** `backlog → todo → doing → review → done`.

Before anything non-trivial, sanity-check the setup:

```bash
fkanban doctor      # config present, node reachable, schemas loaded
```

## Commands

```bash
fkanban list --json                      # whole default board
fkanban list --board <b> --column todo   # filter
fkanban show <slug> --json               # one card in detail
fkanban add <slug> [flags]               # create OR update a card
fkanban move <slug> <column> [--position N]
fkanban rm <slug>                        # soft-delete (tombstone)
fkanban board create <slug> --title ... --columns a,b,c
fkanban board list
```

`add` flags: `--title --board --column --assignee --tags --deps --body`.
Re-running `add` with the same slug **updates** the card (upsert), so it's safe
to edit a card by re-adding it. A fresh card defaults to `backlog`; for work you
want picked up soon, pass `--column todo`.

### ⚠️ Filing a card with a real body — write the body to a file first

The card body is usually a multi-paragraph spec. **Do not** inline it with a
nested heredoc (`--body "$(cat <<'EOF' ... EOF)"`) — that mangles the text and
can silently produce an empty card, especially if the command is backgrounded.
Instead write the body to a temp file and read it back, in the **foreground**:

```bash
# 1. write the spec
cat > /tmp/card-body.md <<'EOF'
...full markdown body...
EOF
# 2. file the card (foreground, so you SEE the confirmation/error)
fkanban add my-slug \
  --title "Short imperative title" \
  --column todo --tags "area,priority" \
  --body "$(cat /tmp/card-body.md)"
# 3. verify it landed
fkanban show my-slug | head -8
```

`add` also reads the body from **stdin**, which sidesteps quoting entirely:

```bash
fkanban add my-slug --title "..." --column todo < /tmp/card-body.md
```

Always confirm with `show <slug>` after writing — the `add` only succeeded if
the card reads back.

## Filing a card meant to be implemented

If a card should be driven to a merged PR by an agent, put a work header at the
top of its `--body` (there's no `repo` field on the schema, so it goes in the
body), followed by the spec:

```
Repo: owner/name          # GitHub owner/name, or an absolute local path
Base: main                # base branch
Branch: fkanban/<slug>    # optional; defaults to fkanban/<slug>

GOAL: ...
CONTEXT: ...
STEPS: ...
VERIFY: <exact commands that must pass>
DONE WHEN: PR merged into <base>
OUT OF SCOPE: ...
```

fkanban does not auto-spawn agents and finished cards don't reach `done` on
their own — implementing a card is the **fkanban-agent** skill's job. Verify the
facts in a brief against `origin/<base>` before filing (local checkouts lag —
`git fetch` and read `origin/<base>:<file>` rather than describing stale state).

## Grooming / triage

- "What's on the board" → `list --json`, then summarize by column.
- "What's stuck" → cards long in `review` (PR open, not merged) or `doing`
  (claimed, no PR). Surface them; don't silently re-drive — that's the
  fkanban-agent reconcile pass's job.
- Superseded / wrong card → `rm <slug>` (soft delete), or re-`add` to fix it.
- A card in `done` means its PR **merged** — the normal terminal state, not a kill.

## Guardrails

- This skill only **manages** the board. To implement a card, hand off to the
  **fkanban-agent** skill (or tell the user it's ready to be worked).
- Don't reset/wipe the node to "start clean" — `add`/`init` are additive and
  idempotent, and the board is the only copy of its data.
