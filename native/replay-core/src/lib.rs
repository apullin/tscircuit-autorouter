// replay-core — deterministic replay of the TS portfolio supervisor's winner
// selection over captured per-candidate trajectories (RUST-PLAN.md §1 spike:
// replay-parity core; no solver porting).
//
// This is a line-faithful Rust mirror of the OFFLINE REPLAY SIMULATION in
// lib/parallel/replayPool.ts (runReplayRace, lines 187-260 of the
// awt-perf-stack worktree), which was verified winner-exact on 549/550 nodes
// against the sequential supervisor (perf-artifacts/parallelism-design.md §5).
//
// Schedule constants (must match the TS side exactly):
//   GREEDY_MULTIPLIER = 5    PortfolioSingleIntraNodeSolver.ts:260, replayPool.ts:55
//   MIN_SUBSTEPS      = 100  PortfolioSingleIntraNodeSolver.ts:261, replayPool.ts:56
//   guard rounds      = 50_000_000  replayPool.ts:212
//
// candidate_g mirrors candidateG (replayPool.ts:64-81), itself the replay
// mirror of PortfolioSingleIntraNodeSolver.computeG (lines 910-928). Note it
// is the PORTFOLIO override (iterations/1e6, /1e4, polyline 1000+...+30000),
// NOT the HyperParameterSupervisorSolver base formula iterations/MAX_ITERATIONS
// (HyperParameterSupervisorSolver.ts:108-110) — the base formula never runs
// for this solver.
//
// The four replay subtleties (parallelism-design.md §5) and where they live:
//   (1) initial f = candidateG(0), h absent — v==0 branch in the fitness loop
//       (replayPool.ts:239-240; live origin: HyperParameterSupervisorSolver.ts
//       initializeSolvers pushes {h:0, g, f:g}, lines 93-99). Polyline
//       candidates therefore start at f = 31000, not 0.
//   (2) computeH uses RAW `progress || 0`, which can exceed 1 → negative f.
//       progress samples are stored raw and NOT clamped (replayPool.ts:203-206;
//       live origin: PortfolioSingleIntraNodeSolver.computeH line 934 before
//       expansion).
//   (3) solved-at-0 candidates stay selectable at v == 0 — the eligibility
//       skip requires v > 0 (replayPool.ts:233-236). Picking one declares the
//       winner in the same round (advance = 0, then v >= iterations).
//   (4) adaptive-expansion triggers at totalCandidateWork >= max(initial
//       candidates' MAX_ITERATIONS), or when no initial candidate is viable
//       (replayPool.ts:188-192 and 213-222; live origin:
//       PortfolioSingleIntraNodeSolver.getDynamicExpansionWorkBudget:236-247
//       and _step:816-821/905-907).
//
// All schedule arithmetic is f64 +,-,*,/ and comparisons only (no
// transcendentals), so it is bit-identical between JS and Rust. Progress
// samples are f32 widened exactly to f64 on read, the same as a JS
// Float32Array element read.

mod json;

use json::{parse_json, write_json_string, JVal};
use std::sync::Mutex;

const GREEDY_MULTIPLIER: f64 = 5.0; // PortfolioSingleIntraNodeSolver.ts:260
const MIN_SUBSTEPS: f64 = 100.0; // PortfolioSingleIntraNodeSolver.ts:261
const REPLAY_GUARD_ROUNDS: u64 = 50_000_000; // replayPool.ts:212

static LAST_ERROR: Mutex<String> = Mutex::new(String::new());

fn set_last_error(msg: String) {
    if let Ok(mut g) = LAST_ERROR.lock() {
        *g = msg;
    }
}

// ---------- JS arithmetic shims ----------

/// Math.min for the 2-arg uses in the replay (NaN-propagating like JS).
/// (JS orders -0 < +0; that case is unreachable here: both uses see
/// non-negative integer-valued operands.)
fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a < b {
        a
    } else {
        b
    }
}

/// Math.max, NaN-propagating like JS.
fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        f64::NAN
    } else if a > b {
        a
    } else {
        b
    }
}

/// JS truthiness of a (possibly absent) JSON value — used for the
/// `hyperParameters.X` checks in candidateG (replayPool.ts:69, 72).
fn js_truthy(v: Option<&JVal>) -> bool {
    match v {
        None => false,
        Some(JVal::Null) => false,
        Some(JVal::Bool(b)) => *b,
        Some(JVal::Num(n)) => *n != 0.0 && !n.is_nan(),
        Some(JVal::Str(s)) => !s.is_empty(),
        Some(JVal::Arr(_)) | Some(JVal::Obj(_)) => true,
    }
}

// ---------- Dataset model ----------

/// Which branch of candidateG (replayPool.ts:64-81) applies. The branch
/// depends only on hyperParameters, so it is resolved once at load time.
#[derive(Clone, Copy, PartialEq)]
enum GClass {
    /// default: iterations / 10_000 (replayPool.ts:80)
    Default,
    /// HIGH_DENSITY_A01 || HIGH_DENSITY_A03: iterations / 1_000_000
    /// (replayPool.ts:69-71)
    A01A03,
    /// MULTI_HEAD_POLYLINE_SOLVER: 1000 + (ITERATION_PENALTY + iterations)
    /// / 10_000 + 10_000 * (SEGMENTS_PER_POLYLINE - 3) (replayPool.ts:72-79)
    Polyline,
}

struct Candidate {
    solved: bool,
    /// final solver.iterations at completion (integer-valued)
    iterations: f64,
    /// post-setup MAX_ITERATIONS (portfolioReplayWorker.ts:75-78)
    max_iterations: f64,
    /// final solved-segment count; -1 when the candidate has no
    /// solvedConnectionsMap (replayPool.ts:17)
    solved_segments: f64,
    g_class: GClass,
    /// hp.ITERATION_PENALTY ?? 0 (replayPool.ts:75)
    iteration_penalty: f64,
    /// hp.SEGMENTS_PER_POLYLINE! — NaN when absent, mirroring JS
    /// `undefined - 3 === NaN` (replayPool.ts:77)
    segments_per_polyline: f64,
    /// schedule-grid trajectory: sample k (0-based) = raw progress after
    /// min((k+1)*100, iterations) iterations. See README "Dataset format".
    traj_offset: usize,
    traj_len: usize,
}

struct NodeData {
    node_id: String,
    node_segment_count: f64,
    initial_count: usize,
    candidates: Vec<Candidate>,
}

pub struct Dataset {
    nodes: Vec<NodeData>,
    payload: Vec<f32>,
}

// ---------- The replay schedule (mirror of replayPool.ts:187-260) ----------

/// candidateG — replayPool.ts:64-81. f64 ops in the same order as JS
/// (left-associative +).
fn candidate_g(c: &Candidate, iterations: f64) -> f64 {
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

/// progressAt — replayPool.ts:197-207, re-indexed to the schedule grid.
///
/// The original reads raw per-iteration samples: idx = min(vit, rawLen) - 1
/// (or 0 when rawLen == 0 / vit <= 0). Virtual iterations vit only ever take
/// values min(k*100, iterations) (v advances by min(MIN_SUBSTEPS,
/// iterations - v), replayPool.ts:252), so the dataset stores exactly those
/// samples: grid sample k-1 == raw[min(min(k*100, iterations), rawLen) - 1],
/// and the lookup here is idx = min(ceil(vit/100), trajLen) - 1. Values are
/// bit-identical to what the raw-trajectory replay reads.
fn progress_at(c: &Candidate, node_segment_count: f64, payload: &[f32], vit: f64, expanded: bool) -> f64 {
    // replayPool.ts:198-201 — after expansion, getCandidateProgress semantics
    // (clamped solvedSegments / nodeSegmentCount) using the FINAL segment
    // count, exactly as the verified TS replay does.
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
    // Raw, UNCLAMPED progress — subtlety (2). f32 → f64 exact widening.
    payload[c.traj_offset + idx] as f64
}

struct ReplayOutcome {
    winner: i32,
    expanded: bool,
    total_work: f64,
    rounds: u64,
}

/// The offline deterministic replay — replayPool.ts:187-260, line by line.
fn replay_node(node: &NodeData, payload: &[f32]) -> ReplayOutcome {
    let n = node.candidates.len();
    let initial_count = node.initial_count.min(n);
    // v = virtual iterations per candidate (Float64Array) — replayPool.ts:188
    let mut v = vec![0.0f64; n];

    // expansionBudget = Math.max(1, ...initial candidates' maxIterations)
    // — replayPool.ts:189-192 (subtlety (4)).
    let mut expansion_budget = 1.0f64;
    for c in &node.candidates[..initial_count] {
        expansion_budget = js_max(expansion_budget, c.max_iterations);
    }

    let mut expanded = false;
    let mut total_work = 0.0f64; // totalCandidateWork
    let mut winner: i32 = -1;
    let mut rounds: u64 = 0;

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
                let c = &node.candidates[i];
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
            let c = &node.candidates[i];
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
                // f = g + (1 - progress) * GREEDY — replayPool.ts:241-242;
                // live: computeF = g + h * GREEDY_MULTIPLIER
                // (HyperParameterSupervisorSolver.ts:116-118).
                candidate_g(c, v[i])
                    + (1.0 - progress_at(c, node.node_segment_count, payload, v[i], expanded))
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
        let c = &node.candidates[bi];
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
    }

    ReplayOutcome {
        winner,
        expanded,
        total_work,
        rounds,
    }
}

// ---------- Dataset parsing (RPLYDS01, see README) ----------

fn parse_candidate(cj: &JVal, ni: usize, ci: usize, payload_len: usize) -> Result<Candidate, String> {
    let ctx = || format!("node {} candidate {}", ni, ci);
    let solved = cj
        .get("solved")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| format!("{}: missing bool 'solved'", ctx()))?;
    let iterations = cj
        .get("iterations")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| format!("{}: missing number 'iterations'", ctx()))?;
    let max_iterations = cj
        .get("maxIterations")
        .and_then(|v| v.as_f64())
        .ok_or_else(|| format!("{}: missing number 'maxIterations'", ctx()))?;
    let solved_segments = cj
        .get("solvedSegments")
        .and_then(|v| v.as_f64())
        .unwrap_or(-1.0);
    let traj_offset = cj
        .get("trajOffset")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| format!("{}: missing integer 'trajOffset'", ctx()))? as usize;
    let traj_len = cj
        .get("trajLen")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| format!("{}: missing integer 'trajLen'", ctx()))? as usize;
    let end = traj_offset
        .checked_add(traj_len)
        .ok_or_else(|| format!("{}: trajectory range overflow", ctx()))?;
    if end > payload_len {
        return Err(format!(
            "{}: trajectory [{}, {}) outside payload of {} samples",
            ctx(),
            traj_offset,
            end,
            payload_len
        ));
    }

    let empty_hp = JVal::Obj(Vec::new());
    let hp = cj.get("hp").unwrap_or(&empty_hp);
    // Branch order mirrors candidateG (replayPool.ts:69-80).
    let g_class = if js_truthy(hp.get("HIGH_DENSITY_A01")) || js_truthy(hp.get("HIGH_DENSITY_A03")) {
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

    Ok(Candidate {
        solved,
        iterations,
        max_iterations,
        solved_segments,
        g_class,
        iteration_penalty,
        segments_per_polyline,
        traj_offset,
        traj_len,
    })
}

fn parse_dataset(bytes: &[u8]) -> Result<Dataset, String> {
    if bytes.len() < 12 {
        return Err("dataset too short (< 12 bytes)".to_string());
    }
    if &bytes[0..8] != b"RPLYDS01" {
        return Err("bad magic (want RPLYDS01)".to_string());
    }
    let header_len = u32::from_le_bytes([bytes[8], bytes[9], bytes[10], bytes[11]]) as usize;
    let payload_off = 12usize
        .checked_add(header_len)
        .ok_or_else(|| "header length overflow".to_string())?;
    if payload_off > bytes.len() {
        return Err("header extends past end of buffer".to_string());
    }
    if payload_off % 4 != 0 {
        return Err("payload offset not 4-byte aligned (header must be space-padded)".to_string());
    }
    let payload_bytes = &bytes[payload_off..];
    if payload_bytes.len() % 4 != 0 {
        return Err("payload size not a multiple of 4".to_string());
    }
    let mut payload = Vec::with_capacity(payload_bytes.len() / 4);
    for chunk in payload_bytes.chunks_exact(4) {
        payload.push(f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]));
    }

    let header = parse_json(&bytes[12..payload_off]).map_err(|e| format!("header JSON: {}", e))?;
    let version = header
        .get("version")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing 'version'".to_string())?;
    if version != 1 {
        return Err(format!("unsupported dataset version {}", version));
    }
    let stride = header
        .get("sampleStride")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "missing 'sampleStride'".to_string())?;
    if stride != MIN_SUBSTEPS as i64 {
        return Err(format!(
            "sampleStride {} does not match MIN_SUBSTEPS {}",
            stride, MIN_SUBSTEPS
        ));
    }
    let nodes_j = header
        .get("nodes")
        .and_then(|v| v.as_arr())
        .ok_or_else(|| "missing 'nodes' array".to_string())?;

    let mut nodes = Vec::with_capacity(nodes_j.len());
    for (ni, nj) in nodes_j.iter().enumerate() {
        let node_id = nj
            .get("nodeId")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        let node_segment_count = nj
            .get("nodeSegmentCount")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("node {}: missing 'nodeSegmentCount'", ni))?;
        let initial_count_raw = nj
            .get("initialCount")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| format!("node {}: missing 'initialCount'", ni))?;
        if initial_count_raw < 0 {
            return Err(format!("node {}: negative initialCount", ni));
        }
        let cands_j = nj
            .get("candidates")
            .and_then(|v| v.as_arr())
            .ok_or_else(|| format!("node {}: missing 'candidates' array", ni))?;
        let mut candidates = Vec::with_capacity(cands_j.len());
        for (ci, cj) in cands_j.iter().enumerate() {
            candidates.push(parse_candidate(cj, ni, ci, payload.len())?);
        }
        // Contract: initialCount <= candidates.length. Clamp defensively so
        // malformed data errs instead of panicking (TS decoder clamps too).
        let initial_count = (initial_count_raw as usize).min(candidates.len());
        nodes.push(NodeData {
            node_id,
            node_segment_count,
            initial_count,
            candidates,
        });
    }

    Ok(Dataset { nodes, payload })
}

// ---------- C ABI (bun:ffi loading pattern mirrors awt-r3/native/hdastar) ----------

/// Parse an RPLYDS01 dataset buffer. Returns an opaque handle (> 0), or 0 on
/// error (see replay_last_error). The buffer is fully copied — the caller may
/// release it as soon as this returns.
#[no_mangle]
pub extern "C" fn replay_load(dataset_ptr: *const u8, dataset_len: usize) -> u64 {
    if dataset_ptr.is_null() || dataset_len == 0 {
        set_last_error("replay_load: null/empty buffer".to_string());
        return 0;
    }
    let bytes = unsafe { std::slice::from_raw_parts(dataset_ptr, dataset_len) };
    match parse_dataset(bytes) {
        Ok(ds) => Box::into_raw(Box::new(ds)) as u64,
        Err(e) => {
            set_last_error(format!("replay_load: {}", e));
            0
        }
    }
}

/// Number of node records in the dataset; -1 on a null handle.
#[no_mangle]
pub extern "C" fn replay_node_count(handle: u64) -> i64 {
    if handle == 0 {
        return -1;
    }
    let ds = unsafe { &*(handle as *const Dataset) };
    ds.nodes.len() as i64
}

/// Replay one node's schedule. Returns the winner candidate index,
/// -1 when no candidate wins (all failed / guard exhausted — the TS
/// winnerIndex === null case), -2 on a bad handle or node index.
#[no_mangle]
pub extern "C" fn replay_run(handle: u64, node_index: u64) -> i32 {
    if handle == 0 {
        return -2;
    }
    let ds = unsafe { &*(handle as *const Dataset) };
    let Some(node) = ds.nodes.get(node_index as usize) else {
        return -2;
    };
    replay_node(node, &ds.payload).winner
}

/// Replay one node and write a small diagnostic JSON
/// {nodeId, winner, expanded, totalCandidateWork, rounds, candidates,
/// initialCount} into out_ptr. Returns bytes written, -1 if the buffer is too
/// small/null, -2 on bad handle/index.
#[no_mangle]
pub extern "C" fn replay_run_detail(
    handle: u64,
    node_index: u64,
    out_ptr: *mut u8,
    out_cap: usize,
) -> i64 {
    if handle == 0 {
        return -2;
    }
    let ds = unsafe { &*(handle as *const Dataset) };
    let Some(node) = ds.nodes.get(node_index as usize) else {
        return -2;
    };
    let out = replay_node(node, &ds.payload);
    let mut s = String::new();
    s.push_str("{\"nodeId\":");
    write_json_string(&mut s, &node.node_id);
    s.push_str(&format!(
        ",\"winner\":{},\"expanded\":{},\"totalCandidateWork\":{},\"rounds\":{},\"candidates\":{},\"initialCount\":{}}}",
        out.winner,
        out.expanded,
        out.total_work,
        out.rounds,
        node.candidates.len(),
        node.initial_count
    ));
    let bytes = s.as_bytes();
    if out_ptr.is_null() || bytes.len() > out_cap {
        return -1;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, bytes.len());
    }
    bytes.len() as i64
}

/// Copy the last load error message into out_ptr; returns bytes written
/// (0 when there is no error, -1 if the buffer is too small/null).
#[no_mangle]
pub extern "C" fn replay_last_error(out_ptr: *mut u8, out_cap: usize) -> i64 {
    let msg = match LAST_ERROR.lock() {
        Ok(g) => g.clone(),
        Err(_) => return -1,
    };
    let bytes = msg.as_bytes();
    if bytes.is_empty() {
        return 0;
    }
    if out_ptr.is_null() || bytes.len() > out_cap {
        return -1;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, bytes.len());
    }
    bytes.len() as i64
}

/// Free a dataset handle created by replay_load.
#[no_mangle]
pub extern "C" fn replay_free(handle: u64) {
    if handle == 0 {
        return;
    }
    unsafe {
        drop(Box::from_raw(handle as *mut Dataset));
    }
}

// ---------- Tests (cargo test; no bun needed) ----------

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
    ) -> Candidate {
        Candidate {
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
    fn solved_at_zero_wins_when_reached() {
        // Subtlety (3): c0 default fails at 100; c1 solved at 0 iterations.
        // Round 1 picks c0 (index tie-break at f=0), c0 dies; round 2 picks
        // c1 at v=0, advance 0, winner declared same round.
        let payload = vec![0.0f32];
        let node = NodeData {
            node_id: "t".to_string(),
            node_segment_count: 1.0,
            initial_count: 2,
            candidates: vec![
                cand(false, 100.0, 1000.0, GClass::Default, 0, 1),
                cand(true, 0.0, 1000.0, GClass::Default, 0, 0),
            ],
        };
        let out = replay_node(&node, &payload);
        assert_eq!(out.winner, 1);
    }

    #[test]
    fn all_failed_returns_none() {
        let payload = vec![0.1f32, 0.2];
        let node = NodeData {
            node_id: "t".to_string(),
            node_segment_count: 1.0,
            initial_count: 2,
            candidates: vec![
                cand(false, 100.0, 1000.0, GClass::Default, 0, 1),
                cand(false, 200.0, 1000.0, GClass::Default, 0, 2),
            ],
        };
        let out = replay_node(&node, &payload);
        assert_eq!(out.winner, -1);
    }

    #[test]
    fn unclamped_progress_gives_negative_f() {
        // Subtlety (2): progress 1.2 → f = g + (1 - 1.2) * 5 < 0.
        let payload = vec![1.2f32];
        let c = cand(false, 200.0, 1000.0, GClass::Default, 0, 1);
        let f = candidate_g(&c, 100.0)
            + (1.0 - progress_at(&c, 1.0, &payload, 100.0, false)) * GREEDY_MULTIPLIER;
        assert!(f < 0.0);
    }
}
