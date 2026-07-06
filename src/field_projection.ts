// Shared TSV projection for list/search read commands.

import { FkanbanError } from "./client.ts";
import type { Card } from "./record.ts";
import { fieldsFor } from "./schemas.ts";

type ProjectableCard = Card & Partial<{
  blocked: boolean;
  blockedBy: string[];
  missingDeps: string[];
}>;

const FIELD_ALIASES: Record<string, string> = {
  pr: "pr_url",
  blocked_by: "blockedBy",
  missing_deps: "missingDeps",
};

const DERIVED_FIELD_NAMES = [
  "deps",
  "done_at",
  "blocked",
  "blockedBy",
  "missingDeps",
] as const;

export const FIELD_NAMES = new Set([
  ...fieldsFor("card"),
  ...DERIVED_FIELD_NAMES,
]);

const DISPLAY_ONLY_FIELDS = new Set([
  "slug",
  "title",
  "board",
  "column",
  "position",
  "assignee",
  "tags",
  "deps",
  "created_at",
  "done_at",
  "blocked",
  "blockedBy",
  "missingDeps",
]);

function normalizeFieldName(field: string): string {
  const trimmed = field.trim();
  const normalized = FIELD_ALIASES[trimmed] ?? trimmed;
  if (!FIELD_NAMES.has(normalized)) {
    throw new FkanbanError({
      code: "invalid_field",
      message: `Unknown field "${field}".`,
      hint: `Use one of: ${[...FIELD_NAMES, ...Object.keys(FIELD_ALIASES)].sort().join(", ")}`,
    });
  }
  return normalized;
}

export function fieldProjectionNeedsFullCards(fields: string[]): boolean {
  return fields.some((field) => !DISPLAY_ONLY_FIELDS.has(normalizeFieldName(field)));
}

function cellValue(value: unknown): string {
  if (value === undefined || value === null) return "";
  const raw = Array.isArray(value) ? value.join(",") : String(value);
  return raw.replace(/[\t\r\n]+/g, " ");
}

export function renderFieldProjection(cards: ProjectableCard[], fields: string[]): string {
  const normalized = fields.map(normalizeFieldName);
  return cards
    .map((card) =>
      normalized
        .map((field) => cellValue((card as Record<string, unknown>)[field]))
        .join("\t")
    )
    .join("\n");
}
