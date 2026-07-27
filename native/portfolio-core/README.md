# portfolio-core — Rust portfolio runtime + FFI (M3)

Module M3 of native/PORT-SPEC.md section 8: run every dominant-class
intra-node candidate on rayon threads TO COMPLETION, record per-candidate
trajectories on the 100-iteration schedule grid, merge TS-side records for
the non-dominant candidate classes, select the winner with the parity-proven
replay semantics of `native/replay-core`, commit staged cache entries under
the section 5 commit-on-sequential-semantics policy, and return the winner's
routes over a bun:ffi C ABI (flag `TS_NATIVE_PORTFOLIO`).

One crate hosts all port modules (M0 `geom_rng`, M1 `sr_astar`, M2
`contract`/`cache`/`cache_key`/`intra_node`/`js_num`, M3
`json`/`replay_sim`/`runtime`/`ffi` + `driver.ts`); `src/lib.rs` documents
the ownership table.

## Build

```
cd /home/pullin/personal/awt-perf-stack/native/portfolio-core
cargo build --release          # produces target/release/libportfolio_core.so
cargo test                     # pure-Rust tests, no bun needed
```

Notes:
- `replay-core` is a path dependency (`../replay-core`, built automatically).
- Unlike replay-core this crate is NOT zero-dependency: the first build
  fetches rayon from crates.io (vendor a registry mirror for offline boxes).
- `cargo test` includes the integration keystone
  (`runtime::tests::encoded_dataset_matches_replay_core_selection`): the
  runtime's RPLYDS01 encoder is parsed by the REAL replay-core crate and the
  dependency selection and the vendored simulator must agree.

## How winner selection reuses replay-core

Selection itself is performed by DEPENDING ON the replay-core crate
(`Cargo.toml` path dependency; `crate-type` of replay-core includes `rlib`):
`runtime.rs` encodes the merged per-candidate records as an in-memory
RPLYDS01 dataset — the exact layout of `native/replay-core/datasetFormat.ts`,
with each candidate's hyperparameter JSON spliced VERBATIM from the marshaled
TS input — and calls `replay_core::replay_load` / `replay_run` /
`replay_run_detail` / `replay_free`. The compiled code that proved replay
parity (549/550 vs the sequential supervisor at capture time; 1222/1222
TS-vs-Rust replay identity) is the code that picks the winner here.
`candidate_g` and the four replay subtleties are NOT rewritten.

One thing replay-core's ABI does not expose is the schedule's final
virtual-iteration vector `v[]`, which the section 5 cache commit needs
("commit candidates whose virtual iterations reached completion when the
winner landed"). `src/replay_sim.rs` is a VENDORED, line-annotated copy of
replay-core's private simulator (provenance chain in its module doc) with
three deltas: it returns `v[]`, it accepts the optional
`externalMaxIterations` round ceiling, and it reads trajectories from the
shared payload slice. Its winner is cross-checked against replay-core's on
EVERY node — disagreement is a hard error surfaced through `pf_last_error`,
never a silent pick — so the copy cannot drift unnoticed.

## C ABI (contract C3)

| function | signature | notes |
|---|---|---|
| `pf_create` | `(num_threads: u32) -> u64` | session = rayon pool + cross-node SharedCache; 0 = auto (min(cores, 8)); returns 0 on error |
| `pf_load_node` | `(handle, node_json*, len) -> i32` | node-shared input, once per node (1-6 KB); 0 ok, -1 error, -2 bad handle |
| `pf_run_portfolio` | `(handle, hp_json*, len, tsrec_json*, len) -> i64` | returns result byte length; -1 error, -2 bad handle, -3 no node |
| `pf_get_result` | `(handle, out*, cap) -> i64` | copies the result JSON (the get-winner-routes call — routes ride inside); -1 small buffer, -2 no result |
| `pf_last_error` | `(out*, cap) -> i64` | replay-core style error string |
| `pf_free` | `(handle)` | frees pool, cache, node, result |

ABI notes (deltas vs the C3 sketch in PORT-SPEC section 8, each forced by a
gap in the sketch):

- The sketch's per-node `pf_session` became `pf_create` (once) +
  `pf_load_node` (per node): the shared cache must OUTLIVE nodes (all cache
  hits are across solves, section 5), and the sketch gave it nowhere to live.
- `hp_list_json` is a wrapper object
  `{"initialCount", "externalMaxIterations"?, "emitAllRoutes"?, "hps": [...]}`
  — the replay needs `initialCount` (expansion boundary) and the GrowShrink
  ceiling had no channel in the sketch. `hps` is the full marshaled candidate
  list in TS enumeration order (= tie-break order), never re-derived in Rust.
- `tsrec_json` = array of records for candidates TS executed (non-dominant
  classes): `{i, solved, iterations, maxIterations, solvedSegments, traj,
  routes|null, error?}`. Rust runs exactly the indices absent from tsrec and
  refuses any of them whose hp carries a non-dominant marker key.
- Result JSON: `{nodeId, winnerIndex, solved, winnerSource: "rust"|"ts"|null,
  error, routes, perCandidate: [...], replay: {expanded, totalCandidateWork,
  rounds, ceilingHit, replayCoreDetail}, cache: {pending, committed, size}}`.
  A "rust" winner's routes are RAW solvedRoutes (TS applies
  extractWinningRoutes after the FFI returns); a "ts" winner's routes are the
  tsrec routes spliced back verbatim (already post-extract).

## Threading design

- Granularity: one rayon task = one candidate run to completion (~63
  dominant-class tasks per node, durations spread over ~100x). Coarse,
  fully independent tasks with heavy skew are exactly the work-stealing
  shape; `pool.install + par_iter().map().collect()` preserves index order
  for the results, so scheduling order cannot affect selection (the
  tie-break is the hp-list index, decided by the replay over records).
- Shared state: the `NodeSession` is shared read-only (`&NodeSession`) by
  all tasks — the node context crosses the FFI once and is never cloned per
  candidate (the P1 JS postmortem failure this design exists to fix). The
  cache is a plain no-lock struct (`cache::SharedCache`): candidates borrow
  it immutably during the node (the pre-node snapshot; within-node key
  interaction is provably zero), and M3 commits via `&mut` after the pool
  has joined. Rust's borrow rules enforce the § 5 protocol statically —
  no locks, no atomics.
- Pool sizing: per-session `rayon::ThreadPool`, `num_threads` from
  `pf_create` (driver: `TS_NATIVE_PORTFOLIO=N` pins N; `=1` means auto =
  min(available cores, 8) — Gate B measures at 8 threads and 8 is the box's
  proven ceiling for heavy workers).
- Why no crossbeam: the run-to-completion protocol (validated by P2 replay:
  selection needs only FINAL trajectories on the schedule grid) removes all
  mid-run cross-thread communication — no streaming, no cancellation, no
  channels. rayon's own deques cover dispatch; crossbeam would add surface
  with no consumer. (User-approved if a need appears; none did.)
- The FFI itself is single-caller (bun main thread), like replay-core and
  hdastar. Panics (including `todo!()` from pending sibling modules) are
  caught at the boundary and become `pf_last_error` text.

## Sequential mode (`"mode":"seq"` — post-Gate-B)

Gate B recorded the negative result: run-to-completion carries the full
doomed-candidate cost the sequential schedule avoids (~9x+ work multiplier;
threads lose). `src/seq.rs` is the follow-up: a line-faithful mirror of the
LIVE adaptive supervisor schedule (NOT the replay semantics) driving real
`CandidateSolver`s one at a time on the calling thread — no rayon pool, zero
contention, the TS scheduler's work-avoidance kept exactly.

- Schedule: stored-f pick with the live tie-break and the live
  solved-short-circuit (HyperParameterSupervisorSolver.ts:120-137), 100-step
  slices (:158-165), initial f = g(0) (:93-99), adaptive expansion per the
  live triggers (PortfolioSingleIntraNodeSolver.ts:860-865, :949-951,
  :236-247), live computeG/computeH overrides (:954-979), the
  refreshDynamicIterationLimit budget + externalMaxIterations cap
  (:436-464). Full doc: src/seq.rs module header, including the three
  live-vs-replay differences deliberately mirrored on the LIVE side
  (solved short-circuit, stale f across the expansion flip, expanded-h
  clamping).
- Candidate execution is Gate-A bit-exact and the schedule is
  deterministic, so the winner is live-sequential-TS identical — stronger
  than the replay path (no 549/550 caveat). On golden-s8 the seq winner
  differs from the REPLAY-path golden winner on exactly 7/1221 nodes, all
  of them closed-form solved-at-construction nodes where the live pick's
  solved-short-circuit fires — the documented replay divergence class, now
  on the live side.
- Cache: each completing candidate's staged entry is collected in
  COMPLETION ORDER and committed when the node ends — observationally
  identical to the live mid-step saves (within-node keys are disjoint), so
  cache evolution is order-identical to sequential TS (src/seq.rs DIFF-4).
- Non-dominant candidates arrive as tsrec records consumed virtually.
  Production laziness (driver.ts): instant classes run eagerly (0-1
  iterations); A01/A03/polyline ship as ctor-state STUBS
  (`runTsCandidateStub`) and are executed TS-side only when the schedule
  actually PICKS one — the native run returns `needTsCandidates` and the
  driver re-runs the node (nothing committed on that path, so the re-run
  replays the identical schedule prefix). On golden-s8, 951/1209 winners
  land at candidate index 0-9 where the live schedule never touches
  A01/A03/polyline at all.
- Plumbing: hp-wrapper `"mode":"seq"` (default `"rtc"`);
  `TS_NATIVE_PORTFOLIO=seq` or `TS_NATIVE_PORTFOLIO_SEQ=1` (with
  `TS_NATIVE_PORTFOLIO=1`) selects it in `nativePortfolioStep`.
- Driver-level check: `bun native/portfolio-core/driver.ts <golden.jsonl>
  --mode seq` — hard-asserts every schedule-completed dominant candidate
  against its golden record (solved+iterations) and reports winner
  agreement vs the replay-path golden informationally. 2026-07-27 run:
  1221 nodes, 0 hard mismatches, 1214/1221 winner agreement (7 = the
  solved-at-0 class above).

## Driver + integration point

`driver.ts` (bun:ffi) exposes:

- `nativePortfolioStep(solver)` — full replacement for one
  `PortfolioSingleIntraNodeSolver._step` under the flag. It enumerates
  candidates THROUGH THE SOLVER'S OWN methods (line mirror of
  `parallelReplayStep`, PortfolioSingleIntraNodeSolver.ts:645-661), runs
  non-dominant candidates in-process exactly the replay-worker way, and
  applies the outcome (solved/routes/failed/error/stats) to the solver.
- `NativePortfolioSession`, `buildNodeInput`, `runTsCandidate`,
  `isDominantHp` for harness use.

The integration snippet (added by the coordinator; lib/ is not modified by
this module) is documented at the top of driver.ts: a
`TS_NATIVE_PORTFOLIO`-gated early return at the start of `_step()`, same
pattern as the `parallelPortfolioEnabled()` gate, lazy `require` so the main
build gains no native/ dependency. Sequential supervisor remains the
fallback when the flag is off. Parity runs must leave `TS_MAX_EXHAUSTIONS`,
`TS_ABANDON_MAX_PROGRESS`, `TS_NODE_WORK_CAP`, `TS_LEAN_PORTFOLIO` unset
(PORT-SPEC section 3) — this path mirrors parallelReplayStep, which ignores
them.

## Golden-verification runbook (Gate A feeder)

The TS_GOLDEN_DUMP hook is COMMITTED on this branch
(PortfolioSingleIntraNodeSolver.ts:694-710 + native/replay-core/goldenDump.ts)
— no patch application step. Do not run while a benchmark gauntlet is using
the box; 4 replay workers keeps it under the 8-bun-worker cap.

1. Build the cdylib:

```
cd /home/pullin/personal/awt-perf-stack/native/portfolio-core && cargo build --release
```

2. Capture the golden JSONL (srj18 sample 8, from the worktree root):

```
env -u TS_PARALLEL_REPLAY2 -u TS_PARALLEL_HD_NODES -u TS_PARALLEL_A2 -u TS_LEAN_PORTFOLIO \
  TS_PARALLEL_PORTFOLIO=1 TS_PARALLEL_REPLAY=4 \
  TS_GOLDEN_DUMP=$PWD/native/srj18-sample8.golden.jsonl \
  bun scripts/run-sample.ts --pipeline 7 --sample 8 --dataset srj18
```

3. Compare (per-candidate + winner), default = fresh cache per node:

```
bun native/portfolio-core/driver.ts native/srj18-sample8.golden.jsonl
```

Acceptance per Rust-run candidate (PORT-SPEC section 7):
- `solved` equal; `iterations` equal; `maxIterations` equal (directly
  validates the `1000 * n ** 1.5` budget arithmetic);
- `traj` exact (both sides are exact f64 widenings of the f32 schedule-grid
  samples — element-wise `===`);
- `routes` deep-equal AFTER the comparator applies TS `extractWinningRoutes`
  to the Rust raw routes (the golden stores post-extract routes);
- winner index equal per node.

Cache accounting: golden captures were produced by replay workers with
worker-private caches, so a golden candidate can be a cache hit
(iterations == 1) where a cold Rust run computes fresh. The comparator
counts any mismatch where either side completed at iteration 1 as
"cache-implicated" — judge those against the 549/550-class reference bar
(native/replay-core/README.md "Acceptance bar"), attributing each to the
known failure-cache issue (perf-artifacts/pr-staging/issue-failure-cache.md).
`--shared-cache` runs one session for the whole file instead (production
shape: commit-on-sequential-semantics evolving across nodes in file order).

## Gates (from RUST-PLAN.md section 1, restated)

- Gate A: winner parity vs the sequential supervisor on sample 8's full node
  corpus; 549/550-style accounting; every mismatch documented against the
  failure-cache issue.
- Gate B: HD-stage wall time on samples 8 and 6 with Tier-1 quality
  identical. Continue only if parity holds AND the HD stage is >= 1.3x at 8
  threads; otherwise write the negative result in WINS.md and stop.

## Risk register

1. Transcendental parity (PORT-SPEC 6.8): `** 1.5` / `** 1.6` / `exp` /
   `atan` feed maxIterations and trajectories. Both bun (JSC) and Rust std
   dispatch to glibc libm on this box, so bit-parity is EXPECTED but must be
   PROVEN by the golden comparison (`maxIterations` checks pow directly,
   `traj` checks atan/exp/pow end-to-end). Any mismatch: vendor the exact
   function before proceeding.
2. Failure-cache class (section 5): golden mismatches with a
   1-iteration side are cache-implicated by construction; the production
   commit-on-sequential policy (cache.rs) removes the divergence class, but
   Gate A accounting must still attribute each occurrence.
3. `toFixed(6)` decimal ties (6.9) live in M2's dedupe/repair keys; the
   route deep-equal in the comparator is the detector.
4. externalMaxIterations mapping: the proven TS replay path IGNORES the
   GrowShrink ceiling (runReplayRace has no such input), so this crate maps
   one replay round = one supervisor iteration with BaseSolver's post-step
   budget check (round ceiling+1 may still win). The ceiling only binds in
   GrowShrink growth attempts; flagged as an approximation of the
   sequential (non-replay) supervisor.
5. Contract C2 gaps (tracked for M2's `intra_node.rs`, pending at the time
   of writing): M3 calls `new(&NodeSession, &Hp, &SharedCache)`, `step`,
   `status`, `iterations` (u64, must advance by exactly 1 per Running step),
   `max_iterations` (f64, post-setup, readable before stepping), `progress`
   (raw, unclamped), `error() -> Option<&str>` (an M3-REQUIRED EXTENSION —
   the spec's C2 listing omits an error accessor but CandidateRecord.error
   needs it), `take_routes(self)` (raw routes), `pending_cache_entry()`
   (None for cache hits). Divergence from any of these surfaces as a
   contract-violation error or a compile error in runtime.rs, not silent
   drift.
6. tsrec trajectory truncation: the worker's 24 MB SAB cap (~6.29M samples)
   truncates only TS-side candidates; their golden/live records carry
   whatever TS recorded, so the semantics stay TS-owned. Dominant-class
   budgets (1000 * n^1.5) cannot reach the cap.
7. rayon = crates.io fetch on first build (see Build).
8. FFI is single-caller by design; concurrent calls into one handle are
   undefined (same stance as replay-core/hdastar).
9. JSON number forms: Rust writes shortest-round-trip decimals (JS may pick
   exponent notation for the same value); every consumer compares PARSED
   numbers, and hp objects / TS routes are spliced as raw text, so no
   re-serialization ambiguity crosses the selection or comparison paths.

## Status (M3 deliverable)

M3 modules (`json`, `replay_sim`, `runtime`, `ffi`, `driver.ts`) are
complete and self-consistent against the shared `contract`/`cache` surface.
The crate compiles once the sibling modules land: `geom_rng` (M0),
`sr_astar` (M1), and M2's `intra_node` (`CandidateSolver` — the only
M1/M2 symbol M3 calls directly; exact expected surface in risk 5 and in
`runtime.rs::run_candidate`). `cargo test` then exercises the
encoder/replay-core/vendored-simulator keystone without bun.
