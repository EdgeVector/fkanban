import { describe, expect, test } from "bun:test";
import { findSchemaSyncBoundaryViolations } from "../scripts/check-schema-sync-boundary.ts";

describe("schema-sync architecture boundary", () => {
  test("accepts the one canonical transport and its typed client callsites", () => {
    expect(
      findSchemaSyncBoundaryViolations([
        { path: "src/client.ts", content: 'callJson("/api/apps/declare-schema")\ndeclareAppSchema' },
        { path: "src/commands/init.ts", content: "await node.declareAppSchema(app, schema)" },
      ]),
    ).toEqual([]);
  });

  test.each([
    ["src/direct.ts", 'fetch(`${url}/v1/schemas`)', "direct-schema-service"],
    ["src/legacy.ts", 'post("/api/schemas/declare")', "legacy-declare-route"],
    ["src/fallback.ts", 'if (resolution === "local_mint") {}', "local-mint"],
    ["src/sync.ts", "const copy_rows = true", "implicit-row-copy"],
    ["src/other.ts", 'post("/api/apps/declare-schema")', "duplicate-canonical-transport"],
    ["scripts/register-card-schema.ts", "run()", "registration-script"],
  ])("rejects %s", (path, content, rule) => {
    expect(findSchemaSyncBoundaryViolations([{ path, content }])).toContainEqual(
      expect.objectContaining({ path, rule }),
    );
  });
});
