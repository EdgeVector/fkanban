// The LastDB node request-grammar version kanban needs, from
// `lastdb.minApiVersion` in package.json (see the app-sdk README, "Version
// handshake"). `0` = no requirement: the node is never asked. Raise it in the
// same change that makes kanban send a key an older node would refuse;
// enforcement then fails on ONE line that names the fix instead of a bare 400
// on the first write (the 2026-09-03 brain `durability` incident). Malformed
// → 0 so a packaging mistake never bricks every command.
import pkg from "../package.json" with { type: "json" };

export const MIN_LASTDB_API_VERSION: number = parseMinApiVersion(
  (pkg as { lastdb?: { minApiVersion?: unknown } }).lastdb?.minApiVersion,
);

function parseMinApiVersion(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

// Who is asking, for the NodeTooOldError message (`kanban 0.1.0 needs …`).
export const KANBAN_APP_LABEL = `kanban ${pkg.version}`;

// LastDB API 13 (lastdb #803) is the first node that refuses a home with the
// retired shared-value layout at startup. Every schema such a node lists owns
// its values, so its replies may omit the per-schema `independent_fields` key
// (lastdb removes it in stage 2 of the protein removal). An explicit `false`
// still means "not owned", and an older node must still send `true`.
export const OWNED_HOME_API_VERSION = 13;

/** Whether a node reply's `independent_fields` value confirms owned values. */
export const ownsValues = (independentFields: unknown, apiVersion: number): boolean =>
  independentFields === true ||
  (independentFields === undefined && apiVersion >= OWNED_HOME_API_VERSION);
