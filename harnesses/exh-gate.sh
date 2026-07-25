#!/bin/bash
# Full-corpus quality gate for TS_MAX_EXHAUSTIONS=30 (baseline results already
# captured in srj18-final.json / ds01-final.json with the knob off).
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
OUT=$HOME/.perf-scratch
export TS_MAX_EXHAUSTIONS=30
t0=$(date +%s)
./benchmark.sh --dataset 18 --concurrency 8 --sample-timeout 360s > $OUT/srj18-k30.log 2>&1
cp benchmark-result.json $OUT/srj18-k30.json
t1=$(date +%s)
echo "GATE srj18 K=30 done in $((t1-t0))s"
./benchmark.sh --dataset 01 --concurrency 8 --sample-timeout 360s > $OUT/ds01-k30.log 2>&1
cp benchmark-result.json $OUT/ds01-k30.json
t2=$(date +%s)
echo "GATE dataset01 K=30 done in $((t2-t1))s"
