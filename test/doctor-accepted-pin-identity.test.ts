/**
 * Can `doctor` ever go green on the primary?
 *
 * Measured 2026-08-05: it cannot. `kanban doctor` exits 1 on Tom's primary and
 * has since run (e) added the pinned-identity check, on exactly one ✗:
 *
 *   ✗ milestone_cards pin identity — config pins 69e76079…, which the node has
 *     registered as a DIFFERENT schema … pinned schema is Milestone.
 *
 * The check is RIGHT and the condition is REAL. What is missing is that no
 * operator action can clear it. The rows are read and written consistently
 * through that pin; `assertNoSilentSchemaRepin` correctly REFUSES to re-point
 * it (re-pointing orphans every live MilestoneCards row); and the only remedy
 * that would satisfy the check is a data migration on the primary brain, which
 * run (e) deliberately left as Tom's call.
 *
 * So doctor exits 1 forever, which is the failure mode `doctor.ts` already
 * names in its own comments — "a red whose only cause is an optional feature
 * being off is how doctors get ignored". A standing ✗ and a standing exit 1 is
 * the environment the NEXT real mismatch arrives into.
 *
 * The fix follows the design language already established by
 * `--accept-schema-repin`: a red an operator CAN clear. These tests assert on
 * doctor's OUTPUT and EXIT, not on the helper, because a helper unit test
 * passes just as happily when doctor never calls it — the wiring hole this
 * repo has now hit three times (runs (f), (e), and the write-probe branch).
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doctor } from "../src/commands/doctor.ts";
import { allPinnedSchemas, milestoneSchema } from "../src/schemas.ts";
import { handleApiList } from "./http-list.ts";

const HASH_FOR: Record<string, string> = Object.fromEntries(
  allPinnedSchemas().map((e) => [e.key, `hash-${e.key}`]),
);

// The primary's shape, reproduced: `milestone_cards` stays pinned to its own
// hash, but the node reports that hash under the MILESTONE entity's identity.
// That is the multi-key expand putting entity and index on one product.
const MISPINNED_KEY = "milestone_cards";
const REGISTERED_AS = milestoneSchema.schema.descriptive_name;

// One `/api/schemas` row per pinned key, every key at its DECLARED identity
// except `milestone_cards`.
//
// The mispin overrides `descriptive_name` AND NOTHING ELSE, because that is
// what the primary actually reports. Measured there 2026-08-05, the mismatch
// list is `descriptive_name` alone, and the key-layout check on the same run
// PASSES: `✓ MilestoneCards key layout (hash_field=milestone) — HashRange
// key=milestone/sk`. The multi-key expand left the layout intact and moved only
// the identity.
//
// A first cut of this fixture copied the whole Milestone schema, which also
// dragged in `Hash(slug)` and turned the key-layout check red — a mismatch
// shape the primary does not have. That would have made the "nothing else was
// suppressed" test assert against a board state that does not exist.
function schemaRowFor(key: string) {
  const def = allPinnedSchemas().find((e) => e.key === key)!.schema.schema;
  return {
    name: HASH_FOR[key],
    descriptive_name: key === MISPINNED_KEY ? REGISTERED_AS : def.descriptive_name,
    owner_app_id: def.owner_app_id,
    fields: [...def.fields],
    key: { hash_field: def.key.hash_field, range_field: def.key.range_field ?? null },
  };
}

function makeNode() {
  const dir = mkdtempSync(join(tmpdir(), "fkanban-accept-pin-node-"));
  const socketPath = join(dir, "folddb.sock");
  const server = Bun.serve({
    unix: socketPath,
    // Request bodies are never inspected here: this fixture exists to control
    // the SCHEMA SET doctor sees, and every write it accepts unconditionally.
    // The write-probe/parity coverage that does assert on bodies lives in
    // `doctor-index-write-probe-wiring.test.ts`.
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/system/auto-identity") return Response.json({ user_hash: "u" });
      if (url.pathname === "/api/schemas") {
        return Response.json({ schemas: allPinnedSchemas().map((e) => schemaRowFor(e.key)) });
      }
      // GET /api/schema/{hash} — the key-layout checks read the live layout from
      // here. A fixture without it makes those three go red for a reason that
      // has nothing to do with this file's subject, which would leave the
      // "nothing else was suppressed" assertion unable to mean what it says.
      if (url.pathname.startsWith("/api/schema/")) {
        const hash = decodeURIComponent(url.pathname.slice("/api/schema/".length));
        const key = Object.keys(HASH_FOR).find((k) => HASH_FOR[k] === hash);
        if (!key) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ schema: schemaRowFor(key) });
      }
      if (url.pathname === "/api/mutation") return Response.json({ ok: true, success: true });
      if (url.pathname === "/api/list") return handleApiList(url);
      if (url.pathname === "/api/query") return Response.json({ ok: true, results: [], has_more: false });
      return Response.json({ error: "unexpected", path: url.pathname }, { status: 500 });
    },
  });
  return {
    socketPath,
    stop: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "fkanban-accept-pin-cfg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function writeCfg(
  name: string,
  socketPath: string,
  accepted?: Record<string, { hash: string; registeredAs: string }>,
): string {
  const p = join(tmp, name);
  const probe = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  const nodeUrl = `http://127.0.0.1:${probe.port}`;
  probe.stop(true);
  writeFileSync(
    p,
    JSON.stringify({
      configVersion: 1,
      nodeUrl,
      schemaServiceUrl: "http://unused.invalid",
      userHash: "u",
      schemaHashes: { ...HASH_FOR },
      nodeSocketPath: socketPath,
      ...(accepted ? { acceptedSchemaPinIdentities: accepted } : {}),
    }),
  );
  return p;
}

async function run(
  name: string,
  accepted?: Record<string, { hash: string; registeredAs: string }>,
): Promise<{ report: string; ok: boolean }> {
  const node = makeNode();
  const cfgPath = writeCfg(name, node.socketPath, accepted);
  const lines: string[] = [];
  try {
    const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
    return { report: lines.join("\n"), ok };
  } finally {
    node.stop();
  }
}

const ACCEPTED = { [MISPINNED_KEY]: { hash: HASH_FOR[MISPINNED_KEY]!, registeredAs: REGISTERED_AS } };

describe("an unacknowledged identity mismatch is still a red", () => {
  test("doctor fails and names the key", async () => {
    const { report, ok } = await run("unacked.json");
    expect(report).toContain(`✗ ${MISPINNED_KEY} pin identity`);
    expect(ok).toBe(false);
  });

  // The remedy has to be IN the message. A red whose fix lives only in a
  // checkpoint is one the next operator re-derives from scratch.
  test("the red prints the exact config entry that would accept it", async () => {
    const { report } = await run("unacked-remedy.json");
    expect(report).toContain("acceptedSchemaPinIdentities");
    expect(report).toContain(`"hash": "${HASH_FOR[MISPINNED_KEY]}"`);
    expect(report).toContain(`"registeredAs": "${REGISTERED_AS}"`);
  });
});

describe("an acknowledged deviation is reported but does not fail doctor", () => {
  test("doctor goes green, and the deviation is still printed in full", async () => {
    const { report, ok } = await run("acked.json", ACCEPTED);
    expect(ok).toBe(true);
    expect(report).not.toContain(`✗ ${MISPINNED_KEY} pin identity`);
    // Accepted must not mean hidden — the operator still reads the condition.
    expect(report).toContain("ACCEPTED DEVIATION");
    expect(report).toContain(REGISTERED_AS);
  });

  test("no OTHER check was suppressed — doctor's green is the whole run's", async () => {
    const { report } = await run("acked-scope.json", ACCEPTED);
    expect(report).not.toContain("✗");
  });
});

describe("the acknowledgement is scoped to one exact pair", () => {
  // Acknowledging "this key may differ" would waive every future mismatch on
  // the key, including a genuinely re-pointed pin. Both halves must match.
  test("a different registered identity is NOT waived", async () => {
    const { report, ok } = await run("wrong-identity.json", {
      [MISPINNED_KEY]: { hash: HASH_FOR[MISPINNED_KEY]!, registeredAs: "SomethingElse" },
    });
    expect(report).toContain(`✗ ${MISPINNED_KEY} pin identity`);
    expect(ok).toBe(false);
  });

  test("a different pinned hash is NOT waived", async () => {
    const { report, ok } = await run("wrong-hash.json", {
      [MISPINNED_KEY]: { hash: "hash-that-config-does-not-pin", registeredAs: REGISTERED_AS },
    });
    expect(report).toContain(`✗ ${MISPINNED_KEY} pin identity`);
    expect(ok).toBe(false);
  });

  test("acknowledging one key does not waive another", async () => {
    const { report, ok } = await run("other-key.json", {
      board_cards: { hash: HASH_FOR.board_cards!, registeredAs: REGISTERED_AS },
    });
    expect(report).toContain(`✗ ${MISPINNED_KEY} pin identity`);
    expect(ok).toBe(false);
  });
});

describe("a stale acknowledgement announces itself", () => {
  // A suppression that outlives its reason is cruft, and cruft that suppresses
  // is how the next real mismatch gets waived by an entry nobody remembers
  // adding. Say so the run it stops being needed.
  test("an acknowledgement for a now-matching pin is reported as stale", async () => {
    const node = makeNode();
    const cfgPath = writeCfg("stale.json", node.socketPath, {
      // `card` is at its declared identity in this fixture, so the check is
      // `ok` and the acknowledgement has nothing to waive.
      card: { hash: HASH_FOR.card!, registeredAs: "AnythingAtAll" },
    });
    const lines: string[] = [];
    try {
      const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
      const report = lines.join("\n");
      expect(report).toContain("card pin identity acknowledgement is stale");
      // Stale cruft is worth saying, not worth failing on.
      expect(report).not.toContain("✗ card pin identity");
      expect(ok).toBe(false); // still red — milestone_cards is unacknowledged here
    } finally {
      node.stop();
    }
  });
});
