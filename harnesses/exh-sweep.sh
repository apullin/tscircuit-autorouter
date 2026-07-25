#!/bin/bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
S=${SAMPLE:-8}
for K in ${KS:-0 10 20 30 40}; do
  t0=$(date +%s)
  out=$(TS_MAX_EXHAUSTIONS=$K timeout 900 bun scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample $S 2>&1 | grep -E "^completed|Success:|DRC errors:" | tr '\n' ' ')
  t1=$(date +%s)
  echo "EXH sample=$S K=$K wall=$((t1-t0))s $out"
done
