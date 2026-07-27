//! SEQUENTIAL native supervisor (hp-wrapper `"mode":"seq"`) — the follow-up
//! to the Gate B negative result (RUST-PLAN.md "GATE OUTCOMES"): the
//! run-to-completion mode lost because it abandons the TS scheduler's
//! work-avoidance. This mode keeps it EXACTLY: it is a line-faithful mirror
//! of the LIVE adaptive supervisor schedule — NOT the replay semantics —
//! driving real `CandidateSolver`s one at a time on the calling thread (no
//! rayon, zero contention; that is the point).
//!
//! THE LIVE SCHEDULE MIRRORED (all citations against the awt-perf-stack
//! worktree, same standard as the rest of the crate):
//!
//!   outer driver        BaseSolver.step (BaseSolver.ts:33-56): iterations++
//!                       BEFORE _step (:36); budget check AFTER, `iterations >
//!                       MAX_ITERATIONS` with an UNCONDITIONAL error
//!                       assignment (:48-51) that can overwrite a same-step
//!                       all-failed error; tryFinalAcceptance is the base
//!                       no-op for this class (:45-47, :87).
//!   _step               PortfolioSingleIntraNodeSolver.ts:841-952: lazy
//!                       initializeSolvers (:858 via
//!                       HyperParameterSupervisorSolver.ts:148), the
//!                       PRE-step expansion check "no viable candidate"
//!                       (:860-865), super._step (:867), the stepped
//!                       candidate's work fold (:941-944), the POST-step
//!                       expansion check "work budget spent" (:949-951).
//!                       (noteCandidateOutcome / checkNodeWorkCap / lean
//!                       mode are OFF in parity runs — driver.ts module doc —
//!                       and are not modeled.)
//!   super._step         HyperParameterSupervisorSolver.ts:147-172: pick
//!                       (:150), all-failed => failed + message (:152-156),
//!                       the MIN_SUBSTEPS step-slice (:158-160), recompute
//!                       g/h/f FOR THE STEPPED CANDIDATE ONLY (:163-165),
//!                       solved => winner (:167-171).
//!   pick                getSupervisedSolverWithBestFitness (:120-137): scan
//!                       supervisedSolvers IN ORDER; a SOLVED candidate
//!                       returns IMMEDIATELY (:124-125 — before any fitness
//!                       comparison; live-vs-replay difference, see below); a
//!                       failed one is skipped (:127-129); otherwise strict
//!                       `fitness < bestFitness` keeps the FIRST lowest
//!                       STORED f (:130-134) — the tie-break is candidate
//!                       index order = hp enumeration order.
//!   f                   computeF = g + h * GREEDY_MULTIPLIER
//!                       (HyperParameterSupervisorSolver.ts:116-118), with
//!                       GREEDY_MULTIPLIER = 5 and MIN_SUBSTEPS = 100
//!                       (PortfolioSingleIntraNodeSolver.ts:259-261).
//!   g                   the computeG override family
//!                       (PortfolioSingleIntraNodeSolver.ts:954-972): A01/A03
//!                       -> iterations/1e6, polyline -> 1000 + (pen+it)/1e4 +
//!                       1e4*(SPP-3), default -> iterations/1e4. Reused from
//!                       replay_sim::candidate_g / resolve_g_class (the
//!                       proven transcription of the identical
//!                       replayPool.ts:64-81) — the hp-key classification is
//!                       equivalent to the live instanceof checks because
//!                       generateSolver branches on the same keys
//!                       (PortfolioSingleIntraNodeSolver.ts:981-1082).
//!   h                   computeH (:974-979): pre-expansion `1 - (progress
//!                       || 0)` — the RAW NaN pipeline, UNCLAMPED (may exceed
//!                       1 -> negative term); post-expansion
//!                       `1 - getCandidateProgress(solver)` (:192-198):
//!                       solvedConnectionsMap present -> min(1, solvedSegments
//!                       / nodeSegmentCount), else clamp01(progress || 0).
//!   initial f           f = g = computeG(fresh solver) = g(0), h absent
//!                       (HyperParameterSupervisorSolver.ts:92-99; same for
//!                       expansion candidates via addSupervisedCandidate,
//!                       PortfolioSingleIntraNodeSolver.ts:530-542).
//!   expansion           expandAdaptiveSearch (:544-564): append the A01
//!                       seed-1..5 tail (already marshaled at indices >=
//!                       initialCount, driver.ts EXPANSION_SHUFFLE_SEEDS),
//!                       then refreshDynamicIterationLimit (:554). Triggers:
//!                       no-viable-candidate pre-check (:860-865) and
//!                       totalCandidateWork >= getDynamicExpansionWorkBudget
//!                       (:566-574, :949-951), the budget being max(1, max
//!                       initial MAX_ITERATIONS), cached at init (:236-247,
//!                       :525).
//!   supervisor budget   refreshDynamicIterationLimit (:436-464) at init
//!                       (:527) and at expansion (:554): MAX_ITERATIONS =
//!                       max(iterations+1, iterations + Σ over non-terminal
//!                       candidates of ceil(max(0, MAX_i - it_i + 1) /
//!                       MIN_SUBSTEPS)), then capped by a non-null
//!                       externalMaxIterations (:457-462).
//!   work accounting     totalCandidateWork = Σ candidate iterations, folded
//!                       as the stepped solver's delta (recordCandidateWork,
//!                       :204-216, called at :941-944 and — a no-op at 0
//!                       iterations — from initializeSolvers :519-524).
//!   failure message     getFailureMessage (HyperParameterSupervisorSolver
//!                       .ts:139-145): sort by f DESCENDING (stable), take 5,
//!                       join errors with ", " (JS join renders null as "").
//!
//! CANDIDATE EXECUTION: dominant-class candidates are REAL
//! `intra_node::CandidateSolver`s stepped incrementally (contract C2, +1
//! iteration per `step()`, self-no-op once terminal — exactly the live
//! per-slice `solver.step()` x100). Non-dominant candidates arrive as tsrec
//! records and are consumed VIRTUALLY: a slice advances v by min(100,
//! recorded_iterations - v) — the arithmetic outcome of 100 deterministic
//! `step()` calls (same formula as replayPool.ts:252) — and h reads the
//! recorded trajectory on the identical grid
//! (replay_sim::progress_at, delta (4)).
//!
//! LIVE-vs-REPLAY DIFFERENCES DELIBERATELY ON THE LIVE SIDE HERE:
//!   (a) solved-candidate short-circuit: the live pick returns the FIRST
//!       solved candidate before comparing any fitness (:124-125); the
//!       replay keeps solved-at-0 candidates merely "selectable" and picks
//!       by f. On a node with a solved-at-0 record behind a runnable equal-f
//!       candidate the two schedules genuinely diverge (see
//!       `live_short_circuit_diverges_from_replay`).
//!   (b) STORED (stale) f: live recomputes f only for the candidate it just
//!       stepped (:163-165) — when `adaptiveSearchExpanded` flips, every
//!       other candidate keeps its pre-expansion f until next stepped. The
//!       replay recomputes every round with the current flag.
//!   (c) expanded-h clamp: live clamps the no-solvedConnectionsMap progress
//!       into [0,1] (:197); the replay's expanded branch falls through to
//!       the RAW sample.
//!
//! LIVE-vs-NATIVE DIFFERENCES (documented, decision-inert):
//!   DIFF-1 lazy construction: TS constructs EVERY candidate (plus setup) in
//!       initializeSolvers before any step (:509-528). The ctor is
//!       schedule-inert for the dominant class: it does NOT probe the cache
//!       (the probe happens on the candidate's FIRST step,
//!       CachedIntraNodeRouteSolver.ts:89-94 — identical timing either way),
//!       never sets solved/failed (IntraNodeSolver.ts:186-212 fast path
//!       commented out), consumes no shared RNG (per-hp seeds), and setup
//!       neither advances nor solves (:418-426). The only ctor observables
//!       the schedule reads are MAX_ITERATIONS — identical for every
//!       dominant candidate, `intra_node::dominant_max_iterations` — and the
//!       initial f = g(0), an hp-only value. Construction order therefore
//!       cannot affect any schedule decision, and this mode constructs a
//!       CandidateSolver on the candidate's FIRST PICK.
//!   DIFF-2 virtual h inputs: recorded trajectories are f32 samples of the
//!       live f64 progress (worker `progress || 0` + isFinite guard,
//!       portfolioReplayWorker.ts:99-107) — a rounding-level h difference
//!       confined to TS-executed candidates (real candidates use their exact
//!       f64 progress). Post-expansion, a record's solvedSegments is the
//!       FINAL count while live reads the CURRENT count — same approximation
//!       the proven replay makes (replayPool.ts:198-201).
//!   DIFF-3 ctor-state stubs: live knows every candidate's ctor solved/failed
//!       state from eager construction; this mode learns it from stub
//!       records (TsRecord.stub) and ABORTS with `needTsCandidates` when the
//!       schedule first PICKS a stub — the driver runs that candidate for
//!       real (deterministic, so the record equals what live would have
//!       observed) and re-runs the node from the unchanged pre-node cache.
//!   DIFF-4 cache commit point: live publishes a candidate's cache entry
//!       inside its completing step (CachedIntraNodeRouteSolver.ts:264-292);
//!       candidates here hold a shared pre-node snapshot, so entries are
//!       collected IN COMPLETION ORDER and committed together when the node
//!       ends. Observationally identical: two candidates of one node never
//!       share a key (distinct hp is serialized into the v4 key — cache.rs
//!       §5), so no intra-node read can distinguish the deferred commit, and
//!       the committed set/order equals the live save sequence. A
//!       `needTsCandidates` abort commits NOTHING (the re-run must replay
//!       from the pre-node cache).

use crate::cache::SharedCache;
use crate::contract::{CacheValue, HdRoute, Hp, KeyHash, NodeSession, SrStatus};
use crate::intra_node::{dominant_max_iterations, CandidateSolver};
use crate::js_num::{js_max, js_min, js_number_to_string, or_zero};
use crate::json::{write_f64, write_json_string, write_u64};
use crate::replay_sim::{
    candidate_g, progress_at, resolve_g_class, SimCandidate, GREEDY_MULTIPLIER, MIN_SUBSTEPS,
};
use crate::runtime::{
    ensure_dominant, hp_from_entry, index_tsrecs, node_segment_count, HpEntry, RunInput, TsRecord,
};

// ---------------------------------------------------------------------------
// Engine inputs / outputs
// ---------------------------------------------------------------------------

pub(crate) struct SeqInputs<'a> {
    pub session: &'a NodeSession,
    /// The immutable PRE-NODE cache snapshot every candidate reads
    /// (cache.rs protocol step 1); the &mut commit happens after the engine
    /// returns (DIFF-4).
    pub cache: &'a SharedCache,
    pub hps: &'a [HpEntry],
    /// Parsed Hp per DOMINANT index (None for tsrec-backed candidates).
    pub parsed_hps: &'a [Option<Hp>],
    pub ts: &'a [Option<&'a TsRecord>],
    pub initial_count: usize,
    pub external_max_iterations: Option<f64>,
    pub node_segment_count: f64,
}

/// Final per-candidate view for the result JSON / driver golden check.
pub(crate) struct CandFinal {
    pub is_real: bool,
    pub stub: bool,
    /// Was this candidate ever picked (constructed / virtually advanced)?
    pub stepped: bool,
    /// Reached a terminal state under THIS schedule (real: solver terminal;
    /// virtual: v advanced to the recorded completion; stub: ctor-terminal).
    pub completed: bool,
    pub solved: bool,
    pub failed: bool,
    pub iterations: f64,
    pub max_iterations: f64,
    pub solved_segments: f64,
    pub error: Option<String>,
}

pub(crate) struct SeqDone {
    /// Winner candidate index; -1 none (all failed / budget).
    pub winner: i32,
    /// Supervisor error when winner < 0 (all-failed message or the
    /// BaseSolver budget message).
    pub error: Option<String>,
    /// Raw solvedRoutes of a REAL winner (TS applies extractWinningRoutes
    /// after the FFI, PORT-SPEC §2b); None for virtual/absent winners.
    pub routes: Option<Vec<HdRoute>>,
    pub finals: Vec<CandFinal>,
    pub expanded: bool,
    pub total_work: f64,
    /// Supervisor iterations == schedule rounds (BaseSolver.ts:36).
    pub rounds: u64,
    /// The supervisor budget failure fired with the limit set by
    /// externalMaxIterations (:457-462) — the seq counterpart of the rtc
    /// ceilingHit.
    pub ceiling_hit: bool,
    /// Staged cache entries in COMPLETION ORDER (DIFF-4).
    pub staged: Vec<(KeyHash, CacheValue)>,
}

pub(crate) enum SeqRun {
    /// The schedule picked a candidate whose record is a stub (or missing
    /// data it needs): the driver must run these TS-side and re-run the node.
    Need(Vec<usize>),
    Done(Box<SeqDone>),
}

// ---------------------------------------------------------------------------
// The engine
// ---------------------------------------------------------------------------

/// Per-candidate schedule state. The REAL solver lives in a parallel
/// `Vec<Option<CandidateSolver>>` (it borrows session/hp/cache).
struct Meta {
    is_real: bool,
    stub: bool,
    /// Record terminal flags (virtual/stub candidates).
    rec_solved: bool,
    rec_ctor_failed: bool,
    rec_iterations: f64,
    max_iterations: f64,
    /// g/h math view: g_class + polyline params + (virtual) solvedSegments
    /// and trajectory geometry (traj_offset 0 into its own rec traj).
    sim: SimCandidate,
    /// Virtual current iterations (live solver.iterations equivalent).
    v: f64,
    /// STORED fitness — recomputed only when this candidate is stepped
    /// (live-vs-replay difference (b)).
    f: f64,
    /// Present in supervisedSolvers (initial set, or the expansion tail once
    /// expandAdaptiveSearch ran).
    in_list: bool,
    stepped: bool,
    /// Completion-order cache staging already collected (real candidates).
    staged_collected: bool,
}

pub(crate) fn seq_schedule(inp: &SeqInputs) -> Result<SeqRun, String> {
    let n = inp.hps.len();
    let initial = inp.initial_count.min(n);
    let nsc = inp.node_segment_count;

    // --- build per-candidate state --------------------------------------
    let dominant_max = dominant_max_iterations(inp.session);
    let mut meta: Vec<Meta> = Vec::with_capacity(n);
    for i in 0..n {
        let (g_class, iteration_penalty, segments_per_polyline) = resolve_g_class(&inp.hps[i].val);
        let (is_real, stub, rec_solved, rec_ctor_failed, rec_iterations, max_iterations, ss, tl) =
            match inp.ts[i] {
                Some(r) => (
                    false,
                    r.stub,
                    r.solved,
                    r.ctor_failed,
                    r.iterations,
                    r.max_iterations,
                    r.solved_segments,
                    r.traj.len(),
                ),
                None => {
                    // Rust executes this index: must be dominant-class, and
                    // the wrapper must have parsed an Hp for it.
                    ensure_dominant(&inp.hps[i].val, i)?;
                    if inp.parsed_hps[i].is_none() {
                        return Err(format!("candidate {}: missing parsed hp (internal)", i));
                    }
                    (true, false, false, false, 0.0, dominant_max, -1.0, 0)
                }
            };
        let sim = SimCandidate {
            solved: rec_solved,
            iterations: rec_iterations,
            max_iterations,
            solved_segments: ss,
            g_class,
            iteration_penalty,
            segments_per_polyline,
            traj_offset: 0,
            traj_len: tl,
        };
        // Initial f = g = computeG(fresh solver) = g(0), h absent
        // (HyperParameterSupervisorSolver.ts:92-99). Tail candidates get the
        // same value re-assigned at expansion (addSupervisedCandidate
        // :530-542) — identical number, assigned here once.
        let f = candidate_g(&sim, 0.0);
        meta.push(Meta {
            is_real,
            stub,
            rec_solved,
            rec_ctor_failed,
            rec_iterations,
            max_iterations,
            sim,
            v: 0.0,
            f,
            in_list: i < initial,
            stepped: false,
            staged_collected: false,
        });
    }

    let mut solvers: Vec<Option<CandidateSolver>> = (0..n).map(|_| None).collect();

    // --- tiny state helpers (borrow meta/solvers immutably) --------------
    let status_of = |meta: &[Meta], solvers: &[Option<CandidateSolver>], i: usize| -> SrStatus {
        let m = &meta[i];
        if m.is_real {
            match &solvers[i] {
                Some(s) => s.status(),
                None => SrStatus::Running, // fresh, unconstructed (DIFF-1)
            }
        } else if m.stub {
            // Ctor-state only (DIFF-3): live would see exactly these flags
            // on the eagerly constructed solver before its first step.
            if m.rec_solved {
                SrStatus::Solved
            } else if m.rec_ctor_failed {
                SrStatus::Failed
            } else {
                SrStatus::Running
            }
        } else if m.v >= m.rec_iterations {
            // The deterministic record reaches its terminal state when the
            // schedule has advanced it to its recorded completion (covers
            // solved/failed-at-0 records at v == 0: live ctor state).
            if m.rec_solved {
                SrStatus::Solved
            } else {
                SrStatus::Failed
            }
        } else {
            SrStatus::Running
        }
    };
    let iterations_of = |meta: &[Meta], solvers: &[Option<CandidateSolver>], i: usize| -> f64 {
        if meta[i].is_real {
            solvers[i].as_ref().map_or(0.0, |s| s.iterations() as f64)
        } else {
            meta[i].v
        }
    };
    let error_of = |meta: &[Meta], solvers: &[Option<CandidateSolver>], i: usize| -> Option<String> {
        if meta[i].is_real {
            solvers[i].as_ref().and_then(|s| s.error().map(str::to_string))
        } else {
            inp.ts[i].and_then(|r| r.error.clone())
        }
    };

    // getSupervisedSolverWithBestFitness (HyperParameterSupervisorSolver.ts:
    // 120-137): in-order scan of the CURRENT list; solved short-circuit
    // (:124-125), failed skip (:127-129), strict `<` on the STORED f keeps
    // the first lowest (:130-134).
    let pick = |meta: &[Meta], solvers: &[Option<CandidateSolver>]| -> Option<usize> {
        let mut best: Option<usize> = None;
        let mut best_f = f64::INFINITY;
        for (i, m) in meta.iter().enumerate() {
            if !m.in_list {
                continue;
            }
            match status_of(meta, solvers, i) {
                SrStatus::Solved => return Some(i),
                SrStatus::Failed => continue,
                SrStatus::Running => {}
            }
            if m.f < best_f {
                best_f = m.f;
                best = Some(i);
            }
        }
        best
    };

    // refreshDynamicIterationLimit (PortfolioSingleIntraNodeSolver.ts:
    // 436-464). Returns (limit, limit_is_external).
    let refresh_limit = |meta: &[Meta],
                         solvers: &[Option<CandidateSolver>],
                         sup_iters: f64|
     -> (f64, bool) {
        let mut sum = 0.0f64; // reduce over supervisedSolvers, index order
        for (i, m) in meta.iter().enumerate() {
            if !m.in_list {
                continue;
            }
            match status_of(meta, solvers, i) {
                SrStatus::Solved | SrStatus::Failed => continue, // :439
                SrStatus::Running => {}
            }
            let remaining = js_max(
                0.0,
                m.max_iterations - iterations_of(meta, solvers, i) + 1.0,
            ); // :440-443
            sum += (remaining / MIN_SUBSTEPS).ceil(); // :444-446
        }
        let mut limit = js_max(sup_iters + 1.0, sup_iters + sum); // :453-456
        let mut is_external = false;
        if let Some(ext) = inp.external_max_iterations {
            if limit > ext {
                // :457-462 — `externalMaxIterations !== null` + strict `>`
                limit = ext;
                is_external = true;
            }
        }
        (limit, is_external)
    };

    // --- the schedule loop ----------------------------------------------
    let mut sup_iters = 0.0f64; // supervisor BaseSolver.iterations
    let mut sup_max = 0.0f64;
    let mut sup_max_is_external = false;
    let mut expansion_budget = 0.0f64;
    let mut expanded = false;
    let mut total_work = 0.0f64;
    let mut initialized = false;
    let mut winner: i32 = -1;
    let mut failed = false;
    let mut fail_error: Option<String> = None;
    let mut ceiling_hit = false;
    let mut staged: Vec<(KeyHash, CacheValue)> = Vec::new();

    // expandAdaptiveSearch (:544-564) — one-shot; makes the marshaled tail
    // eligible with f = g(0) (addSupervisedCandidate :530-542) and refreshes
    // the supervisor limit (:554).
    macro_rules! expand {
        () => {
            if !expanded {
                expanded = true;
                for i in initial..n {
                    meta[i].in_list = true;
                    meta[i].f = candidate_g(&meta[i].sim, 0.0);
                }
                let (m, e) = refresh_limit(&meta, &solvers, sup_iters);
                sup_max = m;
                sup_max_is_external = e;
            }
        };
    }

    loop {
        sup_iters += 1.0; // BaseSolver.ts:36 — BEFORE _step

        if !initialized {
            initialized = true;
            // initializeSolvers (:509-528): eager TS construction is
            // schedule-inert — DIFF-1; recordCandidateWork over fresh
            // solvers is a no-op at 0 iterations (:519-524). What remains:
            // the cached expansion work budget (:525 -> :236-247, initial
            // candidates only)...
            for m in meta.iter().take(initial) {
                expansion_budget = js_max(expansion_budget, m.max_iterations);
            }
            expansion_budget = js_max(1.0, expansion_budget);
            // ...and the first refreshDynamicIterationLimit (:527), with
            // supervisor iterations already incremented (init happens INSIDE
            // the first _step, :858).
            let (m, e) = refresh_limit(&meta, &solvers, sup_iters);
            sup_max = m;
            sup_max_is_external = e;
        }

        // PRE-step expansion check (:860-865): expand when no candidate is
        // viable (pick() is pure; live calls it here and again in
        // super._step).
        if !expanded && pick(&meta, &solvers).is_none() {
            expand!();
        }

        // super._step (HyperParameterSupervisorSolver.ts:147-172).
        match pick(&meta, &solvers) {
            None => {
                // :152-156 — getFailureMessage (:139-145): sort the CURRENT
                // list by f DESCENDING (stable, like JS Array.sort), take 5,
                // join errors with ", " (null renders as "").
                let mut view: Vec<(f64, String)> = meta
                    .iter()
                    .enumerate()
                    .filter(|(_, m)| m.in_list)
                    .map(|(i, _)| {
                        (
                            meta[i].f,
                            error_of(&meta, &solvers, i).unwrap_or_default(),
                        )
                    })
                    .collect();
                view.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
                let joined = view
                    .iter()
                    .take(5)
                    .map(|(_, e)| e.as_str())
                    .collect::<Vec<_>>()
                    .join(", ");
                fail_error = Some(format!(
                    "All solvers failed in hyper solver. Example failures: {}",
                    joined
                ));
                failed = true;
            }
            Some(bi) => {
                // DIFF-3: the schedule wants this candidate's real behavior
                // but only has its ctor state — hand control back to the
                // driver. Batch every stub the schedule is plausibly about
                // to want (stored f <= the picked f; after expansion, all of
                // them — a node that expanded is running everything down),
                // so one re-run usually suffices. NOTHING is committed on
                // this path.
                if meta[bi].stub && !matches!(status_of(&meta, &solvers, bi), SrStatus::Failed) {
                    let picked_f = meta[bi].f;
                    let mut need: Vec<usize> = vec![bi];
                    for (i, m) in meta.iter().enumerate() {
                        if i == bi || !m.in_list || !m.stub {
                            continue;
                        }
                        if matches!(status_of(&meta, &solvers, i), SrStatus::Failed) {
                            continue; // ctor-failed stubs never need data
                        }
                        if expanded || m.f <= picked_f {
                            need.push(i);
                        }
                    }
                    need.sort_unstable();
                    return Ok(SeqRun::Need(need));
                }

                let before = iterations_of(&meta, &solvers, bi);

                // The step slice (:158-160): MIN_SUBSTEPS live `step()`
                // calls. Real: contract C2 — one iteration per call,
                // self-no-op once terminal (BaseSolver.ts:34-35 mirrored in
                // intra_node::step). Virtual: the deterministic outcome of
                // the same 100 calls on the recorded solver
                // (min-with-remaining arithmetic, replayPool.ts:252).
                if meta[bi].is_real {
                    if solvers[bi].is_none() {
                        // DIFF-1: first pick constructs (live constructed at
                        // initializeSolvers; ctor is schedule-inert).
                        let hp = inp.parsed_hps[bi].as_ref().expect("guarded at build");
                        solvers[bi] = Some(CandidateSolver::new(inp.session, hp, inp.cache));
                    }
                    let s = solvers[bi].as_mut().expect("just constructed");
                    for _ in 0..(MIN_SUBSTEPS as usize) {
                        s.step();
                    }
                } else {
                    let advance = js_min(MIN_SUBSTEPS, meta[bi].rec_iterations - meta[bi].v);
                    meta[bi].v += advance;
                }
                meta[bi].stepped = true;

                // Recompute g/h/f for the STEPPED candidate only (:163-165),
                // with the CURRENT expanded flag — every other candidate
                // keeps its stored f (live-vs-replay difference (b)).
                let iters_now = iterations_of(&meta, &solvers, bi);
                let g = candidate_g(&meta[bi].sim, iters_now); // computeG :954-972
                let raw_p = if meta[bi].is_real {
                    // Real: the solver's exact f64 progress (raw, unclamped
                    // — intra_node::progress docs; M2: sub-solver term == 0).
                    solvers[bi].as_ref().expect("stepped").progress()
                } else {
                    // Virtual: the recorded grid sample at v — identical
                    // indexing to the replay (replay_sim delta (4)); the
                    // `expanded=false` argument requests the RAW sample.
                    let traj: &[f32] = inp.ts[bi].map_or(&[], |r| &r.traj);
                    progress_at(&meta[bi].sim, nsc, traj, meta[bi].v, false)
                };
                let h = if !expanded {
                    1.0 - or_zero(raw_p) // computeH :978 — RAW, unclamped
                } else {
                    // computeH :975-977 -> getCandidateProgress (:192-198).
                    let p = if !meta[bi].is_real && meta[bi].sim.solved_segments >= 0.0 {
                        // solvedConnectionsMap candidates: min(1, ss/nsc) —
                        // FINAL recorded count (DIFF-2, replay-identical).
                        js_min(1.0, meta[bi].sim.solved_segments / nsc)
                    } else {
                        // No map (all dominant candidates): clamp01(p || 0)
                        // — live clamps here, unlike the replay (difference
                        // (c) on the live side).
                        js_max(0.0, js_min(1.0, or_zero(raw_p)))
                    };
                    1.0 - p
                };
                meta[bi].f = g + h * GREEDY_MULTIPLIER; // computeF :116-118

                // DIFF-4: collect the staged cache entry at the completion
                // moment (the TS save ran inside the completing step —
                // CachedIntraNodeRouteSolver.ts:264-292; budget failures and
                // cache hits stage nothing, intra_node step/stage_save).
                let st = status_of(&meta, &solvers, bi);
                if meta[bi].is_real && st != SrStatus::Running && !meta[bi].staged_collected {
                    meta[bi].staged_collected = true;
                    if let Some(entry) = solvers[bi].as_ref().expect("stepped").pending_cache_entry()
                    {
                        staged.push(entry);
                    }
                }

                if st == SrStatus::Solved {
                    winner = bi as i32; // :167-171 — first solve ends the node
                }

                // recordCandidateWork on the stepped solver (:941-944 via
                // :204-216): fold the iteration delta.
                total_work += iterations_of(&meta, &solvers, bi) - before;
            }
        }

        // POST-step expansion check (:949-951 guarded by shouldExpandPortfolio
        // :566-574): work budget spent, not yet expanded, node still live.
        if winner < 0 && !failed && !expanded && total_work >= expansion_budget {
            expand!();
        }

        // BaseSolver.ts:45-51: tryFinalAcceptance is the base no-op (:87);
        // the budget error assignment is UNCONDITIONAL under `!solved` — on
        // the step where both fire it overwrites the all-failed message.
        if winner < 0 && sup_iters > sup_max {
            fail_error = Some(format!(
                "PortfolioSingleIntraNodeSolver ran out of iterations (MAX_ITERATIONS={})",
                js_number_to_string(sup_max)
            ));
            failed = true;
            ceiling_hit = sup_max_is_external;
        }

        if winner >= 0 || failed {
            break;
        }
    }

    // --- final per-candidate views + winner routes -----------------------
    let mut finals: Vec<CandFinal> = Vec::with_capacity(n);
    for i in 0..n {
        let st = status_of(&meta, &solvers, i);
        finals.push(CandFinal {
            is_real: meta[i].is_real,
            stub: meta[i].stub,
            stepped: meta[i].stepped,
            completed: st != SrStatus::Running,
            solved: st == SrStatus::Solved,
            failed: st == SrStatus::Failed,
            iterations: iterations_of(&meta, &solvers, i),
            max_iterations: meta[i].max_iterations,
            solved_segments: meta[i].sim.solved_segments,
            error: error_of(&meta, &solvers, i),
        });
    }
    let routes = if winner >= 0 && meta[winner as usize].is_real {
        solvers[winner as usize]
            .take()
            .map(|s| s.take_routes())
    } else {
        None
    };

    Ok(SeqRun::Done(Box::new(SeqDone {
        winner,
        error: if winner >= 0 { None } else { fail_error },
        routes,
        finals,
        expanded,
        total_work,
        rounds: sup_iters as u64,
        ceiling_hit,
        staged,
    })))
}

// ---------------------------------------------------------------------------
// The mode entry point: parse-side glue + cache commit + result JSON
// ---------------------------------------------------------------------------

pub fn run_portfolio_seq(
    session: &NodeSession,
    cache: &mut SharedCache,
    run: &RunInput,
    tsrecs: &[TsRecord],
) -> Result<String, String> {
    let n = run.hps.len();
    let ts_by_index = index_tsrecs(n, tsrecs)?;

    // Every non-dominant candidate needs at least a stub (live knows every
    // ctor state from eager construction; the schedule cannot start without
    // them — DIFF-3). Parse Hps for the dominant (Rust-executed) indices.
    let mut parsed_hps: Vec<Option<Hp>> = Vec::with_capacity(n);
    for i in 0..n {
        if ts_by_index[i].is_none() {
            ensure_dominant(&run.hps[i].val, i).map_err(|e| {
                format!(
                    "{} (seq mode requires a tsrec record — full or stub — for every non-dominant candidate)",
                    e
                )
            })?;
            parsed_hps.push(Some(hp_from_entry(&run.hps[i], i)?));
        } else {
            parsed_hps.push(None);
        }
    }

    let outcome = {
        // Immutable reborrow for the schedule (cache.rs protocol step 1);
        // all CandidateSolvers drop inside seq_schedule's scope.
        let cache_ro: &SharedCache = cache;
        let inputs = SeqInputs {
            session,
            cache: cache_ro,
            hps: &run.hps,
            parsed_hps: &parsed_hps,
            ts: &ts_by_index,
            initial_count: run.initial_count,
            external_max_iterations: run.external_max_iterations,
            node_segment_count: node_segment_count(session),
        };
        seq_schedule(&inputs)?
    };

    let done = match outcome {
        SeqRun::Need(need) => {
            // No commit, no partial state: the driver re-runs this node from
            // the identical pre-node cache after fetching the records.
            let mut out = String::with_capacity(256);
            out.push_str("{\"nodeId\":");
            write_json_string(&mut out, &session.node_id);
            out.push_str(",\"mode\":\"seq\",\"needTsCandidates\":[");
            for (j, i) in need.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                write_u64(&mut out, *i as u64);
            }
            out.push_str("],\"winnerIndex\":-1,\"solved\":false,\"winnerSource\":null");
            out.push_str(",\"error\":null,\"routes\":null,\"perCandidate\":[]");
            out.push_str(",\"replay\":{\"expanded\":false,\"totalCandidateWork\":0,\"rounds\":0,\"ceilingHit\":false,\"replayCoreDetail\":null}");
            out.push_str(",\"cache\":{\"pending\":0,\"committed\":0,\"size\":");
            write_u64(&mut out, cache.len() as u64);
            out.push_str("}}");
            return Ok(out);
        }
        SeqRun::Done(d) => d,
    };

    // DIFF-4: commit the completion-ordered staged entries — the node is
    // over (winner or supervisor failure), exactly when live's saves have
    // all happened.
    let committed = done.staged.len();
    cache.commit(done.staged);

    // --- result JSON (same document shape as the rtc path) ---------------
    let winner = done.winner;
    let mut out = String::with_capacity(4096);
    out.push_str("{\"nodeId\":");
    write_json_string(&mut out, &session.node_id);
    out.push_str(",\"mode\":\"seq\",\"winnerIndex\":");
    out.push_str(&format!("{}", winner));
    out.push_str(",\"solved\":");
    out.push_str(if winner >= 0 { "true" } else { "false" });
    out.push_str(",\"winnerSource\":");
    if winner >= 0 {
        if done.finals[winner as usize].is_real {
            out.push_str("\"rust\"");
        } else {
            out.push_str("\"ts\"");
        }
    } else {
        out.push_str("null");
    }
    out.push_str(",\"error\":");
    match (&done.error, winner >= 0) {
        (_, true) | (None, false) => out.push_str("null"),
        (Some(e), false) => write_json_string(&mut out, e),
    }
    out.push_str(",\"routes\":");
    if winner >= 0 {
        let w = winner as usize;
        if let Some(routes) = &done.routes {
            // RAW routes — TS applies extractWinningRoutes after the FFI
            // returns (spec §2b), same as the rtc path.
            crate::runtime::write_routes(&mut out, routes);
        } else if let Some(raw) = ts_by_index[w].and_then(|r| r.routes_raw.as_ref()) {
            // TS winner: already post-extractWinningRoutes — splice verbatim.
            out.push_str(raw);
        } else {
            out.push_str("null");
        }
    } else {
        out.push_str("null");
    }

    out.push_str(",\"perCandidate\":[");
    for (i, c) in done.finals.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"i\":");
        write_u64(&mut out, i as u64);
        out.push_str(",\"source\":");
        out.push_str(if c.is_real { "\"rust\"" } else { "\"ts\"" });
        out.push_str(",\"solved\":");
        out.push_str(if c.solved { "true" } else { "false" });
        out.push_str(",\"failed\":");
        out.push_str(if c.failed { "true" } else { "false" });
        out.push_str(",\"iterations\":");
        write_f64(&mut out, c.iterations);
        out.push_str(",\"maxIterations\":");
        write_f64(&mut out, c.max_iterations);
        out.push_str(",\"solvedSegments\":");
        write_f64(&mut out, c.solved_segments);
        out.push_str(",\"stepped\":");
        out.push_str(if c.stepped { "true" } else { "false" });
        out.push_str(",\"completed\":");
        out.push_str(if c.completed { "true" } else { "false" });
        if c.stub {
            out.push_str(",\"stub\":true");
        }
        if let Some(err) = &c.error {
            out.push_str(",\"error\":");
            write_json_string(&mut out, err);
        }
        out.push('}');
    }
    out.push(']');

    // Same observability block as rtc ("replay" naming kept so downstream
    // tooling reads one shape; rounds == supervisor iterations here).
    out.push_str(",\"replay\":{\"expanded\":");
    out.push_str(if done.expanded { "true" } else { "false" });
    out.push_str(",\"totalCandidateWork\":");
    write_f64(&mut out, done.total_work);
    out.push_str(",\"rounds\":");
    write_u64(&mut out, done.rounds);
    out.push_str(",\"ceilingHit\":");
    out.push_str(if done.ceiling_hit { "true" } else { "false" });
    out.push_str(",\"replayCoreDetail\":null}");

    out.push_str(",\"cache\":{\"pending\":");
    write_u64(&mut out, committed as u64);
    out.push_str(",\"committed\":");
    write_u64(&mut out, committed as u64);
    out.push_str(",\"size\":");
    write_u64(&mut out, cache.len() as u64);
    out.push_str("}}");

    Ok(out)
}

// ---------------------------------------------------------------------------
// Tests — pure Rust. Virtual-candidate tests drive the engine directly;
// the integration test runs REAL CandidateSolvers through run_portfolio_seq
// twice to lock cache evolution (miss -> commit -> hit at iteration 1).
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::json::parse_json;
    use crate::replay_sim::simulate;

    /// Minimal 2-connection session (same shape as the runtime parse test).
    fn tiny_session() -> NodeSession {
        let src = br#"{
          "node": {
            "capacityMeshNodeId": "seq_test",
            "center": {"x": 0, "y": 0},
            "width": 3.2, "height": 3.2,
            "portPoints": [
              {"connectionName": "a", "x": -1.2, "y": -1.2, "z": 0},
              {"connectionName": "a", "x": 1.2, "y": 1.2, "z": 0},
              {"connectionName": "b", "x": -1.2, "y": 1.2, "z": 0},
              {"connectionName": "b", "x": 1.2, "y": -1.2, "z": 0}
            ],
            "availableZ": [0, 1]
          },
          "params": {"traceWidth": 0.15, "viaDiameter": 0.3, "obstacleMargin": 0.15},
          "connMap": {"idToNet": {"a": "netA", "b": "netB"},
                      "nets": {"netA": ["a"], "netB": ["b"]}}
        }"#;
        crate::runtime::parse_node_session(src).unwrap()
    }

    fn hp_entry(raw: &str) -> HpEntry {
        HpEntry {
            raw: raw.to_string(),
            val: parse_json(raw.as_bytes()).unwrap(),
        }
    }

    fn full_rec(
        index: usize,
        solved: bool,
        iterations: f64,
        max_iterations: f64,
        traj: Vec<f32>,
    ) -> TsRecord {
        TsRecord {
            index,
            solved,
            iterations,
            max_iterations,
            solved_segments: -1.0,
            traj,
            error: if solved {
                None
            } else {
                Some(format!("cand {} failed", index))
            },
            routes_raw: if solved { Some("[]".to_string()) } else { None },
            stub: false,
            ctor_failed: false,
        }
    }

    fn stub_rec(index: usize, ctor_solved: bool, ctor_failed: bool, max_iterations: f64) -> TsRecord {
        TsRecord {
            index,
            solved: ctor_solved,
            iterations: 0.0,
            max_iterations,
            solved_segments: -1.0,
            traj: Vec::new(),
            error: None,
            routes_raw: None,
            stub: true,
            ctor_failed,
        }
    }

    struct Rig {
        session: NodeSession,
        cache: SharedCache,
        hps: Vec<HpEntry>,
        recs: Vec<TsRecord>,
        initial: usize,
        external: Option<f64>,
    }

    impl Rig {
        fn run(&self) -> SeqRun {
            let n = self.hps.len();
            let ts_by_index = index_tsrecs(n, &self.recs).unwrap();
            let parsed: Vec<Option<Hp>> = (0..n)
                .map(|i| {
                    if ts_by_index[i].is_none() {
                        Some(hp_from_entry(&self.hps[i], i).unwrap())
                    } else {
                        None
                    }
                })
                .collect();
            seq_schedule(&SeqInputs {
                session: &self.session,
                cache: &self.cache,
                hps: &self.hps,
                parsed_hps: &parsed,
                ts: &ts_by_index,
                initial_count: self.initial,
                external_max_iterations: self.external,
                node_segment_count: 2.0,
            })
            .unwrap()
        }

        fn done(&self) -> Box<SeqDone> {
            match self.run() {
                SeqRun::Done(d) => d,
                SeqRun::Need(n) => panic!("unexpected Need({:?})", n),
            }
        }
    }

    /// All-virtual rig: every candidate is a tsrec record ("A03"-keyed hps
    /// keep them non-dominant; the g class is then A01A03 -> g = it/1e6).
    fn virtual_rig(recs: Vec<TsRecord>, initial: usize) -> Rig {
        let hps = (0..recs.len())
            .map(|_| hp_entry("{\"HIGH_DENSITY_A03\":true}"))
            .collect();
        Rig {
            session: tiny_session(),
            cache: SharedCache::new(),
            hps,
            recs,
            initial,
            external: None,
        }
    }

    #[test]
    fn tie_break_keeps_first_index() {
        // Both f = g(0) = 0; the strict `<` scan picks index 0, which
        // completes solved within its first slice — winner 0, one round.
        let rig = virtual_rig(
            vec![
                full_rec(0, true, 100.0, 1000.0, vec![1.0]),
                full_rec(1, true, 100.0, 1000.0, vec![1.0]),
            ],
            2,
        );
        let d = rig.done();
        assert_eq!(d.winner, 0);
        assert_eq!(d.rounds, 1);
        assert_eq!(d.total_work, 100.0);
        assert!(!d.expanded);
    }

    /// Live-vs-replay difference (a): a solved-at-0 record behind an
    /// equal-f runnable candidate. The LIVE pick short-circuits on the
    /// solved candidate (HyperParameterSupervisorSolver.ts:124-125) — winner
    /// 1 in one round. The replay picks index 0 by fitness first and lets it
    /// finish — winner 0. Locks the seq mode to the live side.
    #[test]
    fn live_short_circuit_diverges_from_replay() {
        let rig = virtual_rig(
            vec![
                full_rec(0, true, 100.0, 1000.0, vec![1.0]),
                full_rec(1, true, 0.0, 1000.0, vec![]),
            ],
            2,
        );
        let d = rig.done();
        assert_eq!(d.winner, 1, "live pick returns the first SOLVED candidate");
        assert_eq!(d.rounds, 1);
        assert_eq!(d.total_work, 0.0);

        // Replay semantics on the same data: fitness-first — candidate 0.
        let sims: Vec<SimCandidate> = [(true, 100.0, 1usize), (true, 0.0, 0usize)]
            .iter()
            .map(|(solved, iters, tl)| SimCandidate {
                solved: *solved,
                iterations: *iters,
                max_iterations: 1000.0,
                solved_segments: -1.0,
                g_class: crate::replay_sim::GClass::A01A03,
                iteration_penalty: 0.0,
                segments_per_polyline: f64::NAN,
                traj_offset: 0,
                traj_len: *tl,
            })
            .collect();
        let payload = vec![1.0f32];
        let sim = simulate(&sims, 2, 2.0, &payload, None);
        assert_eq!(sim.winner, 0, "replay picks by fitness, not solved-first");
    }

    #[test]
    fn ctor_failed_at_zero_is_skipped() {
        // Candidate 0 failed at construction (singleLayer-ineligible shape):
        // skipped from the first scan; candidate 1 wins.
        let rig = virtual_rig(
            vec![
                full_rec(0, false, 0.0, 1000.0, vec![]),
                full_rec(1, true, 100.0, 1000.0, vec![1.0]),
            ],
            2,
        );
        let d = rig.done();
        assert_eq!(d.winner, 1);
        assert_eq!(d.rounds, 1);
    }

    #[test]
    fn all_failed_message_and_no_winner() {
        let rig = virtual_rig(
            vec![
                full_rec(0, false, 100.0, 1000.0, vec![0.25]),
                full_rec(1, false, 100.0, 1000.0, vec![0.75]),
            ],
            2,
        );
        let d = rig.done();
        assert_eq!(d.winner, -1);
        // Round 1: c0 (f=0 first) fails; round 2: c1 fails; round 3:
        // pre-check expands (empty tail), pick None -> failure message.
        assert!(d.expanded, "no-viable pre-check expands before failing");
        let msg = d.error.as_deref().unwrap();
        assert!(
            msg.starts_with("All solvers failed in hyper solver. Example failures: "),
            "{}",
            msg
        );
        // Sorted by f DESC: after completion c1's f (lower progress term
        // recomputed at completion) vs c0 — both messages present.
        assert!(msg.contains("cand 0 failed") && msg.contains("cand 1 failed"));
        assert!(d.finals[0].completed && d.finals[1].completed);
    }

    #[test]
    fn expansion_by_all_failed_reaches_tail() {
        // Initial candidate fails; the tail record (index >= initialCount)
        // becomes eligible via the no-viable pre-check and wins.
        let rig = virtual_rig(
            vec![
                full_rec(0, false, 100.0, 1000.0, vec![0.5]),
                full_rec(1, true, 100.0, 1000.0, vec![1.0]),
            ],
            1, // initialCount = 1 -> index 1 is the expansion tail
        );
        let d = rig.done();
        assert!(d.expanded);
        assert_eq!(d.winner, 1);
        // Round 1 exhausts c0; round 2's pre-check expands and the tail
        // solves within its first slice.
        assert_eq!(d.rounds, 2);
        assert_eq!(d.total_work, 200.0);
    }

    #[test]
    fn expansion_by_work_budget() {
        // c0's budget (100) IS the expansion budget; its first slice spends
        // it (work 100 >= 100) -> post-step expansion -> tail c1 (f = g(0) =
        // 0) beats c0's recomputed f -> wins its first slice.
        let rig = virtual_rig(
            vec![
                full_rec(0, true, 600.0, 100.0, vec![0.0, 0.0, 0.0, 0.0, 0.0, 1.0]),
                full_rec(1, true, 50.0, 100.0, vec![1.0]),
            ],
            1,
        );
        let d = rig.done();
        assert!(d.expanded);
        assert_eq!(d.winner, 1);
        assert_eq!(d.rounds, 2);
        assert_eq!(d.total_work, 150.0);
    }

    #[test]
    fn external_ceiling_fails_after_grace_round() {
        // externalMaxIterations = 1: the round at ceiling+1 still executes
        // (BaseSolver post-step check), then the supervisor fails with the
        // live BaseSolver message and ceiling attribution.
        let mut rig = virtual_rig(
            vec![full_rec(0, true, 600.0, 1000.0, vec![0.0; 6])],
            1,
        );
        rig.external = Some(1.0);
        let d = rig.done();
        assert_eq!(d.winner, -1);
        assert!(d.ceiling_hit);
        assert_eq!(d.rounds, 2);
        assert_eq!(
            d.error.as_deref(),
            Some("PortfolioSingleIntraNodeSolver ran out of iterations (MAX_ITERATIONS=1)")
        );
    }

    #[test]
    fn stub_pick_returns_need_batch() {
        // c0: full failed record (consumed first, f=0), c1+c2: running stubs
        // (f=0), c3: ctor-failed stub (never fetched). After c0 fails, the
        // scan picks c1 (stub) -> Need must batch c2 (equal f) but not c3.
        let rig = virtual_rig(
            vec![
                full_rec(0, false, 100.0, 1000.0, vec![0.5]),
                stub_rec(1, false, false, 1000.0),
                stub_rec(2, false, false, 1000.0),
                stub_rec(3, false, true, 1000.0),
            ],
            4,
        );
        match rig.run() {
            SeqRun::Need(need) => assert_eq!(need, vec![1, 2]),
            SeqRun::Done(d) => panic!("expected Need, got winner {}", d.winner),
        }
    }

    #[test]
    fn ctor_solved_stub_wins_scan_but_needs_routes() {
        // A ctor-solved stub is picked by the solved short-circuit on the
        // very first scan; the engine cannot produce routes from a stub, so
        // it must hand back Need([i]).
        let rig = virtual_rig(
            vec![
                full_rec(0, true, 100.0, 1000.0, vec![1.0]),
                stub_rec(1, true, false, 1000.0),
            ],
            2,
        );
        match rig.run() {
            SeqRun::Need(need) => assert_eq!(need, vec![1]),
            SeqRun::Done(d) => panic!("expected Need, got winner {}", d.winner),
        }
    }

    #[test]
    fn dominant_budget_matches_ctor() {
        let session = tiny_session();
        let hp = hp_from_entry(&hp_entry("{}"), 0).unwrap();
        let cache = SharedCache::new();
        let solver = CandidateSolver::new(&session, &hp, &cache);
        assert_eq!(
            dominant_max_iterations(&session),
            solver.max_iterations(),
            "helper must equal the ctor budget (IntraNodeSolver.ts:172-173)"
        );
        // 2 connections -> 1000 * 2^1.5
        assert_eq!(dominant_max_iterations(&session), 1000.0 * 2f64.powf(1.5));
    }

    /// End-to-end through run_portfolio_seq with REAL CandidateSolvers,
    /// twice on one cache: the first run solves and commits (winner entry at
    /// least); the second run cache-HITS and completes at iteration 1 —
    /// sequential cache evolution, live save-point semantics (DIFF-4).
    #[test]
    fn real_candidates_solve_and_cache_evolves() {
        let session = tiny_session();
        let mut cache = SharedCache::new();
        let hp_bytes = br#"{"initialCount": 2, "mode": "seq",
                            "hps": [{}, {"CELL_SIZE_FACTOR": 1}]}"#;
        let run = crate::runtime::parse_run_input(hp_bytes).unwrap();
        assert!(matches!(run.mode, crate::runtime::RunMode::Seq));

        let out1 = run_portfolio_seq(&session, &mut cache, &run, &[]).unwrap();
        assert!(out1.contains("\"mode\":\"seq\""), "{}", out1);
        assert!(out1.contains("\"winnerIndex\":0"), "{}", out1);
        assert!(out1.contains("\"winnerSource\":\"rust\""), "{}", out1);
        assert!(!cache.is_empty(), "winner completion must commit its entry");
        let size_after_1 = cache.len();

        let out2 = run_portfolio_seq(&session, &mut cache, &run, &[]).unwrap();
        assert!(out2.contains("\"winnerIndex\":0"), "{}", out2);
        // Cache hit consumes exactly one iteration (the probe step).
        assert!(
            out2.contains("\"iterations\":1,"),
            "second run must cache-hit at iteration 1: {}",
            out2
        );
        assert_eq!(cache.len(), size_after_1, "hits stage nothing new");
    }

    /// rtc path must reject stub records (they carry no trajectory).
    #[test]
    fn rtc_rejects_stub_records() {
        let session = tiny_session();
        let mut cache = SharedCache::new();
        let pool = rayon::ThreadPoolBuilder::new().num_threads(1).build().unwrap();
        let hp_bytes = br#"{"initialCount": 1, "hps": [{"HIGH_DENSITY_A03": true}]}"#;
        let ts_bytes = br#"[{"i": 0, "stub": true, "solved": false, "failed": false,
                             "iterations": 0, "maxIterations": 1000,
                             "solvedSegments": -1, "traj": []}]"#;
        let err =
            crate::runtime::run_portfolio(&session, &mut cache, &pool, hp_bytes, ts_bytes)
                .unwrap_err();
        assert!(err.contains("only valid in mode \"seq\""), "{}", err);
    }
}
