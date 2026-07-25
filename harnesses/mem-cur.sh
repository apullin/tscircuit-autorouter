#!/bin/bash
# Re-measure peak RSS on the current tree only (main-arm figures are fixed:
# sample 5 = 3959MB, sample 8 = 2421MB, sample 6 >= 9613MB). One at a time.
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
cd /home/pullin/personal/awt-r3
for S in 5 8 6; do
  out=$(/usr/bin/time -f "MAXRSS_KB=%M WALL=%e" timeout 500 bun scripts/run-sample.ts --pipeline 7 --dataset srj18 --sample $S 2>&1)
  rss=$(echo "$out" | grep -o "MAXRSS_KB=[0-9]*" | cut -d= -f2)
  wall=$(echo "$out" | grep -o "WALL=[0-9.]*" | cut -d= -f2)
  drc=$(echo "$out" | grep -o "DRC errors: [0-9]*" | tail -1 | grep -o "[0-9]*$")
  echo "MEMCUR sample=$S peak_rss_mb=$(( ${rss:-0} / 1024 )) wall=${wall}s drc=${drc:-?}"
done
