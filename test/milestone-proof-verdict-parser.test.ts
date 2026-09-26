import { describe, expect, test } from "bun:test";
import { hasPassingProofEvidence, proofLineVerdict, proofVerdict } from "../src/milestone_proof.ts";

// The same rules as last-stack `bin/last-stack-milestone-driver-snapshot`
// `_proof_verdict()`. Every row is a live validate-lane shape or an edge the
// driver pins; a drift between the two parsers makes the driver and the board
// disagree about one proof card.
const CASES: Array<[string, string, "pass" | "fail" | null]> = [
  ["exact PASS", "PROOF: PASS", "pass"],
  ["exact RESULT PASS", "RESULT: PASS", "pass"],
  ["passed with em-dash detail", "PROOF: passed — offline north-star report PASS", "pass"],
  ["PASS with trailing detail", "PROOF: PASS rc=0 report=/tmp/x.md", "pass"],
  ["passed with trailing punctuation", "PROOF: passed.", "pass"],
  ["pass tag", "PROOF[pass-offline]: report ok", "pass"],
  ["lower-case keyword", "proof: pass", "pass"],
  ["indented line", "  PROOF: PASS", "pass"],
  ["exact FAIL", "PROOF: FAIL", "fail"],
  ["failed with detail", "PROOF: failed offline north-star-x -- report FAIL", "fail"],
  ["failed tag wins over word", "PROOF[failed-isolated-copy-contract]: PASS gate ran, FAIL contract", "fail"],
  ["reopened tag", "PROOF[reopened-end-state-unmet]: END STATE not met", "fail"],
  ["unmet anywhere in tag", "PROOF[end-state-unmet]: see log", "fail"],
  ["RESULT failure", "RESULT: failure", "fail"],
  ["non-verdict line is ignored", "PROOF: fix-card filing failed", null],
  ["non-classifying tag, non-verdict word", "PROOF[offline-ns-proof]: ran rc=1", null],
  ["no verdict line", "## GOAL\nProve it.\n", null],
  ["keyword not at line start", "see PROOF: PASS above", null],
  ["PASS then FAIL: last wins", "PROOF: PASS\nlater:\nPROOF: FAIL", "fail"],
  ["FAIL then PASS: last wins", "PROOF[failed-isolated-copy-contract]: x\nPROOF: passed — re-run", "pass"],
  ["PASS then ignored line: PASS stands", "PROOF: PASS\nPROOF: fix-card filing failed", "pass"],
];

describe("proofVerdict — one parser, last-stack _proof_verdict() rules", () => {
  for (const [name, body, want] of CASES) {
    test(name, () => {
      expect(proofVerdict(body)).toBe(want);
    });
  }

  test("proofLineVerdict: a classifying tag wins over the first word", () => {
    expect(proofLineVerdict("failed-x", "PASS")).toBe("fail");
    expect(proofLineVerdict("pass-x", "FAIL")).toBe("pass");
    expect(proofLineVerdict("other", "passed")).toBe("pass");
    expect(proofLineVerdict(undefined, "—")).toBeNull();
  });

  test("hasPassingProofEvidence follows the LAST verdict", () => {
    expect(hasPassingProofEvidence("PROOF: passed — x")).toBe(true);
    expect(hasPassingProofEvidence("PROOF: PASS\nPROOF: FAIL")).toBe(false);
    expect(hasPassingProofEvidence("PROOF: FAIL\nPROOF: PASS")).toBe(true);
    expect(hasPassingProofEvidence("PROOF: fix-card filing failed")).toBe(false);
  });

  test("a FAIL verdict line overrides a satisfied DONE-WHEN file", async () => {
    const fs = await import("node:fs");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fkanban-proof-parser-"));
    const passFile = path.join(dir, "ns.md");
    fs.writeFileSync(passFile, "PASS\n");
    const doneWhen = `DONE-WHEN: file ${passFile} matches /^PASS/`;
    expect(hasPassingProofEvidence(doneWhen)).toBe(true);
    expect(hasPassingProofEvidence(`${doneWhen}\nPROOF: FAIL`)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
