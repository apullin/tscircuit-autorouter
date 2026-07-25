#!/bin/bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
SC=$HOME/.perf-scratch
for T in 0 32 64 128 100000; do
  out=$(TS_LINEAR_SCAN_MAX=$T SAMPLE=8 timeout 700 bun $SC/a2-harness.ts 2>&1 | grep -E '"wall"|"hash"' | tr -d ' \n')
  echo "SWEEP threshold=$T $out"
done
SAMPLE=6 $SC/ab-lin.sh
