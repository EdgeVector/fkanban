// Durable completion checkpoints for cards entering a board's terminal column.
//
// F-Kanban is the live execution queue; F-Brain owns the durable program/North
// Star history. When a card becomes done, record the completion in Brain before
// the ephemeral card can later be pruned from the board.

import { spawn } from "node:child_process";

import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import {
  boardTerminalMap,
  listBoards,
  listCards,
  parseBodyHeader,
  terminalColumn,
  type Card,
} from "./record.ts";

export const ORPHAN_COMPLETION_LEDGER = "fkanban-orphan-completion-checkpoints";

type BrainRecord = {
  slug: string;
  type?: string;
  body: string;
};

type BrainCheckpointClient = {
  get(slug: string): Promise<BrainRecord | null>;
  put(record: { slug: string; type: string; title: string; tags: string[]; body: string }): Promise<void>;
  append(slug: string, chunk: string, type?: string): Promise<void>;
};

export type BrainCheckpointResult =
  | { action: "skipped"; reason: string }
  | { action: "already-exists"; targetSlug: string }
  | { action: "written"; targetSlug: string; ownerSlug: string; orphan: boolean };

let testClient: BrainCheckpointClient | null = null;

export function setBrainCheckpointClientForTest(client: BrainCheckpointClient | null): () => void {
  const previous = testClient;
  testClient = client;
  return () => {
    testClient = previous;
  };
}

function shouldSkipWithoutClient(): boolean {
  return process.env.NODE_ENV === "test" || process.env.FKANBAN_DISABLE_BRAIN_CHECKPOINTS === "1";
}

function brainClient(): BrainCheckpointClient | null {
  if (testClient) return testClient;
  if (shouldSkipWithoutClient()) return null;
  return fbrainCliClient;
}

function runFbrain(args: string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("fbrain", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout);
        return;
      }
      const detail = stderr.trim() || stdout.trim() || `fbrain exited ${code}`;
      reject(new Error(detail));
    });
    if (input !== undefined) child.stdin.end(input);
    else child.stdin.end();
  });
}

const fbrainCliClient: BrainCheckpointClient = {
  async get(slug) {
    const out = await runFbrain(["get", slug, "--json"]);
    const parsed = JSON.parse(out) as { error?: string; slug?: string; type?: string; body?: string };
    if (parsed.error) return null;
    if (!parsed.slug) return null;
    return { slug: parsed.slug, type: parsed.type, body: parsed.body ?? "" };
  },
  async put(record) {
    const frontmatter = [
      "---",
      `type: ${record.type}`,
      `slug: ${record.slug}`,
      `title: ${record.title}`,
      `tags: [${record.tags.join(", ")}]`,
      "---",
      record.body,
    ].join("\n");
    await runFbrain(["put", record.slug, "--type", record.type], frontmatter);
  },
  async append(slug, chunk, type) {
    const args = ["append", slug];
    if (type) args.push("--type", type);
    await runFbrain(args, chunk);
  },
};

function checkpointMarker(cardSlug: string): string {
  return `<!-- fkanban-completion-checkpoint:${cardSlug} -->`;
}

function explicitOwnerSlug(card: Pick<Card, "north_star" | "body" | "tags">): string {
  if (card.north_star.trim()) return card.north_star.trim();
  const fromBody = parseBodyHeader(card.body, "North Star");
  if (fromBody) return fromBody;
  for (const tag of card.tags) {
    const match = tag.match(/^north-star:(.+)$/i) ?? tag.match(/^north_star:(.+)$/i);
    if (match?.[1]) return match[1].trim();
  }
  return "";
}

function programSlugFromActivePrograms(body: string, cardSlug: string): string {
  const escaped = cardSlug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const cardRe = new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}([^A-Za-z0-9_.-]|$)`);
  const sections = body.split(/(?=^##\s+)/m);
  for (const section of sections) {
    if (!cardRe.test(section)) continue;
    const program = section.match(/\*\*program-slug:\*\*\s*`?\[\[([^\]]+)\]\]`?/i);
    if (program?.[1]) return program[1].trim();
  }
  return "";
}

async function resolveOwnerSlug(client: BrainCheckpointClient, card: Card): Promise<string> {
  const explicit = explicitOwnerSlug(card);
  if (explicit) return explicit;
  const activePrograms = await client.get("active-programs").catch(() => null);
  return activePrograms ? programSlugFromActivePrograms(activePrograms.body, card.slug) : "";
}

function isExecutionCard(card: Card): boolean {
  const legacyNonExecution = new Set(["tracker", "umbrella", "program", "capstone"]);
  return !legacyNonExecution.has(card.kind);
}

async function remainingLiveOwnerCards(opts: {
  cfg: Config;
  node: NodeClient;
  completedCard: Card;
  ownerSlug: string;
}): Promise<string[]> {
  const [cards, boards] = await Promise.all([
    listCards(opts.node, opts.cfg),
    listBoards(opts.node, opts.cfg),
  ]);
  const terminals = boardTerminalMap(boards);
  return cards
    .filter((card) => card.slug !== opts.completedCard.slug)
    .filter(isExecutionCard)
    .filter((card) => explicitOwnerSlug(card) === opts.ownerSlug)
    .filter((card) => card.column !== (terminals.get(card.board) ?? "done"))
    .map((card) => card.slug)
    .sort();
}

function firstEvidenceLine(card: Card): string {
  const pr = card.pr_url || parseBodyHeader(card.body, "PR");
  if (pr) return pr;
  const proof = card.body.match(/^(?:PROOF|Proof):\s*(.+)$/im)?.[1]?.trim();
  if (proof) return proof;
  return "(none recorded on card)";
}

function checkpointChunk(opts: {
  card: Card;
  ownerSlug: string;
  orphan: boolean;
  reason: "done-transition" | "delete-backstop";
  remainingLiveCards: string[];
}): string {
  const repo = opts.card.repo || parseBodyHeader(opts.card.body, "Repo") || "(unknown)";
  const base = opts.card.base || parseBodyHeader(opts.card.body, "Base") || "(unknown)";
  const kind = opts.card.kind || parseBodyHeader(opts.card.body, "Kind") || "(unknown)";
  const doneAt = opts.card.done_at || opts.card.updated_at;
  const remaining =
    opts.remainingLiveCards.length === 0
      ? "none found"
      : opts.remainingLiveCards.map((slug) => `\`${slug}\``).join(", ");
  const candidate =
    !opts.orphan && opts.remainingLiveCards.length === 0
      ? "\n- Candidate complete: no remaining live non-terminal F-Kanban execution cards were found for this owner."
      : "";
  return [
    "",
    checkpointMarker(opts.card.slug),
    `## F-Kanban completion checkpoint: ${opts.card.slug}`,
    `- Card: \`${opts.card.slug}\` — ${opts.card.title}`,
    `- Owner: ${opts.orphan ? "orphan completion ledger" : `\`${opts.ownerSlug}\``}`,
    `- Reason: ${opts.reason}`,
    `- Done at: ${doneAt}`,
    `- Repo/base/kind: ${repo} / ${base} / ${kind}`,
    `- PR/proof: ${firstEvidenceLine(opts.card)}`,
    `- Remaining live owner cards: ${remaining}${candidate}`,
    "",
  ].join("\n");
}

async function ensureOrphanLedger(client: BrainCheckpointClient): Promise<BrainRecord> {
  const existing = await client.get(ORPHAN_COMPLETION_LEDGER).catch(() => null);
  if (existing) return existing;
  const body = [
    "# F-Kanban orphan completion checkpoints",
    "",
    "Cards whose owning North Star or program could not be resolved are checkpointed here before they leave the live board.",
    "",
  ].join("\n");
  await client.put({
    slug: ORPHAN_COMPLETION_LEDGER,
    type: "reference",
    title: "F-Kanban orphan completion checkpoints",
    tags: ["fkanban", "completion", "checkpoint", "orphan"],
    body,
  });
  return { slug: ORPHAN_COMPLETION_LEDGER, type: "reference", body };
}

export async function checkpointCardCompletion(opts: {
  cfg: Config;
  node: NodeClient;
  card: Card;
  boardColumns: readonly string[];
  reason: "done-transition" | "delete-backstop";
}): Promise<BrainCheckpointResult> {
  if (opts.card.column !== terminalColumn(opts.boardColumns)) {
    return { action: "skipped", reason: "card is not in the board terminal column" };
  }

  const client = brainClient();
  if (!client) return { action: "skipped", reason: "brain checkpoints disabled in this process" };

  const ownerSlug = await resolveOwnerSlug(client, opts.card);
  const ownerRecord = ownerSlug ? await client.get(ownerSlug).catch(() => null) : null;
  const orphan = !ownerRecord;
  const targetRecord = orphan ? await ensureOrphanLedger(client) : ownerRecord!;
  const marker = checkpointMarker(opts.card.slug);
  if (targetRecord.body.includes(marker)) {
    return { action: "already-exists", targetSlug: targetRecord.slug };
  }

  const remainingLiveCards = ownerSlug && !orphan
    ? await remainingLiveOwnerCards({ cfg: opts.cfg, node: opts.node, completedCard: opts.card, ownerSlug })
    : [];
  const chunk = checkpointChunk({
    card: opts.card,
    ownerSlug,
    orphan,
    reason: opts.reason,
    remainingLiveCards,
  });
  await client.append(targetRecord.slug, chunk, targetRecord.type);
  return { action: "written", targetSlug: targetRecord.slug, ownerSlug, orphan };
}
