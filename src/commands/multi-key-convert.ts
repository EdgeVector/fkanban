import type { NodeClient } from "../client.ts";
import { defaultReadConfigPath, type Config } from "../config.ts";
import { ownedSchemas } from "../multi-key.ts";
import { conversionPlan, executeConversion } from "../schema-conversion.ts";

export async function convertMultiKey(node: NodeClient, cfg: Config,
  options: {apply?:boolean;maintenance?:boolean;abort?:boolean;configPath?:string} = {}) {
  const entries=ownedSchemas().map(({key,schema})=>({keys:[key],schema}));
  const plan=await conversionPlan(node,cfg,entries,async(entry,source)=>{
    if (!["card","board","milestone"].includes(entry.keys[0]!)) return null;
    const aliases=cfg.schemaFieldAliases?.[cfg.schemaHashes[entry.keys[0]!]!];
    const field=aliases?.body ?? "body";
    if (!source.fields.includes(field)) throw new Error("The source has no body membership field.");
    return {kind:"field_exists",field};
  },["board_cards","milestone_cards","board_milestones","card_list_index","kanban_list_head"]);
  return executeConversion(node,cfg,options.configPath ?? cfg.configPath ?? defaultReadConfigPath(),plan,options);
}
