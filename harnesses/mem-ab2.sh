#!/bin/bash
# Interleaved peak-RSS A/B: main vs current, alternating per sample, two rounds.
# Peak RSS in a GC'd runtime depends on machine memory pressure, so the arms
# must be adjacent in time.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
MAIN=/home/pullin/personal/tscircuit-autorouter
CUR=/home/pullin/personal/awt-r3
for round in 1 2; do
  for S in 5 8 6; do
    for arm in main current; do
      if [ "$arm" = "main" ]; then D=$MAIN; else D=$CUR; fi
      cd $D
      out=$(/usr/bin/time -f "MAXRSS_KB=%M WALL=%e" timeout 420 bun scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample $S 2>&1)
      rss=$(echo "$out" | grep -o "MAXRSS_KB=[0-9]*" | cut -d= -f2)
      wall=$(echo "$out" | grep -o "WALL=[0-9.]*" | cut -d= -f2)
      echo "MEM2 round=$round sample=$S arm=$arm peak_rss_mb=$(( ${rss:-0} / 1024 )) wall=${wall}s"
    done
  done
done
