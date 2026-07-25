#!/bin/bash
# Exhaustion abandonment WITH the hopelessness guard: only give up when no
# candidate has ever routed more than P of the node's segments.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
for S in ${SAMPLES:-8 2}; do
  for P in ${PS:-0.999 0.5 0.25}; do
    t0=$(date +%s)
    out=$(TS_MAX_EXHAUSTIONS=${K:-30} TS_ABANDON_MAX_PROGRESS=$P timeout 900 bun scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample $S 2>&1 | grep -E "Success:|DRC errors:" | tr '\n' ' ')
    t1=$(date +%s)
    echo "GUARD sample=$S K=${K:-30} P=$P wall=$((t1-t0))s $out"
  done
done
