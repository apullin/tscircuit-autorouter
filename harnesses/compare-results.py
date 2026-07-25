#!/usr/bin/env python3
"""Summarize archived benchmark-result JSONs into a comparison table.

Usage: python3 compare-results.py  (reads results/*.json next to this script)
Groups by label (filename prefix before -srj18/-dataset01) and averages repeats.
"""
import json
import re
from collections import defaultdict
from pathlib import Path
from statistics import median, mean

results_dir = Path(__file__).parent / "results"
groups = defaultdict(list)
for f in sorted(results_dir.glob("*.json")):
    m = re.match(r"(.+)-(srj18|dataset01)-run(\d+)\.json", f.name)
    if not m:
        continue
    label, dataset, run = m.group(1), m.group(2), int(m.group(3))
    groups[(label, dataset)].append(json.load(open(f)))

def sample_times(d):
    return {s["sampleNumber"]: s.get("elapsedTimeMs") for s in d["snapshots"]}

for (label, dataset), runs in sorted(groups.items(), key=lambda kv: (kv[0][1], kv[0][0])):
    per_run = []
    for d in runs:
        times = [t for t in sample_times(d).values() if t]
        completed = len(times)
        total = d["scenarioCount"]
        drc_pass = sum(1 for s in d["snapshots"] if s.get("relaxedDrcPassed"))
        vias = [s["viaCount"] for s in d["snapshots"] if s.get("viaCount") is not None]
        per_run.append({
            "completed": completed, "total": total, "drc": drc_pass,
            "p50": median(times) / 1000 if times else None,
            "sum": sum(times) / 1000 if times else None,
            "avg_via": mean(vias) if vias else None,
        })
    n = len(per_run)
    comp = mean(r["completed"] for r in per_run)
    drc = mean(r["drc"] for r in per_run)
    p50 = mean(r["p50"] for r in per_run if r["p50"])
    tsum = mean(r["sum"] for r in per_run if r["sum"])
    via = mean(r["avg_via"] for r in per_run if r["avg_via"])
    print(f"{label:24s} {dataset:9s} runs={n} completed={comp:.1f}/{per_run[0]['total']} "
          f"drcPass={drc:.1f} P50={p50:6.1f}s sumSolved={tsum:7.1f}s avgVia={via:6.1f}")

# Per-sample deltas vs a 'main' label when present, srj18 only
main_runs = groups.get(("main", "srj18"))
if main_runs:
    base = defaultdict(list)
    for d in main_runs:
        for k, v in sample_times(d).items():
            if v:
                base[k].append(v)
    base_avg = {k: mean(v) for k, v in base.items()}
    print("\nPer-sample srj18 vs main (avg, seconds; '-' = timeout/missing):")
    labels = sorted({l for (l, ds) in groups if ds == "srj18" and l != "main"})
    header = "sample   main  " + "  ".join(f"{l[:12]:>12s}" for l in labels)
    print(header)
    all_samples = sorted(set(base_avg) | {k for l in labels for d in groups[(l, "srj18")] for k in sample_times(d)})
    for s in all_samples:
        row = f"{s:>6d} {base_avg.get(s, 0)/1000 if s in base_avg else 0:6.1f}  "
        cells = []
        for l in labels:
            vals = [sample_times(d).get(s) for d in groups[(l, "srj18")]]
            vals = [v for v in vals if v]
            cells.append(f"{mean(vals)/1000:12.1f}" if vals else f"{'-':>12s}")
        print(row + "  ".join(cells))
