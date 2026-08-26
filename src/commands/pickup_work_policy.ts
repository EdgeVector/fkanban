// `fkanban pickup work-policy <slug>` — PR-liveness classification for one card.
//
// last-stack-pickup-work-policy used to return `reconcile` for any non-empty
// `pr_url`. Closed-unmerged is terminal for that PR, so this command is the
// in-repo tested source of truth: open → reconcile, merged → closeout,
// closed-unmerged / none → work.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  pickupWorkPolicyFromLiveness,
  probeCardPrLiveness,
  type PrLiveness,
  type PrLivenessProbe,
  type WorkPolicyAction,
} from "../pr_liveness.ts";
import { requireCard } from "../record.ts";

export type PickupWorkPolicyReport = {
  slug: string;
  pr_url: string | null;
  action: WorkPolicyAction;
  stale_pr_url: boolean;
  pr_liveness: PrLiveness;
};

export async function pickupWorkPolicyResult(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  probe?: PrLivenessProbe;
}): Promise<PickupWorkPolicyReport> {
  const slug = opts.slug.trim();
  if (!slug) {
    throw new FkanbanError({
      code: "usage",
      message: "pickup work-policy requires a card slug",
      hint: "Usage: fkanban pickup work-policy <slug> [--json]",
    });
  }
  const card = await requireCard(opts.node, opts.cfg, slug);
  const pr_liveness = await probeCardPrLiveness(card, {
    node: opts.node,
    probe: opts.probe,
  });
  const { action, stale_pr_url } = pickupWorkPolicyFromLiveness(pr_liveness);
  return {
    slug: card.slug,
    pr_url: pr_liveness.pr_url || null,
    action,
    stale_pr_url,
    pr_liveness,
  };
}

export function renderPickupWorkPolicy(report: PickupWorkPolicyReport): string {
  const lines = [
    `pickup work-policy — ${report.slug}`,
    `  pr_url: ${report.pr_url || "(none)"}`,
    `  pr_liveness: ${report.pr_liveness.state} venue=${report.pr_liveness.venue} action=${report.action}`,
    `  ${report.pr_liveness.note}`,
  ];
  if (report.stale_pr_url) {
    lines.push("  stale_pr_url: yes — clear or annotate before a new WORK unit overwrites it");
  }
  return lines.join("\n");
}

export async function pickupWorkPolicyCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  json?: boolean;
  probe?: PrLivenessProbe;
}): Promise<string> {
  const report = await pickupWorkPolicyResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : renderPickupWorkPolicy(report);
}
