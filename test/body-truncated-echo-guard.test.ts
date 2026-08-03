// `assertBodyReplaceSafe` vs the shrink its other arms cannot see: a card body
// replaced by a shorter copy of ITSELF.
//
// Why this file exists, in one measurement (live primary, 2026-08-03,
// `scripts/probe-body-shrink-guard.ts`): card
// `papercut-fkanban-milestone-guard-blocks-non-placement-writes` carried an
// 8092-char brief; its `fkanban_search` preview is 200 chars — 2.5% of it —
// and writing that preview back passed every guard the function had.
//
// The other arms all classify by SHAPE (source code, an unrelated brief, an
// annotation-only stub). A truncation has the shape of the real brief, so it
// reads as substantive prose and walks out clean. These tests pin the arm that
// reads PROPORTION instead, and — just as importantly — pin the shapes it must
// NOT refuse, because a guard that fires on ordinary edits gets forced off.

import { describe, expect, test } from "bun:test";

import { assertBodyReplaceSafe } from "../src/record.ts";
import { FkanbanError } from "../src/client.ts";

// A brief shaped like the real ones — and the leading PROSE line matters, so
// don't "tidy" it away. Real Kind:pr cards open with the pickup instruction
// ("Follow the fkanban-agent skill…"), which is why their flattened preview
// still reads as substantive and sails past the annotation-only-stub arm. A
// fixture that opens with `Repo:` instead gets refused by that older arm for
// the wrong reason, and the truncation arm this file exists for is never the
// thing under test.
function brief(paragraphs: number): string {
  const head =
    "Follow the fkanban-agent skill, WORK mode. Drive this to a merged PR.\n" +
    "Repo: EdgeVector/fkanban\nBase: main\nKind: pr\n\n## GOAL\n";
  const mid = Array.from(
    { length: paragraphs },
    (_, i) =>
      `Step ${i}: reconcile the milestone index against the board partition so ` +
      `pickup stops holding runnable cards behind a stale membership row (${i}).`,
  ).join("\n\n");
  return `${head}${mid}\n\n## END STATE\nThe heal reports zero drift on two consecutive runs.\n`;
}

/** What the MCP read tools hand back by default: flattened, cut at 200 chars. */
function mcpPreview(body: string): string {
  return body.replace(/\s+/g, " ").trim().slice(0, 200);
}

function refusal(fn: () => void): FkanbanError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(FkanbanError);
    return err as FkanbanError;
  }
  throw new Error("expected assertBodyReplaceSafe to refuse, but it returned");
}

describe("assertBodyReplaceSafe refuses a truncated echo", () => {
  test("the measured shape: an ~8000-char brief replaced by its own 200-char preview", () => {
    const full = brief(40);
    expect(full.length).toBeGreaterThan(4000);
    const preview = mcpPreview(full);
    expect(preview.length).toBe(200);

    const err = refusal(() => assertBodyReplaceSafe("papercut-x", full, preview));
    expect(err.code).toBe("destructive_body_replace");
    // The numbers are the argument — a refusal that doesn't say how much would
    // be lost reads as a policy quibble rather than a rescue.
    expect(err.message).toContain(`${preview.length} of ${full.length} chars`);
    expect(err.message).toContain("truncated copy of itself");
  });

  test("the escape hatch it names exists on BOTH surfaces", () => {
    const full = brief(40);
    const err = refusal(() => assertBodyReplaceSafe("papercut-x", full, mcpPreview(full)));
    expect(err.hint).toContain("fkanban mark");
    // The MCP name is the half that was missing: three guards told an agent to
    // "use `fkanban mark`" while the MCP server exposed no such tool.
    expect(err.hint).toContain("fkanban_mark");
    expect(err.hint).toContain("--force");
  });

  test("a half-cut brief is refused too — it is not only the extreme preview case", () => {
    const full = brief(40);
    const half = full.slice(0, Math.floor(full.length / 3));
    const err = refusal(() => assertBodyReplaceSafe("papercut-x", full, half));
    expect(err.code).toBe("destructive_body_replace");
  });
});

describe("assertBodyReplaceSafe still allows every legitimate write", () => {
  const full = brief(40);

  test("--force is the audited path through", () => {
    expect(() => assertBodyReplaceSafe("c", full, mcpPreview(full), true)).not.toThrow();
  });

  test("growth — the `mark` path — is untouched", () => {
    expect(() => assertBodyReplaceSafe("c", full, `${full}\nPROGRESS: shipped.`)).not.toThrow();
  });

  test("an unchanged body is not a replace", () => {
    expect(() => assertBodyReplaceSafe("c", full, full)).not.toThrow();
  });

  test("recovering an empty/annotation-only body is allowed", () => {
    expect(() => assertBodyReplaceSafe("c", "", full)).not.toThrow();
    expect(() => assertBodyReplaceSafe("c", "HANDOFF: parked.", full)).not.toThrow();
  });

  test("a condensed rewrite passes — it says the same thing in new words", () => {
    // The shape this arm must never block: an author genuinely rewriting a long
    // brief into a short one. It keeps the subject (so the pre-existing
    // "unrelated full brief" arm at overlap < 0.08 does not fire) while
    // introducing enough new vocabulary that it is plainly not an echo.
    const rewrite =
      "Repo: EdgeVector/fkanban\nBase: main\nKind: pr\n\n## GOAL\n" +
      "Reconcile the milestone index against the board partition, then teach " +
      "telemetry to stamp a request id per daemon so operators can attribute " +
      "node load to one process instead of guessing from cumulative totals.\n\n" +
      "## END STATE\nAttribution names a process, and drift reports zero twice.\n";
    expect(rewrite.length * 2).toBeLessThan(full.length);
    expect(() => assertBodyReplaceSafe("c", full, rewrite)).not.toThrow();
  });

  test("an ordinary trim that keeps more than half passes", () => {
    const trimmed = full.slice(0, Math.floor(full.length * 0.6));
    expect(() => assertBodyReplaceSafe("c", full, trimmed)).not.toThrow();
  });

  test("short bodies are exempt — an edit and a truncation are indistinguishable there", () => {
    const small =
      "Repo: EdgeVector/fkanban\nBase: main\n\nMake the doctor check the socket path " +
      "before it reports the node reachable.";
    expect(small.length).toBeLessThan(400);
    // Substantive on both sides, so only the proportion arm could object — and
    // below the floor it must not.
    const shorter = "Repo: EdgeVector/fkanban\nBase: main\n\nCheck the socket path.";
    expect(shorter.length * 2).toBeLessThan(small.length * 1.2);
    expect(() => assertBodyReplaceSafe("c", small, shorter)).not.toThrow();
  });
});
