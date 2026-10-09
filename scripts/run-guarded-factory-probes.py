#!/usr/bin/env python3
"""Run the installed probe helper serially against one frozen source slot."""
import json, subprocess, sys
from pathlib import Path
fields="slug title body board column position assignee tags deps surfaces created_at created_by updated_at db repo base kind block_status block_reason north_star milestone pr_url branch".split()
cases=[("field",field,"src/guarded-factory.ts",f"raw23 isolated {field} race") for field in fields]
cases += [("field",field,"src/guarded-factory.ts",f"exact claim stage 2 isolated {field}") for field in ["body","block_status","block_reason","updated_at"]]
cases += [("readback","","src/guarded-factory.ts","stage1 durable readback mismatch") ]
cases += [("build","","src/guarded-factory.ts","unproved compound build unknown"),("unowned","","src/guarded-factory.ts","initial exact claim refuses same-worker"),("deps","","src/guarded-factory.ts","native dependency keys batch and missing"),("peer","","src/guarded-factory.ts","accepted-held resume current canonical peer overlap"),("empty-status","","src/guarded-factory.ts","legitimate empty unheld status"),("sha","","src/guarded-snapshot.ts","malformed sha"),("witness","","src/guarded-snapshot.ts","sequential same-owner GOAL"),("fifo","","src/guarded-snapshot.ts","FIFO snapshot"),("symlink","","src/guarded-snapshot.ts","symlink and oversized"),("drain-cap","","src/client.ts","chunked raw response byte cap"),("incomplete","","src/client.ts","real raw known-key incomplete"),("unresolved","","src/client.ts","real raw known-key unresolved-type"),("count","","src/client.ts","real raw known-key count"),("duplicate","","src/guarded-snapshot.ts","snapshot batch duplicate")]
cases += [("situation","","src/guarded-factory.ts","intended doing Situation"),("ack","","src/client.ts","real NodeClient memory acknowledgement"),("broad-set","","src/commands/set.ts","finite guarded broad set"),("force-move","","src/commands/move.ts","finite guarded force move"),("from-move","","src/guarded-factory.ts","finite guarded wrong from")]
cases += [("silent-force","","src/guarded-factory.ts","no gate bails on --force in silence")]
# The source force-census probe uses its own static test file.
evidence=[]
for mode,field,target,test in cases:
    test_file="test/forced-guard-waivers-are-voiced.test.ts" if mode=="silent-force" else "test/guarded-factory.test.ts"
    argv=["last-stack-mutation-probe","--name",f"raw23-{mode}-{field or 'guard'}","--target",target,"--patch",f"python3 scripts/probe-guarded-factory-patch.py {mode} {field}","--test",f"bun test {test_file} -t '{test}'","--expect-red-on",f"(fail).*{test}"]
    result=subprocess.run(argv,text=True,capture_output=True,timeout=30)
    evidence.append({"mode":mode,"field":field,"test":test,"exit":result.returncode,"stdout":result.stdout,"stderr":result.stderr})
    Path(sys.argv[1]).write_text(json.dumps(evidence,indent=2)+"\n")
    print(f"{mode}:{field or '-'} exit={result.returncode}",flush=True)
    if result.returncode:raise SystemExit(result.returncode)
