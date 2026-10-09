#!/usr/bin/env python3
"""Exact source mutations for the targeted guard proof; the helper restores each target."""
import sys
from pathlib import Path
name=sys.argv[1]
field=sys.argv[2] if len(sys.argv)>2 else ""
path=Path("src/guarded-factory.ts")
if name=="field":
    old="...CARD_FIELDS.map(field => ({ schemaHash: witness.schema_hash"
    new=f'...CARD_FIELDS.filter(field => field !== "{field}").map(field => ({{ schemaHash: witness.schema_hash'
elif name=="situation":
    old='await assertSituationPreflightAllowed(next, opts.situationPreflight);';new=''
elif name=="ack":
    path=Path("src/client.ts");old='(res.json as { durability?: string } | undefined)?.durability !== "durable"';new='false'
elif name=="broad-set":
    path=Path("src/commands/set.ts");old='opts.blockStatus, opts.blockReason, opts.northStar, opts.milestone].some(v => v !== undefined) || opts.force';new='opts.blockStatus, opts.blockReason, opts.northStar, opts.milestone].some(v => false) || false'
elif name=="force-move":
    path=Path("src/commands/move.ts");old='if (opts.force || opts.position !== undefined || opts.assignee !== undefined || opts.worker !== undefined || opts.allowUnclaimed)';new='if (false)'
elif name=="silent-force":
    old="  const keys = [...new Set(next.deps)];";new="  const force = (opts as Context & {force?:boolean}).force;\n  if (force) return;\n"+old
elif name=="from-move":
    old='if (!promotion && !completion)';new='if (false)'
elif name=="readback":
    old="if (!rawEqual(actual.fields, intended))";new="if (false)"
elif name=="build":
    old="version.build !== COMPOUND_CARD_BUILD";new="false"
elif name=="unowned":
    old='if (owner !== "") guardError';new='if (false) guardError'
elif name=="deps":
    old='if (status.blocked) guardError';new='if (false) guardError'
elif name=="peer":
    old='if(surfacesOverlap(card,peer))guardError';new='if(false)guardError'
elif name=="empty-status":
    old='["", "none"].includes(String(snapshot.fields.block_status))';new='["none"].includes(String(snapshot.fields.block_status))'
elif name=="sha":
    path=Path("src/guarded-snapshot.ts");old='sha256(json) !== hash';new='false'
elif name=="witness":
    path=Path("src/guarded-snapshot.ts");old='if (!rawEqual(supplied.fields, current.fields))';new='if (false)'
elif name=="fifo":
    path=Path("src/guarded-snapshot.ts");old='constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK';new='constants.O_RDONLY | constants.O_NOFOLLOW'
elif name=="symlink":
    path=Path("src/guarded-snapshot.ts");old='constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK';new='constants.O_RDONLY | constants.O_NONBLOCK'
elif name=="drain-cap":
    path=Path("src/client.ts");old='if(size>opts.maxResponseBytes)';new='if(false)'
elif name=="incomplete":
    path=Path("src/client.ts");old='body.has_more!==false';new='false'
elif name=="unresolved":
    path=Path("src/client.ts");old='/skip|dangling|missing_atom|unresolved/i.test(k) && v!==0';new='false'
elif name=="count":
    path=Path("src/client.ts");old='body.returned_count!==undefined && body.returned_count!==body.results.length';new='false'
elif name=="duplicate":
    path=Path("src/guarded-snapshot.ts");old='bySlug.has(slug)';new='false'
else:raise SystemExit("unknown mutation")
s=path.read_text();assert s.count(old)==1,(name,s.count(old));path.write_text(s.replace(old,new))
