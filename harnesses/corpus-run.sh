#!/bin/bash
# Clean full-corpus run on the current working tree. No concurrent edits allowed
# while this runs (the harness imports lib/ source directly).
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
OUT=$HOME/.perf-scratch
t0=$(date +%s)
./benchmark.sh --dataset 18 --concurrency 8 --sample-timeout 360s > $OUT/srj18.log 2>&1
cp benchmark-result.json $OUT/srj18-final.json
t1=$(date +%s)
echo "CORPUS srj18 done in $((t1-t0))s"
./benchmark.sh --dataset 01 --concurrency 8 --sample-timeout 360s > $OUT/ds01.log 2>&1
cp benchmark-result.json $OUT/ds01-final.json
t2=$(date +%s)
echo "CORPUS dataset01 done in $((t2-t1))s"
echo "CORPUS total $((t2-t0))s"
