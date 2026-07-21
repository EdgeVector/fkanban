#!/usr/bin/env bun
/**
 * Architecture gate: F-Kanban may synchronize schemas only through Mini's
 * canonical app-schema route. This is executable policy, not a grep reminder.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

export type SourceFile = { path: string; content: string };
export type BoundaryViolation = { path: string; rule: string; detail: string };

const CANONICAL_ROUTE = "/api/apps/declare-schema";
const CANONICAL_ROUTE_OWNER = "src/client.ts";

export function findSchemaSyncBoundaryViolations(files: SourceFile[]): BoundaryViolation[] {
  const violations: BoundaryViolation[] = [];
  for (const file of files) {
    const path = file.path.replaceAll("\\", "/");
    const content = file.content;

    const banned: Array<[RegExp, string, string]> = [
      [/\/v1\/schemas(?:\b|\/)/, "direct-schema-service", "call Mini; applications must not register with Schema Service"],
      [/\/api\/schemas\/declare\b/, "legacy-declare-route", `use ${CANONICAL_ROUTE}`],
      [/\blocal_mint\b/, "local-mint", "durable local schema identities are forbidden"],
      [/\bcopy_rows\b/, "implicit-row-copy", "schema sync never copies rows; key-layout migrations are separate operations"],
    ];
    for (const [pattern, rule, detail] of banned) {
      if (pattern.test(content)) violations.push({ path, rule, detail });
    }

    const directCanonicalTransport = new RegExp(
      `\\b(?:fetch|post|callJson|rawCall|verboseFetch)\\s*\\([^)]{0,240}${CANONICAL_ROUTE.replaceAll("/", "\\/")}`,
      "s",
    );
    if (path !== CANONICAL_ROUTE_OWNER && directCanonicalTransport.test(content)) {
      violations.push({
        path,
        rule: "duplicate-canonical-transport",
        detail: `${CANONICAL_ROUTE} transport belongs only in ${CANONICAL_ROUTE_OWNER}`,
      });
    }
    if (path.startsWith("scripts/") && /(?:register.*schema|schema.*register)/i.test(path)) {
      violations.push({
        path,
        rule: "registration-script",
        detail: "one-off schema registration scripts are forbidden; run kanban init",
      });
    }
  }
  return violations;
}

function productionSources(root: string): SourceFile[] {
  const files: SourceFile[] = [];
  for (const top of ["src", "scripts"]) walk(resolve(root, top));
  return files;

  function walk(dir: string): void {
    for (const entry of readdirSync(dir)) {
      const absolute = resolve(dir, entry);
      if (statSync(absolute).isDirectory()) {
        walk(absolute);
      } else if (/\.(?:ts|js|mjs|sh)$/.test(entry)) {
        const path = relative(root, absolute).replaceAll("\\", "/");
        if (path === "scripts/check-schema-sync-boundary.ts") continue;
        files.push({ path, content: readFileSync(absolute, "utf8") });
      }
    }
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const violations = findSchemaSyncBoundaryViolations(productionSources(root));
  if (violations.length > 0) {
    console.error("Schema-sync architecture boundary FAILED:\n");
    for (const violation of violations) {
      console.error(`- ${violation.path}: ${violation.rule} — ${violation.detail}`);
    }
    process.exit(1);
  }
  console.log("schema-sync architecture boundary PASSED");
}
