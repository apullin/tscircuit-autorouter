#!/bin/bash
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
MAIN=/home/pullin/personal/tscircuit-autorouter
CUR=/home/pullin/personal/awt-r3
for S in 5 8 6; do
  for arm in main current; do
    if [ "$arm" = "main" ]; then D=$MAIN; else D=$CUR; fi
    cd $D
    out=$(/usr/bin/time -f "MAXRSS_KB=%M WALL=%e" timeout 420 bun scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample $S 2>&1)
    rss=$(echo "$out" | grep -o "MAXRSS_KB=[0-9]*" | cut -d= -f2)
    wall=$(echo "$out" | grep -o "WALL=[0-9.]*" | cut -d= -f2)
    drc=$(echo "$out" | grep -o "DRC errors: [0-9]*" | tail -1 | grep -o "[0-9]*$")
    echo "MEM sample=$S arm=$arm peak_rss_mb=$(( ${rss:-0} / 1024 )) wall=${wall}s drc=${drc:-?}"
  done
done
