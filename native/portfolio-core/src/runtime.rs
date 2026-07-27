//! M3 portfolio runtime (PORT-SPEC.md §8, module M3): parse the node-shared
//! session input, run the dominant-class candidates to completion on a rayon
//! pool recording schedule-grid trajectories, merge TS-side records for the
//! non-dominant classes, select the winner with the parity-proven replay-core
//! crate, commit staged cache entries per the §5
//! commit-on-sequential-semantics policy, and assemble the result JSON.
//!
//! Selection reuse: the merged per-candidate records are encoded as an
//! in-memory RPLYDS01 dataset (identical layout to
//! native/replay-core/datasetFormat.ts) and handed to
//! replay_core::replay_load / replay_run — the SAME compiled code that proved
//! 1222/1222-node replay parity decides the winner here. The vendored
//! simulator (src/replay_sim.rs) runs the identical schedule only to recover
//! the final virtual-iteration vector v[] for the cache commit (replay-core's
//! ABI does not expose v[]) and is cross-checked against replay-core's winner
//! on every node — disagreement is a hard error, not a silent pick.
//!
//! Contract surface consumed (defined in src/contract.rs / src/cache.rs —
//! M2-created shared types; consume, don't redefine):
//!   contract::{NodeSession, PortPoint, ConnSlice, Hp, HdRoute,
//!              CandidateRecord, KeyHash, CacheValue, SrStatus}
//!   cache::SharedCache          (plain struct; M3 owns the &mut commit)
//!   intra_node::CandidateSolver (contract C2 — M2 module, pending at the
//!                                time of writing; see lib.rs M2 row)

use crate::cache::SharedCache;
use crate::contract::{
    CacheValue, CandidateRecord, ConnSlice, HdRoute, Hp, KeyHash, NodeSession, PortPoint, SrStatus,
};
use crate::intra_node::CandidateSolver;
use crate::json::{
    array_element_spans, object_entry_spans, parse_json, write_f64, write_json_string, write_u64,
    JVal,
};
use crate::replay_sim::{js_truthy, resolve_g_class, simulate, SimCandidate, MIN_SUBSTEPS};
use rayon::prelude::*;

/// Marker keys that route generateSolver to a NON-default (non-dominant)
/// branch (PortfolioSingleIntraNodeSolver.ts:969-1069, branch order kept for
/// documentation value). This is a GUARD only — the candidate-class split is
/// decided TS-side by which indices arrive in tsrec; Rust merely refuses an
/// hp it cannot execute instead of silently misrouting it.
const NON_DOMINANT_HP_KEYS: [&str; 8] = [
    "SINGLE_LAYER_NO_DIFFERENT_ROOT_INTERSECTIONS",
    "HIGH_DENSITY_A01",
    "HIGH_DENSITY_A03",
    "CLOSED_FORM_TWO_TRACE_SAME_LAYER",
    "CLOSED_FORM_TWO_TRACE_TRANSITION_CROSSING",
    "CLOSED_FORM_SINGLE_TRANSITION",
    "THROUGH_OBSTACLE",
    "MULTI_HEAD_POLYLINE_SOLVER",
];

// ---------------------------------------------------------------------------
// Node session parsing — the input that crosses the FFI ONCE per node
// (PORT-SPEC §3; session-per-node protocol per portfolioReplayWorker.ts:51-68)
// ---------------------------------------------------------------------------
//
// Accepted JSON == the TS_GOLDEN_DUMP "node" line
// (native/replay-core/goldenDump.ts:116-131); t/winnerIndex/initialCount are
// tolerated and ignored; nodeSegmentCount, when present, is CROSS-CHECKED
// against the recomputed value as a marshaling tripwire:
//
// { "nodeId": "cmn_12",              // optional; node.capacityMeshNodeId wins
//   "node": { capacityMeshNodeId, center:{x,y}, width, height,
//             portPoints:[{connectionName, rootConnectionName?, portPointId?,
//                          prevPortPointId?, nextPortPointId?, x, y, z}],
//             availableZ?, portPointsInPairs? },
//   "params": { traceWidth?, viaDiameter?, obstacleMargin?, effort? },
//   "connMap": { "idToNet": {name: net}, "nets": {net: [names]} } | null,
//   "nodeSegmentCount": 3 }
//
// Defaults: traceWidth 0.15, viaDiameter 0.3, obstacleMargin 0.15, effort 1
// (IntraNodeSolver.ts:112-114, PortfolioSingleIntraNodeSolver.ts:258);
// portPoint z defaults to 0 (`pp.z ?? 0` usage). obstacles/layerCount/
// colorMap are deliberately NOT parsed — only the TS-side throughObstacle
// candidate consumes them (§3).

fn num_field(v: &JVal, key: &str, what: &str) -> Result<f64, String> {
    v.get(key)
        .and_then(|x| x.as_f64())
        .ok_or_else(|| format!("{}: missing number '{}'", what, key))
}

fn num_or(v: &JVal, key: &str, default: f64) -> Result<f64, String> {
    match v.get(key) {
        None | Some(JVal::Null) => Ok(default),
        Some(JVal::Num(n)) => Ok(*n),
        Some(_) => Err(format!("'{}' is not a number", key)),
    }
}

fn opt_string(v: &JVal, key: &str) -> Option<String> {
    match v.get(key) {
        Some(JVal::Str(s)) => Some(s.clone()),
        _ => None,
    }
}

pub fn parse_node_session(bytes: &[u8]) -> Result<NodeSession, String> {
    let top = parse_json(bytes).map_err(|e| format!("node JSON: {}", e))?;
    let node = top
        .get("node")
        .filter(|v| !v.is_null())
        .ok_or_else(|| "missing 'node' (nodeWithPortPoints)".to_string())?;

    // capacityMeshNodeId is the canonical id (it becomes HdRoute.region_id);
    // the top-level nodeId is the golden-line convenience copy.
    let node_id = node
        .get("capacityMeshNodeId")
        .and_then(|v| v.as_str())
        .or_else(|| top.get("nodeId").and_then(|v| v.as_str()))
        .unwrap_or("")
        .to_string();

    let center = node
        .get("center")
        .ok_or_else(|| "node: missing 'center'".to_string())?;
    let center = [
        num_field(center, "x", "node.center")?,
        num_field(center, "y", "node.center")?,
    ];
    let width = num_field(node, "width", "node")?;
    let height = num_field(node, "height", "node")?;

    let mut conn = ConnSlice::new();

    // portPoints — ORDER = TS array order (load-bearing, §6.2/§6.6).
    let pp_j = node
        .get("portPoints")
        .and_then(|v| v.as_arr())
        .ok_or_else(|| "node: missing 'portPoints' array".to_string())?;
    let mut port_points = Vec::with_capacity(pp_j.len());
    for (i, p) in pp_j.iter().enumerate() {
        let what = format!("node.portPoints[{}]", i);
        let conn_name = p
            .get("connectionName")
            .and_then(|v| v.as_str())
            .ok_or_else(|| format!("{}: missing string 'connectionName'", what))?;
        let conn_id = conn.intern(conn_name);
        // None when undefined OR "" — every TS consumer applies truthiness
        // (contract.rs PortPoint doc, deviation 2).
        let root_conn = match p.get("rootConnectionName") {
            Some(JVal::Str(s)) if !s.is_empty() => Some(conn.intern(s)),
            Some(JVal::Str(_)) | None | Some(JVal::Null) => None,
            Some(_) => {
                return Err(format!("{}: 'rootConnectionName' is not a string", what));
            }
        };
        port_points.push(PortPoint {
            conn: conn_id,
            root_conn,
            x: num_field(p, "x", &what)?,
            y: num_field(p, "y", &what)?,
            z: num_or(p, "z", 0.0).map_err(|e| format!("{}: {}", what, e))?,
            // Cache-key-only identity (CachedIntraNodeRouteSolver.ts:128-149).
            port_point_id: opt_string(p, "portPointId"),
            prev_port_point_id: opt_string(p, "prevPortPointId"),
            next_port_point_id: opt_string(p, "nextPortPointId"),
        });
    }

    let available_z = match node.get("availableZ") {
        None | Some(JVal::Null) => None,
        Some(JVal::Arr(a)) => {
            let mut zs = Vec::with_capacity(a.len());
            for z in a {
                zs.push(
                    z.as_f64()
                        .ok_or_else(|| "node.availableZ: non-numeric entry".to_string())?,
                );
            }
            Some(zs)
        }
        Some(_) => return Err("node.availableZ is not an array".to_string()),
    };

    let port_points_in_pairs_len = match node.get("portPointsInPairs") {
        None | Some(JVal::Null) => None,
        Some(JVal::Arr(a)) => Some(a.len() as u32),
        Some(_) => return Err("node.portPointsInPairs is not an array".to_string()),
    };

    let empty = JVal::Obj(Vec::new());
    let params = match top.get("params") {
        Some(p) if !p.is_null() => p,
        _ => &empty,
    };
    let trace_width = num_or(params, "traceWidth", 0.15).map_err(|e| format!("params: {}", e))?;
    let via_diameter = num_or(params, "viaDiameter", 0.3).map_err(|e| format!("params: {}", e))?;
    let obstacle_margin =
        num_or(params, "obstacleMargin", 0.15).map_err(|e| format!("params: {}", e))?;
    let effort = num_or(params, "effort", 1.0).map_err(|e| format!("params: {}", e))?;

    // connMap slice: {idToNet: {name: net}, nets: {net: [names]}} | null.
    if let Some(cm) = top.get("connMap") {
        if !cm.is_null() {
            if let Some(id_to_net_j) = cm.get("idToNet").and_then(|v| v.as_obj()) {
                for (name, net) in id_to_net_j {
                    let net = net
                        .as_str()
                        .ok_or_else(|| format!("connMap.idToNet['{}'] is not a string", name))?;
                    let name_id = conn.intern(name);
                    let net_id = conn.intern(net);
                    conn.set_id_to_net(name_id, net_id);
                }
            }
            if let Some(nets_j) = cm.get("nets").and_then(|v| v.as_obj()) {
                for (net, members) in nets_j {
                    let members = members
                        .as_arr()
                        .ok_or_else(|| format!("connMap.nets['{}'] is not an array", net))?;
                    let net_id = conn.intern(net);
                    let mut ids = Vec::with_capacity(members.len());
                    for m in members {
                        let m = m.as_str().ok_or_else(|| {
                            format!("connMap.nets['{}'] has a non-string member", net)
                        })?;
                        ids.push(conn.intern(m));
                    }
                    conn.set_net(net_id, ids);
                }
            }
        }
    }

    let session = NodeSession {
        node_id,
        center,
        width,
        height,
        port_points,
        available_z,
        port_points_in_pairs_len,
        trace_width,
        via_diameter,
        obstacle_margin,
        effort,
        conn,
    };

    // Marshaling tripwire: recomputed nodeSegmentCount must match a provided
    // one (golden node lines carry it).
    if let Some(given) = top.get("nodeSegmentCount").and_then(|v| v.as_f64()) {
        let computed = node_segment_count(&session);
        if computed != given {
            return Err(format!(
                "nodeSegmentCount mismatch: input says {}, session computes {} (node {})",
                given, computed, session.node_id
            ));
        }
    }

    Ok(session)
}

/// PortfolioSingleIntraNodeSolver.getNodeSegmentCount
/// (PortfolioSingleIntraNodeSolver.ts:180-190):
/// max(1, portPointsInPairs?.length ?? distinct connectionName count).
pub fn node_segment_count(session: &NodeSession) -> f64 {
    let n = match session.port_points_in_pairs_len {
        Some(n) => n as usize,
        None => {
            let mut seen: std::collections::HashSet<u32> = std::collections::HashSet::new();
            for p in &session.port_points {
                seen.insert(p.conn);
            }
            seen.len()
        }
    };
    if n < 1 {
        1.0
    } else {
        n as f64
    }
}

// ---------------------------------------------------------------------------
// Run inputs
// ---------------------------------------------------------------------------

/// One marshaled hyperparameter entry: parsed value (for Hp::from_raw, the
/// dominant guard and candidateG classification) plus the RAW source text,
/// spliced verbatim into the RPLYDS01 header so replay-core sees exactly the
/// bytes TS produced (zero re-serialization risk).
pub struct HpEntry {
    pub raw: String,
    pub val: JVal,
}

/// Which schedule drives the node (the "mode" key of the hp wrapper).
#[derive(Clone, Copy, PartialEq, Debug)]
pub enum RunMode {
    /// Run-to-completion + replay selection (the Gate A/B path; default).
    Rtc,
    /// Live-sequential supervisor mirror (src/seq.rs): one candidate at a
    /// time, MIN_SUBSTEPS per pick, single-threaded, no rayon.
    Seq,
}

/// `hp_list_json` payload of pf_run_portfolio:
/// {"initialCount": N, "externalMaxIterations": M|null, "emitAllRoutes": b,
///  "mode": "rtc"|"seq", "hps": [hp, ...]}   (hps = full candidate list in
/// TS enumeration order = tie-break order — marshaled from TS per PORT-SPEC
/// §2b, NEVER re-derived here; "mode" defaults to "rtc").
pub struct RunInput {
    pub initial_count: usize,
    /// GrowShrink ceiling (PortfolioSingleIntraNodeSolver.ts:434-464);
    /// honored as a replay-round ceiling — see replay_sim.rs delta (2) — or,
    /// in seq mode, as the live externalMaxIterations cap on the supervisor
    /// budget (:457-462).
    pub external_max_iterations: Option<f64>,
    /// Golden-verification mode: echo every solved Rust candidate's raw
    /// routes in perCandidate (production keeps winner-only; seq ignores it
    /// — CandidateSolver only surrenders routes by value for the winner).
    pub emit_all_routes: bool,
    pub mode: RunMode,
    pub hps: Vec<HpEntry>,
}

pub fn parse_run_input(bytes: &[u8]) -> Result<RunInput, String> {
    let top = parse_json(bytes).map_err(|e| format!("hp_list JSON: {}", e))?;
    let initial_count = top
        .get("initialCount")
        .and_then(|v| v.as_i64())
        .ok_or_else(|| "hp_list: missing integer 'initialCount'".to_string())?;
    if initial_count < 0 {
        return Err("hp_list: negative initialCount".to_string());
    }
    let external_max_iterations = match top.get("externalMaxIterations") {
        None | Some(JVal::Null) => None,
        Some(JVal::Num(n)) => Some(*n),
        Some(_) => return Err("hp_list: externalMaxIterations is not a number".to_string()),
    };
    let emit_all_routes = top
        .get("emitAllRoutes")
        .and_then(|v| v.as_bool())
        .unwrap_or(false);
    let mode = match top.get("mode") {
        None | Some(JVal::Null) => RunMode::Rtc,
        Some(JVal::Str(s)) if s == "rtc" => RunMode::Rtc,
        Some(JVal::Str(s)) if s == "seq" => RunMode::Seq,
        Some(JVal::Str(s)) => return Err(format!("hp_list: unknown mode '{}'", s)),
        Some(_) => return Err("hp_list: 'mode' is not a string".to_string()),
    };
    let hps_j = top
        .get("hps")
        .and_then(|v| v.as_arr())
        .ok_or_else(|| "hp_list: missing 'hps' array".to_string())?;

    // Raw spans of each hp element for verbatim splicing.
    let entries = object_entry_spans(bytes).map_err(|e| format!("hp_list spans: {}", e))?;
    let (hs, he) = entries
        .iter()
        .find(|(k, _)| k == "hps")
        .map(|(_, span)| *span)
        .ok_or_else(|| "hp_list: no span for 'hps'".to_string())?;
    let el_spans =
        array_element_spans(&bytes[hs..he]).map_err(|e| format!("hp_list hps spans: {}", e))?;
    if el_spans.len() != hps_j.len() {
        return Err("hp_list: span/value count disagreement (internal)".to_string());
    }
    let hps = hps_j
        .iter()
        .zip(el_spans.iter())
        .map(|(v, (s, e))| HpEntry {
            raw: String::from_utf8_lossy(&bytes[hs + s..hs + e]).into_owned(),
            val: v.clone(),
        })
        .collect();

    Ok(RunInput {
        initial_count: initial_count as usize,
        external_max_iterations,
        emit_all_routes,
        mode,
        hps,
    })
}

/// One TS-executed candidate record (non-dominant classes — A01/A03,
/// polyline, closed-form, singleLayer, throughObstacle — PORT-SPEC §2b /
/// contract C3 "tsrec"). `routes` stay raw JSON text: they are already
/// post-extractWinningRoutes (worker semantics, portfolioReplayWorker.ts:112)
/// and Rust never interprets them — a TS winner's routes are spliced back
/// verbatim.
///
/// SEQ-MODE STUBS (`"stub": true`, driver.ts runTsCandidateStub): a record
/// carrying only the candidate's CONSTRUCTION state — post-setup
/// maxIterations plus the ctor-time solved/failed flags (live
/// initializeSolvers constructs + setups every candidate before any step,
/// PortfolioSingleIntraNodeSolver.ts:509-528, so these are exactly the
/// observables the schedule can see before first picking the candidate).
/// iterations must be 0 and traj empty. The seq schedule aborts with a
/// `needTsCandidates` result the moment it PICKS a stub (the driver then
/// runs that candidate for real and re-runs the node). Stubs are invalid in
/// rtc mode (hard error) — the replay path consumes full trajectories only.
pub struct TsRecord {
    pub index: usize,
    pub solved: bool,
    pub iterations: f64,
    pub max_iterations: f64,
    pub solved_segments: f64,
    pub traj: Vec<f32>,
    pub error: Option<String>,
    pub routes_raw: Option<String>,
    /// `"stub": true` — ctor-state-only record (seq mode; see above).
    pub stub: bool,
    /// Stub records only: the candidate was failed AT CONSTRUCTION (e.g. the
    /// ineligible singleLayer solver, PortfolioSingleIntraNodeSolver.ts:
    /// 982-999). Full records encode failure as solved=false + completion.
    pub ctor_failed: bool,
}

pub fn parse_tsrec(bytes: &[u8]) -> Result<Vec<TsRecord>, String> {
    if bytes.is_empty() {
        return Ok(Vec::new());
    }
    let top = parse_json(bytes).map_err(|e| format!("tsrec JSON: {}", e))?;
    if top.is_null() {
        return Ok(Vec::new());
    }
    let arr = top
        .as_arr()
        .ok_or_else(|| "tsrec: not an array".to_string())?;
    let spans = array_element_spans(bytes).map_err(|e| format!("tsrec spans: {}", e))?;
    let mut out = Vec::with_capacity(arr.len());
    for (j, (rec, (rs, re))) in arr.iter().zip(spans.iter()).enumerate() {
        let ctx = || format!("tsrec[{}]", j);
        let index = rec
            .get("i")
            .and_then(|v| v.as_i64())
            .ok_or_else(|| format!("{}: missing integer 'i'", ctx()))?;
        if index < 0 {
            return Err(format!("{}: negative candidate index", ctx()));
        }
        let solved = rec
            .get("solved")
            .and_then(|v| v.as_bool())
            .ok_or_else(|| format!("{}: missing bool 'solved'", ctx()))?;
        let iterations = rec
            .get("iterations")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("{}: missing number 'iterations'", ctx()))?;
        let max_iterations = rec
            .get("maxIterations")
            .and_then(|v| v.as_f64())
            .ok_or_else(|| format!("{}: missing number 'maxIterations'", ctx()))?;
        let solved_segments = rec
            .get("solvedSegments")
            .and_then(|v| v.as_f64())
            .unwrap_or(-1.0);
        let traj = match rec.get("traj") {
            None | Some(JVal::Null) => Vec::new(),
            Some(JVal::Arr(a)) => {
                let mut t = Vec::with_capacity(a.len());
                for x in a {
                    // Golden traj values are exact f64 widenings of f32
                    // samples; `as f32` recovers the original sample exactly.
                    t.push(
                        x.as_f64()
                            .ok_or_else(|| format!("{}: non-numeric traj entry", ctx()))?
                            as f32,
                    );
                }
                t
            }
            Some(_) => return Err(format!("{}: 'traj' is not an array", ctx())),
        };
        let error = match rec.get("error") {
            Some(JVal::Str(s)) => Some(s.clone()),
            _ => None,
        };
        let stub = rec.get("stub").and_then(|v| v.as_bool()).unwrap_or(false);
        let ctor_failed = rec.get("failed").and_then(|v| v.as_bool()).unwrap_or(false);
        if stub && (iterations != 0.0 || !traj.is_empty()) {
            return Err(format!(
                "{}: stub record must have iterations 0 and an empty traj",
                ctx()
            ));
        }
        // Raw span of the routes value (only when it is an actual array).
        let routes_raw = if matches!(rec.get("routes"), Some(JVal::Arr(_))) {
            let entry_spans =
                object_entry_spans(&bytes[*rs..*re]).map_err(|e| format!("{}: {}", ctx(), e))?;
            entry_spans
                .iter()
                .find(|(k, _)| k == "routes")
                .map(|(_, (s, e))| String::from_utf8_lossy(&bytes[rs + s..rs + e]).into_owned())
        } else {
            None
        };
        out.push(TsRecord {
            index: index as usize,
            solved,
            iterations,
            max_iterations,
            solved_segments,
            traj,
            error,
            routes_raw,
            stub,
            ctor_failed,
        });
    }
    Ok(out)
}

/// Index tsrec entries by candidate index, rejecting out-of-range and
/// duplicate indices (shared by the rtc and seq paths).
pub(crate) fn index_tsrecs<'a>(
    n: usize,
    tsrecs: &'a [TsRecord],
) -> Result<Vec<Option<&'a TsRecord>>, String> {
    let mut ts_by_index: Vec<Option<&TsRecord>> = vec![None; n];
    for r in tsrecs {
        if r.index >= n {
            return Err(format!(
                "tsrec index {} out of range (candidates: {})",
                r.index, n
            ));
        }
        if ts_by_index[r.index].is_some() {
            return Err(format!("duplicate tsrec index {}", r.index));
        }
        ts_by_index[r.index] = Some(r);
    }
    Ok(ts_by_index)
}

/// Guard: a candidate Rust is about to execute must be dominant-class — its
/// hp must contain none of the generateSolver marker keys (shared by the rtc
/// and seq paths; the candidate-class split itself is decided TS-side).
pub(crate) fn ensure_dominant(hp_val: &JVal, i: usize) -> Result<(), String> {
    for key in NON_DOMINANT_HP_KEYS {
        if js_truthy(hp_val.get(key)) {
            return Err(format!(
                "candidate {} hp contains '{}': non-dominant class — must be executed TS-side and marshaled via tsrec",
                i, key
            ));
        }
    }
    Ok(())
}

pub(crate) fn hp_from_entry(entry: &HpEntry, idx: usize) -> Result<Hp, String> {
    match &entry.val {
        JVal::Obj(entries) => Ok(Hp::from_raw(entries.clone())),
        _ => Err(format!("candidate {}: hp is not an object", idx)),
    }
}

// ---------------------------------------------------------------------------
// Candidate execution (rayon task body)
// ---------------------------------------------------------------------------

struct Executed {
    record: CandidateRecord,
    pending: Option<(KeyHash, CacheValue)>,
}

/// Run ONE dominant-class candidate to completion, recording the
/// schedule-grid trajectory: sample k = raw progress after
/// min((k+1)*100, iterations) iterations — the identical grid to
/// datasetFormat.decimateTrajectory (bit-exact for the replay; the recording
/// mirrors portfolioReplayWorker.ts:99-107 where `progress || 0` collapses
/// NaN and the isFinite guard collapses infinities to 0 before the f32
/// store).
fn run_candidate(
    session: &NodeSession,
    hp: &Hp,
    cache: &SharedCache,
    idx: usize,
) -> Result<Executed, String> {
    let mut solver = CandidateSolver::new(session, hp, cache);
    // Post-setup budget, read BEFORE stepping (portfolioReplayWorker.ts:75-78).
    // GOLDEN-PARITY CORRECTION (2026-07-27): the verified replay transport
    // stores this value into an Int32Array SAB slot ([2] maxIterations,
    // replayPool.ts:112), so the RECORDED budget is ToInt32-truncated
    // (5196.152... -> 5196) even though the solver's internal budget stays
    // fractional (IntraNodeSolver.ts:173). candidateG divides by the recorded
    // value and the golden dump captures it, so the record must mirror the
    // truncation exactly; the in-solver budget check remains fractional.
    let max_iterations = (solver.max_iterations() as i64 as i32) as f64;

    let mut traj: Vec<f32> = Vec::new();
    while solver.status() == SrStatus::Running {
        // Step to the next grid boundary (or completion, whichever first).
        let target = (solver.iterations() / MIN_SUBSTEPS as u64 + 1) * MIN_SUBSTEPS as u64;
        while solver.status() == SrStatus::Running && solver.iterations() < target {
            let before = solver.iterations();
            solver.step();
            if solver.status() == SrStatus::Running && solver.iterations() != before + 1 {
                return Err(format!(
                    "candidate {}: step() moved iterations {} -> {} while Running (contract C2 violation)",
                    idx,
                    before,
                    solver.iterations()
                ));
            }
        }
        // Progress sample after min(target, completion) iterations.
        let p = solver.progress();
        let sample = if p.is_finite() && p != 0.0 { p } else { 0.0 };
        traj.push(sample as f32);
    }

    let solved = solver.status() == SrStatus::Solved;
    let iterations = solver.iterations();
    let error = solver.error().map(|s| s.to_string());
    let pending = solver.pending_cache_entry();
    let routes = if solved {
        Some(solver.take_routes())
    } else {
        None
    };

    Ok(Executed {
        record: CandidateRecord {
            hp_index: idx as u32,
            solved,
            iterations,
            max_iterations,
            // Dominant class has no solvedConnectionsMap (spec §4).
            solved_segments: -1,
            traj,
            error,
            routes,
        },
        pending,
    })
}

// ---------------------------------------------------------------------------
// Merged view + RPLYDS01 encoding
// ---------------------------------------------------------------------------

#[derive(Clone, Debug)]
pub(crate) struct MergedCand {
    pub solved: bool,
    pub iterations: f64,
    pub max_iterations: f64,
    pub solved_segments: f64,
    pub traj_offset: usize,
    pub traj_len: usize,
    pub is_ts: bool,
}

/// Encode one node's merged records as an RPLYDS01 buffer (layout defined in
/// native/replay-core/datasetFormat.ts and re-validated by replay-core's
/// parser): magic, u32-LE header length, space-padded JSON header, LE f32
/// payload. hp values are spliced RAW from the marshaled input.
pub(crate) fn encode_rplyds01(
    node_id: &str,
    node_segment_count: f64,
    initial_count: usize,
    cands: &[MergedCand],
    hp_raws: &[&str],
    payload: &[f32],
) -> Vec<u8> {
    let mut header = String::with_capacity(256 + cands.len() * 128);
    header.push_str("{\"version\":1,\"sampleStride\":");
    write_f64(&mut header, MIN_SUBSTEPS);
    header.push_str(",\"nodes\":[{\"nodeId\":");
    write_json_string(&mut header, node_id);
    header.push_str(",\"nodeSegmentCount\":");
    write_f64(&mut header, node_segment_count);
    header.push_str(",\"initialCount\":");
    write_u64(&mut header, initial_count as u64);
    header.push_str(",\"capturedWinnerIndex\":-1,\"candidates\":[");
    for (i, c) in cands.iter().enumerate() {
        if i > 0 {
            header.push(',');
        }
        header.push_str("{\"hp\":");
        header.push_str(hp_raws[i]);
        header.push_str(",\"solved\":");
        header.push_str(if c.solved { "true" } else { "false" });
        header.push_str(",\"iterations\":");
        write_f64(&mut header, c.iterations);
        header.push_str(",\"maxIterations\":");
        write_f64(&mut header, c.max_iterations);
        header.push_str(",\"solvedSegments\":");
        write_f64(&mut header, c.solved_segments);
        header.push_str(",\"trajOffset\":");
        write_u64(&mut header, c.traj_offset as u64);
        header.push_str(",\"trajLen\":");
        write_u64(&mut header, c.traj_len as u64);
        header.push('}');
    }
    header.push_str("]}]}");

    let mut header_bytes = header.into_bytes();
    let pad = (4 - ((12 + header_bytes.len()) % 4)) % 4;
    header_bytes.extend(std::iter::repeat(b' ').take(pad));

    let mut out = Vec::with_capacity(12 + header_bytes.len() + payload.len() * 4);
    out.extend_from_slice(b"RPLYDS01");
    out.extend_from_slice(&(header_bytes.len() as u32).to_le_bytes());
    out.extend_from_slice(&header_bytes);
    for s in payload {
        out.extend_from_slice(&s.to_le_bytes());
    }
    out
}

// ---------------------------------------------------------------------------
// The portfolio run
// ---------------------------------------------------------------------------

pub fn run_portfolio(
    session: &NodeSession,
    cache: &mut SharedCache,
    pool: &rayon::ThreadPool,
    hp_bytes: &[u8],
    tsrec_bytes: &[u8],
) -> Result<String, String> {
    let run = parse_run_input(hp_bytes)?;
    let tsrecs = parse_tsrec(tsrec_bytes)?;

    // mode "seq": the live-sequential supervisor mirror. Single-threaded by
    // design — the rayon pool is deliberately NOT passed (zero contention,
    // zero dispatch: the whole point of the sequential schedule).
    if run.mode == RunMode::Seq {
        return crate::seq::run_portfolio_seq(session, cache, &run, &tsrecs);
    }
    // Stub records carry no trajectory; the replay path cannot consume them.
    if let Some(s) = tsrecs.iter().find(|r| r.stub) {
        return Err(format!(
            "tsrec index {}: stub records are only valid in mode \"seq\"",
            s.index
        ));
    }

    let n = run.hps.len();
    let initial_count = run.initial_count.min(n);

    // Index the TS records; reject out-of-range/duplicate indices.
    let ts_by_index = index_tsrecs(n, &tsrecs)?;

    // Rust runs every index TS did not; guard that each is dominant-class.
    let mut work: Vec<(usize, Hp)> = Vec::new();
    for i in 0..n {
        if ts_by_index[i].is_none() {
            ensure_dominant(&run.hps[i].val, i)?;
            work.push((i, hp_from_entry(&run.hps[i], i)?));
        }
    }

    // Dispatch to the rayon pool: one task = one candidate run to completion
    // (coarse, independent; results land by index so scheduling order cannot
    // affect the outcome — the tie-break stays the hp-list index). Candidates
    // hold &SharedCache — the immutable pre-node snapshot (cache.rs protocol
    // step 1); the &mut commit happens after the pool has joined.
    let cache_ro: &SharedCache = cache;
    let executed_pairs: Vec<(usize, Result<Executed, String>)> = pool.install(|| {
        work.par_iter()
            .map(|(i, hp)| (*i, run_candidate(session, hp, cache_ro, *i)))
            .collect()
    });
    let mut executed: Vec<Option<Executed>> = (0..n).map(|_| None).collect();
    for (i, res) in executed_pairs {
        executed[i] = Some(res?);
    }

    // Merge (TS + Rust) into index order; concatenate trajectories into the
    // shared payload exactly as datasetFormat.encodeDataset does.
    let mut payload: Vec<f32> = Vec::new();
    let mut merged: Vec<MergedCand> = Vec::with_capacity(n);
    for i in 0..n {
        let (solved, iterations, max_iterations, solved_segments, traj): (
            bool,
            f64,
            f64,
            f64,
            &[f32],
        ) = if let Some(ts) = ts_by_index[i] {
            (
                ts.solved,
                ts.iterations,
                ts.max_iterations,
                ts.solved_segments,
                &ts.traj,
            )
        } else {
            let ex = executed[i].as_ref().expect("rust slot filled");
            (
                ex.record.solved,
                ex.record.iterations as f64,
                ex.record.max_iterations,
                ex.record.solved_segments as f64,
                &ex.record.traj,
            )
        };
        let traj_offset = payload.len();
        payload.extend_from_slice(traj);
        merged.push(MergedCand {
            solved,
            iterations,
            max_iterations,
            solved_segments,
            traj_offset,
            traj_len: traj.len(),
            is_ts: ts_by_index[i].is_some(),
        });
    }

    // --- Winner selection: DEPEND on the parity-proven replay-core crate ---
    let nsc = node_segment_count(session);
    let hp_raws: Vec<&str> = run.hps.iter().map(|h| h.raw.as_str()).collect();
    let dataset = encode_rplyds01(
        &session.node_id,
        nsc,
        initial_count,
        &merged,
        &hp_raws,
        &payload,
    );
    let handle = replay_core::replay_load(dataset.as_ptr(), dataset.len());
    if handle == 0 {
        let mut buf = vec![0u8; 4096];
        let m = replay_core::replay_last_error(buf.as_mut_ptr(), buf.len());
        let msg = if m > 0 {
            String::from_utf8_lossy(&buf[..m as usize]).into_owned()
        } else {
            "(no message)".to_string()
        };
        return Err(format!("replay-core rejected encoded dataset: {}", msg));
    }
    let rc_winner = replay_core::replay_run(handle, 0);
    let mut detail_buf = vec![0u8; 65536];
    let dn = replay_core::replay_run_detail(handle, 0, detail_buf.as_mut_ptr(), detail_buf.len());
    let rc_detail = if dn > 0 {
        Some(String::from_utf8_lossy(&detail_buf[..dn as usize]).into_owned())
    } else {
        None
    };
    replay_core::replay_free(handle);
    if rc_winner == -2 {
        return Err("replay-core: bad handle/node index (internal)".to_string());
    }

    // Vendored schedule for v[] (cache commit) + externalMaxIterations
    // ceiling; hard cross-check against replay-core whenever the ceiling did
    // not cut the schedule short.
    let sim_cands: Vec<SimCandidate> = (0..n)
        .map(|i| {
            let (g_class, iteration_penalty, segments_per_polyline) =
                resolve_g_class(&run.hps[i].val);
            let m = &merged[i];
            SimCandidate {
                solved: m.solved,
                iterations: m.iterations,
                max_iterations: m.max_iterations,
                solved_segments: m.solved_segments,
                g_class,
                iteration_penalty,
                segments_per_polyline,
                traj_offset: m.traj_offset,
                traj_len: m.traj_len,
            }
        })
        .collect();
    let sim = simulate(
        &sim_cands,
        initial_count,
        nsc,
        &payload,
        run.external_max_iterations,
    );
    if !sim.ceiling_hit && sim.winner != rc_winner {
        return Err(format!(
            "selection tripwire at node {}: vendored simulator winner {} != replay-core winner {}",
            session.node_id, sim.winner, rc_winner
        ));
    }
    let winner: i32 = if sim.ceiling_hit { -1 } else { rc_winner };

    // --- Cache commit (§5, commit-on-sequential-semantics) ---
    // Stage, in candidate-index order, exactly the entries the sequential
    // schedule would have produced: candidates whose virtual iterations
    // reached their recorded completion when the schedule stopped
    // (v[i] >= iterations), plus the winner. Only Rust-run candidates carry
    // staged entries; None from pending_cache_entry (cache hit / still
    // running) commits nothing.
    let mut staged: Vec<(KeyHash, CacheValue)> = Vec::new();
    let mut pending_count = 0usize;
    for i in 0..n {
        if let Some(ex) = executed[i].as_mut() {
            if ex.pending.is_some() {
                pending_count += 1;
            }
            let completed = sim.v[i] >= merged[i].iterations;
            if completed || (i as i32) == winner {
                if let Some(entry) = ex.pending.take() {
                    staged.push(entry);
                }
            }
        }
    }
    let committed = staged.len();
    cache.commit(staged);

    // --- Result JSON ---
    let mut out = String::with_capacity(4096);
    out.push_str("{\"nodeId\":");
    write_json_string(&mut out, &session.node_id);
    out.push_str(",\"winnerIndex\":");
    out.push_str(&format!("{}", winner));
    out.push_str(",\"solved\":");
    out.push_str(if winner >= 0 { "true" } else { "false" });
    out.push_str(",\"winnerSource\":");
    if winner >= 0 {
        if merged[winner as usize].is_ts {
            out.push_str("\"ts\"");
        } else {
            out.push_str("\"rust\"");
        }
    } else {
        out.push_str("null");
    }
    out.push_str(",\"error\":");
    if winner >= 0 {
        out.push_str("null");
    } else if sim.ceiling_hit {
        let msg = format!(
            "external iteration ceiling reached (externalMaxIterations={})",
            run.external_max_iterations.unwrap_or(f64::NAN)
        );
        write_json_string(&mut out, &msg);
    } else {
        // Mirror of PortfolioSingleIntraNodeSolver.ts:731.
        write_json_string(&mut out, "All candidates failed in parallel replay");
    }
    out.push_str(",\"routes\":");
    if winner >= 0 {
        let w = winner as usize;
        if let Some(ts) = ts_by_index[w] {
            match &ts.routes_raw {
                // Already post-extractWinningRoutes (worker semantics) —
                // splice back verbatim.
                Some(raw) => out.push_str(raw),
                None => out.push_str("null"),
            }
        } else {
            match executed[w].as_ref().and_then(|e| e.record.routes.as_ref()) {
                // RAW routes — TS applies extractWinningRoutes after the FFI
                // returns (spec §2b).
                Some(routes) => write_routes(&mut out, routes),
                None => out.push_str("null"),
            }
        }
    } else {
        out.push_str("null");
    }

    out.push_str(",\"perCandidate\":[");
    for i in 0..n {
        if i > 0 {
            out.push(',');
        }
        let m = &merged[i];
        out.push_str("{\"i\":");
        write_u64(&mut out, i as u64);
        out.push_str(",\"source\":");
        out.push_str(if m.is_ts { "\"ts\"" } else { "\"rust\"" });
        out.push_str(",\"solved\":");
        out.push_str(if m.solved { "true" } else { "false" });
        out.push_str(",\"iterations\":");
        write_f64(&mut out, m.iterations);
        out.push_str(",\"maxIterations\":");
        write_f64(&mut out, m.max_iterations);
        out.push_str(",\"solvedSegments\":");
        write_f64(&mut out, m.solved_segments);
        if let Some(ex) = executed[i].as_ref() {
            // Rust-run extras: trajectory (f32 samples widened exactly to
            // f64, matching a JS Float32Array read) + error + optional routes.
            out.push_str(",\"traj\":[");
            for (j, s) in ex.record.traj.iter().enumerate() {
                if j > 0 {
                    out.push(',');
                }
                write_f64(&mut out, *s as f64);
            }
            out.push(']');
            if let Some(err) = &ex.record.error {
                out.push_str(",\"error\":");
                write_json_string(&mut out, err);
            }
            if run.emit_all_routes {
                if let Some(routes) = &ex.record.routes {
                    out.push_str(",\"routes\":");
                    write_routes(&mut out, routes);
                }
            }
        } else if let Some(ts) = ts_by_index[i] {
            if let Some(err) = &ts.error {
                out.push_str(",\"error\":");
                write_json_string(&mut out, err);
            }
        }
        out.push('}');
    }
    out.push(']');

    out.push_str(",\"replay\":{\"expanded\":");
    out.push_str(if sim.expanded { "true" } else { "false" });
    out.push_str(",\"totalCandidateWork\":");
    write_f64(&mut out, sim.total_work);
    out.push_str(",\"rounds\":");
    write_u64(&mut out, sim.rounds);
    out.push_str(",\"ceilingHit\":");
    out.push_str(if sim.ceiling_hit { "true" } else { "false" });
    out.push_str(",\"replayCoreDetail\":");
    match &rc_detail {
        Some(raw) => out.push_str(raw), // small JSON object from replay-core
        None => out.push_str("null"),
    }
    out.push('}');

    out.push_str(",\"cache\":{\"pending\":");
    write_u64(&mut out, pending_count as u64);
    out.push_str(",\"committed\":");
    write_u64(&mut out, committed as u64);
    out.push_str(",\"size\":");
    write_u64(&mut out, cache.len() as u64);
    out.push_str("}}");

    Ok(out)
}

/// Serialize raw HdRoutes in lib/types/high-density-types.ts field naming.
/// (Shared with the seq mode's result assembly.)
pub(crate) fn write_routes(out: &mut String, routes: &[HdRoute]) {
    out.push('[');
    for (i, r) in routes.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"connectionName\":");
        write_json_string(out, &r.connection_name);
        if let Some(root) = &r.root_connection_name {
            out.push_str(",\"rootConnectionName\":");
            write_json_string(out, root);
        }
        if let Some(rid) = &r.region_id {
            out.push_str(",\"regionId\":");
            write_json_string(out, rid);
        }
        out.push_str(",\"traceThickness\":");
        write_f64(out, r.trace_thickness);
        out.push_str(",\"viaDiameter\":");
        write_f64(out, r.via_diameter);
        out.push_str(",\"route\":[");
        for (j, p) in r.route.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str("{\"x\":");
            write_f64(out, p[0]);
            out.push_str(",\"y\":");
            write_f64(out, p[1]);
            out.push_str(",\"z\":");
            write_f64(out, p[2]);
            out.push('}');
        }
        out.push_str("],\"vias\":[");
        for (j, v) in r.vias.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            out.push_str("{\"x\":");
            write_f64(out, v[0]);
            out.push_str(",\"y\":");
            write_f64(out, v[1]);
            out.push('}');
        }
        out.push_str("]}");
    }
    out.push(']');
}

// ---------------------------------------------------------------------------
// Tests — pure Rust, no bun. The first test is the integration keystone: the
// runtime's RPLYDS01 encoder is accepted by the real replay-core crate and
// both selection paths (dependency + vendored) agree.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn merged(
        solved: bool,
        iterations: f64,
        max_iterations: f64,
        solved_segments: f64,
        traj_offset: usize,
        traj_len: usize,
    ) -> MergedCand {
        MergedCand {
            solved,
            iterations,
            max_iterations,
            solved_segments,
            traj_offset,
            traj_len,
            is_ts: false,
        }
    }

    /// Mirrors replay-core harness.ts "selftest-basic": candidate 1 (the only
    /// solved one) must win, via BOTH the encoded-dataset replay-core path
    /// and the vendored simulator.
    #[test]
    fn encoded_dataset_matches_replay_core_selection() {
        let hp_raws: Vec<&str> = vec!["{}", "{\"SHUFFLE_SEED\":0}", "{\"HIGH_DENSITY_A01\":true}"];
        let hp_vals: Vec<JVal> = hp_raws
            .iter()
            .map(|r| parse_json(r.as_bytes()).unwrap())
            .collect();

        let mut payload: Vec<f32> = Vec::new();
        payload.extend_from_slice(&[0.1, 0.2, 0.3]);
        payload.extend_from_slice(&[0.4, 0.9, 1.0]);
        payload.extend((0..10).map(|i| 0.05f32 * i as f32));

        let cands = vec![
            merged(false, 300.0, 100_000.0, -1.0, 0, 3),
            merged(true, 250.0, 100_000.0, 2.0, 3, 3),
            merged(false, 1000.0, 1_000_000.0, -1.0, 6, 10),
        ];

        let ds = encode_rplyds01("selftest-basic", 2.0, 3, &cands, &hp_raws, &payload);
        let handle = replay_core::replay_load(ds.as_ptr(), ds.len());
        assert_ne!(handle, 0, "replay-core rejected the encoded dataset");
        assert_eq!(replay_core::replay_node_count(handle), 1);
        let rc_winner = replay_core::replay_run(handle, 0);
        replay_core::replay_free(handle);

        let sim_cands: Vec<SimCandidate> = cands
            .iter()
            .zip(hp_vals.iter())
            .map(|(m, hp)| {
                let (g_class, iteration_penalty, segments_per_polyline) = resolve_g_class(hp);
                SimCandidate {
                    solved: m.solved,
                    iterations: m.iterations,
                    max_iterations: m.max_iterations,
                    solved_segments: m.solved_segments,
                    g_class,
                    iteration_penalty,
                    segments_per_polyline,
                    traj_offset: m.traj_offset,
                    traj_len: m.traj_len,
                }
            })
            .collect();
        let sim = simulate(&sim_cands, 3, 2.0, &payload, None);

        assert_eq!(rc_winner, sim.winner, "dependency vs vendored divergence");
        assert_eq!(rc_winner, 1);
        // Cache-commit predicate sanity: the winner completed virtually.
        assert!(sim.v[1] >= 250.0);
    }

    #[test]
    fn run_input_spans_and_fields() {
        let src = br#"{"initialCount": 2, "externalMaxIterations": null,
                       "hps": [ {"CELL_SIZE_FACTOR": 0.5, "SHUFFLE_SEED": 3}, {} ]}"#;
        let run = parse_run_input(src).unwrap();
        assert_eq!(run.initial_count, 2);
        assert!(run.external_max_iterations.is_none());
        assert!(!run.emit_all_routes);
        assert_eq!(run.hps.len(), 2);
        assert_eq!(run.hps[1].raw, "{}");
        let hp = hp_from_entry(&run.hps[0], 0).unwrap();
        assert_eq!(hp.cell_size_factor, 0.5);
        assert_eq!(hp.shuffle_seed, 3);
        assert_eq!(hp.fut_trace_pen, 2.0);
        // Raw splice keeps the exact source text.
        assert!(run.hps[0].raw.contains("\"CELL_SIZE_FACTOR\": 0.5"));
    }

    #[test]
    fn tsrec_routes_raw_span() {
        let src = br#"[{"i": 2, "solved": true, "iterations": 40, "maxIterations": 1000,
                        "solvedSegments": 2, "traj": [0.5],
                        "routes": [{"connectionName":"a","route":[{"x":1,"y":2,"z":0}],"vias":[]}]}]"#;
        let recs = parse_tsrec(src).unwrap();
        assert_eq!(recs.len(), 1);
        assert_eq!(recs[0].index, 2);
        assert_eq!(recs[0].traj, vec![0.5f32]);
        let raw = recs[0].routes_raw.as_ref().unwrap();
        assert!(raw.starts_with('[') && raw.contains("\"connectionName\":\"a\""));
    }

    #[test]
    fn parses_golden_node_line_shape() {
        let src = br#"{
          "t": "node", "nodeId": "cmn_1", "nodeSegmentCount": 2,
          "initialCount": 70, "winnerIndex": 3,
          "node": {
            "capacityMeshNodeId": "cmn_1",
            "center": {"x": 1.5, "y": -2},
            "width": 3.2, "height": 3.2,
            "portPoints": [
              {"connectionName": "a", "portPointId": "pp0", "x": 0, "y": 0, "z": 0},
              {"connectionName": "b", "rootConnectionName": "rb", "x": 1, "y": 1, "z": 1},
              {"connectionName": "a", "rootConnectionName": "", "x": 2, "y": 0.5, "z": 0}
            ],
            "availableZ": [0, 1]
          },
          "params": {"traceWidth": 0.1, "viaDiameter": 0.3, "obstacleMargin": 0.15, "effort": 1},
          "connMap": {"idToNet": {"a": "net0", "b": "net0"}, "nets": {"net0": ["a", "b"]}}
        }"#;
        let s = parse_node_session(src).unwrap();
        assert_eq!(s.node_id, "cmn_1");
        assert_eq!(s.port_points.len(), 3);
        assert_eq!(s.port_points[0].conn, s.port_points[2].conn);
        assert_eq!(s.port_points[0].port_point_id.as_deref(), Some("pp0"));
        // "" rootConnectionName collapses to None (contract.rs deviation 2).
        assert!(s.port_points[2].root_conn.is_none());
        assert!(s.port_points[1].root_conn.is_some());
        assert_eq!(node_segment_count(&s), 2.0);
        assert_eq!(s.trace_width, 0.1);
        let a = s.conn.lookup("a").unwrap();
        let net0 = s.conn.lookup("net0").unwrap();
        assert_eq!(s.conn.get_net_connected_to_id(a), Some(net0));
        assert_eq!(s.conn.get_ids_connected_to_net(net0).len(), 2);
    }

    #[test]
    fn segment_count_cross_check_fires() {
        let src = br#"{
          "nodeSegmentCount": 5,
          "node": {"center": {"x": 0, "y": 0}, "width": 1, "height": 1,
                   "portPoints": [{"connectionName": "a", "x": 0, "y": 0, "z": 0}]}
        }"#;
        let err = parse_node_session(src).unwrap_err();
        assert!(err.contains("nodeSegmentCount mismatch"), "{}", err);
    }
}
