// `fkanban set <slug>` — metadata-only update for an EXISTING card.
//
// Structurally cannot touch `body`. Grooming / NS-MS backfill scripts that only
// need north_star, milestone, tags, priority, etc. must use this verb (or an
// equivalent path that never sources body from argv/stdin) so a whole-body
// replace can never destroy a real GOAL/END STATE brief as a side effect of a
// metadata stamp.
//
// Contrast with `fkanban add`, which still accepts `--body` / piped stdin and
// replaces the brief when either is present. `add` keeps the destructive
// replace path on purpose (authoring, recovery); `set` removes the entire
// class of accidental clobber for maintenance loops.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { requireCard, type PriorityTier } from "../record.ts";
import { addCmd, type AddResult } from "./add.ts";

export type SetOptions = {
  cfg: Config;
  node: NodeClient;
  slug: string;
  title?: string;
  assignee?: string;
  tags?: string[];
  priority?: PriorityTier;
  repo?: string;
  base?: string;
  kind?: string;
  blockStatus?: string;
  blockReason?: string;
  northStar?: string;
  milestone?: string;
  prUrl?: string;
  branch?: string;
  surfaces?: string[];
  /** Explicit operator override for lane/dependency guards (forwarded to add). */
  force?: boolean;
  dbLocator?: string;
};

function hasAnyField(opts: SetOptions): boolean {
  return (
    opts.title !== undefined ||
    opts.assignee !== undefined ||
    opts.tags !== undefined ||
    opts.priority !== undefined ||
    opts.repo !== undefined ||
    opts.base !== undefined ||
    opts.kind !== undefined ||
    opts.blockStatus !== undefined ||
    opts.blockReason !== undefined ||
    opts.northStar !== undefined ||
    opts.milestone !== undefined ||
    opts.prUrl !== undefined ||
    opts.branch !== undefined ||
    opts.surfaces !== undefined ||
    opts.dbLocator !== undefined
  );
}

/**
 * Update structured / display fields on an existing card without ever writing
 * `body`. Requires the card to already exist (no create path).
 */
export async function setCmd(opts: SetOptions): Promise<AddResult> {
  if (!hasAnyField(opts)) {
    throw new FkanbanError({
      code: "set_no_fields",
      message: `\`set\` needs at least one field to update on "${opts.slug}".`,
      hint:
        "Pass one or more of: --title --assignee --tags --priority --repo --base --kind " +
        "--block-status --block-reason --north-star --milestone --pr-url --branch --surfaces. " +
        "To rewrite the brief, use `fkanban add --body` (or pipe a body). " +
        "To append one line, use `fkanban mark`.",
    });
  }

  // Point-get: refuse create. Metadata-only backfills must not invent shells.
  await requireCard(opts.node, opts.cfg, opts.slug);

  // Deliberately omit `body` so addCmd preserves the existing brief byte-for-byte
  // (aside from stamp-side effects that do not rewrite body when body is omitted).
  return addCmd({
    cfg: opts.cfg,
    node: opts.node,
    slug: opts.slug,
    title: opts.title,
    assignee: opts.assignee,
    tags: opts.tags,
    priority: opts.priority,
    repo: opts.repo,
    base: opts.base,
    kind: opts.kind,
    blockStatus: opts.blockStatus,
    blockReason: opts.blockReason,
    northStar: opts.northStar,
    milestone: opts.milestone,
    prUrl: opts.prUrl,
    branch: opts.branch,
    surfaces: opts.surfaces,
    force: opts.force,
    dbLocator: opts.dbLocator,
    // body: intentionally never set
  });
}
