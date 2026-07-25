#!/bin/bash
# Sweep the per-growth-attempt inner budget. 0 = upstream default (unbounded,
# so a node that only routes at 2x first burns its whole 1x budget).
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-exp
for S in ${SAMPLES:-8}; do
  for N in ${ITERS:-0 100000 300000 1000000}; do
    t0=$(date +%s)
    out=$(TS_MAX_INNER_ITERS=$N timeout 900 bun scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample $S 2>&1 | grep -E "Success:|DRC errors:" | tr '\n' ' ')
    t1=$(date +%s)
    echo "INNER sample=$S cap=$N wall=$((t1-t0))s $out"
  done
done
