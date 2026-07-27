#!/usr/bin/env bash
# G10 Lever-1: targetMinCapacity sweep on s8 (deeper mesh in dense regions).
# Base 0.5 comes from the gauntlet's seq leg. Serial, quiet-box protocol.
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
OUT=/tmp/g10-tmc-sweep-s8.jsonl
: > "$OUT"
for tmc in 0.4 0.3 0.25; do
  echo "{\"tmc\": $tmc, $(TS_PARALLEL_HD_NODES=0 TS_PARALLEL_A2=0 timeout 600 bun scripts/eviction-probe.ts --dataset srj18 --sample 8 --target-min-capacity "$tmc" 2>/dev/null | tr -d '\n ' | sed 's/^{//;s/}$//')}" >> "$OUT"
  echo "done tmc $tmc"
done
echo "SWEEP COMPLETE"
