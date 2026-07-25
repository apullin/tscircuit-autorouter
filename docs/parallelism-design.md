# Parallelism design — intra-sample CPU parallelism (draft 2026-07-24, pre-implementation)

Status: DESIGN ONLY, no code. Written after round 4; implements OUR_TODOS A1/A2/A4/A5.
Constraint context: memory-capped box (8 bun workers TOTAL), result-identity discipline,
benchmark harness already parallelizes ACROSS samples (intra-sample parallelism buys
single-board latency + the timeout tail, not suite throughput).

## 1. What the sequential code actually does (verified by reading)

### A1 target: PortfolioSingleIntraNodeSolver (lib/solvers/HyperHighDensitySolver/)
- HyperParameterSupervisorSolver._step: picks best-fitness candidate, steps it
  MIN_SUBSTEPS=100 iterations, recomputes f = g + h*GREEDY (g = iterations/MAX_ITERATIONS,
  h = 1-progress). FIRST candidate to reach solved=true becomes winningSolver.
- Portfolio size per node ≈ 100 candidates: throughObstacle(1), singleLayer(1),
  multiHeadPolyLine(1), majorCombinations(3)×orderings6(6)×cellSizeFactor(2)=36,
  noVias(1), orderings50(50), flipTrace(6), closedForm(1), A01(1), A03(1).
- Candidates are FULL intra-node solves (all connections in the node), differing only
  by hyperParameters. ~2000 intra-node solves per board, ms-to-seconds each.
- Serialization surface: constructorParams = nodeWithPortPoints (plain data),
  connMap (class instance — rehydrate from idToNetMap/netMap), hyperParameters, scalars.
  Small per-node clones; the big srj never crosses the boundary.

### A2 target: GlobalDrcBranchPortfolioSolver (high-density-repair03)
- 3 branches (baseline / broad / viaInPad) stepped as SEQUENTIAL PHASES, not independent
  parallel branches: field `broadInputSnapshot` suggests broad may start from baseline's
  output. DEPENDENCY MUST BE VERIFIED before claiming A2 is trivially parallel — if broad
  consumes baseline's result, only baseline ∥ (precompute) is available and A2 shrinks.

**VERIFIED 2026-07-24 (read the phase machine): A2 is VIABLE and can be result-identical.**
**SHIPPED 2026-07-24 (commit 075834b0, flag TS_PARALLEL_A2): bit-identical (output hashes
seq == par on samples 8/6/12), sample 6 -42s (-14%), Tier-1 sample 6 1.25x / sample 8 1.13x,
quality identical. Worker transport: 2 persistent Bun Workers, 64MB SAB result channels,
Bun.sleepSync polling; DRC evaluator rebuilt worker-side from serializable config (the
evaluatorConfig is passed alongside params; connMap prototype rehydrated). Implementation:
lib/parallel/a2BranchWorker.ts, lib/parallel/a2Pool.ts,
lib/solvers/HighDensityRepairSolver/ParallelGlobalDrcBranchPortfolioSolver.ts (extends the
upstream class; delegates to super._step() when the flag is off). Known gap: branch-solver
stats are not serialized back (stats observability only; output unaffected).
- baseline: GlobalDrcForceImproveSolver(inputHdRoutes)
- broad: input = applyBroadRepulsionForces(inputHdRoutes) — derives from INPUT only, NOT
  from baseline's solve. The expensive work (baseline solve ∥ broad repulsion + broad
  solve) is genuinely independent and can run concurrently.
- Selection compares broadInputSnapshot.count vs baselineSnapshot.count — pure data
  decision, NO timing dependence → parallel execution can be BIT-IDENTICAL to sequential.
- viaInPad starts from the selection winner (usually skipped/short).
- Expected win: max(baseline, broad) instead of sum(baseline, broad) on the
  exactGeometryDrcForceImproveSolver stage — the stage that killed sample 2/12 pre-round-1
  and where sample 6 spends its tail. This is the cleanest parallelism target:
  deterministic, small blast radius (2 workers), no quality gate needed.

## 2. Semantics decision (the crux)

Sequential winner = first solved under the ADAPTIVE FITNESS SCHEDULE. A wall-clock race
changes winner identity → different routes → NOT result-identical. Three options:

- **P1 race-and-take-first (non-identical).** Wall time = min over candidates of
  time-to-success. Quality-gated on benchmarks (allowed by OUR_TODOS A1 caveat).
  Simplest semantics; biggest win; results vary run-to-run ONLY in winner identity
  when multiple candidates can solve (each candidate itself is deterministic).
  Can be made run-to-run DETERMINISTIC by preferring lower portfolio index on
  near-ties, but not sequential-identical.
- **P2 deterministic schedule replay (identical).** Run all candidates concurrently to
  completion (or to first success + cancel), record progress-vs-iteration trajectories,
  select the winner by simulating the sequential fitness schedule. Requires true
  per-candidate progress — BLOCKED BY B2 (computeProgress NaN in
  SingleHighDensityRouteSolver; portfolio fitness never sees real progress). Fix B2
  first. Higher memory (all candidates resident), wall = max not min.
- **P3 parallel-map, sequential-schedule (identical, partial).** Keep the supervisor
  sequential but execute each candidate's 100-substep slice in a worker. No winner
  change, but scheduling overhead dominates (100 iterations ≈ ms) — likely a loss.
  Not recommended.

Recommendation: **P1 for the product** (gate on quality metrics), with B2 fixed
separately as its own gated experiment (it changes scheduling even single-threaded).

**2026-07-24 PROTOTYPE RESULT — P1 take-first REJECTED.** Built the full P1 stack
(lib/parallel/PortfolioRacePool.ts + portfolioRaceWorker.ts, flag TS_PARALLEL_PORTFOLIO=N;
Bun Workers + SAB result channel + Bun.sleepSync polling — the mechanics work fine).
srj18 sample 5: sequential 41.8s/0 DRC vs race×4 56.7s/15 DRC vs race×8 55.1s/16 DRC.
TWO independent failures: (1) the sequential fitness schedule encodes a QUALITY
preference, not just CPU rationing — first-to-finish picks cheap weak candidates and
the board degrades (0→15 DRC errors). Take-first is the wrong semantics; P2
(run-to-completion + schedule replay) is required and is blocked on B2. (2) connMap
is structured-cloned per candidate per node — needs a per-node session protocol
(context once, hyperparameters per task). RSS also grew (1.17→1.8GB at 8 workers).
R=9.28 says the work exists; P1's winner selection is what fails. Code stays
flag-gated OFF. Next: fix B2 (progress NaN) as its own experiment, then P2 with
session protocol; re-test on HD-heavy samples 8/12, not sample 5.

**2026-07-24 B2 FOLLOW-UP: the B2 fix itself was REJECTED on benchmarks** (perf/b2-progress:
samples 10/12 12% slower, sample 10 gained a DRC error, vias up). P2's premise of "fix progress,
then replay the schedule" is weakened — the current progress metric is harmful when used.
Parallelism is PARKED behind that redesign; measured R=9.28 remains the justification for
revisiting it.

## 3. Architecture (P1)

- Persistent Bun Worker pool (N = min(physical cores, memory budget / per-worker RSS)).
  Workers load the solver stack ONCE (cold JIT amortized over ~2000 node solves/board).
- Dispatch: { candidateHyperParameters, constructorParams } → structured clone.
  Response: solved | failed + solvedRoutes + iterations + stats.
- Supervisor replacement: on node entry, post all candidates (or a capped wave, e.g.
  2×pool) to the pool; first solved response wins; cancel/lazily-abandon the rest
  (workers are per-candidate isolates — abandonment = let them run to a check flag
  or terminate; terminating wastes in-flight work, abandoning wastes memory. Decide
  empirically; candidates are seconds at most).
- Memory model: per-candidate RSS on heavy nodes is 10s of MB (node-local data).
  8-16 workers ≈ 1-2 GB extra — fits under the cap if benchmark concurrency is
  reduced correspondingly. NEVER exceed 8 total bun workers on this box.
- Fallback: env/flag to run the sequential supervisor (CI parity + A/B).

## 4. Expected value (Amdahl, from stage profile)

**MEASURED 2026-07-24 (PERF_SUPERVISOR_STATS=1, srj18 sample 8, 1210 nodes):**
aggregate work ratio Σ totalCandidateWork / Σ winnerIterations = **9.28x**.
Winner mix: CachedIntraNodeRouteSolver 1080, A01 82, A03 25, misc 23.
(p50 per-node R ≈ 0 is an instrumentation artifact of trivially-solved nodes;
the aggregate over all work is the meaningful figure.) With 8-16 workers the
HD stage (~58% of wall) could go ~4-8x → overall **~2-3.5x**, before the
hypergraph pathing stage (~30%) becomes the wall. GO decision: justified.

Prior estimate text: HD stage ≈ 58% of srj18 wall. If candidate time-to-success ratio
(aggregate scheduled work / winner work) is R and we have C effective cores, HD
speedup ≈ min(R, C).

## 5. P2-replay: the bit-identical portfolio parallelism (VERDICT: PARKED)

**BUILT AND EVALUATED 2026-07-24 (commits on perf/ts-round3, flag TS_PARALLEL_REPLAY).**
Winner semantics FULLY CRACKED — 549/550 nodes match sequential exactly after fixing:
(1) initial f = candidateG(0) — polyline candidates start at f=31000, NOT 0;
(2) computeH uses RAW `progress || 0` which exceeds 1 → negative f → progressing
candidates get re-stepped before unstepped ones (clamping progress breaks the model);
(3) solved-at-0 candidates must stay selectable at v=0;
(4) adaptive-expansion trigger = max(initial candidates' MAX_ITERATIONS) of total work.

BIT-IDENTITY: **blocked by CachedIntraNodeRouteSolver failure-cache poisoning** — the
sequential pipeline caches FAILED attempts; at node cmn_51 a candidate reads a cached
failure while a cold worker computes fresh and succeeds. Replaying bit-identically would
require reproducing the exact cache state per node — infeasible. SIDE QUESTION WORTH
UPSTREAM REVIEW: does the intra-node cache key include obstacle/solved-route state?
If not, failure entries can poison later solves of the same node — a real correctness bug.

SPEED: stage-1 (run all + offline replay) is 3.8x SLOWER on sample 5 (total candidate
work ÷ 4 workers + per-node session clones + trajectory serialization). Stage-2
(early exit + board-level session) was scoped but not worth it once identity broke.
**A2 (075834b0) remains the shipped parallelism.** R=9.28 measured. P2 parked.

P1 died on winner selection; B2 rejection proved the progress signal is mostly inert —
i.e. the sequential schedule is a pure function of LOGGABLE quantities (per candidate:
iterations, solvedConnections/total, solved/failed, MAX_ITERATIONS). So the schedule is
REPLAYABLE:

1. Workers run candidates in waves (session protocol: constructorParams+connMap sent ONCE
   per node; only hyperParameters per candidate). Each worker logs its trajectory
   (progress sampled every iteration into a typed array — progress = solvedSegments/
   nodeSegments for intra-node solvers, matching getCandidateProgress semantics).
2. Main thread replays the sequential fitness schedule over trajectories: at each
   100-substep slice pick best f = g + h*GREEDY (g = iterations/MAX_ITERATIONS,
   h = 1 - progress) and advance that candidate virtually — winner = who the sequential
   schedule would have brought to solved=true first. BIT-IDENTICAL winner to sequential.
3. Early-exit: candidates whose trajectories show they can never out-compete the
   simulated winner's remaining work can be cancelled (bounded speculation).

Open design points: (a) progress trajectories for NON-standard candidates (A01/A03 expose
progress differently — getCandidateProgress already handles via solvedConnectionsMap);
(b) wave sizing vs memory (8-16 workers × node-local candidate RSS ≈ 10s of MB — fine);
(c) replay granularity = MIN_SUBSTEPS (100) — trajectory sampling every iteration makes
replay exact; (d) candidate classes with side-channel state (CachedIntraNodeRouteSolver
cache) — cache must be per-worker-process, warmed per node session.

Historical plan (all four items now DONE — R measured 9.28, B2 rejected, P1 rejected,
A2 shipped):

## 6. Interaction with benchmarking/profiling (user concern)

- CPU profiles split per worker isolate; bun --cpu-prof covers the main isolate only.
  → Do ALL remaining profile-driven TS work BEFORE landing parallelism. (Done: rounds
  1-4. Remaining safe items are small; see OUR_TODOS.)
- A/B comparisons must control worker count + benchmark --concurrency jointly
  (cores = samples × workers-per-sample). Recommend benchmark runs at --concurrency 1
  with intra-sample workers for the A/B, then a combined sweep.
- Iteration-time win is real for the DEV loop too: sample 8 ≈120s → ~40-60s,
  sample 6 ≈330s → possibly under the 360s cap with margin.

## 7. Risks

- Winner-identity churn flipping DRC quality on some board (mitigate: quality gate
  on both corpora, keep sequential fallback flag).
- Memory blowout from abandoned in-flight candidates (mitigate: wave cap, terminate
  on win, worker RSS telemetry).
- Worker startup/JIT amortization failing on small nodes (mitigate: run small nodes
  in-process — dispatch only nodes whose estimated work exceeds a threshold).
- Repair-stage (A2) dependency making that part moot (verify broadInputSnapshot first).
