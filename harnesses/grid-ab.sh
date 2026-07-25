#!/bin/bash
# Interleaved legacy-vs-exact-grid comparison with quality metrics.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
for S in ${SAMPLES:-8 6}; do
  for round in 1 2; do
    for G in 0 1; do
      if [ "$G" = "0" ]; then export TS_EXACT_GRID=0; else unset TS_EXACT_GRID; fi
      out=$(SAMPLE=$S timeout 900 bun $HOME/.perf-scratch/metrics.ts 2>&1 | tail -1)
      echo "GRIDAB round=$round $out"
    done
  done
done
