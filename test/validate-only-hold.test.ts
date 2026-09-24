// A card whose code already merged and that only waits on a post-merge END
// STATE is validate work, never a WORK claim (2026-09-24: a Loom land-card walk
// claimed a reopened CLOSED-ON-MERGE card and IMPLEMENT failed on no-commit).
import { describe, expect, test } from "bun:test";
import { bodyDeclaredValidateOnly, claimHoldReason, emptyStructuredFields, type Card } from "../src/record.ts";
import { classifyPickupCard } from "../src/pickup.ts";

const CLOSED =
  "CLOSED-ON-MERGE 2026-09-24T02:14:05Z — card moved to done because a PR merged; its ## END STATE was NOT evaluated.";
const REOPENED =
  "PROOF[reopened-end-state-unmet]: reopened from CLOSED-ON-MERGE 2026-09-24T02:14:05Z: live --list still omits the slug";

describe("bodyDeclaredValidateOnly", () => {
  test("each producer marker makes the card validate-only", () => {
    expect(bodyDeclaredValidateOnly(`## GOAL\nx\n${CLOSED}\n`)).toContain("CLOSED-ON-MERGE");
    expect(bodyDeclaredValidateOnly(`## GOAL\nx\n${REOPENED}\n`)).toContain("PROOF[reopened-end-state-unmet]");
    expect(bodyDeclaredValidateOnly("VALIDATE-ONLY: awaiting host-track install\n")).toContain("VALIDATE-ONLY");
    expect(bodyDeclaredValidateOnly(`- ${CLOSED}\n`)).toContain("(CLOSED-ON-MERGE)");
  });

  test("a later REWORK line re-admits the card; a marker after it holds again", () => {
    expect(bodyDeclaredValidateOnly(`${CLOSED}\nREWORK: END STATE needs a code fix in this card\n`)).toBeNull();
    expect(bodyDeclaredValidateOnly(`${CLOSED}\nREWORK: fix\n${REOPENED}\n`)).not.toBeNull();
  });

  test("prose and fenced text do not count", () => {
    expect(bodyDeclaredValidateOnly("## GOAL\nWrite the CLOSED-ON-MERGE audit line.\n")).toBeNull();
    expect(bodyDeclaredValidateOnly("```\nCLOSED-ON-MERGE example\n```\n")).toBeNull();
    expect(bodyDeclaredValidateOnly("")).toBeNull();
  });

  test("claimHoldReason refuses a validate-only card", () => {
    expect(claimHoldReason({ block_status: "none", body: `## GOAL\nx\n${REOPENED}\n` })).toContain("validate-only");
    expect(claimHoldReason({ block_status: "none", body: "## GOAL\nx\n" })).toBeNull();
  });
});

describe("classifyPickupCard", () => {
  const base: Card = {
    slug: "harness",
    title: "harness",
    body: `Repo: EdgeVector/last-stack\nBase: main\n\n## GOAL\nx\n\n## END STATE\nlive --list has it\n${CLOSED}\n${REOPENED}\n`,
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    repo: "EdgeVector/last-stack",
    base: "main",
    kind: "pr",
    surfaces: ["harness/x"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  };
  const noDep = { blocked: false, blockedBy: [], missing: [] };

  test("a todo Kind:pr card with a reopen marker is parked, not WORK-ready", () => {
    const got = classifyPickupCard(base, [base], noDep);
    expect(got.ready).toBe(false);
    expect(got.category).toBe("parked/non-work");
    expect(got.reason).toContain("validate-only");
  });

  test("the same card without the marker stays ready", () => {
    const plain = { ...base, body: "Repo: EdgeVector/last-stack\nBase: main\n\n## GOAL\nx\n" };
    expect(classifyPickupCard(plain, [plain], noDep).ready).toBe(true);
  });
});
