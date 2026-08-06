import { FkanbanError } from "./client.ts";
import {
  isBodyOmitted,
  parseBodyHeader,
  resolvePickupRepo,
  type Card,
} from "./record.ts";

export type SituationPreflightResponse = {
  ok: boolean;
  checked?: { action?: string; repo?: string };
  blocks?: Array<{
    situation?: {
      slug?: string;
      links_brain?: string[];
      allowed_actions?: string[];
    };
    action?: string;
    message?: string;
  }>;
};

export type SituationPreflight = (opts: {
  action: string;
  repo: string;
}) => Promise<SituationPreflightResponse>;

export type SituationFenceResult = {
  allowed: boolean;
  reason: string;
  suggestion: string;
  details: string[];
  situationSlug?: string;
  action?: string;
};

function textMentionsFoldDbNodeWork(card: Card): boolean {
  const haystack = [
    card.title,
    card.body,
    card.tags.join(" "),
    card.surfaces.join(" "),
  ].join("\n").toLowerCase();
  return [
    "fold_db_node",
    "subsystem-fold_db_node",
    "lastdb_node",
    "lastdb_host",
    "lastdb_uds",
    "fold_db core",
    "fold_db-core-transform",
    "folddb ",
    "/api/",
  ].some((needle) => haystack.includes(needle));
}

/**
 * The one repo this fence has actions for.
 *
 * Named once because {@link inferSituationPreflightActions} and
 * {@link situationFenceNeedsBody} must agree on which cards the fence can act
 * on: the second exists to fetch the evidence the first needs, so a second copy
 * of this string would let the fetch and the decision disagree about scope —
 * and the fetch failing silently looks exactly like "no action inferred", which
 * is the failure this whole area already had once.
 */
const FENCED_REPO = "EdgeVector/fold";

export function inferSituationPreflightActions(card: Card): string[] {
  const repo = resolvePickupRepo(card);
  if (!repo.ok) return [];
  if (repo.repo === FENCED_REPO && textMentionsFoldDbNodeWork(card)) {
    return ["file-fold-db-node-feature-card", "modify-fold-db-node"];
  }
  return [];
}

/**
 * Could reading this card's body change the fence's verdict?
 *
 * ## Why the fence needs to ask this at all
 *
 * `textMentionsFoldDbNodeWork` matches over title + body + tags + surfaces.
 * Three of those four ride the thin BoardCards projection; `body` does not.
 * `pickup status` classifies from that thin projection and hydrates only the
 * cards `pickupClassificationNeedsBody` selects — a predicate about ROUTING that
 * knows nothing about this fence. So a card whose only fold_db_node evidence is
 * body prose reached `checkSituationFence` with `body: ""`, inferred no action,
 * and was waived as pickup-ready.
 *
 * That is not a corner: real cards say `/api/` and `lastdb_node` in their briefs
 * and carry no `fold_db_node` tag at all. Measured on the live primary
 * 2026-08-04 (`scripts/probe-situation-fence-liveness.ts`), of the 6 active
 * `EdgeVector/fold` cards whose full record infers a fence action, **6 of 6**
 * were waived by the body-free record — a 100% false-waive rate against the
 * fence's entire in-scope population, and zero preflight subprocesses ever
 * started (`scripts/probe-pickup-fence-spawn-fanout.ts`).
 *
 * ## Why the selection is safe to make from the thin record
 *
 * Repo is a STRUCTURED field, so `resolvePickupRepo` answers correctly without a
 * body for any card that carries one — and a fold card that names its repo only
 * in body prose is already `malformed-routing`, never `pickup-ready`, so it does
 * not reach the fence. That keeps the fetch bounded by the fold cards in the
 * ready set (3 of 16 on the live board) rather than by the board.
 *
 * Ordered cheapest-first: a card that already infers an action needs no body,
 * and a card whose body is in hand has nothing to fetch.
 */
export function situationFenceNeedsBody(card: Card): boolean {
  if (!isBodyOmitted(card)) return false;
  if (inferSituationPreflightActions(card).length > 0) return false;
  const repo = resolvePickupRepo(card);
  return repo.ok && repo.repo === FENCED_REPO;
}

function situationSlug(result: SituationPreflightResponse): string {
  return result.blocks?.find((block) => block.situation?.slug)?.situation?.slug ?? "unknown-situation";
}

function situationAllowsNorthStar(result: SituationPreflightResponse, card: Card): boolean {
  const northStar = (card.north_star.trim() || parseBodyHeader(card.body, "North Star")).trim();
  if (!northStar) return false;
  return result.blocks?.some((block) => block.situation?.links_brain?.includes(northStar)) ?? false;
}

function situationAllowsCardAction(result: SituationPreflightResponse, card: Card): boolean {
  const needle = `work-cards:${card.slug}`;
  return result.blocks?.some((block) =>
    block.situation?.allowed_actions?.some((action) =>
      action === needle ||
      (action.startsWith("work-cards:") &&
        action.slice("work-cards:".length).split(",").map((slug) => slug.trim()).includes(card.slug))
    )
  ) ?? false;
}

function commandCandidates(): string[][] {
  const args = ["preflight"];
  const explicit = process.env.FKANBAN_FSITUATIONS_BIN;
  const out: string[][] = explicit ? [[explicit, ...args]] : [["fsituations", ...args]];
  const checkout = process.env.FKANBAN_FSITUATIONS_CHECKOUT ?? "/Users/tomtang/code/edgevector/fsituations";
  out.push(["bun", "--cwd", checkout, "src/cli.ts", ...args]);
  return out;
}

async function runJsonCommand(argv: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([...argv, "--json"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

export async function fsituationsPreflight(opts: { action: string; repo: string }): Promise<SituationPreflightResponse> {
  const suffix = ["--action", opts.action, "--repo", opts.repo];
  const errors: string[] = [];
  for (const base of commandCandidates()) {
    try {
      const { code, stdout, stderr } = await runJsonCommand([...base, ...suffix]);
      if (code !== 0 && code !== 3) {
        errors.push(`${base[0]} exited ${code}: ${stderr.trim() || stdout.trim()}`);
        continue;
      }
      return JSON.parse(stdout) as SituationPreflightResponse;
    } catch (err) {
      errors.push(`${base[0]} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  throw new Error(errors.join("; "));
}

export async function checkSituationFence(
  card: Card,
  preflight: SituationPreflight = fsituationsPreflight,
): Promise<SituationFenceResult> {
  const actions = inferSituationPreflightActions(card);
  if (actions.length === 0) {
    return { allowed: true, reason: "no Situation preflight action inferred", suggestion: "", details: [] };
  }
  const repo = resolvePickupRepo(card);
  if (!repo.ok) {
    return { allowed: true, reason: "repo unresolved before Situation preflight", suggestion: "", details: [] };
  }

  try {
    for (const action of actions) {
      const result = await preflight({ action, repo: repo.repo });
      if (result.ok || situationAllowsNorthStar(result, card) || situationAllowsCardAction(result, card)) {
        continue;
      }

      const slug = situationSlug(result);
      return {
        allowed: false,
        reason: `blocked by active Situation ${slug}`,
        suggestion: "Do not pick up this card until the Situation allows it or the card is re-scoped.",
        details: [`fsituations preflight ${action} --repo ${repo.repo} returned BLOCKED`, `action: ${action}`],
        situationSlug: slug,
        action,
      };
    }

    return { allowed: true, reason: "Situation preflight allowed card", suggestion: "", details: [] };
  } catch (err) {
    return {
      allowed: false,
      reason: "fsituations preflight failed",
      suggestion: "Fix fsituations preflight before moving this card into doing.",
      details: [err instanceof Error ? err.message : String(err)],
      action: actions.join(","),
    };
  }
}

export async function assertSituationPreflightAllowed(
  card: Card,
  preflight?: SituationPreflight,
): Promise<void> {
  // `doing` ONLY, and deliberately so. The fence asks "may this card be picked
  // up while a Situation is active" — `checkSituationFence`'s own refusal reads
  // "do not pick up this card until the Situation allows it" — so it belongs on
  // entering work, not on finishing it. Fencing a move to `done` would strand
  // work an agent had already completed behind an unrelated incident.
  //
  // This used to read `card.column !== "doing" || !isWorkingColumn(card.column)`.
  // `WORKING_COLUMNS` is `["doing", "done"]`, so the second test could never be
  // true once the first had passed: dead, and it advertised a gate over both
  // working columns that the first test had already narrowed to one.
  if (card.column !== "doing") return;
  const result = await checkSituationFence(card, preflight);
  if (result.allowed) return;
  throw new FkanbanError({
    code: "situation_fenced",
    message: `Card "${card.slug}" cannot move to doing: ${result.reason}.`,
    hint: result.details.length > 0 ? result.details.join("; ") : result.suggestion,
  });
}
