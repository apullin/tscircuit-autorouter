#!/bin/bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
S=${SAMPLE:-6}
CAP=${CAP:-0}
t0=$(date +%s)
out=$(TS_NODE_WORK_CAP=$CAP timeout 900 bun scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample $S 2>&1 | grep -E "^completed|Success:|DRC errors:" | tr '\n' ' ')
t1=$(date +%s)
echo "RESULT sample=$S cap=$CAP wall=$((t1-t0))s $out"
