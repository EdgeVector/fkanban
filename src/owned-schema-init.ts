import { canonicalSchema, profilesFor } from "./canonical-vocabulary.ts";
import { FkanbanError, type NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { MULTI_KEY_MODEL, ownedSchemas } from "./multi-key.ts";
import { OWNER_APP_ID, type SchemaDefinition } from "./schemas.ts";
import { HISTORICAL_SCHEMAS } from "./legacy-schemas.ts";
import { OWNED_HOME_API_VERSION, ownedHome } from "./lastdb-version.ts";

type InstalledSchema = {
  name: string;
  identity_hash: string;
  owner_app_id: string;
  descriptive_name: string;
  schema_type: string;
  fields: string[];
  key: Record<string, string>;
  field_types: Record<string, unknown>;
  field_descriptions: Record<string, string>;
  alternate_keys?: unknown;
  transform_fields?: Record<string, unknown>;
};

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
function stable(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(stable).join(",") + "]";
  if (value && typeof value === "object")
    return (
      "{" +
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => JSON.stringify(key) + ":" + stable(item))
        .join(",") +
      "}"
    );
  return JSON.stringify(value);
}
const same = (left: unknown, right: unknown) => stable(left) === stable(right);

async function readInstalledSchema(
  node: NodeClient,
  name: string,
): Promise<InstalledSchema> {
  const path = `/api/schema/${encodeURIComponent(name)}`;
  const response = await node.rawCall("GET", path);
  if (response.status !== 200 || object(response.json).ok === false)
    throw new FkanbanError({
      code: "schema_read_failed",
      message: `${path} returned HTTP ${response.status}. Init leaves the config unchanged.`,
    });
  const payload = object(object(response.json).data ?? response.json);
  return (payload.schema ?? payload) as InstalledSchema;
}

/** An installed historical definition must match exactly. No field rename is inferred. */
function checkHistoricalDefinition(
  source: InstalledSchema,
  local: SchemaDefinition,
): void {
  const canonical = canonicalSchema(local);
  const definition = same(
    [...(source.fields ?? [])].sort(),
    [...canonical.fields].sort(),
  )
    ? canonical
    : local;
  if (
    source.owner_app_id !== OWNER_APP_ID ||
    source.descriptive_name !== definition.descriptive_name ||
    source.schema_type !== definition.schema_type ||
    typeof source.identity_hash !== "string" ||
    !/^[a-f0-9]{64}$/.test(source.identity_hash) ||
    typeof source.name !== "string" ||
    !source.name ||
    !same([...(source.fields ?? [])].sort(), [...definition.fields].sort()) ||
    !same(
      [source.key?.hash_field, source.key?.range_field ?? null],
      [definition.key.hash_field, definition.key.range_field ?? null],
    ) ||
    !same(source.field_types, definition.field_types) ||
    !same(source.field_descriptions, definition.field_descriptions) ||
    Object.keys(source.transform_fields ?? {}).length ||
    Object.keys(source.alternate_keys ?? {}).length
  )
    throw new FkanbanError({
      code: "historical_schema_differs",
      message: `The installed ${local.descriptive_name} definition differs. Init leaves it unchanged.`,
    });
}

export async function syncOwnedModel(
  node: NodeClient,
  base: Config,
  existing: Config | null,
  canonicalVocabulary: boolean,
): Promise<Config> {
  const version = await node.rawCall("GET", "/api/version");
  const { api_version: apiVersion, capabilities } = (version.json ?? {}) as {
    api_version?: unknown;
    capabilities?: Record<string, boolean>;
  };
  if (
    version.status !== 200 ||
    !capabilities?.compound_alternate_keys_v1 ||
    !capabilities.independent_hash_range_v1
  ) {
    throw new FkanbanError({
      code: "multi_key_upgrade_required",
      message:
        "This node needs compound alternate keys and independent HashRange schemas.",
    });
  }
  // Every schema on an API 13+ node owns its values. Check once, before any declaration.
  if (typeof apiVersion !== "number" || !ownedHome(apiVersion)) {
    throw new FkanbanError({
      code: "owned_schema_receipt_invalid",
      message: `This node is older than LastDB API ${OWNED_HOME_API_VERSION}. It cannot confirm schema-owned values.`,
    });
  }
  const response = await node.rawCall("GET", "/api/schemas");
  const root = response.json as { data?: unknown };
  const catalog = (root?.data ?? root) as {
    ready?: boolean;
    schemas?: InstalledSchema[];
  };
  if (
    response.status !== 200 ||
    catalog.ready !== true ||
    !Array.isArray(catalog.schemas)
  ) {
    throw new FkanbanError({
      code: "schema_directory_unavailable",
      message: "The schema directory is not available.",
    });
  }
  const declarations = ownedSchemas();
  const known = [...declarations, ...HISTORICAL_SCHEMAS];
  const installed = catalog.schemas.filter(
    (schema) => schema.owner_app_id === OWNER_APP_ID,
  );
  if (
    installed.some(
      (schema) =>
        !known.some(
          (entry) => entry.schema.descriptive_name === schema.descriptive_name,
        ),
    )
  )
    throw new FkanbanError({
      code: "unreviewed_app_schema",
      message:
        "This home contains an unreviewed F-Kanban schema. Init leaves it unchanged.",
    });
  if (
    new Set(installed.map((schema) => schema.descriptive_name)).size !==
    installed.length
  )
    throw new FkanbanError({
      code: "ambiguous_app_schema",
      message:
        "Several installed schemas claim one app record type. Init leaves them unchanged.",
    });
  if (
    existing &&
    Object.keys(existing.schemaHashes).some(
      (key) => !known.some((entry) => entry.key === key),
    )
  )
    throw new FkanbanError({
      code: "unreviewed_schema_pin",
      message: "The saved config contains an unreviewed schema pin.",
    });
  const historical = await Promise.all(
    HISTORICAL_SCHEMAS.filter(
      ({ key, schema }) =>
        existing?.schemaHashes[key] ||
        installed.some(
          (source) => source.descriptive_name === schema.descriptive_name,
        ),
    ).map(async (entry) => {
      const pin =
        existing?.schemaHashes[entry.key] ??
        installed.find(
          (source) => source.descriptive_name === entry.schema.descriptive_name,
        )!.name;
      const source = await readInstalledSchema(node, pin);
      checkHistoricalDefinition(source, entry.schema);
      if (
        existing?.schemaIdentities?.[entry.key] &&
        existing.schemaIdentities[entry.key] !== source.identity_hash
      )
        throw new FkanbanError({
          code: "schema_pin_changed",
          message: "A historical definition identity differs.",
        });
      return { ...entry, runtime: source.name, identity: source.identity_hash };
    }),
  );
  if (!node.declareAppSchema)
    throw new FkanbanError({
      code: "schema_declare_unavailable",
      message: "The client cannot declare owned schemas.",
    });
  const resolved = await Promise.all(
    declarations.map(async (entry) => {
      const declaration = await node.declareAppSchema!(
        OWNER_APP_ID,
        entry.schema,
      );
      if (
        !declaration.identityHash ||
        !/^[a-f0-9]{64}$/.test(declaration.identityHash) ||
        declaration.app_id !== OWNER_APP_ID ||
        declaration.schema !== OWNER_APP_ID + "/" + entry.schema.name ||
        !declaration.canonical
      ) {
        throw new FkanbanError({
          code: "owned_schema_receipt_invalid",
          message:
            "The declaration did not confirm the exact app schema and a definition identity.",
        });
      }
      return {
        ...entry,
        runtime: declaration.canonical,
        identity: declaration.identityHash,
      };
    }),
  );
  const all = [...resolved, ...historical];
  const schemaHashes = Object.fromEntries(
    all.map((entry) => [entry.key, entry.runtime]),
  );
  const schemaIdentities = Object.fromEntries(
    all.map((entry) => [entry.key, entry.identity]),
  );
  if (
    existing &&
    resolved.some(
      (entry) =>
        (existing.schemaHashes[entry.key] !== entry.identity &&
          existing.schemaHashes[entry.key] !== entry.runtime) ||
        (existing.schemaIdentities?.[entry.key] &&
          existing.schemaIdentities[entry.key] !== entry.identity),
    )
  ) {
    throw new FkanbanError({
      code: "schema_pin_changed",
      message: "An owned schema address changed. The config remains unchanged.",
    });
  }
  return {
    ...existing,
    ...base,
    storageModel: MULTI_KEY_MODEL,
    schemaHashes,
    schemaIdentities,
    schemaFieldAliases: canonicalVocabulary
      ? Object.assign(
          {},
          existing?.schemaFieldAliases,
          ...all.map((entry) =>
            profilesFor(entry.schema, [
              entry.identity,
              entry.runtime,
              OWNER_APP_ID + "/" + entry.schema.name,
            ]),
          ),
        )
      : existing?.schemaFieldAliases,
  };
}
