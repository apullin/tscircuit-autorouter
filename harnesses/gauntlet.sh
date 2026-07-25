#!/usr/bin/env bash
# Benchmark gauntlet: each branch in turn, 8 workers max (MEMORY-capped, not core-capped).
# Each branch: 2 srj18 runs at 480s sample timeout, then dataset01, then a quiet combined run.
# NOTE: 8 is a hard memory ceiling for this box — solves hold GB-scale heaps and going wider
# OOM-crashed the machine on 2026-07-24. Never scale bun concurrency by nproc.
set -uo pipefail
export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"
RD="$(cd "$(dirname "$0")" && pwd)/results"
mkdir -p "$RD"

declare -A DIRS=(
  [main]="$HOME/personal/tscircuit-autorouter"
  [hygiene]="$HOME/personal/awt-hygiene"
  [astar]="$HOME/personal/awt-astar"
  [drc]="$HOME/personal/awt-drc"
  [combined]="$HOME/personal/awt-combined"
)

bench_branch() {
  local label="$1" dir="$2"
  for i in 1 2; do
    echo "[gauntlet] $label srj18 run$i start $(date +%H:%M:%S)"
    (cd "$dir" && BENCHMARK_CONCURRENCY=8 ./benchmark.sh --dataset 18 --sample-timeout 480s > /dev/null 2>&1)
    cp "$dir/benchmark-result.json" "$RD/$label-srj18-run$i.json" 2>/dev/null \
      && echo "[gauntlet] $label srj18 run$i done $(date +%H:%M:%S)" \
      || echo "[gauntlet] $label srj18 run$i FAILED (no result json)"
  done
}

# MEMORY CAP: run branches SEQUENTIALLY, 8 workers each (OOM risk — see bun-worker-limit memory).
# A solve can hold GB-scale heaps; 5 branches x 6 workers OOM-crashed the box on 2026-07-24.
# Tradeoff: sequential runs lose the "identical simultaneous ambient load" fairness property,
# so compare like-for-like and prefer the quiet CI-condition run for headline numbers.
for label in "${!DIRS[@]}"; do
  bench_branch "$label" "${DIRS[$label]}"
done
echo "[gauntlet] srj18 phase complete"

# MEMORY CAP: run branches SEQUENTIALLY, 8 workers each (OOM risk — see bun-worker-limit)
for label in "${!DIRS[@]}"; do
  dir="${DIRS[$label]}"
  echo "[gauntlet] $label dataset01 start $(date +%H:%M:%S)"
  (cd "$dir" && ./benchmark.sh --concurrency 8 > /dev/null 2>&1)
  cp "$dir/benchmark-result.json" "$RD/$label-dataset01-run1.json" 2>/dev/null \
    || echo "[gauntlet] $label dataset01 FAILED"
done
echo "[gauntlet] dataset01 phase complete"

echo "[gauntlet] quiet CI-condition combined srj18 run (8 workers, 360s)"
(cd "${DIRS[combined]}" && BENCHMARK_CONCURRENCY=8 ./benchmark.sh --dataset 18 > /dev/null 2>&1)
cp "${DIRS[combined]}/benchmark-result.json" "$RD/combined-quiet-srj18-run1.json" 2>/dev/null || true
echo "[gauntlet] ALL DONE $(date +%H:%M:%S)"
