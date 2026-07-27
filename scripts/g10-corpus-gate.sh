#!/usr/bin/env bash
# G10 corpus gate: srj18 x16 at maxNodeDimension=4, effort=2 (candidate
# quality config) vs the default legs in /tmp/gauntlet-auto-ab.jsonl (seq mode).
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
OUT=/tmp/g10-corpus-mnd4eff2.jsonl
: > "$OUT"
for sample in $(seq 1 16); do
  echo "{\"sample\": $sample, \"cfg\": \"mnd4-eff2\", $(TS_PARALLEL_HD_NODES=0 TS_PARALLEL_A2=0 timeout 900 bun scripts/eviction-probe.ts --dataset srj18 --sample "$sample" --max-node-dimension 4 --effort 2 2>/dev/null | tr -d '\n ' | sed 's/^{//;s/}$//')}" >> "$OUT"
  echo "done sample $sample"
done
echo "GATE COMPLETE"
