# OUR_TODOS.md — running idea list (untracked scratchpad)

Convention: `- [ ]` open, `- [x] ~~done~~` struck through but KEPT for history, with date + outcome.
Companion files: WINS.md (measured results), perf-audit-2026-07-23.md (findings),
perf-artifacts/kernel-inventory.md (accelerator analysis).

---

## A. Parallelism (highest-leverage open direction)

- [ ] **A1. Parallelize the intra-node portfolio.** `PortfolioSingleIntraNodeSolver` runs ~60 independent
      candidate solvers per node; `HyperParameterSupervisorSolver` adaptively time-slices them because it
      is rationing ONE core. With 64 cores the rationing is counterproductive — run candidates
      concurrently and take first/best success. Converts adaptive scheduling into a race.
      NOTE: changes results (not result-identical) → gate on benchmark quality, not snapshots.
      Serialization is small (a node = dozens of port points + local obstacles).
- [ ] **A2. Parallelize the DRC branch portfolio.** `GlobalDrcBranchPortfolioSolver` runs 3 branches
      (baseline / broad / via-in-pad) sequentially, each capped 32/8/32 iters. Trivially independent.
- [ ] **A3. Node-level parallelism in GrowShrink queue** — HARDER: solved routes constrain later nodes
      (see `getFirstSolvedViaTraceConflict`). Needs dependency analysis / optimistic execution + conflict
      re-solve. Do after A1/A2.
- [ ] **A4. Decide worker transport.** Bun Workers (separate isolates, structured-clone) vs
      SharedArrayBuffer + SoA typed arrays. SoA work (C1) makes this much cheaper. Measure clone cost
      before committing.
- [ ] **A5. Amdahl sanity check first** — HD stage is ~58% of srj18 wall. 8x on that alone ≈ 2x overall.
      Hypergraph pathing (~30%) is sequential pathing and will become the new bottleneck. Model before building.

## A-bis. Sampling-based planning as an optional routing tech (new 2026-07-24)

- [ ] **A6. RRT / sampling-based planner as a portfolio candidate + stagnation fallback.**
      Idea source: user recalled a Stanford prof (likely Shuran Song, Stanford EE/robotics; if it was a
      planning specialist, Marco Pavone's StanfordASL is the better match) favoring random-tree search for
      being parallelizable and not getting stuck. Technique = RRT (LaValle 1998) / PRM / RRT* / FMT*.
      **Why it fits here specifically:**
      (a) The intra-node portfolio IS a homotopy-class explorer (per kernel-inventory finding), but it
          currently generates classes by ENUMERATING hand-tuned hyperparameter combos. Sampling is the
          principled alternative — cf. "homotopy-conscious PRM" literature
          (link.springer.com/article/10.1007/s10846-015-0278-z).
      (b) Probabilistic completeness directly targets B1 (sample 6 spins 1M iters at 0% progress).
          DEPENDENCY: needs B2 (computeProgress NaN) fixed first so stagnation is even detectable.
      (c) Smoothing infra already exists — MultiHeadPolyLine force relaxation + TraceSimplificationSolver
          + MultiSimplifiedPathSolver — so RRT's jagged-path weakness is already covered.
      (d) Parallelizes trivially → composes with A1 portfolio racing.
      **Known weaknesses:** plans ONE path (routing is multi-agent: N non-colliding paths — either
      sequential w/ ordering, which the portfolio already varies, or joint config space which explodes);
      probabilistically complete but NOT optimal (RRT* converges slowly, PCB cares hard about
      length/vias/DRC); no PCB/VLSI precedent found in literature search — novel but unproven here.
      **Scope:** additive portfolio candidate + stuck-escape hatch, NOT a replacement for the A* router.
      Architecture already supports pluggable strategies (HIGH_DENSITY_A01, MULTI_HEAD_POLYLINE_SOLVER,
      CLOSED_FORM_SINGLE_TRANSITION are hyperparameter-selected today).

## B. More TypeScript / algorithmic wins

- [ ] **B1. Sample 6 pathology** — only remaining hard srj18 timeout. HighDensitySolver spins ~1M
      iterations at 0% progress. Algorithmic (stagnation detection / escalation), not micro-opt.
- [x] ~~B2. computeProgress-returns-NaN bug~~ — **2026-07-24: EXPERIMENT, REJECTED.** Fixed the no-arg
      call to return stored progress (branch perf/b2-progress, ed0039da). Tier-1: samples 10/12 12%
      SLOWER, vias up on 4/5 samples, sample 10 gained a DRC error (0→1); samples 8/6 DRC improved
      (45→39, 99→82). Net: slower and quality-mixed. The NaN masking (schedule on work-consumed
      only, h=1) is de-facto correct behavior — progress-aware fitness is greedier in a bad way.
      Do NOT merge. Implication for P2 parallelism: schedule replay needs a BETTER progress metric,
      not the existing one.
- [x] ~~B3. Round-2 items in flight~~ — 2026-07-24: DONE, 4 commits on perf/ts-round2 (pushed to fork
      as perf-ts-round2). Tests green (419/0), zero snapshot diffs, byte-identical vs perf/combined.
      Benchmarked as ts-round2 baseline in the round-3 A/B (P50 121.4s on Tier-1 set, 4/5 completed,
      sample 6 timeout). Items: computeNodePf O(N²)→O(N) handoff, regions.find→Map+bbox prune,
      MultiHeadPolyLine per-pair rebuild hoisting, objectHash/structuredClone→JSON key+manual clone,
      HighDensityRouteSpatialIndex numeric keys/generation-stamp/per-route buckets. Deferred (not
      result-identity-safe): candidates.shift()→priority queue in the polyline solver.
- [x] ~~B6. Math.hypot→sqrt: BLOCKED by result-identity~~ — **2026-07-26: ACTIVATED, quality-gated.**
      Round 4 measured it (1.054x corpus, srj18 DRC 581→575, all dataset01 boards identical) but the
      live tree had silently lost the edit — it survived only as docs/tiny-hypergraph-hypot.patch.
      Re-applied 2026-07-26 as perf-patches/bun-tiny-hypergraph-hypot.patch (kept SEPARATE from the
      identity-safe tiny-hypergraph patch), snapshots updated for the churned tests. New sample-5
      identity anchor: iterations 1053687 (was 1048233). One Math.hypot deliberately remains
      (selective-rerip :455, outside the measured 13-site swap — see G/R5).
- [ ] **B7. math-utils scalar kernels — MOSTLY BLOCKED by result-identity (2026-07-24 analysis).
      Squared-distance comparisons (d2 < p*p vs sqrt(d2) < p) diverge at boundary ties in ulps →
      float-nonidentical → same class as the reverted hypot swap. The only bit-identical piece:
      local scalar pointToBoxDistance with EXACT same op order (alloc removal) at hot callers
      (isThroughObstacleSegment, getTerminalPadWidthLimit) — small (~0.5%), unmeasured.
- [ ] **B4. CapacityPathing sort()+shift() per expansion** → use the already-written-but-DEAD
      `lib/data-structures/PriorityQueue.ts` (nothing imports it). Mostly pipeline 1, lower p7 value.
- [ ] **B5. Union-find in connectivity map** → proper DSU (currently linear scan per node + entries-array
      alloc per merge). Upstream, but int-id interning is also a prerequisite for any SoA marshaling.

## C. Kernel / SoA extraction (accelerator ladder)

- [ ] **C1. SoA SegmentTable + batched segment-distance API** behind the repo-side DRC evaluator seam
      (`lib/testing/getDrcErrors.ts`). Float32Array ax/ay/bx/by/halfWidth + Int32Array layer/net/traceId.
      fp32 safe (~1e-4mm err vs 5e-3mm DRC epsilon); zero-thickness exact-intersection predicate needs fp64.
      Pure-TS backend first + golden-output harness. This is the swappable boundary for ANY backend.
- [x] ~~C2. Re-profile sample 8 on perf/combined BEFORE building C1~~ — 2026-07-24: done on ts-round2
      (186s vs 365s original). Residuals: A01/A03 kernels ~15% (fixed r3), checks 5.7% (fixed r3),
      getNetConnectedToId 3.8% (fixed r3), tiny-hypergraph computeG ~5% (hoisted r3; hypot parked B6),
      flatbush search ~3.8% (isNodeTooCloseToObstacle/doesPathToParentIntersectObstacle query volume —
      OPEN), graphics-debug/fflate ~8% (harness-only). Profile: awt-ts2/perf-artifacts/r3-prof/.
- [ ] **C7. Cross-candidate obstacle-clearance cache — STRING-KEY MEMO FAILED (2026-07-24).**
      85.9% probe redundancy (3.83M calls, 540k distinct) but per-instance string-key memo REGRESSED
      sample 8 by 11% (126.9s vs 112.9s): key building + Map ops + GC pressure > flatbush search cost.
      Reverted. Possible salvage: numeric lattice key (quantize x,y by this.cellStep into a packed
      number — needs proof all node positions share one lattice so distinct floats never share a key)
      or a per-instance Int32 stamp grid. Measure TIME of probes vs key cost on sample 8 before retrying.
- [ ] **C7b. flatbush search ~5% remains open** — isNodeTooCloseToObstacle query VOLUME is the cost.
      Alternative attacks: prune queries at the caller (skip re-probing cells already known-clear via
      the A* explored/frontier sets), numeric-key Flatbush fork, or SoA segment table + scalar scan
      (segments per query are few). Profile sample 8 post-round-4 first.
- [ ] **C3. Native CPU backend (Rust via napi-rs or cdylib+bun:ffi)** for C1 if the batch justifies it.
      Far less onerous than CUDA: no driver/version coupling, portable CI, easy SIMD.
- [x] ~~C4. Evaluate cuDSS/cuSPARSE for MultiHeadPolyLine force relaxation~~ — **2026-07-24: NO.**
      Pure exponential repulsion, no springs, not a gradient system, multiple equilibria semantically
      load-bearing, ≤84 DOF. Fix as in-place TS SoA instead.
- [x] ~~C5. Assess GPU offload viability~~ — **2026-07-24: NOT YET JUSTIFIED.** The only offload-sized
      batch (segment-distance, ~25% of old profile) was driven by contiguity checking in DRC candidate
      scoring, which perf/drc-scoring already deleted. Revisit only if parallel candidate scoring (A1/A2)
      multiplies DRC eval counts back up — then cuSpatial pairwise_linestring_distance is a drop-in shape.
- [ ] **C6. Tenstorrent Wormhole n300** — parked behind C1-C3. Architecturally interesting for A1-style
      independent branchy searches (128 MIMD Tensix cores w/ ~1.5MB SRAM each ≈ one small A* per core),
      which is exactly what SIMT/CUDA is bad at. High effort (tt-metal is low-level). Do CPU parallelism
      first — it answers the same "is there enough independent work?" question for free.

## D. Upstream contributions (hot code lives in deps)

- [ ] **D1. `circuit-json-to-connectivity-map`** — PcbConnectivityMap all-trace-pairs × all-segment-pairs
      (was `doesLineIntersectLine` 24% of old profile); `findConnectedNetworks` quadratic union-find.
- [x] ~~D2. `@tscircuit/checks`~~ — 2026-07-24 (round 3, as perf-patches/, not upstreamed):
      checkViaTraceClearance spatial index (~8-9x micro), net-id hoisting in non-overlap + via-spacing
      checks, duplicate closest-point removal in getTraceObstacleClearance. Verified byte-identical on
      300 random seeds. NOTE: nested hdr03 copy (checks@0.0.123) untouched — showed ~0 in fresh profile.
      getReadableNameForPcbTrace linear scan NOT fixed (not hot in fresh profile).
- [ ] **D3. `high-density-repair03`** — incremental/scoped DRC re-check instead of full-board per
      candidate (the structural fix; we only fixed the repo-side scoring seam); connMap not passed →
      3 quadratic rebuilds per candidate.
- [x] ~~D4. `@tscircuit/high-density-a01`~~ — 2026-07-24 (round 3): A03 fillViaOccupants inline +
      occupancy-version cache = 2.2x micro on dataset01 sample001 (58.6% cache hit rate), A01 1.07x.
      Bit-identical outputs (hash-verified).
- [ ] **D5. Decide contribution posture** — vendored patches vs upstream PRs vs both. Fork exists:
      github.com/apullin/tscircuit-autorouter.

## E. Features (not perf)

- [ ] **E1. Current-carrying trace annotations → width sizing.** Feasibility assessed 2026-07-24:
      `TraceWidthSolver` ALREADY does per-connection variable width w/ schedule + tapering + pad necking
      (`SimpleRouteConnection.nominalTraceWidth`). Missing: (a) a current prop, (b) IPC-2221/2152
      current→width conversion (needs copper weight, temp rise, internal/external layer), (c) plumbing to
      `nominalTraceWidth` at circuit-json→SRJ conversion.
- [ ] **E2. Loud DRC check when width solver can't meet required width.** Currently narrows to
      `minTraceWidth` SILENTLY → electrically wrong board, no error. Cheap, high value, do with E1.
- [ ] **E3. Width-aware capacity planning** — router doesn't reserve room for wide traces
      (`traceWidthSolver` runs ~5 stages AFTER `highDensityRouteSolver`). Real work in the capacity model.
      Do after perf work settles; touches the same internals.
- [ ] **E4. Via current handling** — no current-aware via sizing / stitching exists at all.

## F. Infrastructure / process

- [x] ~~F1. Get tests + benchmarks running locally~~ — 2026-07-23. bun+node installed user-local;
      `bun test --parallel=32` (30min → 164s).
- [x] ~~F2. Reproduce their CI benchmarks~~ — 2026-07-23. Matches CI to the decimal.
- [x] ~~F3. Parallel benchmark gauntlet~~ — 2026-07-24, `perf-artifacts/gauntlet.sh` (run detached via
      setsid; a session crash killed it once). Lesson: staggered starts break load symmetry → run2 noisy.
- [ ] **F4. Automate the Tier-1 subset as a one-command A/B** (`--sample-numbers 5,8,10`) with
      before/after table output. Currently hand-assembled per agent.
- [x] ~~F5. Consider upstreaming the perf work as PRs~~ — **2026-07-26: STAGED, awaiting user
      trigger.** Three PRs (math-utils correctness, math-utils perf, autorouter growth-cap fix) and
      three issues (failure-cache key, cross-node margin, scaleRoute thickness) are one-command
      ready in PR-STAGING.md + perf-artifacts/pr-staging/. Branch hazard fixed: PR 2 must come from
      perf/parametric-segment-distance (contains the fix), NOT perf/geometry-hot-path. The stack
      itself should upstream later as a curated series, not a megabranch.
- [ ] **F6. bun node_modules hardlink hazard — document for all agents.** bun hardlinks installed files
      into ~/.bun/install/cache and across worktrees. NEVER edit node_modules in place: apply changes via
      `patch` (replaces file, breaks link) or rm+cp first. Round 3 hit this: npm-package edits leaked into
      the cache + 6 worktrees; restored via /tmp/checks-r3 orig snapshots + GH cache copies.
- [!] **F7. ANCHOR TRAP (since G9 auto-enable, 2026-07-27): bare probe runs are NONDETERMINISTIC** —
      auto parallel HD solving kicks in with env unset (s5 lands in a 1026915-1027001 band).
      Every identity/anchor check MUST pin TS_BENCHMARK=1 or TS_PARALLEL_HD_NODES=0
      TS_PARALLEL_A2=0. Anchors: s5 1053687/DRC 0, s8 1973601/DRC 41.
- [!] **F8. LOCKFILE TRAP: no lockfile in the repo** — a fresh `bun install` resolves newer deps
      (e.g. @tscircuit/eval 1050→1072) and SHIFTS ITERATION COUNTS even with all perf-patches
      applied. Anchors only reproduce on the frozen node_modules lineage. New worktrees:
      `cp -a ~/personal/awt-ts2/node_modules <worktree>/` instead of bun install (patches
      already applied there; verify the last patch of each chain reverse-applies cleanly).
      (Some fresh installs DO still reproduce — resolution-timing dependent; always verify.)

## G. Round 5 frontier (2026-07-26, from the second-opinion review — see REVIEW-2026-07-26.md)

- [x] **G1/R1. tiny-hypergraph compact-hop typed arrays — LANDED 2026-07-26 (16192ba9,
      bun-tiny-hypergraph-r1-compact-hop.patch).** hopId = portId*2+side; sparse-mode Maps and the
      heap's indexByHopId Map + closedHopIds Set → typed arrays with generation stamps; compact
      hopId cached on candidates at queue time (delivers R7). Identity-safe: anchors s5 1053687 /
      s8 1973601 EXACT, DRC 0/41. Measured 1.089x on Tier-1.
- [x] **G2/R2. Kill per-neighbor candidate allocation** — LANDED 2026-07-27 (59a7ab39).
      Step A was already live (R2a in the r5 patch); Step B: SoA pool in
      IndexedCandidateHeap with lazy Candidate materialization (one alloc per
      expansion, zero object traffic in sift loops). Bit-identical: differential
      harness 1100 cases 0 mismatches; anchors s5 1053687 / s8 1973601 EXACT,
      DRC 0/41 (re-verified by Main). Wall effect to be resolved by the next
      quiet-box gauntlet (identity-tier, expected ~2-5% of the pathing stage).
- [x] **G3/R3. computeG invariant hoisting — LANDED 2026-07-26 (3dd20cc4,
      bun-tiny-hypergraph-g3-hoist.patch).** Per-dequeued-candidate invariants hoisted via
      predeclared class fields with a self-repopulating guard (expansionCandidate !==
      currentCandidate) covering unlisted call paths incl. the GreedyFinalRoute seam.
      Anchors s5/s8 EXACT, DRC 0/41.
- [x] **G4/R4. countNewIntersections packed int — LANDED 2026-07-26 (3fe64aa7, in the r5 patch).**
      countNewIntersectionsPackedWithValues at both core.ts call sites; tuple API kept for compat.
- [ ] **G5/R5. Blocker-search churn** (M, ~1.3-2.6% wall, REMAINING half): R6 (shared
      getPortOwners() between direct and alternate blocker searches) LANDED 2026-07-26 in the r5
      patch. Still open: owner Sets → insertion-ordered arrays + bitset. CAUTION: [...owners]
      order feeds rip order — a bare bitset is NOT identity-safe. Also the one remaining
      Math.hypot (selective-rerip :455).
- [x] **G6. Eviction + re-path of over-committed nodes — BUILT, MEASURED, PARKED
      (2026-07-27, be0798ac, negative for speed).** Local-detour eviction works
      mechanically (TS_EVICT_REPATH, default off; 10 unit tests) and confirms
      over-commitment on both boards, but rescue economics lose to growth:
      trimmed nodes are MARGINALLY routable (near-exhaustion searches) while
      growth makes nodes EASY. s8 g=0: 6 rescues, +8% iterations, +3 DRC —
      rejected. s6 g=1: 1 rescue, DRC 96 vs 100, +16% iterations — rejected
      for speed. Placement is the s6 bottleneck (rejectedPlans 5, victims 0
      lacking). Machinery kept flag-off as the repair valve for the capacity
      model path. Full data: perf-artifacts/g6-eviction-design.md epilogue.
      ⇒ The lever is now unambiguously **capacity-model prevention**
      (getTunedTotalCapacity1, tuned for 2 layers on 4-layer boards) with
      PERF_NODE_DUMP labels + eviction stats as calibration truth.
- [x] **G10. Capacity-model prevention — INVESTIGATED, shipped as opt-in (2026-07-27,
      7eb94e46).** Two levers measured: mesh granularity (maxNodeDimension —
      targetMinCapacity proven a DEAD opt in pipeline 7) and effort scaling.
      Corpus gate @ mnd=4/eff2: DRC -35% at +80% wall, wins on DRC-heavy
      boards (s6 -66%, s8 -56%), easy boards pay +150-270%; s15 timeout
      pathology. Effort's DRC win = global more-search=better-winners, not
      doomed-node rescue; doomed nodes have no local signature (nodePf dead
      too — cmn_166 doomed at pf 0.000). Shipped: `qualityMode` pipeline opt.
      Follow-ups: region-count-scaled pathing budgets (s15 class); upstream
      note about the dead opts.
- [x] **G7a. Runtime A/B: node/V8 vs bun/JSC — MEASURED 2026-07-27 (WINS.md entry).**
      node 1.09-1.28x slower on the stack; NO priority reshuffle; stack speedup is BIGGER
      for node users (s5 1.99x vs bun 1.72x). Bonus finding: upstream is engine-
      NONDETERMINISTIC (base s8 forks on Math.hypot: DRC 45 bun vs 41 node); the stack's
      hypot→sqrt makes results engine-stable — upstream ammo. Browser leg not run (V8
      numbers proxy Chrome; Safari=JSC ~ bun numbers).
- [x] **G7b. lib/parallel node worker_threads port — LANDED (merge 8904d3ac, 2026-07-27).**
      Runtime shim + lazily prebundled worker entries + nodeWorkerSupport() auto-gate.
      Merged-stack verification: bun anchors EXACT, 13/13 parallel tests, node smoke PASS
      (s8 seq 96.4s → HD=2 63.1s, DRC 41=41, 1211/1211 node statuses). Still open:
      web-worker (browser) layer; dist-published worker bundles so npm consumers (not
      just repo checkouts) can go parallel under node.
- [x] **G8. Growth-ladder corpus gate — GATED 2026-07-27, NEGATIVE as default (dc6ffe4c,
      WINS.md entry).** srj18 ×16: wall +24%, DRC 558→577 net WORSE (s8 −17, s15 +35).
      Mechanism attributed: extra rung displaces the 8x rung under the attempts cap (cap-4
      probe restores s15 to exactly 90; s8/s13 bit-identical at either cap). Best case DRC −3%
      @ +24% wall — dominated by qualityMode. Env hooks landed default-off: TS_GROWTH_SCHEDULE
      + TS_MAX_GROWTH_ATTEMPTS. Only future use: per-board adaptive quality policy (s8-class).
- [x] **G9. HD-node + A2 parallelism productization — LANDED (2026-07-27, 42d12713 +
      83f46ea8).** Auto-enable off-benchmark/off-browser with hardware/memory +
      board-size gates; explicit env always wins; benchmark.sh pins both flags
      to 0. Full bookkeeping parity on the parallel path; worker-side
      success-only intra-node cache closes the failure-cache poisoning class.
      Gates: s5 anchor exact under TS_BENCHMARK=1; s8 auto DRC 41==41,
      wall ~1.5x (load-contaminated). Remaining: node/web-worker runtime port
      (G7) so non-Bun users benefit; eviction+parallel composition (G6 v2,
      needs the eviction economics fixed first).
