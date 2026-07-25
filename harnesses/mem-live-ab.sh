#!/bin/bash
# Live-set A/B: main vs current, arms adjacent in time, deterministic metric.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
for S in 5 8 6; do
  for REPO in /home/pullin/personal/tscircuit-autorouter /home/pullin/personal/awt-r3; do
    cd $REPO
    out=$(REPO=$REPO SAMPLE=$S timeout 500 bun $HOME/.perf-scratch/mem-probe.ts 2>&1 | tail -1)
    echo "LIVE $out"
  done
done
