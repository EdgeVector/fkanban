import { FkanbanError } from "./client.ts";
import {
  isWorkingColumn,
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

export function inferSituationPreflightAction(card: Card): string | null {
  const repo = resolvePickupRepo(card);
  if (!repo.ok) return null;
  if (repo.repo === "EdgeVector/fold" && textMentionsFoldDbNodeWork(card)) {
    return "file-fold-db-node-feature-card";
  }
  return null;
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
  const action = inferSituationPreflightAction(card);
  if (!action) {
    return { allowed: true, reason: "no Situation preflight action inferred", suggestion: "", details: [] };
  }
  const repo = resolvePickupRepo(card);
  if (!repo.ok) {
    return { allowed: true, reason: "repo unresolved before Situation preflight", suggestion: "", details: [] };
  }

  try {
    const allowListed = await preflight({ action: `work-cards:${card.slug}`, repo: repo.repo });
    if (allowListed.ok) {
      return { allowed: true, reason: "card allow-listed by active Situation", suggestion: "", details: [] };
    }

    const result = await preflight({ action, repo: repo.repo });
    if (result.ok || situationAllowsNorthStar(result, card) || situationAllowsCardAction(result, card)) {
      return { allowed: true, reason: "Situation preflight allowed card", suggestion: "", details: [] };
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
  } catch (err) {
    return {
      allowed: false,
      reason: "fsituations preflight failed",
      suggestion: "Fix fsituations preflight before moving this card into doing.",
      details: [err instanceof Error ? err.message : String(err)],
      action,
    };
  }
}

export async function assertSituationPreflightAllowed(
  card: Card,
  preflight?: SituationPreflight,
): Promise<void> {
  if (card.column !== "doing" || !isWorkingColumn(card.column)) return;
  const result = await checkSituationFence(card, preflight);
  if (result.allowed) return;
  throw new FkanbanError({
    code: "situation_fenced",
    message: `Card "${card.slug}" cannot move to doing: ${result.reason}.`,
    hint: result.details.length > 0 ? result.details.join("; ") : result.suggestion,
  });
}
