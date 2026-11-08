// PR liveness for pickup work-policy.
//
// A non-empty `pr_url` is not always in-flight work. Closed-unmerged is a
// terminal state for that review artifact: reconcile can never complete, and
// treating it as `reconcile` parks the card forever. This module classifies
// the locator (open / merged / closed-unmerged / unknown / none) so pickup
// explain and work-policy can choose WORK vs reconcile vs closeout.

import { type Card } from "./record.ts";

export const PR_LIVENESS_TIMEOUT_MS = 1500;

export type PrVenue = "github" | "unknown";
export type PrLivenessState = "none" | "open" | "merged" | "closed-unmerged" | "unknown";
export type WorkPolicyAction = "work" | "reconcile" | "closeout";

export type ParsedPrUrl = {
  venue: PrVenue;
  owner: string;
  repo: string;
  number: string;
  origin: string;
};

export type PrProbeResult = {
  found: boolean;
  open: boolean;
  merged: boolean;
  error?: string;
};

export type PrLiveness = {
  pr_url: string;
  state: PrLivenessState;
  venue: PrVenue;
  action: WorkPolicyAction;
  note: string;
};

export type PrLivenessProbe = (parsed: ParsedPrUrl, prUrl: string) => Promise<PrProbeResult>;

const EMPTY_PARSED: ParsedPrUrl = {
  venue: "unknown",
  owner: "",
  repo: "",
  number: "",
  origin: "",
};

function githubHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "github.com" || h === "www.github.com" || h.endsWith(".github.com");
}

export function parsePrUrl(prUrl: string): ParsedPrUrl {
  const t = prUrl.trim();
  if (!t) return { ...EMPTY_PARSED };

  const github = t.match(/^(https?:\/\/)?(?:www\.)?github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (github?.[2] && github[3] && github[4]) {
    return {
      ...EMPTY_PARSED,
      venue: "github",
      owner: github[2],
      repo: github[3].replace(/\.git$/i, ""),
      number: github[4],
      origin: "https://github.com",
    };
  }

  const pulls = t.match(/^(https?:\/\/([^/]+))\/([^/]+)\/([^/]+)\/pulls?\/(\d+)/i);
  if (pulls?.[2] && pulls[3] && pulls[4] && pulls[5] && githubHost(pulls[2])) {
    return {
      ...EMPTY_PARSED,
      venue: "github",
      owner: pulls[3],
      repo: pulls[4].replace(/\.git$/i, ""),
      number: pulls[5],
      origin: "https://github.com",
    };
  }

  return { ...EMPTY_PARSED, venue: "unknown" };
}

export function workPolicyAction(state: PrLivenessState): WorkPolicyAction {
  switch (state) {
    case "open":
      return "reconcile";
    case "merged":
      return "closeout";
    case "unknown":
      // Fail closed: do not start a second WORK unit when the venue did not answer.
      return "reconcile";
    case "none":
    case "closed-unmerged":
      return "work";
  }
}

export function livenessNote(state: PrLivenessState, venue: PrVenue): string {
  switch (state) {
    case "none":
      return "no pr_url; fresh WORK";
    case "open":
      return "PR is open; reconcile (not pickup WORK)";
    case "merged":
      return "PR is merged; close out the card";
    case "closed-unmerged":
      return "PR is closed and unmerged; treat as no PR (fresh WORK)";
    case "unknown":
      return `PR liveness unknown (${venue}); fail-closed reconcile`;
  }
}

export function classifyPrProbe(
  prUrl: string,
  venue: PrVenue,
  probe: PrProbeResult | null,
): PrLiveness {
  const trimmed = prUrl.trim();
  if (!trimmed) {
    return {
      pr_url: "",
      state: "none",
      venue: "unknown",
      action: workPolicyAction("none"),
      note: livenessNote("none", "unknown"),
    };
  }

  let state: PrLivenessState;
  if (!probe) {
    state = "unknown";
  } else if (probe.error && !probe.found) {
    state = "unknown";
  } else if (!probe.found) {
    state = "closed-unmerged";
  } else if (probe.merged) {
    state = "merged";
  } else if (probe.open) {
    state = "open";
  } else {
    state = "closed-unmerged";
  }

  return {
    pr_url: trimmed,
    state,
    venue,
    action: workPolicyAction(state),
    note: livenessNote(state, venue),
  };
}

function jsonField(obj: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    if (name in obj) return obj[name];
  }
  return undefined;
}

function probeFromHttpBody(body: unknown): PrProbeResult {
  if (!body || typeof body !== "object") {
    return { found: true, open: false, merged: false, error: "unrecognized PR payload" };
  }
  const obj = body as Record<string, unknown>;
  const stateRaw = String(jsonField(obj, "state", "State") ?? "").toLowerCase();
  const mergedAt = jsonField(obj, "merged_at", "mergedAt", "MergedAt");
  const mergedFlag = jsonField(obj, "merged", "Merged");
  const mergeOid = String(jsonField(obj, "merge_oid", "mergeOid") ?? "").trim();
  const merged =
    mergedFlag === true ||
    (typeof mergedAt === "string" && mergedAt.length > 0) ||
    mergeOid.length > 0 ||
    stateRaw === "merged";
  const open = !merged && (stateRaw === "open" || stateRaw === "");
  return { found: true, open, merged };
}

async function httpGetJson(url: string, timeoutMs: number): Promise<{ status: number; body: unknown }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    return { status: res.status, body };
  } finally {
    clearTimeout(timer);
  }
}

export async function defaultPrLivenessProbe(
  parsed: ParsedPrUrl,
  _prUrl: string,
): Promise<PrProbeResult> {
  if (parsed.venue === "github" && parsed.owner && parsed.repo && parsed.number) {
    const url = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.number}`;
    try {
      const { status, body } = await httpGetJson(url, PR_LIVENESS_TIMEOUT_MS);
      if (status === 404) return { found: false, open: false, merged: false };
      if (status < 200 || status >= 300) {
        return { found: false, open: false, merged: false, error: `github HTTP ${status}` };
      }
      return probeFromHttpBody(body);
    } catch (err) {
      return {
        found: false,
        open: false,
        merged: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { found: false, open: false, merged: false, error: "unrecognized pr_url" };
}

export async function probePrLiveness(
  prUrl: string,
  opts?: { probe?: PrLivenessProbe },
): Promise<PrLiveness> {
  const trimmed = prUrl.trim();
  if (!trimmed) return classifyPrProbe("", "unknown", null);
  const parsed = parsePrUrl(trimmed);
  try {
    const probe = opts?.probe
      ? await opts.probe(parsed, trimmed)
      : await defaultPrLivenessProbe(parsed, trimmed);
    return classifyPrProbe(trimmed, parsed.venue, probe);
  } catch (err) {
    return classifyPrProbe(trimmed, parsed.venue, {
      found: false,
      open: false,
      merged: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export async function probeCardPrLiveness(
  card: Pick<Card, "pr_url">,
  opts?: { probe?: PrLivenessProbe },
): Promise<PrLiveness> {
  return probePrLiveness(card.pr_url.trim(), { probe: opts?.probe });
}

/** Pickup WORK vs reconcile vs closeout from a liveness verdict. */
export function pickupWorkPolicyFromLiveness(liveness: PrLiveness): {
  action: WorkPolicyAction;
  stale_pr_url: boolean;
} {
  return {
    action: liveness.action,
    stale_pr_url: liveness.state === "closed-unmerged",
  };
}
