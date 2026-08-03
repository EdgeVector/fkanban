#!/usr/bin/env bun
/**
 * Probe: how much of the live board could a "read it, write it back" agent
 * destroy — and does `assertBodyReplaceSafe` stop it?
 *
 * ## The loop being measured
 *
 * `fkanban_list` / `fkanban_search` return each card's `body` as a flattened
 * ~200-char PREVIEW (`BODY_PREVIEW_CHARS`, `bodyTruncated: true`) so a board
 * read doesn't cost an agent its whole context. `fkanban_add`'s `body`
 * REPLACES the entire body. Nothing structurally prevents an agent from
 * pairing the two, and until 2026-08-03 nothing detected it either: the
 * replacement is a slice of the real brief, so it reads as substantive prose
 * and passes every shape-based arm of the guard.
 *
 * This probe puts real card bodies through the real guard and reports, per
 * card, how much would be lost and whether the guard objects.
 *
 * READ-ONLY. It issues the same board read `kanban list --full-body` does and
 * writes nothing — the guard is a pure function, so the "would this write be
 * refused?" question is answered without attempting one.
 *
 * Run: bun scripts/probe-body-shrink-guard.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, FkanbanError } from "../src/client.ts";
import { assertBodyReplaceSafe, listBoards, listCardsWithBodies } from "../src/record.ts";

/** Mirrors `previewBody()` in src/mcp/server.ts. Keep the two in step. */
const BODY_PREVIEW_CHARS = 200;
const previewOf = (body: string): string =>
  body.replace(/\s+/g, " ").trim().slice(0, BODY_PREVIEW_CHARS);

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);
const cards = await listCardsWithBodies(node, cfg, { boards });

type Row = { slug: string; full: number; preview: number; keptPct: number; refused: string | null };
const rows: Row[] = [];

for (const card of cards) {
  const full = card.body ?? "";
  if (full.length === 0) continue;
  const preview = previewOf(full);
  if (preview === full.trim()) continue; // nothing was truncated; no loss to measure

  let refused: string | null = null;
  try {
    assertBodyReplaceSafe(card.slug, full, preview);
  } catch (err) {
    refused = err instanceof FkanbanError ? err.code : "unknown";
  }
  rows.push({
    slug: card.slug,
    full: full.length,
    preview: preview.length,
    keptPct: (preview.length / full.length) * 100,
    refused,
  });
}

rows.sort((a, b) => a.keptPct - b.keptPct);

const allowed = rows.filter((r) => r.refused === null);
const lostChars = allowed.reduce((n, r) => n + (r.full - r.preview), 0);

console.log(`cards with a truncatable body: ${rows.length} (of ${cards.length} on ${boards.length} board(s))`);
console.log(`writing the preview back would be REFUSED for : ${rows.length - allowed.length}`);
console.log(`writing the preview back would be ALLOWED for : ${allowed.length}`);
console.log(`chars of brief at risk in the allowed set      : ${lostChars.toLocaleString()}`);
console.log("");
console.log("worst losses (smallest fraction of the brief kept):");
console.log("  kept%   full  preview  verdict   slug");
for (const r of rows.slice(0, 10)) {
  console.log(
    `  ${r.keptPct.toFixed(1).padStart(5)}  ${String(r.full).padStart(5)}  ` +
      `${String(r.preview).padStart(7)}  ${(r.refused ?? "ALLOWED").padEnd(8)}  ${r.slug}`,
  );
}
