# HANDOVER — tscircuit autorouter performance campaign

**Audience:** a fresh agent (any harness) picking up this project. This is the
only file that consolidates the map, the rules, the scoreboard, the pitfalls,
and the frontier. Read it before touching anything.

Last updated: 2026-07-27 (end of a full working day; every number below was
measured that day unless another date is cited).

---

## Table of contents

1. What this project is
2. Scoreboard (why this is worth continuing)
3. The machines, repos, and worktree farm
4. Ground rules (campaign law — each has a scar behind it)
5. Environment cheat-sheet
6. What's shipped (measured, on the branch)
7. Parked/rejected with evidence (do not re-try blindly)
8. The frontier, ranked
9. How to work here (commands, harness, docs discipline)
10. Pitfalls encountered (failure modes to avoid)
11. Doc map

---

## 1. What this project is

`tscircuit/tscircuit-autorouter` (npm `@tscircuit/capacity-autorouter`) is a
~90k-line pure-TypeScript PCB autorouter: circuit JSON in, routed traces out.
Production runs single-threaded per board on Bun (also ships to browsers).
The codebase is a pipeline of ~20 staged iterative solvers
(`BaseSolver._step()` micro-step design) over a hand-rolled capacity-mesh +
tiny-hypergraph pathing + high-density A* per-node routing stack.

This campaign's goal: make it faster without degrading output quality, on a
64-thread/123GB x86 box, with Bun 1.3.14 (user-local `~/.bun/bin`) and Node
24.13 (`~/.local/bin`). All work lands on branch `perf-ts-stack`
(fork `github.com/apullin/tscircuit-autorouter`), currently
`v0.0.718 + ~55 commits`, pushed after every green step.

Long-horizon GPU/Tenstorrent interest was evaluated and answered (see §6,
Rust chapter): not the next move.

## 2. Scoreboard

**Aggregate vs top-of-tree (2026-07-27, srj18 16-board hard corpus):**
- **~4x wall**: upstream v0.0.718 (= origin/main tip) 3724.7s → stack
  default 932.6s = **3.99x, a LOWER bound** (main timed out on s6/s14/s15
  and was charged only the 480s cap each). Per-board: min 2.25x (s5),
  P50 4.19x, max 6.62x (s8: 324.4s → 49.0s).
- Completions: main 13/16 → stack **16/16**. DRC exact on 11 boards,
  better on 2 (s7 7→5, s8 45→41), no-main-baseline on the 3 timeouts.
- Chain of the 4x: ~2.5x sequential (TS rounds 1–6 + math-utils PR +
  tiny-hypergraph R1) × ~1.55x worker parallelism (productized this day,
  default-on for CLI/server).

**Quality parity protocol** (what "faster without cheating" means here):
per-board relaxed-DRC error counts, via counts, and completion counts must
match or beat baseline on the corpus; identity anchors (below) must not move
for identity-tier changes. Routes are NOT required byte-identical outside
the sequential default path.

## 3. Machines, repos, worktrees

Work happens on this box (`peri`-class workstation, 64 threads, 123GB).
A second host `para` (Tenstorrent card) exists but is parked (see
`~/.codex/AGENTS.md`); not needed for current work.

`~/personal/tscircuit-autorouter` is the main clone (remote `fork`). All
`~/personal/awt-*` dirs are git WORKTREES of it (shared .git, one branch
each). **Do not move/rename directories** — worktree metadata and
node_modules symlinks use absolute paths.

| dir | branch | role |
|---|---|---|
| tscircuit-autorouter | main (+ local notes commits) | docs home: HANDOFF.md, WINS.md, OUR_TODOS.md, RUST-PLAN.md, PR-STAGING.md, REVIEW-2026-07-26.md |
| **awt-perf-stack** | **perf-ts-stack** | **THE working tree — all current work** |
| awt-ts2 | perf/ts-round2 | ⚠ LOAD-BEARING: owns the shared patched `node_modules` that awt-perf-stack and awt-r3 symlink to. `bun install` HERE reverts all dep patches |
| awt-r3 | perf/ts-round3 | round-3 history + perf-artifacts |
| awt-r3base | detached | pristine-deps benchmark baseline |
| awt-exp | exp/rewrites | experiments archive (wavefront, drop-one, HD-parallel origin) |
| awt-combined/drc/astar/hygiene/b2 | round-1/2 | historical; contents inside perf-ts-stack |
| awt-upstream-fix | bugfix branch | staged upstream PR (growth-cap) |

Other repos: `~/personal/math-utils-fix` (@tscircuit/math-utils; two PR-ready
branches — see PR-STAGING.md). Meta-notes: this dir (`~/personal/tscircuit`)
also holds `WORKSPACE.md` (farm map).

## 4. Ground rules (campaign law)

1. **NEVER `bun install` in awt-ts2 / awt-perf-stack / awt-r3.** Their
   node_modules are symlinked, hand-patched dep trees owned by awt-ts2.
   A reinstall silently reverts every perf patch (this has bitten twice).
   Recovery procedure: `perf-patches/README.md` in awt-perf-stack.
2. **NEVER edit node_modules in place — anywhere.** bun hardlinks installed
   files into `~/.bun/install/cache` and across worktrees; an in-place edit
   contaminates every tree (the 2026-07-24 hardlink incident cost a night).
   Dep changes: edit a copy → unified diff into `perf-patches/` → apply with
   `patch` (breaks the hardlink). Register npm-dep patches in package.json
   `patchedDependencies`; **git-dep patches are NOT registered** (bun 1.3.14
   silently ignores patchedDependencies for git deps — verified) — apply
   manually and document in `perf-patches/README.md`.
3. **Max 8 bun workers TOTAL on the box.** Memory, not cores, binds: a
   single solve can hold GB-scale heap (main peaked 3.59GB on s5). A session
   was crash-killed once by 32 test workers + 5 concurrent benchmarks.
   Detach long runs with `setsid`.
4. **Identity anchors**: srj18 sample 5 = **1053687** iterations, sample 8 =
   **1973601**, DRC 0/41 — the sequential default path must not move these
   without an explicitly quality-gated experiment. Suite baseline:
   **447 pass / 2 fail / 55 skip**; the 2 fails (`bugreport36-d4c6c2`,
   `dip16`) are PROVEN upstream drift (fail on unmodified v0.0.717, pass on
   v0.0.714) — never "fix" them locally; that masks the drift.
5. **Benchmark hygiene**: benchmark.sh sets `TS_BENCHMARK=1` and pins both
   parallelism flags to 0 — perf A/B runs must set them explicitly.
   Interleave configs serially for clean walls when the box isn't quiet;
   iteration counts and DRC counts are load-independent, walls are not.
   **`CI=1` disables auto-parallelism by design** (CI/throughput contexts
   stay sequential); agent shells often export CI=1 — use `env -u CI` for
   manual parallel measurements.
6. PATH for non-interactive shells: `export PATH="$HOME/.bun/bin:$HOME/.local/bin:$PATH"`.

## 5. Environment cheat-sheet

- Tests: `bun test --parallel=4 --timeout 300000` (~4 min; sequential
  default takes 30+ min).
- Benchmark harness: `./benchmark.sh --dataset 18 --sample-numbers 5,8
  --concurrency 2 --sample-timeout 480s` (always sequential-pinned).
- Single-sample probe (the campaign's main instrument; prints JSON:
  iterations, wallS, relaxed-DRC count, failure stage, mesh node count,
  growth-attempt count, HD-stage wall, eviction stats; supports
  `--max-node-dimension`, `--target-min-capacity`, `--effort`):
  `TS_PARALLEL_HD_NODES=0 bun scripts/eviction-probe.ts --dataset srj18 --sample 8`
- Profiling: `bun --cpu-prof --cpu-prof-md scripts/run-sample.ts --pipeline 7
  --dataset srj18 --sample 8`; stage-level: `bun scripts/profile-solvers.ts`.
- Datasets are git-hosted deps: **srj18** (16 Arduino/antmicro boards = the
  hard corpus; s6 hardest, s5/s8 = identity anchors) and **dataset01**
  (85 easy boards, P50 ~3s).
- Flag inventory: `TS_PARALLEL_HD_NODES=N|auto` (HD node workers),
  `TS_PARALLEL_A2=0/1|auto` (DRC branch portfolio), `TS_BENCHMARK=1`
  (sequential pin), `TS_EVICT_REPATH=1` (+ tunables `TS_EVICT_*`; parked G6
  machinery), `TS_MAX_EXHAUSTIONS` (parked cap), `PERF_NODE_DUMP=1`,
  `PERF_SUPERVISOR_STATS=1` (stats tooling).

## 6. What's shipped (all measured, all on perf-ts-stack)

- **TS rounds 1–6**: 2.34x aggregate vs main (DRC scoring deletion of an
  O(T²·p²) contiguity check was the dominant single win, ~25-35%; A* hotloop
  bit-identical rewrite cut peak RSS 3.59→1.17GB; +hygiene).
- **math-utils perf PR** (in-tree as patchedDependency): Tier-1 1.10x with
  identical iteration/DRC/via counts. Sibling correctness PR staged.
- **tiny-hypergraph R1 compact-hop typed arrays** (1.089x Tier-1,
  bit-identical) and **R2 SoA candidate heap with lazy materialization**
  (2026-07-27; bit-identical via 1100-case differential harness).
- **Worker parallelism productized (2026-07-27)**: node-level HD parallelism
  + A2 DRC-branch portfolio, auto-on off-benchmark/off-browser
  (hardware/memory/board-size gates; explicit env wins). Bookkeeping parity
  on the parallel path; workers cache intra-node successes only (closes the
  failure-cache poisoning class worker-side — see issue-failure-cache.md).
  srj18: aggregate 1.51x, s6 2.17x, DRC exact on all 16.
- **`qualityMode` opt-in** (pipeline 7): `{maxNodeDimension:4, effort:2}` as
  overridable defaults. Corpus: DRC −35% at +80% wall (wins on DRC-heavy
  boards: s6 −66%, s8 −56%, s14 −31%; easy boards pay +150-270%). Caveat:
  s15-class boards exhaust even 2x pathing budgets. **Not a default.**
- **Rust chapter CLOSED (user's call, 2026-07-27)**: native/portfolio-core
  (~7.7k LOC) is a bit-exact mirror of the TS portfolio (1221 nodes, 76,923
  candidates, 0 mismatches) — kept as the parity harness — but the native
  engine runs this workload at ~0.6x JSC even sequentially. Three
  independent confirmations (A01 kernel wash, run-to-completion loss,
  schedule-identical loss). The campaign's own JIT-friendliness work removed
  the headroom. Tenstorrent answered transitively: zero-transport native
  threads lose to the JS scheduler, so an accelerator port is not the next
  move. **Do not revive without new evidence.**

## 7. Parked/rejected with evidence

Each has a measured writeup (WINS.md / commit messages / perf-artifacts).
Re-trying one without new evidence wastes a quota window.

- **G6 eviction+re-path** (`TS_EVICT_REPATH`, machinery shipped flag-off):
  evicting one connection from a doomed node + local detour re-path.
  Works mechanically (6/6 planned evictions rescued) but loses economically:
  a trimmed node is MARGINALLY routable (rescue = near-exhaustion search)
  while growth makes it EASY. s8: +8% iterations/+3 DRC; s6: +16% iterations.
- **Doom prediction** (four analytic bounds, learned rule, nodePf targeting):
  no local signature exists — doomed node cmn_166 has pf 0.000 while healthy
  cmn_434 has 0.625. Third confirmation 2026-07-27.
- **Parallelism variants**: P1 take-first race (winner selection is
  quality-load-bearing: 0→15 DRC), P2 deterministic replay (winner semantics
  solved but worker transport costs 3.8x/70%), Rust run-to-completion (Gate
  B: ~9x work multiplier swamps 8 threads).
- **Growth ladder 1.2,2,4,8** (G8, parked): s8 DRC 45→31 at ~8% wall;
  needs two-corpus gate; 1.2-only catastrophic on s6 (99→289).
- **Cost caps** (move work to 2x scale instead of eliminating it),
  **salvage-before-grow** (complete-but-illegal repairs better),
  **exact-grid coordinates** (mixed quality, no speed),
  **probe memoization** (twice: call redundancy real, memo cost exceeds it),
  **wavefront router** (0 unroutable but 3x trace length, 1854 DRC),
  **explored-cell bitmap** (0.99x), **B2 progress-aware scheduling** (−12%).

## 8. The frontier (ranked by evidence)

1. **Upstream PRs — STAGED, awaiting the user's trigger only**
   (PR-STAGING.md, one command each): math-utils correctness (collinear
   dust manufactures false DRC for every consumer), math-utils perf,
   autorouter growth-cap fix; 3 drafted issues (failure-cache key,
   cross-node margin, scaleRoute thickness). Never fire autonomously.
2. **Region-count-scaled pathing budgets** — SelectiveRerip's budget is a
   fixed `2M×effort`; finer meshes exhaust it (s15 class, qualityMode
   caveat, blocks any global granularity reduction).
3. **Upstream note**: `targetMinCapacity`/`capacityDepth` are computed but
   never consumed in pipeline 7 (proven byte-identical dead opts).
4. **G7 runtime port**: lib/parallel is Bun-API-only — Node/web-worker port
   before non-Bun users get the 1.5x. Plus a node-vs-bun JIT A/B.
5. **Capacity-model prevention proper** (G10 follow-up): demand-aware mesh
   generation. Research project; every reactive path is measured-closed
   (perf-artifacts/g10-capacity-prevention-design.md).
6. **Stage-2 incremental replay** (~4x theoretical): fifth parallel attempt;
   only with explicit new evidence.

## 9. How to work here

Daily flow: work in `awt-perf-stack` on `perf-ts-stack`; granular commits
with evidence in the message (what was measured, what is inert, anchor
status); push to fork when green; design docs in `perf-artifacts/`
(untracked scratch).

**Docs discipline is load-bearing** (this campaign runs multi-model relay):
every measured claim into `WINS.md` (config + corpus + date), ideas/parked
items in `OUR_TODOS.md`, dated session block atop `HANDOFF.md`. Mirror the
docs to fork branch `perf-notes` (`docs/` dir) via a temp worktree:

```bash
cd ~/personal/tscircuit-autorouter
git worktree add /tmp/pn perf-notes
cp WINS.md OUR_TODOS.md HANDOFF.md /tmp/pn/docs/
cd /tmp/pn && git commit -am "notes: <what changed>" && git push fork perf-notes
cd - && git worktree remove /tmp/pn
```

Quality gates by change class:
- **Identity-tier** (bit-identical required): anchors EXACT (s5 1053687 /
  s8 1973601) + DRC 0/41 + a differential harness where feasible.
- **Behavioral** (output may change): corpus quality parity — per-board
  relaxed-DRC counts, vias, completions on srj18 (and dataset01 when broad).
- Walls only on a quiet box, interleaved serial A/B; report load context.

## 10. Pitfalls encountered (learn from our scars)

- **bun hardlink contamination** (§4.2): one in-place node_modules edit
  leaked into the global cache + 6 worktrees; restored from snapshots.
- **Math.hypot→sqrt flips tie-breaks** in tiny-hypergraph cost functions
  (3 snapshot tests failed despite synthetic identity) — re-landed later as
  a quality-gated patch with snapshot updates. Float-op order is semantic.
- **Benchmark load corruption**: another project's builds once poisoned
  overnight A/B comparisons (±15% noise). Always check `uptime`; interleave.
- **`CI=1` in agent shells** silently disables auto-parallelism (by design);
  a whole A/B measured "no effect" before this was caught. `env -u CI`.
- **pgrep self-match**: watcher loops like
  `while pgrep -f "eviction-probe"; do sleep 10; done` deadlock — the
  watcher's own cmdline matches. Use PID files or hub process management.
- **`cd "$(dirname "$0")"` in scripts/** lands in scripts/, breaking
  `bun scripts/...` invocations (a whole gauntlet silently produced empty
  rows). Use `cd "$(dirname "$0")/.."`.
- **Dormant patches**: a "landed" dep optimization survived only as a patch
  file while the live tree excluded it for weeks — always verify the live
  node_modules content, not the patch registry (round-4 hypot lesson).
- **O(N²) getOutput traps**: `TinyHypergraphPortPointPathingSolver.getOutput()`
  is pure but rebuilds all nodes per call; per-node callers must cache
  (fixed in computeNodePf).

## 11. Doc map

| file | content |
|---|---|
| **HANDOVER.md** (this file) | `~/personal/tscircuit/` — start here |
| WORKSPACE.md | `~/personal/tscircuit/` — farm/worktree map |
| HANDOFF.md | main clone — campaign history, dated blocks (read top first) |
| WINS.md | main clone — every measured win/loss with context |
| OUR_TODOS.md | main clone — frontier items G1–G10 with status |
| REVIEW-2026-07-26.md | main clone — second-opinion audit |
| RUST-PLAN.md | main clone — native plan + gate outcomes (closed) |
| PR-STAGING.md | main clone — staged upstream PRs (awaiting user trigger) |
| perf-artifacts/ | awt-perf-stack — design docs (g6-eviction, g10-capacity, parallelism-design), profiles, gauntlet logs; untracked |
| fork branch `perf-notes` | mirror of the docs above (`docs/` dir) — travels with the repo |

If anything in this file disagrees with the tree, trust the tree and the
latest WINS.md entry — then fix the doc.
