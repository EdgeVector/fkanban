import { profilesFor } from "./canonical-vocabulary.ts";
import { FkanbanError, type NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { CONVERSION_HINT, MULTI_KEY_MODEL, ownedSchemas } from "./multi-key.ts";
import { OWNER_APP_ID } from "./schemas.ts";
import { HISTORICAL_SCHEMAS } from "./legacy-schemas.ts";
import {
  conversionDefinition,
  conversionCall,
  type Metadata,
} from "./schema-conversion.ts";

export async function syncOwnedModel(
  node: NodeClient,
  base: Config,
  existing: Config | null,
  canonicalVocabulary: boolean,
): Promise<Config> {
  const version = await node.rawCall("GET", "/api/version");
  const capabilities = (
    version.json as { capabilities?: Record<string, boolean> }
  )?.capabilities;
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
  const response = await node.rawCall("GET", "/api/schemas");
  const root = response.json as { data?: unknown };
  const catalog = (root?.data ?? root) as {
    ready?: boolean;
    schemas?: Metadata[];
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
  if (installed.some((schema) => schema.independent_fields !== true)) {
    throw new FkanbanError({
      code: "multi_key_conversion_required",
      message:
        "Existing F-Kanban values need the explicit multi-key conversion. Init leaves them unchanged.",
      hint: CONVERSION_HINT,
    });
  }
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
      const source = await conversionCall<Metadata>(
        node,
        "GET",
        `/api/schema/${encodeURIComponent(pin)}`,
      );
      conversionDefinition(source, entry.schema);
      if (
        source.independent_fields !== true ||
        Object.keys(source.alternate_keys ?? {}).length ||
        Object.keys(source.field_mappers ?? {}).length
      )
        throw new FkanbanError({
          code: "historical_conversion_required",
          message:
            "A historical layout needs its explicit ownership conversion.",
        });
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
        !declaration.independentFields ||
        !declaration.identityHash ||
        !/^[a-f0-9]{64}$/.test(declaration.identityHash) ||
        declaration.app_id !== OWNER_APP_ID ||
        declaration.schema !== OWNER_APP_ID + "/" + entry.schema.name ||
        !declaration.canonical
      ) {
        throw new FkanbanError({
          code: "owned_schema_receipt_invalid",
          message:
            "The declaration did not confirm independent values and a definition identity.",
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
