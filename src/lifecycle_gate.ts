// Body-only terminal-move gate.
// A card opts in with Requires-Status / Requires-Deploy headers.
// A move into the terminal column passes only when a positive PROOF line
// follows the last of those headers. --force waives the gate out loud.

import { FkanbanError } from "./client.ts";
import {
  FORCE_IS_UNSCOPED,
  forcedGuardWaiverWarning,
  parseBodyListHeader,
  type Card,
} from "./record.ts";

export type LifecycleRequirements = {
  statusContexts: string[];
  deployContexts: string[];
};

function uniqueNonEmpty(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Collect opt-in gate contexts from card body headers (comma-separated). */
export function parseLifecycleRequirements(body: string): LifecycleRequirements {
  return {
    statusContexts: uniqueNonEmpty(parseBodyListHeader(body, "Requires-Status")),
    deployContexts: uniqueNonEmpty(parseBodyListHeader(body, "Requires-Deploy")),
  };
}

function requiredContexts(reqs: LifecycleRequirements): string[] {
  return uniqueNonEmpty([...reqs.statusContexts, ...reqs.deployContexts]);
}

export function hasLifecycleGate(reqs: LifecycleRequirements): boolean {
  return requiredContexts(reqs).length > 0;
}

const LIFECYCLE_HEADER_RE = /^[ \t]*Requires-(?:Status|Deploy)[ \t]*:/i;
const PROOF_LINE_RE = /^[ \t]*(?:[-*][ \t]*)?PROOF[ \t]*:[ \t]*(.*)$/i;
const POSITIVE_PROOF_RE =
  /\b(pass|passed|verified|proven|green|satisfied|met|confirmed|success|successful|complete|completed)\b/i;

/**
 * True when a positive `PROOF:` line follows the LAST Requires-Status /
 * Requires-Deploy line in the body. Same positive-word rule as
 * `last-stack-card-closeout`, so the helper and this gate agree.
 * An older proof does not satisfy a newer gate.
 */
export function hasProofAfterLastLifecycleHeader(body: string): boolean {
  const lines = body.split(/\r?\n/);
  let lastHeader = -1;
  let inFence = false;
  lines.forEach((line, idx) => {
    if (/^[ \t]*```/.test(line)) inFence = !inFence;
    else if (!inFence && LIFECYCLE_HEADER_RE.test(line)) lastHeader = idx;
  });
  if (lastHeader < 0) return false;
  inFence = false;
  for (let idx = 0; idx < lines.length; idx += 1) {
    const line = lines[idx]!;
    if (/^[ \t]*```/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (idx <= lastHeader || inFence) continue;
    const m = line.match(PROOF_LINE_RE);
    if (m && POSITIVE_PROOF_RE.test(m[1] ?? "")) return true;
  }
  return false;
}

/**
 * Opt-in gate for moving into a board's terminal column.
 * No-op when the card has no Requires-Status / Requires-Deploy headers.
 * `--force` bypasses — out loud (caller passes force=true).
 */
export async function assertLifecycleMoveAllowed(opts: {
  card: Card;
  targetColumn: string;
  terminalColumn: string;
  force?: boolean;
}): Promise<void> {
  if (opts.targetColumn !== opts.terminalColumn) return;

  const requirements = parseLifecycleRequirements(opts.card.body);
  if (!hasLifecycleGate(requirements)) return;
  if (hasProofAfterLastLifecycleHeader(opts.card.body)) return;

  const detail = [
    ...requirements.statusContexts.map((context) => `status:${context}=missing`),
    ...requirements.deployContexts.map((context) => `deploy:${context}=missing`),
  ].join(", ");
  const message =
    `lifecycle_status_blocked: Card "${opts.card.slug}" cannot move to ` +
    `"${opts.targetColumn}" until required pipeline contexts succeed (${detail}).`;
  if (opts.force) {
    console.error(forcedGuardWaiverWarning(opts.card.slug, "lifecycle", message));
    return;
  }
  throw new FkanbanError({
    code: "lifecycle_status_blocked",
    message,
    hint:
      "Append a positive `PROOF: <live evidence>` line after the last " +
      "Requires-Status/Requires-Deploy line, or pass --force to bypass the opt-in gate." +
      FORCE_IS_UNSCOPED,
  });
}
