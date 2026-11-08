import { profilesFor } from "./canonical-vocabulary.ts";
import { FkanbanError, type NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { MULTI_KEY_MODEL, ownedSchemas } from "./multi-key.ts";
import { OWNER_APP_ID } from "./schemas.ts";

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

export async function syncOwnedModel(
  node: NodeClient,
  base: Config,
  existing: Config | null,
  canonicalVocabulary: boolean,
): Promise<Config> {
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
  const known = declarations;
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
  const schemaHashes = Object.fromEntries(
    resolved.map((entry) => [entry.key, entry.runtime]),
  );
  const schemaIdentities = Object.fromEntries(
    resolved.map((entry) => [entry.key, entry.identity]),
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
          ...resolved.map((entry) =>
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
