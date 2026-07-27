//! VENDORED copy of the parity-proven replay simulator from
//! native/replay-core/src/lib.rs (the line-faithful mirror of
//! lib/parallel/replayPool.ts:187-260, verified winner-exact on 549/550
//! nodes; see replay-core's module doc for the full provenance chain).
//!
//! WHY A COPY EXISTS AT ALL: winner selection itself is performed by
//! DEPENDING ON the replay-core crate (src/runtime.rs encodes an RPLYDS01
//! dataset and calls replay_core::replay_load / replay_run — the compiled,
//! parity-proven code path decides the winner). But the section 5
//! cache-commit step needs the FINAL VIRTUAL-ITERATION VECTOR `v[]` of the
//! schedule ("commit candidates whose virtual iterations reached completion
//! when the winner landed"), and replay-core's ABI does not expose `v[]`.
//! This module is a verbatim transcription of replay-core's private
//! simulator with exactly three deltas:
//!   (1) SimOutcome carries the final `v` vector (for the cache commit);
//!   (2) an optional `external_max_rounds` ceiling implements the
//!       GrowShrink externalMaxIterations mirror (PORT-SPEC section 4;
//!       PortfolioSingleIntraNodeSolver.ts:434-464) — one replay round is
//!       one supervisor iteration, and BaseSolver checks the budget AFTER
//!       the step (iterations++ BEFORE _step, fail when
//!       iterations > MAX_ITERATIONS — BaseSolver.ts:33-51), so the round
//!       executing at ceiling+1 still runs and may still declare a winner;
//!   (3) trajectories are read from a shared payload slice via
//!       (traj_offset, traj_len), same as replay-core's Dataset layout.
//! Runtime.rs cross-checks this module's winner against replay-core's on
//! EVERY node (hard error on disagreement) whenever the ceiling did not
//! fire, so any drift between the copy and the proven crate is caught
//! immediately instead of silently diverging.
//!
//! Schedule constants (must match the TS side exactly):
//!   GREEDY_MULTIPLIER = 5    PortfolioSingleIntraNodeSolver.ts:260
//!   MIN_SUBSTEPS      = 100  PortfolioSingleIntraNodeSolver.ts:261
//!   guard rounds      = 50_000_000  replayPool.ts:212
//!
//! The four replay subtleties (annotated below at their mirror points, same
//! as replay-core):
//!   (1) initial f = candidateG(0), h absent (replayPool.ts:239-240);
//!   (2) computeH uses RAW `progress || 0`, may exceed 1 -> negative f
//!       (replayPool.ts:203-206);
//!   (3) solved-at-0 candidates stay selectable at v == 0
//!       (replayPool.ts:233-236);
//!   (4) adaptive expansion at totalCandidateWork >= max(1, initial
//!       candidates' MAX_ITERATIONS) or when no initial candidate is viable
//!       (replayPool.ts:188-192, 213-222).

use crate::json::JVal;

pub const GREEDY_MULTIPLIER: f64 = 5.0; // PortfolioSingleIntraNodeSolver.ts:260
pub const MIN_SUBSTEPS: f64 = 100.0; // PortfolioSingleIntraNodeSolver.ts:261
pub const REPLAY_GUARD_ROUNDS: u64 = 50_000_000; // replayPool.ts:212

// ---------- JS arithmetic shims (replay-core src/lib.rs, verbatim) ----------

/// Math.min for the 2-arg uses in the replay (NaN-propagating like JS).
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// Math.max, NaN-propagating like JS.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// JS truthiness of a (possibly absent) JSON value — the
/// `hyperParameters.X` checks in candidateG (replayPool.ts:69, 72), also
/// reused by runtime.rs for the dominant-class guard and
/// FLIP_TRACE_ALIGNMENT_DIRECTION extraction.
pub fn js_truthy(v: Option<&JVal>) -> bool {
    match v {
        None => false,
        Some(JVal::Null) => false,
        Some(JVal::Bool(b)) => *b,
        Some(JVal::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(JVal::Str(s)) => !s.is_empty(),
        Some(JVal::Arr(_)) | Some(JVal::Obj(_)) => true,
    }
}

// ---------- Candidate model (replay-core src/lib.rs, verbatim shapes) ----------

/// Which branch of candidateG (replayPool.ts:64-81) applies; resolved once
/// from the hyperparameters.
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum GClass {
    /// default: iterations / 10_000 (replayPool.ts:80)
    Default,
    /// HIGH_DENSITY_A01 || HIGH_DENSITY_A03: iterations / 1_000_000
    /// (replayPool.ts:69-71)
    A01A03,
    /// MULTI_HEAD_POLYLINE_SOLVER: 1000 + (ITERATION_PENALTY + iterations)
    /// / 10_000 + 10_000 * (SEGMENTS_PER_POLYLINE - 3) (replayPool.ts:72-79)
    Polyline,
}

#[derive(Clone, Debug)]
pub struct SimCandidate {
    pub solved: bool,
    /// final solver.iterations at completion (integer-valued)
    pub iterations: f64,
    /// post-setup MAX_ITERATIONS
    pub max_iterations: f64,
    /// final solved-segment count; -1 when the candidate has no
    /// solvedConnectionsMap (replayPool.ts:17)
    pub solved_segments: f64,
    pub g_class: GClass,
    /// hp.ITERATION_PENALTY ?? 0 (replayPool.ts:75)
    pub iteration_penalty: f64,
    /// hp.SEGMENTS_PER_POLYLINE! — NaN when absent, mirroring JS
    /// `undefined - 3 === NaN` (replayPool.ts:77)
    pub segments_per_polyline: f64,
    /// schedule-grid trajectory range into the shared payload
    pub traj_offset: usize,
    pub traj_len: usize,
}

/// Resolve (g_class, iteration_penalty, segments_per_polyline) from raw
/// hyperparameters — replay-core parse_candidate, verbatim branch order
/// (mirrors candidateG, replayPool.ts:69-80).
pub fn resolve_g_class(hp: &JVal) -> (GClass, f64, f64) {
    let g_class = if js_truthy(hp.get("HIGH_DENSITY_A01")) || js_truthy(hp.get("HIGH_DENSITY_A03"))
    {
        GClass::A01A03
    } else if js_truthy(hp.get("MULTI_HEAD_POLYLINE_SOLVER")) {
        GClass::Polyline
    } else {
        GClass::Default
    };
    // `(hp.ITERATION_PENALTY as number) ?? 0` — ?? replaces only null/absent.
    let iteration_penalty = match hp.get("ITERATION_PENALTY") {
        Some(JVal::Num(x)) => *x,
        Some(JVal::Null) | None => 0.0,
        Some(_) => f64::NAN, // non-numeric never occurs in practice
    };
    // `hp.SEGMENTS_PER_POLYLINE!` — absent would be NaN arithmetic in JS.
    let segments_per_polyline = match hp.get("SEGMENTS_PER_POLYLINE") {
        Some(JVal::Num(x)) => *x,
        _ => f64::NAN,
    };
    (g_class, iteration_penalty, segments_per_polyline)
}

// ---------- The replay schedule (replay-core src/lib.rs, verbatim logic) ----------

/// candidateG — replayPool.ts:64-81. f64 ops in the same order as JS
/// (left-associative +).
pub fn candidate_g(c: &SimCandidate, iterations: f64) -> f64 {
    match c.g_class {
        GClass::A01A03 => iterations / 1_000_000.0, // replayPool.ts:70
        GClass::Polyline => {
            // replayPool.ts:73-79
            1000.0
                + (c.iteration_penalty + iterations) / 10_000.0
                + 10_000.0 * (c.segments_per_polyline - 3.0)
        }
        GClass::Default => iterations / 10_000.0, // replayPool.ts:80
    }
}

/// progressAt — replayPool.ts:197-207, re-indexed to the schedule grid
/// (bit-exact; see replay-core datasetFormat.ts module doc).
fn progress_at(
    c: &SimCandidate,
    node_segment_count: f64,
    payload: &[f32],
    vit: f64,
    expanded: bool,
) -> f64 {
    // replayPool.ts:198-201 — after expansion, getCandidateProgress semantics
    // (clamped solvedSegments / nodeSegmentCount) using the FINAL count.
    if expanded && c.solved_segments >= 0.0 {
        return js_min(1.0, c.solved_segments / node_segment_count);
    }
    if vit <= 0.0 {
        return 0.0; // replayPool.ts:202
    }
    if c.traj_len == 0 {
        return 0.0; // replayPool.ts:206 idx == -1 branch (rawLen == 0)
    }
    // vit > 0 implies ceil(vit/100) >= 1, so idx never underflows.
    let k = (vit / MIN_SUBSTEPS).ceil() as usize;
    let idx = (if k < c.traj_len { k } else { c.traj_len }) - 1;
    // Raw, UNCLAMPED progress — subtlety (2). f32 -> f64 exact widening.
    payload[c.traj_offset + idx] as f64
}

pub struct SimOutcome {
    /// winner candidate index; -1 none (all failed / guard exhausted /
    /// ceiling hit)
    pub winner: i32,
    pub expanded: bool,
    pub total_work: f64,
    pub rounds: u64,
    /// FINAL virtual iterations per candidate — the section 5 cache-commit
    /// predicate input (delta (1) vs replay-core).
    pub v: Vec<f64>,
    /// true when external_max_rounds stopped the schedule before a winner
    /// (delta (2) vs replay-core; replay-core comparison is skipped then).
    pub ceiling_hit: bool,
}

/// The offline deterministic replay — replayPool.ts:187-260 via replay-core
/// replay_node, line by line (see module doc for the three deltas).
pub fn simulate(
    candidates: &[SimCandidate],
    initial_count: usize,
    node_segment_count: f64,
    payload: &[f32],
    external_max_rounds: Option<f64>,
) -> SimOutcome {
    let n = candidates.len();
    let initial_count = initial_count.min(n);
    // v = virtual iterations per candidate (Float64Array) — replayPool.ts:188
    let mut v = vec![0.0f64; n];

    // expansionBudget = Math.max(1, ...initial candidates' maxIterations)
    // — replayPool.ts:189-192 (subtlety (4)).
    let mut expansion_budget = 1.0f64;
    for c in &candidates[..initial_count] {
        expansion_budget = js_max(expansion_budget, c.max_iterations);
    }

    let mut expanded = false;
    let mut total_work = 0.0f64; // totalCandidateWork
    let mut winner: i32 = -1;
    let mut rounds: u64 = 0;
    let mut ceiling_hit = false;

    for _guard in 0..REPLAY_GUARD_ROUNDS {
        // replayPool.ts:212
        rounds += 1;

        // Expansion condition — replayPool.ts:213-222. Transcribed exactly:
        // expand when work >= budget OR there is no initial candidate with
        // (!solved && !isFailedAt), where isFailedAt = !solved && v >= iters
        // (replayPool.ts:209-210).
        if !expanded {
            let mut any_initial_alive = false;
            for i in 0..initial_count {
                let c = &candidates[i];
                let failed_at = !c.solved && v[i] >= c.iterations;
                if !c.solved && !failed_at {
                    any_initial_alive = true;
                    break;
                }
            }
            if total_work >= expansion_budget || !any_initial_alive {
                expanded = true;
            }
        }

        // Best fitness among viable candidates — replayPool.ts:228-247.
        // Strict `<` keeps the FIRST lowest f: tie-break is candidate index
        // order, matching the live supervisor's in-order scan
        // (HyperParameterSupervisorSolver.ts:120-137).
        let mut best: i32 = -1;
        let mut best_f = f64::INFINITY;
        let limit = if expanded { n } else { initial_count }; // replayPool.ts:230
        for i in 0..limit {
            let c = &candidates[i];
            // Solved candidates stepped to completion are done; solved-at-0
            // stays selectable at v == 0 — subtlety (3) (replayPool.ts:233-236).
            if c.solved && v[i] > 0.0 && v[i] >= c.iterations {
                continue;
            }
            // isFailedAt — replayPool.ts:237
            if !c.solved && v[i] >= c.iterations {
                continue;
            }
            let f = if v[i] == 0.0 {
                // Initial f = g(0), no h term — subtlety (1)
                // (replayPool.ts:239-240).
                candidate_g(c, 0.0)
            } else {
                // f = g + (1 - progress) * GREEDY — replayPool.ts:241-242.
                candidate_g(c, v[i])
                    + (1.0 - progress_at(c, node_segment_count, payload, v[i], expanded))
                        * GREEDY_MULTIPLIER
            };
            if f < best_f {
                best_f = f;
                best = i as i32;
            }
        }

        if best < 0 {
            break; // replayPool.ts:249 — all failed (or none viable)
        }
        let bi = best as usize;
        let c = &candidates[bi];
        // advance = min(MIN_SUBSTEPS, iterations - v) — replayPool.ts:252
        let advance = js_min(MIN_SUBSTEPS, c.iterations - v[bi]);
        v[bi] += advance; // replayPool.ts:253
        total_work += js_max(0.0, advance); // replayPool.ts:254

        // Winner = first candidate whose virtual schedule reaches its
        // recorded solved completion — replayPool.ts:256-259.
        if c.solved && v[bi] >= c.iterations {
            winner = best;
            break;
        }

        // Delta (2): externalMaxIterations ceiling. One round == one
        // supervisor iteration; BaseSolver's post-step check lets the round
        // at ceiling+1 execute (and win) before the budget failure lands, so
        // the stop triggers only after an unsuccessful round with
        // rounds > ceiling.
        if let Some(m) = external_max_rounds {
            if (rounds as f64) > m {
                ceiling_hit = true;
                break;
            }
        }
    }

    SimOutcome {
        winner,
        expanded,
        total_work,
        rounds,
        v,
        ceiling_hit,
    }
}

// ---------- Tests (pure Rust; no bun needed) ----------

#[cfg(test)]
mod tests {
    use super::*;

    fn cand(
        solved: bool,
        iterations: f64,
        max_iterations: f64,
        g_class: GClass,
        traj_offset: usize,
        traj_len: usize,
    ) -> SimCandidate {
        SimCandidate {
            solved,
            iterations,
            max_iterations,
            solved_segments: -1.0,
            g_class,
            iteration_penalty: 0.0,
            segments_per_polyline: f64::NAN,
            traj_offset,
            traj_len,
        }
    }

    #[test]
    fn polyline_initial_f_is_31000() {
        // Subtlety (1): SEGMENTS_PER_POLYLINE=6, no ITERATION_PENALTY.
        let mut c = cand(false, 0.0, 1.0, GClass::Polyline, 0, 0);
        c.segments_per_polyline = 6.0;
        assert_eq!(candidate_g(&c, 0.0), 31000.0);
    }

    #[test]
    fn solved_at_zero_wins_and_v_is_final() {
        // Subtlety (3): c0 default fails at 100; c1 solved at 0 iterations.
        let payload = vec![0.0f32];
        let cands = vec![
            cand(false, 100.0, 1000.0, GClass::Default, 0, 1),
            cand(true, 0.0, 1000.0, GClass::Default, 0, 0),
        ];
        let out = simulate(&cands, 2, 1.0, &payload, None);
        assert_eq!(out.winner, 1);
        // Cache-commit predicate view: c0 virtually exhausted, c1 completed.
        assert!(out.v[0] >= 100.0);
        assert!(out.v[1] >= 0.0);
    }

    #[test]
    fn all_failed_returns_none_and_all_v_complete() {
        let payload = vec![0.1f32, 0.2];
        let cands = vec![
            cand(false, 100.0, 1000.0, GClass::Default, 0, 1),
            cand(false, 200.0, 1000.0, GClass::Default, 0, 2),
        ];
        let out = simulate(&cands, 2, 1.0, &payload, None);
        assert_eq!(out.winner, -1);
        assert!(out.v[0] >= 100.0 && out.v[1] >= 200.0);
    }

    #[test]
    fn ceiling_stops_schedule_without_winner() {
        // Winner would land around round ~5 (c1 solved at 250, plus rounds
        // spent on c0); a 1-round ceiling stops after round 2 (post-step
        // check semantics: round at ceiling+1 still executes).
        let payload = vec![0.1f32, 0.2, 0.3, 0.4, 0.9, 1.0];
        let cands = vec![
            cand(false, 300.0, 100_000.0, GClass::Default, 0, 3),
            cand(true, 250.0, 100_000.0, GClass::Default, 3, 3),
        ];
        let unbounded = simulate(&cands, 2, 2.0, &payload, None);
        assert_eq!(unbounded.winner, 1);
        let capped = simulate(&cands, 2, 2.0, &payload, Some(1.0));
        assert_eq!(capped.winner, -1);
        assert!(capped.ceiling_hit);
        assert_eq!(capped.rounds, 2);
    }
}
