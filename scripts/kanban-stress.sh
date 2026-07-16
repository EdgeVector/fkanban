#!/usr/bin/env bash
# Consistency stress harness for fkanban over the LastDB Unix-socket transport.
#
# It writes only to an isolated scratch board, reports machine-readable findings,
# and exits 0 so scheduled callers can parse the report without canceling their
# queue. FINDING means a persisted consistency violation; ERROR means harness,
# liveness, or configuration trouble.

set -o pipefail

FK="${FKANBAN:-kanban}"
BOARD="${KSTRESS_BOARD:-agent-dogfood-scratch}"
N="${KSTRESS_N:-8}"
BURST="${KSTRESS_BURST:-10}"
RUN="kstress-$(date +%s)-$$"
FIXED_COLUMNS="backlog,todo,doing,done"

findings=()
errors=()
created=()

finding() { findings+=("$1 | $2"); printf 'FINDING: %s | %s\n' "$1" "$2"; }
errlog() { errors+=("$1"); printf 'ERROR: %s\n' "$1"; }

fkjson() { "$FK" show "$1" --json 2>/dev/null; }
field() { fkjson "$1" | jq -r "$2 // empty" 2>/dev/null; }

ensure_board() {
  local board="$1" title="$2" out rc
  out=$("$FK" board create "$board" --title "$title" --columns "$FIXED_COLUMNS" --json 2>&1)
  rc=$?
  if [ "$rc" != "0" ]; then
    errlog "board create $board failed rc=$rc out=$(printf '%s' "$out" | tr '\n' ' ')"
    return 1
  fi
  if ! printf '%s' "$out" | jq -e '.slug == "'"$board"'"' >/dev/null 2>&1; then
    errlog "board create $board returned unexpected output: $(printf '%s' "$out" | tr '\n' ' ')"
    return 1
  fi
  return 0
}

# Preflight
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq not found - cannot assert JSON read-backs"
  echo "SUMMARY: findings=0 errors=1 board=$BOARD run=$RUN"
  exit 0
fi
if ! "$FK" board list --json >/dev/null 2>&1; then
  echo "ERROR: node/board unreachable - skipping stress run (retries next schedule)"
  echo "SUMMARY: findings=0 errors=1 board=$BOARD run=$RUN"
  exit 0
fi
ensure_board "$BOARD" "agent dogfood scratch" || {
  echo "SUMMARY: findings=0 errors=${#errors[@]} board=$BOARD run=$RUN"
  exit 0
}

echo "kanban-stress run=$RUN board=$BOARD N=$N burst=$BURST"

# 1. create -> read-back
i=1
while [ "$i" -le "$N" ]; do
  s="$RUN-c$i"; title="stress $RUN card $i"; body="body-$RUN-$i"
  res=$("$FK" add "$s" --title "$title" --board "$BOARD" --column todo --tags kstress --repo EdgeVector/fold --body "$body" --json 2>/dev/null)
  if ! printf '%s' "$res" | jq -e '.slug' >/dev/null 2>&1; then
    errlog "add $s did not ACK: $(printf '%s' "$res" | tr '\n' ' ')"
    i=$((i+1)); continue
  fi
  created+=("$s")
  j=$(fkjson "$s")
  if [ -z "$j" ]; then
    finding "lost-write" "$s: add ACKed but show read back nothing"
    i=$((i+1)); continue
  fi
  gt=$(printf '%s' "$j" | jq -r '.title // empty')
  gb=$(printf '%s' "$j" | jq -r '.body // empty')
  gc=$(printf '%s' "$j" | jq -r '.column // empty')
  [ "$gt" = "$title" ] || finding "stale-read-title" "$s: wrote '$title' read '$gt'"
  case "$gb" in *"$body"*) : ;; *) finding "stale-read-body" "$s: wrote '$body' not found in read-back '$gb'" ;; esac
  [ "$gc" = "todo" ] || finding "wrong-column" "$s: wrote todo read '$gc'"
  i=$((i+1))
done

# 2. update -> read-back
if [ "$N" -ge 1 ]; then
  s="$RUN-c1"; new="updated-$RUN-$(date +%s%N)"
  "$FK" add "$s" --title "$new" --board "$BOARD" --repo EdgeVector/fold >/dev/null 2>&1
  got=$(field "$s" '.title')
  [ "$got" = "$new" ] || finding "stale-read-update" "$s: updated to '$new' but read '$got'"
fi

# 3. move -> read-back through fixed non-terminal and terminal columns
if [ "$N" -ge 1 ]; then
  s="$RUN-c1"
  for col in doing done; do
    "$FK" move "$s" "$col" --force >/dev/null 2>&1
    got=$(field "$s" '.column')
    [ "$got" = "$col" ] || finding "move-not-persisted" "$s: moved to $col but read '$got'"
  done
fi

# 4. tag add/rm -> read-back
if [ "$N" -ge 4 ]; then
  s="$RUN-c4"
  "$FK" tag add "$s" zztag1 >/dev/null 2>&1
  field "$s" '.tags[]' | grep -qx zztag1 || finding "tag-add-not-persisted" "$s: tag add zztag1 not read back"
  "$FK" tag rm "$s" zztag1 >/dev/null 2>&1
  if field "$s" '.tags[]' | grep -qx zztag1; then finding "tag-rm-not-persisted" "$s: tag rm zztag1 still present"; fi
fi

# 5. read stability
if [ "$N" -ge 5 ]; then
  s="$RUN-c5"; a=$(fkjson "$s"); k=1
  while [ "$k" -le 4 ]; do
    b=$(fkjson "$s")
    [ "$a" = "$b" ] || { finding "unstable-read" "$s: consecutive read-backs differ"; break; }
    a="$b"; k=$((k+1))
  done
fi

# 6. concurrency burst
tmp=$(mktemp -d 2>/dev/null || echo "/tmp/kstress.$$"); mkdir -p "$tmp"
i=1
while [ "$i" -le "$BURST" ]; do
  s="$RUN-b$i"
  ( "$FK" add "$s" --title "burst $i $RUN" --board "$BOARD" --column todo --tags kstress --repo EdgeVector/fold --json >"$tmp/b$i.out" 2>/dev/null; echo $? >"$tmp/b$i.rc" ) &
  i=$((i+1))
done
wait
i=1
while [ "$i" -le "$BURST" ]; do
  s="$RUN-b$i"
  rc=$(cat "$tmp/b$i.rc" 2>/dev/null || echo 1)
  ack=$(jq -r '.slug // empty' "$tmp/b$i.out" 2>/dev/null)
  if [ "$rc" != "0" ] || [ -z "$ack" ]; then
    errlog "concurrent add $s failed rc=$rc out=$(tr '\n' ' ' <"$tmp/b$i.out" 2>/dev/null)"
    i=$((i+1)); continue
  fi
  created+=("$s")
  if [ -z "$(field "$s" '.slug')" ]; then
    finding "lost-write-concurrent" "$s: add ACKed but absent on read-back"
  fi
  i=$((i+1))
done

# 7. concurrent updates to one card
if [ "$N" -ge 2 ]; then
  u="$RUN-c2"; vals=""; i=1
  while [ "$i" -le "$BURST" ]; do
    v="v$i-$RUN"; vals="$vals|$v|"
    ( "$FK" add "$u" --title "$v" --board "$BOARD" --repo EdgeVector/fold >/dev/null 2>&1 ) &
    i=$((i+1))
  done
  wait
  r1=$(field "$u" '.title'); r2=$(field "$u" '.title'); r3=$(field "$u" '.title')
  if [ "$r1" != "$r2" ] || [ "$r2" != "$r3" ]; then
    finding "unstable-read-after-concurrent-update" "$u: reads diverged '$r1'/'$r2'/'$r3'"
  fi
  case "$vals" in *"|$r1|"*) : ;; *) finding "torn-write" "$u: final title '$r1' is not any written value" ;; esac
fi

rm -rf "$tmp" 2>/dev/null || true

# 8. search index consistency
if [ "$N" -ge 6 ]; then
  tok="kdogtok$(date +%s)"
  ss="$RUN-s1"
  "$FK" add "$ss" --title "find me $tok" --board "$BOARD" --column todo --tags kstress --repo EdgeVector/fold >/dev/null 2>&1
  created+=("$ss")
  if ! "$FK" search "$tok" --board "$BOARD" --json --all 2>/dev/null | grep -q "$ss"; then
    if [ -n "$(field "$ss" '.slug')" ]; then
      finding "search-index-divergence" "$ss: readable via show but search('$tok') missed it"
    else
      errlog "search test card $ss not created"
    fi
  fi
fi

# 9. delete -> read-back
if [ "$N" -ge 3 ]; then
  d="$RUN-c3"
  "$FK" rm "$d" >/dev/null 2>&1
  if [ -n "$(field "$d" '.slug')" ]; then
    finding "delete-not-persisted" "$d: rm ACKed but card still readable via show"
  fi
fi

# 10. board-record durability + enumeration consistency
board_state() {
  local s="$1" a b
  a=$("$FK" board list --json 2>/dev/null | jq -r '[.[]?.slug]|join(",")' 2>/dev/null)
  [ -z "$a" ] && { echo readfail; return; }
  case ",$a," in *",$s,"*) echo present; return;; esac
  b=$("$FK" board list --json 2>/dev/null | jq -r '[.[]?.slug]|join(",")' 2>/dev/null)
  [ -z "$b" ] && { echo readfail; return; }
  case ",$b," in *",$s,"*) echo present; return;; esac
  echo missing
}

bd=(zz-kstress-bd-1 zz-kstress-bd-2 zz-kstress-bd-3)
for b in "${bd[@]}"; do
  if ensure_board "$b" "kstress board-durability"; then
    case "$(board_state "$b")" in
      missing) finding "board-create-not-readback" "$b: board create ACKed but confirmed absent from board list";;
      readfail) errlog "board list empty/unreadable during create-readback of $b";;
    esac
  fi
done

for b in "${bd[@]}" "$BOARD"; do
  case "$(board_state "$b")" in
    missing) finding "board-record-vanished" "$b: present-then-confirmed-absent";;
    readfail) errlog "board list empty/unreadable during durability re-check of $b";;
  esac
done

tmpbc=$(mktemp -d 2>/dev/null || echo "/tmp/kstress-bc.$$"); mkdir -p "$tmpbc"
i=0
while [ "$i" -lt 4 ]; do
  b="zz-kstress-bcburst-$i"
  ( "$FK" board create "$b" --title "bc $RUN" --columns "$FIXED_COLUMNS" --json >"$tmpbc/bc$i.out" 2>&1; echo $? >"$tmpbc/bc$i.rc" ) &
  i=$((i+1))
done
wait
i=0
while [ "$i" -lt 4 ]; do
  rc=$(cat "$tmpbc/bc$i.rc" 2>/dev/null || echo 1)
  out=$(tr '\n' ' ' <"$tmpbc/bc$i.out" 2>/dev/null)
  if [ "$rc" != "0" ]; then
    errlog "board create zz-kstress-bcburst-$i failed rc=$rc out=$out"
  fi
  i=$((i+1))
done
lost=0; rf=0; i=0
while [ "$i" -lt 4 ]; do
  case "$(board_state "zz-kstress-bcburst-$i")" in missing) lost=$((lost+1));; readfail) rf=$((rf+1));; esac
  i=$((i+1))
done
[ "$lost" -gt 0 ] && finding "board-concurrent-lost-write" "$lost/4 boards from a concurrent create burst were confirmed absent afterward"
[ "$rf" -gt 0 ] && errlog "board list unreadable for $rf/4 concurrent-burst re-checks"
rm -rf "$tmpbc" 2>/dev/null || true

for b in "${bd[@]}" zz-kstress-bcburst-0 zz-kstress-bcburst-1 zz-kstress-bcburst-2 zz-kstress-bcburst-3; do
  "$FK" board rm "$b" --force >/dev/null 2>&1 || true
done

if [ "${#created[@]}" -gt 0 ]; then
  for s in "${created[@]}"; do "$FK" rm "$s" >/dev/null 2>&1 || true; done
fi

echo "SUMMARY: findings=${#findings[@]} errors=${#errors[@]} board=$BOARD run=$RUN"
