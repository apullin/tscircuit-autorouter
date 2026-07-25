#!/bin/bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
D=/home/pullin/personal/awt-ts2/node_modules/@tscircuit/math-utils/dist
S=${SAMPLE:-6}
for i in 1 2; do
  for v in orig parametric; do
    rm -rf $D && cp -r /tmp/math-utils-dist-$v $D
    cd /home/pullin/personal/awt-r3
    t0=$(date +%s)
    out=$(timeout 900 bun scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample $S 2>&1 | grep -E "^completed|Success:|DRC errors:" | tr '\n' ' ')
    t1=$(date +%s)
    echo "MU-AB sample=$S run=$i ver=$v wall=$((t1-t0))s $out"
  done
done
rm -rf $D && cp -r /tmp/math-utils-dist-parametric $D
