import type { NodeClient } from "../client.ts";
import { defaultReadConfigPath, type Config } from "../config.ts";
import { ownedSchemas } from "../multi-key.ts";
import { conversionPlan, executeConversion } from "../schema-conversion.ts";
import { HISTORICAL_SCHEMAS } from "../legacy-schemas.ts";
import { aliasesFor } from "../canonical-vocabulary.ts";

export async function convertMultiKey(
  node: NodeClient,
  cfg: Config,
  options: {
    apply?: boolean;
    maintenance?: boolean;
    abort?: boolean;
    configPath?: string;
  } = {},
) {
  const path = options.configPath ?? cfg.configPath ?? defaultReadConfigPath();
  const entries = [
    ...ownedSchemas().map(({ key, schema }) => ({ keys: [key], schema })),
    ...HISTORICAL_SCHEMAS.map(({ key, schema }) => ({
      keys: [key],
      schema: { ...schema, independent_fields: true, alternate_keys: {} },
      historical: true,
    })),
  ];
  const plan = await conversionPlan(
    node,
    cfg,
    entries,
    async (entry, source) => {
      if (!["card", "board", "milestone"].includes(entry.keys[0]!)) return null;
      const field = source.fields.includes("body")
        ? "body"
        : aliasesFor(entry.schema).body;
      if (!field || !source.fields.includes(field))
        throw new Error("The source has no body membership field.");
      return { kind: "field_exists", field };
    },
    path,
  );
  return executeConversion(node, plan, options);
}
