//! v4 cache key composer — mirrors
//! `CachedIntraNodeRouteSolver.computeCacheKeyAndTransform`
//! (lib/solvers/HighDensitySolver/CachedIntraNodeRouteSolver.ts:111-208)
//! including the exact `JSON.stringify` composition: property insertion
//! order, undefined-key omission, JS number rendering (json.rs `write_f64`:
//! shortest round-trip, -0 → "0", non-finite → "null") and JS string
//! escaping (`write_json_string`).
//!
//! Sorting-rule inventory (each mirrored at its call site below):
//!   - port points: comparator sort by (connectionName localeCompare,
//!     (portPointId ?? "") localeCompare, x, y, z) — :129-139, stable;
//!   - hyperparameter entries: key localeCompare — :154;
//!   - connectedIds: `[...new Set(ids)].sort()` — DEFAULT string sort
//!     (code-unit order), :160-164;
//!   - availableZ: `[...az].sort()` — DEFAULT sort on numbers, i.e. compare
//!     ToString(n) code-unit-wise, :177-179 (js_num::js_default_sort_numbers).
//!
//! localeCompare deviation (FLAGGED — PORT-SPEC.md §5/§6.10 sanction it):
//! the two localeCompare sites are replaced by byte order. ICU root
//! collation orders e.g. "_" before digits while byte order does not, so a
//! TS key and a Rust key for the same node can order entries differently —
//! cross-language key equality is a NON-goal ("Rust keys need only internal
//! consistency — do NOT chase TS key-string equality"). Within Rust the keys
//! are deterministic and collision-free, which is all the hit/miss pattern
//! needs. Everything else (rounding, structure, number/string rendering) is
//! composed to match TS byte-for-byte.
//!
//! Worked example (hand-derived; one connection "connectivity_net5" with
//! port points (10.6,-4.6,0),(9.8,-4.6,1) around center (10.2,-4.6), node
//! 0.8x0.8, availableZ [0,1], hp {SHUFFLE_SEED:3} — the seed-3 point shuffle
//! reverses the two points, so normalizedConnections shows z 1 before z 0
//! while the sorted portPoints list orders by raw x):
//!
//! intranode-solver:{"cacheSchemaVersion":4,"node":{"width":0.8,"height":0.8,
//! "center":{"x":10.2,"y":-4.6},"availableZ":[0,1],"portPoints":[
//! {"connectionName":"connectivity_net5","x":-0.4,"y":0,"z":1},
//! {"connectionName":"connectivity_net5","x":0.4,"y":0,"z":0}]},
//! "normalizedConnections":[{"connectionName":"connectivity_net5","points":[
//! {"connectionName":"connectivity_net5","x":-0.4,"y":0,"z":1},
//! {"connectionName":"connectivity_net5","x":0.4,"y":0,"z":0}]}],
//! "normalizedHyperParameters":{"SHUFFLE_SEED":3},
//! "minDistBetweenEnteringPoints":0,"traceWidth":0.15,"viaDiameter":0.3,
//! "obstacleMargin":0.15,"normalizedConnMap":[{"connectionName":
//! "connectivity_net5","connectedIds":["source_port_7","source_trace_2"]}]}
//!
//! (single line in reality; note "y":0 — the dirty float diff
//! -4.6 - (-4.6) rounds to 0 and renders "0", and roundCoord(9.8 - 10.2) =
//! -0.4 exactly despite fl(9.8-10.2) = -0.39999999999999858.)

use std::cmp::Ordering;

use crate::contract::{FutureConn, KeyHash, NodeSession, PortPoint};
use crate::js_num::{js_default_sort_numbers, js_round};
use crate::json::{write_f64, write_json_string, JVal};

pub const INTRA_NODE_CACHE_SCHEMA_VERSION: u32 = 4; // CachedIntraNodeRouteSolver.ts:45

/// `roundCoord` (CachedIntraNodeRouteSolver.ts:16):
/// `Math.round(n * 200) / 200` — 1/200 mm grid.
pub fn round_coord(n: f64) -> f64 {
    js_round(n * 200.0) / 200.0
}

/// One numeric comparator tier of the TS sort (`if (a !== b) return a - b`).
/// `Some(ord)` => the comparator returned there; `None` => next tier.
/// A NaN difference is coerced to +0 by ECMA SortCompare (elements compare
/// equal AND the comparator returns — no further tiers), hence
/// `Some(Equal)` for incomparable values. NaN coordinates do not occur; the
/// branch exists for exactness.
fn num_tier(a: f64, b: f64) -> Option<Ordering> {
    if a != b {
        Some(a.partial_cmp(&b).unwrap_or(Ordering::Equal))
    } else {
        None
    }
}

/// `JSON.stringify` of a marshaled JSON value: JVal cannot represent
/// `undefined`, objects keep insertion order, numbers/strings render via the
/// shared writers.
fn write_jval(out: &mut String, v: &JVal) {
    match v {
        JVal::Null => out.push_str("null"),
        JVal::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        JVal::Num(n) => write_f64(out, *n),
        JVal::Str(s) => write_json_string(out, s),
        JVal::Arr(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_jval(out, item);
            }
            out.push(']');
        }
        JVal::Obj(entries) => {
            out.push('{');
            for (i, (k, val)) in entries.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_json_string(out, k);
                out.push(':');
                write_jval(out, val);
            }
            out.push('}');
        }
    }
}

/// Compose the v4 key. `initial_unsolved_connections` is the POST-shuffle
/// snapshot captured in the Cached ctor (CachedIntraNodeRouteSolver.ts:82) —
/// SHUFFLE_SEED reaches the key both through the hp map and through this
/// connection order (PORT-SPEC.md §5).
///
/// `normalizedConnMap` is ALWAYS emitted: the session's ConnSlice is
/// non-optional (contract §3). The TS connMap-absent branch (key omits the
/// property, :157-166) is not modeled — the parallel pipeline always
/// rehydrates a connMap (portfolioReplayWorker.ts:56-61). FLAGGED.
pub fn compute_cache_key_v4(
    session: &NodeSession,
    hp_raw: &[(String, JVal)],
    initial_unsolved_connections: &[FutureConn],
    min_dist_between_entering_points: f64,
) -> KeyHash {
    let conn = &session.conn;
    let cx = session.center[0];
    let cy = session.center[1];

    let mut out = String::with_capacity(4096);
    // :201 — prefix + canonical JSON of keyData (:168-191), properties in
    // literal insertion order.
    out.push_str("intranode-solver:{\"cacheSchemaVersion\":");
    write_f64(&mut out, INTRA_NODE_CACHE_SCHEMA_VERSION as f64);

    // -- node (:170-181) --
    out.push_str(",\"node\":{\"width\":");
    write_f64(&mut out, round_coord(session.width));
    out.push_str(",\"height\":");
    write_f64(&mut out, round_coord(session.height));
    out.push_str(",\"center\":{\"x\":");
    write_f64(&mut out, round_coord(cx));
    out.push_str(",\"y\":");
    write_f64(&mut out, round_coord(cy));
    out.push('}');
    // :177-179 — truthiness on the ARRAY: present-but-empty is kept as [];
    // absent is omitted (JSON.stringify drops undefined values).
    if let Some(az) = &session.available_z {
        let mut sorted = az.clone();
        js_default_sort_numbers(&mut sorted); // default sort, NOT numeric
        out.push_str(",\"availableZ\":[");
        for (i, z) in sorted.iter().enumerate() {
            if i > 0 {
                out.push(',');
            }
            write_f64(&mut out, *z);
        }
        out.push(']');
    }

    // -- node.portPoints (:128-149) — sorted copy of the RAW port points --
    out.push_str(",\"portPoints\":[");
    let mut pps: Vec<&PortPoint> = session.port_points.iter().collect();
    pps.sort_by(|a, b| {
        // :130-132 connectionName localeCompare → byte order (flagged above)
        let an = conn.resolve(a.conn);
        let bn = conn.resolve(b.conn);
        if an != bn {
            return an.cmp(bn);
        }
        // :133-135 (portPointId ?? "") localeCompare
        let ap = a.port_point_id.as_deref().unwrap_or("");
        let bp = b.port_point_id.as_deref().unwrap_or("");
        if ap != bp {
            return ap.cmp(bp);
        }
        // :136-138 x, y, (z ?? 0) numeric ascending; stable on full tie
        if let Some(o) = num_tier(a.x, b.x) {
            return o;
        }
        if let Some(o) = num_tier(a.y, b.y) {
            return o;
        }
        num_tier(a.z, b.z).unwrap_or(Ordering::Equal)
    });
    for (i, p) in pps.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        // :140-149 — property order; Options mirror undefined-omission.
        out.push_str("{\"connectionName\":");
        write_json_string(&mut out, conn.resolve(p.conn));
        if let Some(rc) = p.root_conn {
            out.push_str(",\"rootConnectionName\":");
            write_json_string(&mut out, conn.resolve(rc));
        }
        if let Some(id) = &p.port_point_id {
            out.push_str(",\"portPointId\":");
            write_json_string(&mut out, id);
        }
        if let Some(id) = &p.prev_port_point_id {
            out.push_str(",\"prevPortPointId\":");
            write_json_string(&mut out, id);
        }
        if let Some(id) = &p.next_port_point_id {
            out.push_str(",\"nextPortPointId\":");
            write_json_string(&mut out, id);
        }
        out.push_str(",\"x\":");
        write_f64(&mut out, round_coord(p.x - cx));
        out.push_str(",\"y\":");
        write_f64(&mut out, round_coord(p.y - cy));
        out.push_str(",\"z\":");
        write_f64(&mut out, p.z);
        out.push('}');
    }
    out.push_str("]}");

    // -- normalizedConnections (:116-127) — post-shuffle order --
    out.push_str(",\"normalizedConnections\":[");
    for (i, c) in initial_unsolved_connections.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"connectionName\":");
        write_json_string(&mut out, conn.resolve(c.conn));
        if let Some(rc) = c.root_conn {
            out.push_str(",\"rootConnectionName\":");
            write_json_string(&mut out, conn.resolve(rc));
        }
        out.push_str(",\"points\":[");
        for (j, p) in c.points.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            // :121-125 — each point repeats connectionName; z was already
            // ?? 0-resolved when the connection map was built.
            out.push_str("{\"connectionName\":");
            write_json_string(&mut out, conn.resolve(c.conn));
            out.push_str(",\"x\":");
            write_f64(&mut out, round_coord(p[0] - cx));
            out.push_str(",\"y\":");
            write_f64(&mut out, round_coord(p[1] - cy));
            out.push_str(",\"z\":");
            write_f64(&mut out, p[2]);
            out.push('}');
        }
        out.push_str("]}");
    }
    out.push(']');

    // -- normalizedHyperParameters (:151-155) --
    // Object.entries(hp).filter(v !== undefined).sort(localeCompare) →
    // Object.fromEntries; JVal cannot hold undefined (JSON-marshaled), so
    // the filter is a no-op; null survives it and renders as null.
    out.push_str(",\"normalizedHyperParameters\":{");
    let mut entries: Vec<&(String, JVal)> = hp_raw.iter().collect();
    entries.sort_by(|a, b| a.0.cmp(&b.0)); // localeCompare → byte order (flagged)
    for (i, (k, v)) in entries.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        write_json_string(&mut out, k);
        out.push(':');
        write_jval(&mut out, v);
    }
    out.push('}');

    // -- scalars (:184-189), all roundCoord'd --
    out.push_str(",\"minDistBetweenEnteringPoints\":");
    write_f64(&mut out, round_coord(min_dist_between_entering_points));
    out.push_str(",\"traceWidth\":");
    write_f64(&mut out, round_coord(session.trace_width));
    out.push_str(",\"viaDiameter\":");
    write_f64(&mut out, round_coord(session.via_diameter));
    out.push_str(",\"obstacleMargin\":");
    write_f64(&mut out, round_coord(session.obstacle_margin));

    // -- normalizedConnMap (:157-166) — initial (post-shuffle) order --
    out.push_str(",\"normalizedConnMap\":[");
    for (i, c) in initial_unsolved_connections.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        out.push_str("{\"connectionName\":");
        write_json_string(&mut out, conn.resolve(c.conn));
        out.push_str(",\"connectedIds\":[");
        // getIdsConnectedToNet(connectionName) — a CONNECTION name used as a
        // net id (PORT-SPEC.md §3); `?? []` at :162 is redundant with the
        // `|| []` inside the method. [...new Set(ids)].sort() == sorted
        // unique; default string sort == byte order on these ASCII ids.
        let ids = conn.get_ids_connected_to_net(c.conn);
        let mut names: Vec<&str> = ids.iter().map(|&id| conn.resolve(id)).collect();
        names.sort_unstable();
        names.dedup();
        for (j, n) in names.iter().enumerate() {
            if j > 0 {
                out.push(',');
            }
            write_json_string(&mut out, n);
        }
        out.push_str("]}");
    }
    out.push_str("]}");

    out
}
