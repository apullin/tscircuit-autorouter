#!/bin/bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
F=lib/solvers/HighDensitySolver/SingleHighDensityRouteSolver.ts
S=${SAMPLE:-8}
for i in 1 2; do
  for v in pre post; do
    cp /tmp/$v-shd.ts $F
    t0=$(date +%s%N)
    out=$(SAMPLE=$S timeout 600 bun /tmp/a2-harness.ts 2>&1 | grep -E '"wall"|"hash"' | tr -d ' \n')
    t1=$(date +%s%N)
    echo "AB sample=$S run=$i ver=$v elapsed=$(( (t1-t0)/1000000 ))ms $out"
  done
done
cp /tmp/post-shd.ts $F
