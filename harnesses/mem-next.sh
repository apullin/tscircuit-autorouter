#!/bin/bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
echo "--- baseline (default heap)"
/usr/bin/time -f "RSS_MB=%M_KB WALL=%e" bun scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample 8 2>&1 | grep -E "RSS_MB|DRC errors"
echo "--- bun --smol (constrained heap)"
/usr/bin/time -f "RSS_MB=%M_KB WALL=%e" bun --smol scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample 8 2>&1 | grep -E "RSS_MB|DRC errors"
echo "--- heap composition at peak live"
REPO=/home/pullin/personal/awt-r3 SAMPLE=8 bun $HOME/.perf-scratch/heap-composition.ts 2>&1 | tail -40
