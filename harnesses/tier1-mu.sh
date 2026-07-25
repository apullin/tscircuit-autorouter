#!/bin/bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
D=/home/pullin/personal/awt-ts2/node_modules/@tscircuit/math-utils/dist
cd /home/pullin/personal/awt-r3
for v in orig parametric; do
  rm -rf $D && cp -r /tmp/math-utils-dist-$v $D
  t0=$(date +%s)
  ./benchmark.sh --dataset 18 --sample-numbers 5,8,10,6,12 --concurrency 5 --sample-timeout 360s > /tmp/tier1-$v.log 2>&1
  t1=$(date +%s)
  cp benchmark-result.json /tmp/tier1-$v.json
  echo "TIER1 ver=$v wall=$((t1-t0))s"
done
rm -rf $D && cp -r /tmp/math-utils-dist-parametric $D
