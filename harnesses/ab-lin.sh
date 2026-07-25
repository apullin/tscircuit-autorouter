#!/bin/bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
F=lib/solvers/HighDensitySolver/SingleHighDensityRouteSolver.ts
S=${SAMPLE:-8}
SC=$HOME/.perf-scratch
for i in 1 2; do
  for v in pre post; do
    cp $SC/$v-lin.ts $F
    out=$(SAMPLE=$S timeout 700 bun $SC/a2-harness.ts 2>&1 | grep -E '"wall"|"hash"' | tr -d ' \n')
    echo "AB-LIN sample=$S run=$i ver=$v $out"
  done
done
cp $SC/post-lin.ts $F
