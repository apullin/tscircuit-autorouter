# replay-core — replay-parity spike (RUST-PLAN.md §1, increment 1)

A Rust cdylib that reproduces the TypeScript portfolio supervisor's
deterministic winner selection from captured per-candidate trajectories, plus
the harness that proves parity. **No solver logic is ported** — this increment
is only the schedule/selection core that the later Rust-threads portfolio will
be built around.

Everything here mirrors the *verified* offline replay in
`lib/parallel/replayPool.ts` (`runReplayRace`, lines 187–260), the code that
achieved 549/550 winner-exact nodes against the sequential supervisor on srj18
sample 5 (perf-artifacts/parallelism-design.md §5, WINS 2026-07-24).

## Files

| file | role |
|---|---|
| `Cargo.toml`, `src/lib.rs`, `src/json.rs` | the cdylib (zero deps; json.rs is the proven parser copied from awt-r3/native/hdastar) |
| `datasetFormat.ts` | RPLYDS01 encode/decode + trajectory decimation (shared by capture and harness) |
| `captureDump.ts` | TS_REPLAY_DUMP sink: accumulates nodes, writes the dataset at process exit |
| `capture-hook.patch` | 15-line flag-gated hook into `PortfolioSingleIntraNodeSolver.parallelReplayStep` (verified `git apply --check` clean) |
| `harness.ts` | per-node TS-vs-Rust winner comparison + summary; `--selftest` mode needs no capture |

## Schedule semantics being mirrored (citations = awt-perf-stack worktree)

- Fitness `f = g + h * GREEDY_MULTIPLIER`, `GREEDY_MULTIPLIER = 5`,
  `MIN_SUBSTEPS = 100` slices — `PortfolioSingleIntraNodeSolver.ts:260-261`,
  `HyperParameterSupervisorSolver.ts:116-118, 158-165`.
- `g` is the PORTFOLIO override (`computeG`,
  `PortfolioSingleIntraNodeSolver.ts:910-928`), **not** the base
  `iterations/MAX_ITERATIONS`: A01/A03 → `iterations/1e6`; polyline →
  `1000 + (ITERATION_PENALTY??0 + iterations)/1e4 + 1e4*(SEGMENTS_PER_POLYLINE-3)`;
  default → `iterations/1e4`. Replay mirror: `candidateG`,
  `replayPool.ts:64-81` (imported by the harness, reimplemented in
  `src/lib.rs candidate_g`).
- `h = 1 - progress` with **raw, unclamped** `progress || 0` before expansion
  (`PortfolioSingleIntraNodeSolver.ts:930-935`); after expansion,
  `getCandidateProgress` = clamped `solvedSegments/nodeSegmentCount`
  (`:192-198`). Replay uses the recorded per-iteration samples / final segment
  count (`replayPool.ts:197-207`).
- Winner = first candidate the simulated schedule brings to its recorded
  solved completion (`replayPool.ts:256-259`); ties on equal `f` break to the
  LOWEST index (strict `<` scan, `replayPool.ts:243-246`, matching the live
  in-order scan `HyperParameterSupervisorSolver.ts:120-137`).
- Ineligibility: failed candidates once `v >= iterations`
  (`replayPool.ts:209-210, 237`); solved candidates once `v > 0 && v >=
  iterations` — i.e. solved-at-0 stays selectable at `v = 0`
  (`replayPool.ts:233-236`).
- Adaptive expansion at `totalCandidateWork >= max(1, initial candidates'
  MAX_ITERATIONS)` or when no initial candidate is viable
  (`replayPool.ts:188-192, 213-222`; live:
  `PortfolioSingleIntraNodeSolver.ts:236-247, 816-821, 905-907`).
- The four cracked subtleties (parallelism-design.md §5) are annotated at
  their exact mirror points in `src/lib.rs`.

All schedule arithmetic is f64 add/sub/mul/div + comparisons — bit-identical
between JSC and Rust. Progress samples cross as f32 and widen exactly.

## Dataset format (RPLYDS01)

Defined once in `datasetFormat.ts` (module doc) and re-validated by the Rust
parser: 8-byte magic `RPLYDS01`, u32-LE header length, space-padded UTF-8 JSON
header (per-node metadata + per-candidate `hp/solved/iterations/maxIterations/
solvedSegments/trajOffset/trajLen`), then a little-endian f32 payload of
concatenated trajectories.

Trajectories are stored on the **schedule grid**: sample `k` = raw progress
after `min((k+1)*100, iterations)` iterations. The replay only ever reads
progress at exactly those virtual-iteration values (v advances by
`min(100, iterations - v)`, `replayPool.ts:252`), so this 100× decimation is
bit-exact, not an approximation — the equivalence argument is spelled out in
`datasetFormat.ts`. It keeps a full srj18 sample-8 capture in the tens of MB
instead of GBs.

## C ABI

```
replay_load(dataset_ptr, len)   -> handle (u64; 0 = error, see replay_last_error)
replay_node_count(handle)       -> i64 (-1 bad handle)
replay_run(handle, node_index)  -> i32 winner candidate index; -1 none; -2 bad handle/index
replay_run_detail(handle, node_index, out_ptr, out_cap) -> i64 bytes of diagnostic JSON
replay_last_error(out_ptr, out_cap) -> i64
replay_free(handle)
```

`replay_load` copies the buffer; the JS side may release it immediately.
Loading pattern is the same stateful bun:ffi recipe as
`awt-r3/native/hdastar/a01NativeDriver.ts`.

## Coordinator runbook (exact commands)

All from the worktree root `/home/pullin/personal/awt-perf-stack` unless noted.

**1. Build the cdylib** (offline-safe, no dependencies):

```
cd /home/pullin/personal/awt-perf-stack/native/replay-core && cargo build --release
```

Produces `target/release/libreplay_core.so`. Optional: `cargo test` runs four
pure-Rust unit tests covering the subtleties.

**2. Smoke-test without a capture** (writes + replays a synthetic dataset):

```
bun native/replay-core/harness.ts --selftest
```

Expected: `nodes: 5, candidates: 14`, `... 5/5 identical, 0 mismatches`,
`0 divergences`, `PARITY: OK`, exit 0.

**3. Apply the capture hook** (one file, 15 added lines, off unless
`TS_REPLAY_DUMP` is set):

```
git apply native/replay-core/capture-hook.patch
```

**4. Capture srj18 sample 8** (runs the existing TS_PARALLEL_REPLAY stage-1
path — expect it to be a few times slower than a normal sample-8 run, which is
~2 min; 4 replay workers keeps the box under its 8-bun-worker cap):

```
env -u TS_PARALLEL_REPLAY2 -u TS_PARALLEL_HD_NODES -u TS_PARALLEL_A2 -u TS_LEAN_PORTFOLIO \
  TS_PARALLEL_PORTFOLIO=1 TS_PARALLEL_REPLAY=4 \
  TS_REPLAY_DUMP=/home/pullin/personal/awt-perf-stack/native/replay-core/srj18-sample8.rplyds01 \
  bun scripts/run-sample.ts --pipeline 7 --sample 8 --dataset srj18
```

Notes: `TS_PARALLEL_PORTFOLIO` is the master gate
(`PortfolioRacePool.ts:181-184`); `TS_PARALLEL_REPLAY=N` selects the replay
path inside it (`PortfolioSingleIntraNodeSolver.ts:582-592`).
`TS_PARALLEL_REPLAY2` must stay unset (it would take precedence and has no
dump hook); the `-u` flags keep other worker pools from stacking on top. The
dump is written ONCE at normal process exit (stderr line
`[replay-core] TS_REPLAY_DUMP: wrote N nodes ...`); a killed/timed-out run
leaves no usable file. Records include every PortfolioSingleIntraNodeSolver
instance that runs (HD stage + any repair-stage nesting), each as its own node
entry.

**5. Parity harness:**

```
bun native/replay-core/harness.ts native/replay-core/srj18-sample8.rplyds01
```

Expected output shape:

```
dataset: native/replay-core/srj18-sample8.rplyds01
nodes: <N ~1200>, candidates: <~75*N>
TS-replay vs Rust-replay winners: N/N identical, 0 mismatches
harness TS-replay vs capture-time winner: 0 divergences (expected 0)
PARITY: OK
```

**6. Revert the hook when done:** `git apply -R native/replay-core/capture-hook.patch`

## Acceptance bar

- **TS-replay vs Rust-replay: 0 mismatches required.** Both sides replay the
  *same recorded trajectories*, so any disagreement is a bug in the Rust port
  (or harness transcription), full stop. Mismatches print both winners' hp and
  the Rust diagnostic JSON (`replay_run_detail`).
- **harness-TS vs capture-time winner: 0 divergences expected.** The capture
  stores the winner the live `runReplayRace` picked; the harness recomputes it
  from the decimated file. A divergence implicates the decimation/format, not
  the Rust side.
- The known **CachedIntraNodeRouteSolver failure-cache** issue (the 1-in-550
  P2 mismatch at cmn_51, staged as
  perf-artifacts/pr-staging/issue-failure-cache.md) lives between
  *captured-parallel execution* and the *true sequential run*. It does NOT
  appear in this harness's comparisons (both sides consume the same capture).
  If the coordinator additionally cross-checks captured winners against a
  sequential `PERF_SUPERVISOR_STATS` run, the reference bar is the P2 result —
  549/550-class agreement, with every mismatch implicating only the
  failure-cache path.

## Known risks / simplifications

- The harness's TS simulation is a transcription of `replayPool.ts:187-260`
  (the original fuses worker dispatch with the simulation and cannot be
  imported in isolation); `candidateG` itself IS imported from the production
  module. Every transcribed block is annotated with its source lines.
- Replay fidelity target is the **verified replay semantics**, not the live
  sequential supervisor: the replay approximates post-expansion progress with
  the FINAL solvedSegments (`replayPool.ts:198-201`) and competes solved-at-0
  candidates by f/index instead of the live "first solved short-circuit"
  (`HyperParameterSupervisorSolver.ts:123-126`). Those are properties of the
  TS replay that measured 549/550; Rust mirrors them exactly.
- `Math.min/max` NaN propagation is mirrored; JS `-0` ordering is not
  (unreachable with this schedule's non-negative integer operands).
- Dataset floats are little-endian (every box involved is LE x86/ARM).
- Capture memory: trajectories are decimated at record time; header JSON +
  samples for ~1200 nodes × ~75 candidates ≈ tens of MB resident and on disk.
