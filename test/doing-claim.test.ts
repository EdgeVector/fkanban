/**
 * Durable doing-claim + soft zombie reclaim compound.
 *
 * Red-before: bare move leaves assignee empty; reclaim predicate returns true
 * after grace with no PR. Green-after: claim path leaves assignee; reclaim
 * predicate returns false solely for missing pr_url while assignee is set.
 */
import { describe, expect, test } from "bun:test";
import {
  planDoingClaim,
  resolveClaimActor,
  shouldSoftReclaimUnclaimedDoing,
} from "../src/doing-claim.ts";

const graceMs = 60 * 60 * 1000;

describe("planDoingClaim", () => {
  test("stamps explicit worker", () => {
    const plan = planDoingClaim({
      currentAssignee: "",
      explicitActor: "last-stack-fkanban-pickup",
      env: {},
    });
    expect(plan).toEqual({ kind: "stamp", assignee: "last-stack-fkanban-pickup" });
  });

  test("keeps existing assignee", () => {
    const plan = planDoingClaim({
      currentAssignee: "already-mine",
      explicitActor: "other",
      env: {},
    });
    expect(plan).toEqual({ kind: "keep", assignee: "already-mine" });
  });

  test("refuses silent unclaimed without actor", () => {
    const plan = planDoingClaim({ currentAssignee: "", env: {} });
    expect(plan.kind).toBe("refuse");
  });

  test("allow-unclaimed permits empty assignee", () => {
    const plan = planDoingClaim({
      currentAssignee: "",
      allowUnclaimed: true,
      env: {},
    });
    expect(plan).toEqual({ kind: "keep", assignee: "" });
  });

  test("routine env resolves as claim actor", () => {
    expect(
      resolveClaimActor(undefined, {
        DRIVEN_BY: "routine",
        AUTOMATION_ID: "last-stack-fkanban-pickup",
      }),
    ).toBe("routine:last-stack-fkanban-pickup");
  });
});

describe("compound: move claim vs soft zombie reclaim", () => {
  test("red-before: unclaimed empty doing is reclaimable after grace", () => {
    expect(
      shouldSoftReclaimUnclaimedDoing({
        assignee: "",
        ageMs: graceMs + 1,
        graceMs,
        hasPr: false,
        hasLiveWorker: false,
        hasBranchCommits: false,
      }),
    ).toBe(true);
  });

  test("green-after: durable assignee is not reclaimed solely for missing pr_url", () => {
    expect(
      shouldSoftReclaimUnclaimedDoing({
        assignee: "last-stack-fkanban-pickup",
        ageMs: graceMs + 1,
        graceMs,
        hasPr: false,
        hasLiveWorker: false,
        hasBranchCommits: false,
      }),
    ).toBe(false);
  });

  test("young cards never reclaim even when unclaimed", () => {
    expect(
      shouldSoftReclaimUnclaimedDoing({
        assignee: "",
        ageMs: graceMs - 1,
        graceMs,
        hasPr: false,
        hasLiveWorker: false,
        hasBranchCommits: false,
      }),
    ).toBe(false);
  });

  test("open PR never reclaim", () => {
    expect(
      shouldSoftReclaimUnclaimedDoing({
        assignee: "",
        ageMs: graceMs + 1,
        graceMs,
        hasPr: true,
        hasLiveWorker: false,
        hasBranchCommits: false,
      }),
    ).toBe(false);
  });
});
