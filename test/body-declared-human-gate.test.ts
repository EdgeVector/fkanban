// papercut-kanban-pickup-claims-human-gated-card-after-ungate-20260922
import { describe, expect, test } from "bun:test";
import { bodyDeclaredHumanGate, claimHoldReason } from "../src/record.ts";

describe("bodyDeclaredHumanGate", () => {
  test("Requires-Actor with a human/interactive actor is a gate", () => {
    expect(bodyDeclaredHumanGate("Repo: o/n\nRequires-Actor: interactive\n")).toBe(
      "body declares Requires-Actor: interactive",
    );
    expect(bodyDeclaredHumanGate("Requires-Actor: non-routinesd\n")).toContain("non-routinesd");
  });

  test("Requires-Actor for an unattended worker is not a gate", () => {
    expect(bodyDeclaredHumanGate("Requires-Actor: agent\n")).toBeNull();
    expect(bodyDeclaredHumanGate("Requires-Actor: any\n")).toBeNull();
  });

  test("Human-Gate is a gate unless cleared", () => {
    expect(bodyDeclaredHumanGate("Human-Gate: launchctl-kickstart\n")).toContain("launchctl-kickstart");
    expect(bodyDeclaredHumanGate("Human-Gate: none\n")).toBeNull();
  });

  test("a header inside a code fence is ignored", () => {
    expect(bodyDeclaredHumanGate("```\nRequires-Actor: interactive\n```\n")).toBeNull();
  });

  test("no header, no gate", () => {
    expect(bodyDeclaredHumanGate("## GOAL\nkeep it simple\n")).toBeNull();
  });
});

describe("claimHoldReason", () => {
  test("block_status holds and body gates both stop a claim", () => {
    expect(claimHoldReason({ block_status: "needs_human", body: "" })).toBe("intentional hold: needs_human");
    expect(claimHoldReason({ block_status: "deferred", body: "" })).toBe("deferred hold");
    expect(claimHoldReason({ block_status: "none", body: "Requires-Actor: human\n" })).toContain("human");
    expect(claimHoldReason({ block_status: "none", body: "## GOAL\nx\n" })).toBeNull();
  });
});
