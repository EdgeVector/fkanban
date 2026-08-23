#!/usr/bin/env bun
/**
 * Probe: what does a LastDB CAS `expected` precondition compare against — the
 * STORED row, or the WRITE PAYLOAD?
 *
 * This decides whether the narrow card write (`writeChangedCardFieldsOnly`,
 * src/record.ts) may carry a CAS expectation. If CAS read stored state, a
 * narrow payload could assert on any field. It does not.
 *
 * Measured 2026-08-23 against a real isolated Mini node (0.23.3), Card stored
 * with `column: "todo"`:
 *
 * | payload | expected | result |
 * |---|---|---|
 * | `{title, column}` | `column = todo`  (true)  | accepted |
 * | `{title, column}` | `column = done`  (false) | rejected |
 * | `{title}`         | `column = todo`  (true)  | **rejected** |
 *
 * So the precondition is evaluated against the payload: a write that omits the
 * CAS field fails a precondition that holds. `writeChangedCardFieldsOnly`
 * therefore adds the CAS field at its stored value when the command did not
 * change it — the assertion stays testable and the field stays put.
 *
 * WRITES to the configured node (one scratch card, deleted at the end). Point
 * it at an isolated node, not the shared primary:
 *   KANBAN_CONFIG=/tmp/probe/kanban-config.json bun scripts/probe-card-cas-narrow-write.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { fieldsFor } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const hash = schemaHashFor("card", cfg);
const fields = fieldsFor("card");
const slug = `probe-cas-${process.pid}`;

await node.createRecord({
  schemaHash: hash,
  keyHash: slug,
  fields: {
    slug,
    title: "t0",
    body: "probe",
    board: "agent-dogfood-scratch",
    column: "todo",
    position: "1",
    created_at: "x",
    updated_at: "x",
  },
});

const read = async (): Promise<string> => {
  const res = await node.queryAll({ schemaHash: hash, fields, filter: { HashKey: slug } });
  const row = (res.results[0] as { fields?: Record<string, unknown> } | undefined)?.fields;
  return `title=${row?.title} column=${row?.column}`;
};

const attempt = async (
  label: string,
  payload: Record<string, unknown>,
  value: string,
): Promise<void> => {
  let verdict: string;
  try {
    await node.updateRecord({
      schemaHash: hash,
      keyHash: slug,
      fields: payload,
      expected: { type: "value", field: "column", value },
    });
    verdict = "accepted";
  } catch {
    verdict = "rejected";
  }
  console.log(`${label.padEnd(42)} ${verdict.padEnd(9)} ${await read()}`);
};

console.log(`seed: ${await read()}\n`);
await attempt("payload WITH column, expect todo (true)", { title: "t1", column: "todo" }, "todo");
await attempt("payload WITH column, expect done (false)", { title: "t2", column: "todo" }, "done");
await attempt("payload NO   column, expect todo (true)", { title: "t3" }, "todo");

await node.deleteRecord({ schemaHash: hash, keyHash: slug });
