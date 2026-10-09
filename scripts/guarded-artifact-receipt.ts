// Build-time immutable receipt. Runs only against this artifact's compiled CLIs.
import { readFileSync, writeFileSync } from "node:fs";
import { sha256, GUARDED_CONTRACT, GUARDED_CONTRACT_SHA256 } from "../src/guarded-snapshot.ts";
const root = new URL("../", import.meta.url).pathname;
const cli = Bun.spawnSync([root+"dist/kanban", "guarded-contract", "--json"], {env:{...process.env,KANBAN_CONFIG:"/nonexistent-guarded-build-config"},stdout:"pipe",stderr:"pipe"});
if(cli.exitCode!==0)throw Error("Compiled guarded contract requires config or failed.");
const contract=JSON.parse(new TextDecoder().decode(cli.stdout));
if(contract.contract_sha256!==GUARDED_CONTRACT_SHA256)throw Error("Compiled contract differs from the source contract.");
const files=[...new Bun.Glob("**/*.ts").scanSync({cwd:root+"src",onlyFiles:true})].sort();
const manifest=files.map(path=>({path:"src/"+path,sha256:sha256(readFileSync(root+"src/"+path))}));
const git=Bun.spawnSync(["git","rev-parse","HEAD"],{cwd:root,stdout:"pipe",stderr:"pipe"});
if(git.exitCode!==0)throw Error("Artifact source commit is unavailable.");
writeFileSync(root+"dist/guarded-contract.json", JSON.stringify({version:1,contract:GUARDED_CONTRACT,
  contract_sha256:GUARDED_CONTRACT_SHA256,source_commit:new TextDecoder().decode(git.stdout).trim(),
  source_manifest_sha256:sha256(JSON.stringify(manifest)),source_manifest:manifest,
  cli_sha256:sha256(readFileSync(root+"dist/kanban")),mcp_sha256:sha256(readFileSync(root+"dist/kanban-mcp")),
},null,2)+"\n");
