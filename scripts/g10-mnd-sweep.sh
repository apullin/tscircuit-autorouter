#!/usr/bin/env bash
# G10 Lever-1b: maxNodeDimension sweep on s8 (the pipeline-7 mesh granularity
# knob; targetMinCapacity/capacityDepth are DEAD opts in pipeline 7).
# Base 16 comes from the gauntlet's seq leg. Serial, quiet-box protocol.
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
OUT=/tmp/g10-mnd-sweep-s8.jsonl
: > "$OUT"
for mnd in 8 4 2; do
  echo "{\"maxNodeDimension\": $mnd, $(TS_PARALLEL_HD_NODES=0 TS_PARALLEL_A2=0 timeout 600 bun scripts/eviction-probe.ts --dataset srj18 --sample 8 --max-node-dimension "$mnd" 2>/dev/null | tr -d '\n ' | sed 's/^{//;s/}$//')}" >> "$OUT"
  echo "done maxNodeDimension $mnd"
done
echo "SWEEP COMPLETE"
