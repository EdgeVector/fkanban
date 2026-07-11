import { FkanbanError, type AppSchemaDeclaration, type NodeClient } from "../client.ts";

export const FKANBAN_APP_ID = "fkanban";
export const GATES_LOCAL_SCHEMA = "Reference";
export const OPEN_DECISIONS_SLUG = "open-decisions";

export type GateStatus = "open" | "cleared";

export type GateEntry = {
  status: GateStatus;
  slug: string;
  program: string;
  unblocks: string;
  evidence: string;
  surfaced: string;
  recommendation?: string;
  cleared?: string;
  resolution?: string;
};

export type GatesOptions = {
  node: NodeClient;
  json?: boolean;
};

export type GatesDeclareOptions = {
  node: NodeClient;
};

export const openDecisionsLinkSchema: Record<string, unknown> = {
  name: GATES_LOCAL_SCHEMA,
  descriptive_name: "Reference",
  purpose_statement: "Pointer to an external resource useful for future lookup",
  schema_type: "Hash",
  key: { hash_field: "slug" },
  fields: ["slug", "title", "body", "status", "tags", "created_at", "updated_at"],
  field_types: {
    slug: "String",
    title: "String",
    body: "String",
    status: "String",
    tags: { Array: "String" },
    created_at: "String",
    updated_at: "String",
  },
  field_descriptions: {
    slug: "stable url-style id",
    title: "one-line name",
    body: "markdown content",
    status: "active|broken|archived",
    tags: "array of freeform tags",
    created_at: "RFC 3339 timestamp",
    updated_at: "RFC 3339 timestamp",
  },
  field_classifications: { title: ["word"], body: ["word"] },
  field_data_classifications: {
    slug: { sensitivity_level: 0, data_domain: "general" },
    title: { sensitivity_level: 0, data_domain: "general" },
    body: { sensitivity_level: 0, data_domain: "general" },
    status: { sensitivity_level: 0, data_domain: "general" },
    tags: { sensitivity_level: 0, data_domain: "general" },
    created_at: { sensitivity_level: 0, data_domain: "general" },
    updated_at: { sensitivity_level: 0, data_domain: "general" },
  },
};

export async function declareGatesLink(opts: GatesDeclareOptions): Promise<AppSchemaDeclaration> {
  if (!opts.node.declareAppSchema) {
    throw new FkanbanError({
      code: "app_schema_declare_unsupported",
      message: "This node client does not support /api/apps/declare-schema.",
      hint: "Upgrade LastDB/fold, then re-run `fkanban gates --declare-link`.",
    });
  }
  const declared = await opts.node.declareAppSchema(FKANBAN_APP_ID, openDecisionsLinkSchema);
  if (declared.resolution !== "link") {
    throw new FkanbanError({
      code: "gates_link_not_established",
      message:
        `Node declared ${FKANBAN_APP_ID}/${GATES_LOCAL_SCHEMA} as ${declared.resolution} ` +
        `(${declared.canonical}), not as a read-only LINK.`,
      hint:
        "Configure the dev node's app-schema matcher so it links the fkanban Reference ref " +
        "to fbrain's shared Reference canonical, then re-run `fkanban gates --declare-link`.",
    });
  }
  return declared;
}

export async function gatesCmd(opts: GatesOptions): Promise<string> {
  const rows = await opts.node.queryAll({
    schemaHash: GATES_LOCAL_SCHEMA,
    fields: ["slug", "title", "body", "status", "tags", "created_at", "updated_at"],
    filter: { HashKey: OPEN_DECISIONS_SLUG },
  });
  const row = rows.results.find((r) => r.key?.hash === OPEN_DECISIONS_SLUG) ?? rows.results[0];
  const body = typeof row?.fields?.body === "string" ? row.fields.body : "";
  if (body.length === 0) {
    throw new FkanbanError({
      code: "open_decisions_not_found",
      message: `No linked ${OPEN_DECISIONS_SLUG} ledger was visible through ${FKANBAN_APP_ID}/${GATES_LOCAL_SCHEMA}.`,
      hint: "Run `fkanban gates --declare-link` against the dev node and ensure fbrain has seeded open-decisions.",
    });
  }
  const open = parseGateEntries(body).filter((g) => g.status === "open");
  if (opts.json) return JSON.stringify(open);
  if (open.length === 0) return "(no open gates)";
  return open.map(formatGateLineForDisplay).join("\n");
}

export function parseGateEntries(body: string): GateEntry[] {
  const entries: GateEntry[] = [];
  for (const line of body.split("\n")) {
    const entry = parseGateLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function parseGateLine(line: string): GateEntry | null {
  const trimmed = line.trim();
  const raw = trimmed.startsWith("- ") ? trimmed.slice(2).trim() : trimmed;
  if (!raw.startsWith("status=")) return null;
  const fields = parseFieldLine(raw);
  const status = fields.get("status");
  if (status !== "open" && status !== "cleared") return null;
  const entry: GateEntry = {
    status,
    slug: requiredField(fields, "slug"),
    program: requiredField(fields, "program"),
    unblocks: requiredField(fields, "unblocks"),
    evidence: requiredField(fields, "evidence"),
    surfaced: requiredField(fields, "surfaced"),
  };
  const recommendation = fields.get("recommendation");
  if (recommendation !== undefined) entry.recommendation = recommendation;
  const cleared = fields.get("cleared");
  if (cleared !== undefined) entry.cleared = cleared;
  const resolution = fields.get("resolution");
  if (resolution !== undefined) entry.resolution = resolution;
  return entry;
}

export function formatGateLineForDisplay(gate: GateEntry): string {
  return `${gate.slug} · program=${gate.program} · unblocks=${gate.unblocks} · evidence=${gate.evidence} · surfaced=${gate.surfaced}`;
}

function requiredField(fields: Map<string, string>, key: string): string {
  const value = fields.get(key);
  if (value === undefined || value.length === 0) {
    throw new FkanbanError({
      code: "malformed_gate_line",
      message: `Structured gate line is missing ${key}=...`,
    });
  }
  return value;
}

function parseFieldLine(raw: string): Map<string, string> {
  const fields = new Map<string, string>();
  let i = 0;
  while (i < raw.length) {
    while (raw[i] === " ") i++;
    const keyStart = i;
    while (i < raw.length && raw[i] !== "=" && raw[i] !== " ") i++;
    const key = raw.slice(keyStart, i);
    if (raw[i] !== "=" || key.length === 0) break;
    i++;
    let value = "";
    if (raw[i] === '"') {
      i++;
      while (i < raw.length) {
        const ch = raw[i]!;
        if (ch === "\\") {
          const next = raw[i + 1];
          if (next !== undefined) {
            value += next;
            i += 2;
            continue;
          }
        }
        if (ch === '"') {
          i++;
          break;
        }
        value += ch;
        i++;
      }
    } else {
      const valueStart = i;
      while (i < raw.length && raw[i] !== " ") i++;
      value = raw.slice(valueStart, i);
    }
    fields.set(key, value);
  }
  return fields;
}
