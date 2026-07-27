#!/usr/bin/env bash
# srj18 gauntlet A/B: sequential (flags pinned 0) vs productized auto-default
# (env -u CI, flags unset), interleaved per sample at concurrency 1.
# 480s per-run cap; JSON lines out to /tmp/gauntlet-auto-ab.jsonl.
set -u
cd "$(dirname "$0")/.."
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
OUT=/tmp/gauntlet-auto-ab.jsonl
: > "$OUT"
for sample in $(seq 1 16); do
  echo "{\"sample\": $sample, \"mode\": \"seq\", $(TS_PARALLEL_HD_NODES=0 TS_PARALLEL_A2=0 timeout 480 bun scripts/eviction-probe.ts --dataset srj18 --sample "$sample" 2>/dev/null | tr -d '\n ' | sed 's/^{//;s/}$//')}" >> "$OUT"
  echo "{\"sample\": $sample, \"mode\": \"auto\", $(env -u CI timeout 480 bun scripts/eviction-probe.ts --dataset srj18 --sample "$sample" 2>/dev/null | tr -d '\n ' | sed 's/^{//;s/}$//')}" >> "$OUT"
  echo "done sample $sample"
done
echo "GAUNTLET COMPLETE"
