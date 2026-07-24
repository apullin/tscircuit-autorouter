// hdastar — Rust port of HighDensitySolverA01 (tscircuit/high-density-a01)
// Faithful, bit-identical reimplementation of the TS solver's arithmetic and
// control flow. No transcendentals in cost math; js_round shims Math.round.

mod json;

use json::{parse_json, write_f64, write_json_string, write_jval, JVal};
use std::collections::HashMap;

// ---------- JSON I/O ----------

fn pp_str<'a>(v: &'a JVal, key: &str) -> Option<&'a str> {
    v.get(key).and_then(|x| x.as_str())
}
fn pp_f64(v: &JVal, key: &str) -> f64 {
    v.get(key).and_then(|x| x.as_f64()).unwrap_or(0.0)
}
fn pp_i32(v: &JVal, key: &str) -> i32 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0) as i32
}
fn pp_usize(v: &JVal, key: &str) -> Option<usize> {
    v.get(key).and_then(|x| x.as_i64()).map(|n| n as usize)
}
fn pp_opt_usize(v: &JVal, key: &str) -> Option<usize> {
    match v.get(key) {
        Some(JVal::Num(n)) => Some(*n as usize),
        _ => None,
    }
}

#[derive(Clone, Copy)]
struct HyperParams {
    shuffle_seed: i64,
    rip_cost: f64,
    rip_trace_penalty: f64,
    rip_via_penalty: f64,
    via_base_cost: f64,
    greedy_multiplier: f64,
}

#[derive(Clone, Copy)]
struct Pt {
    x: f64,
    y: f64,
}

struct Input {
    rows: usize,
    cols: usize,
    available_z: Vec<i32>,
    cell_size_mm: f64,
    via_diameter: f64,
    trace_thickness: f64,
    trace_margin: f64,
    via_min_dist_from_border: f64,
    effort: f64,
    max_cell_count: Option<usize>,
    step_multiplier: usize,
    hyper: HyperParams,
    grid_origin: Pt,
    width: f64,
    height: f64,
    region_id: Option<String>,
    port_points: Vec<JVal>,
    max_iterations: usize,
}

fn req_f64(v: &JVal, key: &str) -> Result<f64, String> {
    v.get(key)
        .and_then(|x| x.as_f64())
        .ok_or_else(|| format!("missing numeric field '{}'", key))
}

fn req_usize(v: &JVal, key: &str) -> Result<usize, String> {
    v.get(key)
        .and_then(|x| x.as_i64())
        .map(|n| n as usize)
        .ok_or_else(|| format!("missing integer field '{}'", key))
}

impl Input {
    fn from_jval(v: &JVal) -> Result<Input, String> {
        let hp = v
            .get("hyperParameters")
            .ok_or("missing hyperParameters")?;
        let go = v.get("gridOrigin").ok_or("missing gridOrigin")?;
        let available_z: Vec<i32> = v
            .get("availableZ")
            .and_then(|x| x.as_arr())
            .ok_or("missing availableZ")?
            .iter()
            .map(|z| z.as_i64().unwrap_or(0) as i32)
            .collect();
        let port_points = v
            .get("portPoints")
            .and_then(|x| x.as_arr())
            .ok_or("missing portPoints")?
            .clone();
        Ok(Input {
            rows: req_usize(v, "rows")?,
            cols: req_usize(v, "cols")?,
            available_z,
            cell_size_mm: req_f64(v, "cellSizeMm")?,
            via_diameter: req_f64(v, "viaDiameter")?,
            trace_thickness: req_f64(v, "traceThickness")?,
            trace_margin: req_f64(v, "traceMargin")?,
            via_min_dist_from_border: req_f64(v, "viaMinDistFromBorder")?,
            effort: req_f64(v, "effort")?,
            max_cell_count: pp_opt_usize(v, "maxCellCount"),
            step_multiplier: pp_usize(v, "stepMultiplier").unwrap_or(1),
            hyper: HyperParams {
                shuffle_seed: hp
                    .get("shuffleSeed")
                    .and_then(|x| x.as_i64())
                    .unwrap_or(0),
                rip_cost: req_f64(hp, "ripCost")?,
                rip_trace_penalty: req_f64(hp, "ripTracePenalty")?,
                rip_via_penalty: req_f64(hp, "ripViaPenalty")?,
                via_base_cost: req_f64(hp, "viaBaseCost")?,
                greedy_multiplier: req_f64(hp, "greedyMultiplier")?,
            },
            grid_origin: Pt {
                x: req_f64(go, "x")?,
                y: req_f64(go, "y")?,
            },
            width: req_f64(v, "width")?,
            height: req_f64(v, "height")?,
            region_id: v.get("regionId").and_then(|x| {
                if x.is_null() {
                    None
                } else {
                    x.as_str().map(|s| s.to_string())
                }
            }),
            port_points,
            max_iterations: req_usize(v, "maxIterations")?,
        })
    }
}

struct Output {
    solved: bool,
    failed: bool,
    error: Option<String>,
    iterations: usize,
    routes_json: String, // pre-serialized routes array (matches TS getOutput JSON)
}

// ---------- Solver ----------

#[inline(always)]
fn js_round(x: f64) -> f64 {
    (x + 0.5).floor()
}

/// Math.max(lo, Math.min(hi, v)) — unlike i32::clamp, inverted bounds return lo.
#[inline(always)]
fn js_clamp_i32(v: i32, lo: i32, hi: i32) -> i32 {
    v.min(hi).max(lo)
}

const DIRS_DR: [i32; 8] = [-1, -1, -1, 0, 0, 1, 1, 1];
const DIRS_DC: [i32; 8] = [-1, 0, 1, -1, 1, -1, 0, 1];
const SQRT2: f64 = std::f64::consts::SQRT_2;

#[derive(Clone)]
struct ConnectionSeg {
    conn_id: i32,
    start_z: usize,
    start_row: i32,
    start_col: i32,
    start_point: JVal,
    end_z: usize,
    end_row: i32,
    end_col: i32,
    end_point: JVal,
}

#[derive(Clone)]
struct SolvedRouteInternal {
    conn_id: i32,
    start_z: usize,
    start_row: i32,
    start_col: i32,
    start_point: JVal,
    end_z: usize,
    end_row: i32,
    end_col: i32,
    end_point: JVal,
    cells: Vec<(usize, i32, i32)>, // (z, row, col)
    via_cells: Vec<(i32, i32)>,
}

#[derive(Clone, Copy, PartialEq)]
struct HeapEntry {
    f: f64,
    seq: u64,
    id: u32,
}

impl Eq for HeapEntry {}

impl PartialOrd for HeapEntry {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}

impl Ord for HeapEntry {
    // min-heap via reversed comparison: smaller f first, ties by smaller seq
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        other
            .f
            .partial_cmp(&self.f)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| other.seq.cmp(&self.seq))
    }
}

struct MinHeap {
    inner: std::collections::BinaryHeap<HeapEntry>,
}

impl MinHeap {
    fn new() -> Self {
        MinHeap {
            inner: std::collections::BinaryHeap::with_capacity(4096),
        }
    }
    #[inline(always)]
    fn push(&mut self, f: f64, seq: u64, id: usize) {
        self.inner.push(HeapEntry { f, seq, id: id as u32 });
    }
    #[inline(always)]
    fn pop(&mut self) -> usize {
        self.inner.pop().unwrap().id as usize
    }
    #[inline(always)]
    fn size(&self) -> usize {
        self.inner.len()
    }
    fn clear(&mut self) {
        self.inner.clear();
    }
}

// Ripped chain: index into rip_nodes, -1 = null
struct Solver {
    // dims
    rows: usize,
    cols: usize,
    layers: usize,
    plane_size: usize,
    available_z: Vec<i32>,
    z_to_layer: HashMap<i32, usize>,
    cell_size_mm: f64,
    via_diameter: f64,
    trace_thickness: f64,
    trace_margin: f64,
    via_min_dist_from_border: f64,
    effort: f64,
    hyper: HyperParams,
    grid_origin: Pt,
    region_id: Option<String>,
    max_iterations: usize,
    base_search_budget_iters: usize,

    // connections
    conn_id_to_name: Vec<String>,
    conn_id_to_root_net: Vec<String>,
    conn_id_to_root_net_id: Vec<u32>,
    root_net_name_to_id: HashMap<String, u32>,
    conn_name_to_id: HashMap<String, i32>,
    overlap_friendly_root_net_ids: Vec<bool>,

    // flat state
    used_cells_flat: Vec<i32>,
    port_owner_flat: Vec<i32>,
    used_diag_flat: Vec<i32>,
    penalty2d: Vec<f64>,
    visited_stamp: Vec<u32>,
    stamp: u32,
    shared_cross_root_port_cells: Vec<i64>, // Set<usize> via sorted vec + binary search; small

    via_offsets_dr: Vec<i32>,
    via_offsets_dc: Vec<i32>,
    min_via_row: i32,
    max_via_row: i32,
    min_via_col: i32,
    max_via_col: i32,

    used_indices_by_conn: Vec<Vec<i32>>,
    used_diag_indices_by_conn: Vec<Vec<i32>>,

    unsolved_segs: Vec<ConnectionSeg>, // used as a queue via index
    unsolved_head: usize,
    // solvedRoutes: connId -> routes, plus insertion order tracking
    solved_routes: HashMap<i32, Vec<SolvedRouteInternal>>,
    solved_insertion_order: Vec<i32>,

    // A* state
    active_conn_seg: Option<ConnectionSeg>,
    active_conn_id: i32,
    cross_layer_search: bool,
    node_z: Vec<i32>,
    node_row: Vec<i32>,
    node_col: Vec<i32>,
    node_g: Vec<f64>,
    node_f: Vec<f64>,
    node_parent: Vec<i32>,
    node_ripped: Vec<i32>, // head index into rip_nodes, -1 = null
    rip_node_id: Vec<i32>,
    rip_node_prev: Vec<i32>,
    heap: MinHeap,
    seq_counter: u64,

    via_occs: Vec<i32>,
    occupancy_version: u64,
    via_occ_cache_version: i64,
    via_occ_cache_row: i32,
    via_occ_cache_col: i32,
    via_occ_cache_conn: i32,

    rip_count: Vec<usize>,
    total_rip_events: usize,
    search_iterations: usize,
    consecutive_skips: usize,
    penalty_cap: f64,
    max_rips: usize,

    move_cost: f64,
    move_ripped: i32,

    iterations: usize,
    solved: bool,
    failed: bool,
    error: Option<String>,
}

impl Solver {
    #[inline]
    fn root_net(&self, conn: i32) -> &str {
        if conn < 0 {
            return "";
        }
        &self.conn_id_to_root_net[conn as usize]
    }

    #[inline]
    fn root_net_id(&self, conn: i32) -> u32 {
        if conn < 0 {
            return u32::MAX;
        }
        self.conn_id_to_root_net_id[conn as usize]
    }

    #[inline]
    fn overlap_friendly_id(&self, root_id: u32) -> bool {
        root_id != u32::MAX && self.overlap_friendly_root_net_ids[root_id as usize]
    }

    fn intern_root_net(&mut self, name: &str) -> u32 {
        if let Some(&id) = self.root_net_name_to_id.get(name) {
            return id;
        }
        let id = self.root_net_name_to_id.len() as u32;
        self.root_net_name_to_id.insert(name.to_string(), id);
        self.overlap_friendly_root_net_ids.push(false);
        id
    }

    fn shared_cross_root_has(&self, flat: i64) -> bool {
        self.shared_cross_root_port_cells.binary_search(&flat).is_ok()
    }

    fn intern_conn(&mut self, name: &str, root_net_name: Option<&str>) -> i32 {
        if let Some(&id) = self.conn_name_to_id.get(name) {
            return id;
        }
        let id = self.conn_id_to_name.len() as i32;
        self.conn_id_to_name.push(name.to_string());
        let root = match root_net_name {
            Some(r) => r.to_string(),
            None => to_root_net_name(name, None),
        };
        let root_id = self.intern_root_net(&root);
        self.conn_id_to_root_net.push(root);
        self.conn_id_to_root_net_id.push(root_id);
        self.conn_name_to_id.insert(name.to_string(), id);
        id
    }

    fn point_to_cell(&self, x: f64, y: f64, z: i32) -> (usize, i32, i32) {
        let col = js_round((x - self.grid_origin.x) / self.cell_size_mm - 0.5)
            .max(0.0)
            .min((self.cols - 1) as f64) as i32;
        let row = js_round((y - self.grid_origin.y) / self.cell_size_mm - 0.5)
            .max(0.0)
            .min((self.rows - 1) as f64) as i32;
        let zz = *self.z_to_layer.get(&z).unwrap_or(&0);
        (zz, row, col)
    }

    fn next_stamp(&mut self) {
        self.stamp = self.stamp.wrapping_add(1);
        if self.stamp == 0 {
            self.visited_stamp.fill(0);
            self.stamp = 1;
        }
    }

    fn compute_h(&self, z: usize, row: i32, col: i32, to_z: usize, to_row: i32, to_col: i32) -> f64 {
        let dr = (row - to_row).abs();
        let dc = (col - to_col).abs();
        let manhattan = dr + dc;
        if z == to_z {
            return manhattan as f64 * self.cell_size_mm;
        }
        if !self.cross_layer_search {
            return manhattan as f64 * self.cell_size_mm + self.hyper.via_base_cost;
        }
        // JS Math.max(min, Math.min(max, v)) semantics: inverted bounds
        // (min > max on small nodes) yield `min`, not a panic
        let vr1 = js_clamp_i32(row, self.min_via_row, self.max_via_row);
        let vc1 = js_clamp_i32(col, self.min_via_col, self.max_via_col);
        let vr2 = js_clamp_i32(to_row, self.min_via_row, self.max_via_row);
        let vc2 = js_clamp_i32(to_col, self.min_via_col, self.max_via_col);
        let via1 = (row - vr1).abs() + (col - vc1).abs() + (vr1 - to_row).abs() + (vc1 - to_col).abs();
        let via2 = (row - vr2).abs() + (col - vc2).abs() + (vr2 - to_row).abs() + (vc2 - to_col).abs();
        via1.min(via2).max(manhattan) as f64 * self.cell_size_mm + self.hyper.via_base_cost
    }

    fn ripped_contains(&self, mut r: i32, id: i32) -> bool {
        while r >= 0 {
            if self.rip_node_id[r as usize] == id {
                return true;
            }
            r = self.rip_node_prev[r as usize];
        }
        false
    }

    fn rip_push(&mut self, prev: i32, id: i32) -> i32 {
        let idx = self.rip_node_id.len() as i32;
        self.rip_node_id.push(id);
        self.rip_node_prev.push(prev);
        idx
    }

    fn fill_via_occupants(&mut self, row: i32, col: i32, active_conn: i32) {
        if self.via_occ_cache_version == self.occupancy_version as i64
            && self.via_occ_cache_row == row
            && self.via_occ_cache_col == col
            && self.via_occ_cache_conn == active_conn
        {
            return;
        }
        self.via_occ_cache_version = self.occupancy_version as i64;
        self.via_occ_cache_row = row;
        self.via_occ_cache_col = col;
        self.via_occ_cache_conn = active_conn;

        self.via_occs.clear();
        let rows = self.rows as i32;
        let cols = self.cols as i32;
        let active_root_id = self.root_net_id(active_conn);
        let active_overlap = self.overlap_friendly_id(active_root_id);
        for z in 0..self.layers {
            let z_base = z * self.plane_size;
            for i in 0..self.via_offsets_dr.len() {
                let r = row + self.via_offsets_dr[i];
                let c = col + self.via_offsets_dc[i];
                if r < 0 || c < 0 || r >= rows || c >= cols {
                    continue;
                }
                let occ = self.used_cells_flat[z_base + (r * cols + c) as usize];
                if occ == -1 || occ == active_conn {
                    continue;
                }
                if active_overlap && self.root_net_id(occ) == active_root_id {
                    continue;
                }
                if !self.via_occs.contains(&occ) {
                    self.via_occs.push(occ);
                }
            }
        }
    }

    fn should_skip_fixed_port_halo(&self, flat_idx: usize, conn_id: i32) -> bool {
        let fixed_owner = self.port_owner_flat[flat_idx];
        if fixed_owner == conn_id {
            return false;
        }
        if fixed_owner == -2 {
            return true;
        }
        if fixed_owner < 0 {
            return false;
        }
        let same_root = self.root_net_id(fixed_owner) == self.root_net_id(conn_id);
        !(same_root && self.overlap_friendly_id(self.root_net_id(conn_id)))
    }

    fn compute_move_cost_and_rips(
        &mut self,
        active_conn: i32,
        from_z: usize,
        from_row: i32,
        from_col: i32,
        to_z: usize,
        to_row: i32,
        to_col: i32,
        ripped: i32,
    ) {
        let mut cost = 0.0f64;
        let mut r = ripped;
        let cols = self.cols;
        let hyper = self.hyper;
        let penalty_cap = self.penalty_cap;
        let active_root_id = self.root_net_id(active_conn);
        let active_overlap = self.overlap_friendly_id(active_root_id);

        if from_z != to_z {
            // via transition
            cost += hyper.via_base_cost;
            cost += self.penalty2d[(to_row * cols as i32 + to_col) as usize].min(penalty_cap);

            let to_flat_idx = (to_z * self.rows + to_row as usize) * cols + to_col as usize;
            let fixed_owner = self.port_owner_flat[to_flat_idx];
            let fixed_same_root = self.root_net_id(fixed_owner) == active_root_id;
            let allow_fixed_overlap = fixed_same_root && active_overlap;
            let is_seg_end = match &self.active_conn_seg {
                Some(seg) => to_z == seg.end_z && to_row == seg.end_row && to_col == seg.end_col,
                None => false,
            };
            if fixed_owner >= 0 && fixed_owner != active_conn && !allow_fixed_overlap && !is_seg_end {
                self.move_cost = -1.0;
                self.move_ripped = r;
                return;
            }

            self.fill_via_occupants(to_row, to_col, active_conn);
            let rip_cost = hyper.rip_cost;
            let rip_via_penalty = hyper.rip_via_penalty;
            for i in 0..self.via_occs.len() {
                let occ = self.via_occs[i];
                if !self.ripped_contains(r, occ) {
                    cost += rip_cost;
                    r = self.rip_push(r, occ);
                }
                cost += rip_via_penalty;
            }
        } else {
            // lateral movement
            let dr = (from_row - to_row).abs();
            let dc = (from_col - to_col).abs();
            cost += (if dr + dc > 1 { SQRT2 } else { 1.0 }) * self.cell_size_mm;
            cost += self.penalty2d[(to_row * cols as i32 + to_col) as usize].min(penalty_cap);

            let flat_idx = (to_z * self.rows + to_row as usize) * cols + to_col as usize;
            let fixed_owner = self.port_owner_flat[flat_idx];
            let fixed_same_root = self.root_net_id(fixed_owner) == active_root_id;
            let allow_fixed_overlap = fixed_same_root && active_overlap;
            let is_seg_end = match &self.active_conn_seg {
                Some(seg) => to_z == seg.end_z && to_row == seg.end_row && to_col == seg.end_col,
                None => false,
            };
            if fixed_owner >= 0 && fixed_owner != active_conn && !allow_fixed_overlap && !is_seg_end {
                self.move_cost = -1.0;
                self.move_ripped = r;
                return;
            }

            let occ = self.used_cells_flat[flat_idx];
            let same_root = self.root_net_id(occ) == active_root_id;
            let allow_same_root_overlap = same_root && active_overlap;
            if occ != -1 && occ != active_conn && !allow_same_root_overlap {
                if !self.ripped_contains(r, occ) {
                    cost += hyper.rip_cost;
                    r = self.rip_push(r, occ);
                }
                cost += hyper.rip_trace_penalty;
            }

            // diagonal X-crossing prevention
            if dr == 1 && dc == 1 {
                let sq_row = from_row.min(to_row);
                let sq_col = from_col.min(to_col);
                let is_backslash = (from_row < to_row && from_col < to_col)
                    || (from_row > to_row && from_col > to_col);
                let diag_slot = if is_backslash { 0 } else { 1 };
                let crossing_slot = diag_slot ^ 1;
                let sq_cols = self.cols - 1;
                let diag_base = ((to_z * (self.rows - 1) + sq_row as usize) * sq_cols
                    + sq_col as usize)
                    * 2;
                let crossing_occ = self.used_diag_flat[diag_base + crossing_slot];
                let crossing_same_root = self.root_net_id(crossing_occ) == active_root_id;
                let allow_crossing_overlap = crossing_same_root && active_overlap;
                if crossing_occ != -1 && crossing_occ != active_conn && !allow_crossing_overlap {
                    self.move_cost = -1.0;
                    self.move_ripped = r;
                    return;
                }
            }
        }

        self.move_cost = cost;
        self.move_ripped = r;
    }

    fn step_once(&mut self) {
        if self.active_conn_seg.is_none() {
            if self.unsolved_head >= self.unsolved_segs.len() {
                self.solved = true;
                return;
            }
            let next = self.unsolved_segs[self.unsolved_head].clone();
            self.unsolved_head += 1;
            self.active_conn_seg = Some(next.clone());
            self.active_conn_id = next.conn_id;
            self.cross_layer_search = next.start_z != next.end_z;

            self.node_z.clear();
            self.node_row.clear();
            self.node_col.clear();
            self.node_g.clear();
            self.node_f.clear();
            self.node_parent.clear();
            self.node_ripped.clear();
            self.heap.clear();
            self.seq_counter = 0;
            self.search_iterations = 0;
            self.next_stamp();

            let h = self.compute_h(
                next.start_z, next.start_row, next.start_col, next.end_z, next.end_row,
                next.end_col,
            );
            let f = h * self.hyper.greedy_multiplier;
            self.node_z.push(next.start_z as i32);
            self.node_row.push(next.start_row);
            self.node_col.push(next.start_col);
            self.node_g.push(0.0);
            self.node_f.push(f);
            self.node_parent.push(-1);
            self.node_ripped.push(-1);
            self.heap.push(f, self.seq_counter, 0);
            self.seq_counter += 1;
            return;
        }

        self.search_iterations += 1;
        let conn_rips = *self.rip_count.get(self.active_conn_id as usize).unwrap_or(&0);
        let budget = (self.base_search_budget_iters as f64
            * (1.0 + (conn_rips.min(10) as f64) * 0.25))
            .round() as usize;
        if self.search_iterations > budget {
            for p in self.penalty2d.iter_mut() {
                *p *= 0.9;
            }
            let seg = self.active_conn_seg.take().unwrap();
            self.unsolved_segs.push(seg);
            self.active_conn_id = -1;
            self.heap.clear();
            self.node_z.clear();
            self.node_row.clear();
            self.node_col.clear();
            self.node_g.clear();
            self.node_f.clear();
            self.node_parent.clear();
            self.node_ripped.clear();
            self.consecutive_skips += 1;
            let remaining = self.unsolved_segs.len() - self.unsolved_head;
            if self.consecutive_skips >= remaining * 3 {
                self.error = Some(format!(
                    "Convergence failure: {} connections stuck",
                    remaining
                ));
                self.failed = true;
            }
            return;
        }

        if self.heap.size() == 0 {
            self.error = Some(format!(
                "No path found for {}",
                self.conn_id_to_name[self.active_conn_id as usize]
            ));
            self.failed = true;
            return;
        }

        let node_idx = self.heap.pop();
        let z = self.node_z[node_idx] as usize;
        let row = self.node_row[node_idx];
        let col = self.node_col[node_idx];
        let g = self.node_g[node_idx];
        let ripped = self.node_ripped[node_idx];

        let cell_idx = (z * self.rows + row as usize) * self.cols + col as usize;
        if self.visited_stamp[cell_idx] == self.stamp {
            return;
        }
        self.visited_stamp[cell_idx] = self.stamp;

        let (end_zc, end_rowc, end_colc) = {
            let seg = self.active_conn_seg.as_ref().unwrap();
            (seg.end_z, seg.end_row, seg.end_col)
        };
        if z == end_zc && row == end_rowc && col == end_colc {
            self.finalize_route(node_idx);
            self.active_conn_seg = None;
            self.active_conn_id = -1;
            return;
        }

        let end_z = end_zc;
        let end_row = end_rowc;
        let end_col = end_colc;
        let active_conn = self.active_conn_id;
        let rows = self.rows as i32;
        let cols = self.cols as i32;
        let stamp = self.stamp;
        let greedy = self.hyper.greedy_multiplier;

        // lateral moves
        for d in 0..8 {
            let nr = row + DIRS_DR[d];
            let nc = col + DIRS_DC[d];
            if nr < 0 || nr >= rows || nc < 0 || nc >= cols {
                continue;
            }
            let n_idx = (z * self.rows + nr as usize) * self.cols + nc as usize;
            if self.visited_stamp[n_idx] == stamp {
                continue;
            }
            self.compute_move_cost_and_rips(active_conn, z, row, col, z, nr, nc, ripped);
            if self.move_cost < 0.0 {
                continue;
            }
            let g2 = g + self.move_cost;
            let f2 = g2 + self.compute_h(z, nr, nc, end_z, end_row, end_col) * greedy;
            let new_idx = self.node_z.len();
            self.node_z.push(z as i32);
            self.node_row.push(nr);
            self.node_col.push(nc);
            self.node_g.push(g2);
            self.node_f.push(f2);
            self.node_parent.push(node_idx as i32);
            self.node_ripped.push(self.move_ripped);
            self.heap.push(f2, self.seq_counter, new_idx);
            self.seq_counter += 1;
        }

        // via moves
        let can_via = row >= self.min_via_row
            && row <= self.max_via_row
            && col >= self.min_via_col
            && col <= self.max_via_col;
        if can_via {
            for nz in 0..self.layers {
                if nz == z {
                    continue;
                }
                let n_idx = (nz * self.rows + row as usize) * self.cols + col as usize;
                if self.visited_stamp[n_idx] == stamp {
                    continue;
                }
                self.compute_move_cost_and_rips(active_conn, z, row, col, nz, row, col, ripped);
                if self.move_cost < 0.0 {
                    continue;
                }
                let g2 = g + self.move_cost;
                let f2 = g2 + self.compute_h(nz, row, col, end_z, end_row, end_col) * greedy;
                let new_idx = self.node_z.len();
                self.node_z.push(nz as i32);
                self.node_row.push(row);
                self.node_col.push(col);
                self.node_g.push(g2);
                self.node_f.push(f2);
                self.node_parent.push(node_idx as i32);
                self.node_ripped.push(self.move_ripped);
                self.heap.push(f2, self.seq_counter, new_idx);
                self.seq_counter += 1;
            }
        }
    }

    fn finalize_route(&mut self, goal_node_idx: usize) {
        self.consecutive_skips = self.consecutive_skips.saturating_sub(1);

        let mut cells: Vec<(usize, i32, i32)> = Vec::new();
        let mut idx = goal_node_idx as i32;
        while idx >= 0 {
            cells.push((
                self.node_z[idx as usize] as usize,
                self.node_row[idx as usize],
                self.node_col[idx as usize],
            ));
            idx = self.node_parent[idx as usize];
        }
        cells.reverse();

        while cells.len() > 1 {
            let first = cells[0];
            let first_flat =
                ((first.0 * self.rows + first.1 as usize) * self.cols + first.2 as usize) as i64;
            if !self.shared_cross_root_has(first_flat) {
                break;
            }
            cells.remove(0);
        }
        while cells.len() > 1 {
            let last = cells[cells.len() - 1];
            let last_flat =
                ((last.0 * self.rows + last.1 as usize) * self.cols + last.2 as usize) as i64;
            if !self.shared_cross_root_has(last_flat) {
                break;
            }
            cells.pop();
        }

        let mut via_cells: Vec<(i32, i32)> = Vec::new();
        for i in 1..cells.len() {
            if cells[i].0 != cells[i - 1].0 {
                via_cells.push((cells[i].1, cells[i].2));
            }
        }

        let first_cell = cells[0];
        let last_cell = cells[cells.len() - 1];
        let conn_id = self.active_conn_id;

        let mut ripped_ids: Vec<i32> = Vec::new();
        let mut cur = self.node_ripped[goal_node_idx];
        while cur >= 0 {
            ripped_ids.push(self.rip_node_id[cur as usize]);
            cur = self.rip_node_prev[cur as usize];
        }

        for &id in &ripped_ids {
            self.rip_trace(id);
            if self.failed {
                return;
            }
        }

        self.occupancy_version += 1;
        let margin_cells = (self.trace_margin / self.cell_size_mm).ceil() as i32;
        let mut indices: Vec<i32> = Vec::new();
        let rows = self.rows as i32;
        let cols = self.cols as i32;

        for &cell in &cells {
            for dr in -margin_cells..=margin_cells {
                for dc in -margin_cells..=margin_cells {
                    let r = cell.1 + dr;
                    let c = cell.2 + dc;
                    if r < 0 || r >= rows || c < 0 || c >= cols {
                        continue;
                    }
                    let flat_idx = (cell.0 * self.rows + r as usize) * self.cols + c as usize;
                    if (r != cell.1 || c != cell.2)
                        && self.should_skip_fixed_port_halo(flat_idx, conn_id)
                    {
                        continue;
                    }
                    let existing = self.used_cells_flat[flat_idx];
                    let same_root = self.root_net_id(existing) == self.root_net_id(conn_id);
                    let allow = same_root && self.overlap_friendly_id(self.root_net_id(conn_id));
                    if existing != -1 && existing != conn_id && !allow {
                        continue;
                    }
                    self.used_cells_flat[flat_idx] = conn_id;
                    indices.push(flat_idx as i32);
                }
            }
        }

        // via footprint cells
        let mut displaced_by_vias: Vec<i32> = Vec::new();
        for &via in &via_cells {
            for z in 0..self.layers {
                let z_base = z * self.plane_size;
                for oi in 0..self.via_offsets_dr.len() {
                    let r = via.0 + self.via_offsets_dr[oi];
                    let c = via.1 + self.via_offsets_dc[oi];
                    if r < 0 || r >= rows || c < 0 || c >= cols {
                        continue;
                    }
                    let flat_idx = z_base + (r * cols + c) as usize;
                    if (r != via.0 || c != via.1)
                        && self.should_skip_fixed_port_halo(flat_idx, conn_id)
                    {
                        continue;
                    }
                    let existing = self.used_cells_flat[flat_idx];
                    let same_root = self.root_net_id(existing) == self.root_net_id(conn_id);
                    let allow = same_root && self.overlap_friendly_id(self.root_net_id(conn_id));
                    if existing != -1 && existing != conn_id && !allow {
                        if !displaced_by_vias.contains(&existing) {
                            displaced_by_vias.push(existing);
                        }
                    }
                    self.used_cells_flat[flat_idx] = conn_id;
                    indices.push(flat_idx as i32);
                }
            }
        }

        // diagonal occupancy
        let mut diag_indices: Vec<i32> = Vec::new();
        let sq_cols = self.cols - 1;
        for i in 1..cells.len() {
            let prev = cells[i - 1];
            let curr = cells[i];
            if prev.0 != curr.0 {
                continue;
            }
            let dr = (prev.1 - curr.1).abs();
            let dc = (prev.2 - curr.2).abs();
            if dr != 1 || dc != 1 {
                continue;
            }
            let sq_row = prev.1.min(curr.1);
            let sq_col = prev.2.min(curr.2);
            let is_backslash = (prev.1 < curr.1 && prev.2 < curr.2)
                || (prev.1 > curr.1 && prev.2 > curr.2);
            let diag_slot = if is_backslash { 0 } else { 1 };
            let crossing_slot = diag_slot ^ 1;
            let diag_base =
                ((prev.0 * (self.rows - 1) + sq_row as usize) * sq_cols + sq_col as usize) * 2;
            let crossing_idx = diag_base + crossing_slot;
            let crossing_occ = self.used_diag_flat[crossing_idx];
            let crossing_same_root = self.root_net_id(crossing_occ) == self.root_net_id(conn_id);
            let allow = crossing_same_root && self.overlap_friendly_id(self.root_net_id(conn_id));
            if crossing_occ != -1 && crossing_occ != conn_id && !allow {
                continue;
            }
            let diag_idx = diag_base + diag_slot;
            self.used_diag_flat[diag_idx] = conn_id;
            diag_indices.push(diag_idx as i32);
        }

        while self.used_indices_by_conn.len() <= conn_id as usize {
            self.used_indices_by_conn.push(Vec::new());
        }
        self.used_indices_by_conn[conn_id as usize].extend(indices);
        while self.used_diag_indices_by_conn.len() <= conn_id as usize {
            self.used_diag_indices_by_conn.push(Vec::new());
        }
        self.used_diag_indices_by_conn[conn_id as usize].extend(diag_indices);

        let (start_point, end_point) = {
            let seg = self.active_conn_seg.as_ref().unwrap();
            (seg.start_point.clone(), seg.end_point.clone())
        };
        let route = SolvedRouteInternal {
            conn_id,
            start_z: first_cell.0,
            start_row: first_cell.1,
            start_col: first_cell.2,
            start_point,
            end_z: last_cell.0,
            end_row: last_cell.1,
            end_col: last_cell.2,
            end_point,
            cells,
            via_cells,
        };
        if !self.solved_routes.contains_key(&conn_id) {
            self.solved_insertion_order.push(conn_id);
        }
        self.solved_routes.entry(conn_id).or_default().push(route);

        for &id in &displaced_by_vias {
            self.rip_trace(id);
            if self.failed {
                return;
            }
        }
        if !ripped_ids.is_empty() || !displaced_by_vias.is_empty() {
            if self.total_rip_events > 50 {
                for p in self.penalty2d.iter_mut() {
                    *p *= 0.99;
                }
            } else {
                let cap = self.penalty_cap;
                for p in self.penalty2d.iter_mut() {
                    if *p > cap {
                        *p *= 0.5;
                    }
                }
            }
        }
    }

    fn rip_trace(&mut self, conn_id: i32) {
        while self.rip_count.len() <= conn_id as usize {
            self.rip_count.push(0);
        }
        self.rip_count[conn_id as usize] += 1;
        self.total_rip_events += 1;
        if self.total_rip_events >= self.max_rips {
            self.error = Some(format!(
                "Convergence failure: exceeded MAX_RIPS {}",
                self.max_rips
            ));
            self.failed = true;
            return;
        }

        let routes = self.solved_routes.get(&conn_id).cloned().unwrap_or_default();

        if !routes.is_empty() {
            let cols = self.cols as i32;
            for route in &routes {
                for &cell in &route.cells {
                    let cell_idx = (cell.1 * cols + cell.2) as usize;
                    self.penalty2d[cell_idx] += self.hyper.rip_trace_penalty;
                }
                for &via in &route.via_cells {
                    let via_idx = (via.0 * cols + via.1) as usize;
                    self.penalty2d[via_idx] += self.hyper.rip_via_penalty;
                }
            }
        }

        if conn_id < self.used_indices_by_conn.len() as i32 {
            let indices = std::mem::take(&mut self.used_indices_by_conn[conn_id as usize]);
            if !indices.is_empty() {
                self.occupancy_version += 1;
                for flat_idx in indices {
                    if self.used_cells_flat[flat_idx as usize] == conn_id {
                        self.used_cells_flat[flat_idx as usize] = -1;
                    }
                }
            }
        }

        if conn_id < self.used_diag_indices_by_conn.len() as i32 {
            let diag_indices = std::mem::take(&mut self.used_diag_indices_by_conn[conn_id as usize]);
            for flat_idx in diag_indices {
                if self.used_diag_flat[flat_idx as usize] == conn_id {
                    self.used_diag_flat[flat_idx as usize] = -1;
                }
            }
        }

        if !routes.is_empty() {
            // delete from insertion order
            if let Some(pos) = self.solved_insertion_order.iter().position(|&c| c == conn_id) {
                self.solved_insertion_order.remove(pos);
            }
            self.solved_routes.remove(&conn_id);
            for route in routes {
                self.unsolved_segs.push(ConnectionSeg {
                    conn_id,
                    start_z: route.start_z,
                    start_row: route.start_row,
                    start_col: route.start_col,
                    start_point: route.start_point,
                    end_z: route.end_z,
                    end_row: route.end_row,
                    end_col: route.end_col,
                    end_point: route.end_point,
                });
            }
        }
    }
}

fn to_root_net_name(connection_name: &str, root: Option<&str>) -> String {
    match root {
        Some(r) => r.to_string(),
        None => {
            // strip _mstN suffix
            if let Some(pos) = connection_name.rfind("_mst") {
                let suffix = &connection_name[pos + 4..];
                if !suffix.is_empty() && suffix.chars().all(|c| c.is_ascii_digit()) {
                    return connection_name[..pos].to_string();
                }
            }
            connection_name.to_string()
        }
    }
}

fn build_pairs(port_points: &[JVal]) -> Vec<(usize, usize)> {
    // mirror getConnectionPortPointPairs
    let by_id: HashMap<&str, usize> = port_points
        .iter()
        .enumerate()
        .filter_map(|(i, p)| pp_str(p, "portPointId").map(|id| (id, i)))
        .collect();
    let mut seen: Vec<String> = Vec::new();
    let mut pairs: Vec<(usize, usize)> = Vec::new();

    let pair_key = |a: usize, b: usize| -> String {
        let pa = &port_points[a];
        let pb = &port_points[b];
        let ka = pp_str(pa, "portPointId").map(|s| s.to_string()).unwrap_or_else(|| {
            format!(
                "{}:{}:{}:{}",
                pp_str(pa, "connectionName").unwrap_or(""),
                pp_f64(pa, "x"),
                pp_f64(pa, "y"),
                pp_i32(pa, "z")
            )
        });
        let kb = pp_str(pb, "portPointId").map(|s| s.to_string()).unwrap_or_else(|| {
            format!(
                "{}:{}:{}:{}",
                pp_str(pb, "connectionName").unwrap_or(""),
                pp_f64(pb, "x"),
                pp_f64(pb, "y"),
                pp_i32(pb, "z")
            )
        });
        if ka < kb {
            format!("{}|{}", ka, kb)
        } else {
            format!("{}|{}", kb, ka)
        }
    };

    let mut append_unique = |a: usize, b: usize, seen: &mut Vec<String>, pairs: &mut Vec<(usize, usize)>| {
        if a == b {
            return;
        }
        let key = pair_key(a, b);
        if seen.contains(&key) {
            return;
        }
        seen.push(key);
        pairs.push((a, b));
    };

    for (i, pp) in port_points.iter().enumerate() {
        if let Some(prev_id) = pp_str(pp, "prevPortPointId") {
            if let Some(&prev) = by_id.get(prev_id) {
                if pp_str(&port_points[prev], "connectionName") == pp_str(pp, "connectionName") {
                    append_unique(prev, i, &mut seen, &mut pairs);
                }
            }
        }
        if let Some(next_id) = pp_str(pp, "nextPortPointId") {
            if let Some(&next) = by_id.get(next_id) {
                if pp_str(&port_points[next], "connectionName") == pp_str(pp, "connectionName") {
                    append_unique(i, next, &mut seen, &mut pairs);
                }
            }
        }
    }

    if pairs.is_empty() {
        for i in 0..port_points.len().saturating_sub(1) {
            append_unique(i, i + 1, &mut seen, &mut pairs);
        }
        return pairs;
    }

    // linked ids
    let mut linked: Vec<&str> = Vec::new();
    for &(a, b) in &pairs {
        if let Some(id) = pp_str(&port_points[a], "portPointId") {
            if !linked.contains(&id) {
                linked.push(id);
            }
        }
        if let Some(id) = pp_str(&port_points[b], "portPointId") {
            if !linked.contains(&id) {
                linked.push(id);
            }
        }
    }
    let unlinked: Vec<usize> = port_points
        .iter()
        .enumerate()
        .filter_map(|(i, p)| match pp_str(p, "portPointId") {
            None => Some(i),
            Some(id) if !linked.contains(&id) => Some(i),
            _ => None,
        })
        .collect();
    for w in 0..unlinked.len().saturating_sub(1) {
        append_unique(unlinked[w], unlinked[w + 1], &mut seen, &mut pairs);
    }

    pairs
}

fn clampf(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

fn new_solver(input: &Input) -> Solver {
    let rows = input.rows;
    let cols = input.cols;
    let layers = input.available_z.len();
    let plane_size = rows * cols;
    let total_cells = layers * plane_size;
    let exceeds = matches!(input.max_cell_count, Some(m) if total_cells > m);

    let mut s = Solver {
        rows,
        cols,
        layers,
        plane_size,
        available_z: input.available_z.clone(),
        z_to_layer: input
            .available_z
            .iter()
            .enumerate()
            .map(|(i, &z)| (z, i))
            .collect(),
        cell_size_mm: input.cell_size_mm,
        via_diameter: input.via_diameter,
        trace_thickness: input.trace_thickness,
        trace_margin: input.trace_margin,
        via_min_dist_from_border: input.via_min_dist_from_border,
        effort: input.effort,
        hyper: input.hyper,
        grid_origin: input.grid_origin,
        region_id: input.region_id.clone(),
        max_iterations: input.max_iterations,
        base_search_budget_iters: 0,
        conn_id_to_name: Vec::new(),
        conn_id_to_root_net: Vec::new(),
        conn_id_to_root_net_id: Vec::new(),
        root_net_name_to_id: HashMap::new(),
        conn_name_to_id: HashMap::new(),
        overlap_friendly_root_net_ids: Vec::new(),
        used_cells_flat: vec![-1; total_cells],
        port_owner_flat: vec![-1; total_cells],
        used_diag_flat: vec![
            -1;
            layers
                * rows.saturating_sub(1)
                * cols.saturating_sub(1)
                * 2
        ],
        penalty2d: vec![0.0; plane_size],
        visited_stamp: vec![0; total_cells],
        stamp: 0,
        shared_cross_root_port_cells: Vec::new(),
        via_offsets_dr: Vec::new(),
        via_offsets_dc: Vec::new(),
        min_via_row: 0,
        max_via_row: 0,
        min_via_col: 0,
        max_via_col: 0,
        used_indices_by_conn: Vec::new(),
        used_diag_indices_by_conn: Vec::new(),
        unsolved_segs: Vec::new(),
        unsolved_head: 0,
        solved_routes: HashMap::new(),
        solved_insertion_order: Vec::new(),
        active_conn_seg: None,
        active_conn_id: -1,
        cross_layer_search: false,
        node_z: Vec::with_capacity(4096),
        node_row: Vec::with_capacity(4096),
        node_col: Vec::with_capacity(4096),
        node_g: Vec::with_capacity(4096),
        node_f: Vec::with_capacity(4096),
        node_parent: Vec::with_capacity(4096),
        node_ripped: Vec::with_capacity(4096),
        rip_node_id: Vec::new(),
        rip_node_prev: Vec::new(),
        heap: MinHeap::new(),
        seq_counter: 0,
        via_occs: Vec::new(),
        occupancy_version: 0,
        via_occ_cache_version: -1,
        via_occ_cache_row: -1,
        via_occ_cache_col: -1,
        via_occ_cache_conn: -1,
        rip_count: Vec::new(),
        total_rip_events: 0,
        search_iterations: 0,
        consecutive_skips: 0,
        penalty_cap: input.hyper.rip_cost * 0.5,
        max_rips: 200,
        move_cost: 0.0,
        move_ripped: -1,
        iterations: 0,
        solved: false,
        failed: false,
        error: None,
    };

    // via offsets
    let via_radius_cells = (input.via_diameter / 2.0 / input.cell_size_mm).ceil() as i32;
    let r2 = via_radius_cells * via_radius_cells;
    for dr in -via_radius_cells..=via_radius_cells {
        for dc in -via_radius_cells..=via_radius_cells {
            if dr * dr + dc * dc <= r2 {
                s.via_offsets_dr.push(dr);
                s.via_offsets_dc.push(dc);
            }
        }
    }

    // via zone
    if input.via_min_dist_from_border > 0.0 {
        let border_cells = (input.via_min_dist_from_border / input.cell_size_mm).ceil() as i32;
        s.min_via_row = border_cells;
        s.max_via_row = rows as i32 - 1 - border_cells;
        s.min_via_col = border_cells;
        s.max_via_col = cols as i32 - 1 - border_cells;
    } else {
        s.min_via_row = 0;
        s.max_via_row = rows as i32 - 1;
        s.min_via_col = 0;
        s.max_via_col = cols as i32 - 1;
    }

    // build connection segs (mirror buildConnectionSegs)
    let mut by_name: HashMap<String, (Vec<usize>, Option<String>)> = HashMap::new();
    let mut name_order: Vec<String> = Vec::new();
    for (i, pp) in input.port_points.iter().enumerate() {
        let cname = pp_str(pp, "connectionName").unwrap_or("").to_string();
        let entry = by_name.entry(cname.clone()).or_insert_with(|| {
            name_order.push(cname.clone());
            (Vec::new(), pp_str(pp, "rootConnectionName").map(|s| s.to_string()))
        });
        entry.0.push(i);
    }

    let mut segs: Vec<ConnectionSeg> = Vec::new();
    let mut seen_seg_keys: Vec<String> = Vec::new();
    let mut shared_cross: Vec<i64> = Vec::new();

    for name in &name_order {
        let (idxs, root_name) = by_name.get(name).unwrap();
        let pts: Vec<JVal> =
            idxs.iter().map(|&i| input.port_points[i].clone()).collect();
        let pairs = build_pairs(&pts);
        if pairs.is_empty() {
            continue;
        }
        let conn_id = s.intern_conn(name, root_name.as_deref());
        for (ai, bi) in pairs {
            let a = &pts[ai];
            let b = &pts[bi];
            let (sz, srow, scol) =
                s.point_to_cell(pp_f64(a, "x"), pp_f64(a, "y"), pp_i32(a, "z"));
            let (ez, erow, ecol) =
                s.point_to_cell(pp_f64(b, "x"), pp_f64(b, "y"), pp_i32(b, "z"));
            let endpoint_a = format!("{}:{}:{}", sz, srow, scol);
            let endpoint_b = format!("{}:{}:{}", ez, erow, ecol);
            let ordered = if endpoint_a < endpoint_b {
                format!("{}|{}", endpoint_a, endpoint_b)
            } else {
                format!("{}|{}", endpoint_b, endpoint_a)
            };
            let net_name = root_name.clone().unwrap_or_else(|| name.clone());
            let seg_key = format!("{}|{}", net_name, ordered);
            if seen_seg_keys.contains(&seg_key) {
                let rid = s.intern_root_net(&net_name);
                s.overlap_friendly_root_net_ids[rid as usize] = true;
                continue;
            }
            seen_seg_keys.push(seg_key);
            segs.push(ConnectionSeg {
                conn_id,
                start_z: sz,
                start_row: srow,
                start_col: scol,
                start_point: a.clone(),
                end_z: ez,
                end_row: erow,
                end_col: ecol,
                end_point: b.clone(),
            });
        }
    }
    s.unsolved_segs = segs;

    // shared cross-root port cells + port owner flat
    let mut root_by_port_flat: HashMap<usize, String> = HashMap::new();
    for pp in &input.port_points {
        let conn_id = match s.conn_name_to_id.get(pp_str(pp, "connectionName").unwrap_or("")) {
            Some(&id) => id,
            None => continue,
        };
        let (z, row, col) = s.point_to_cell(pp_f64(pp, "x"), pp_f64(pp, "y"), pp_i32(pp, "z"));
        let flat_idx = (z * rows + row as usize) * cols + col as usize;
        let root_net = s.conn_id_to_root_net[conn_id as usize].clone();
        match root_by_port_flat.get(&flat_idx) {
            None => {
                root_by_port_flat.insert(flat_idx, root_net);
            }
            Some(existing) => {
                if *existing != root_net {
                    shared_cross.push(flat_idx as i64);
                }
            }
        }
        let existing = s.port_owner_flat[flat_idx];
        if existing == -1 || existing == conn_id {
            s.port_owner_flat[flat_idx] = conn_id;
        } else {
            s.port_owner_flat[flat_idx] = -2;
        }
    }
    shared_cross.sort_unstable();
    s.shared_cross_root_port_cells = shared_cross;

    // shuffle (LCG identical to TS)
    {
        let arr = &mut s.unsolved_segs;
        let mut seed = input.hyper.shuffle_seed as u32;
        let mut rng = move || {
            seed = (seed.wrapping_mul(1664525)).wrapping_add(1013904223);
            (seed as f64) / (u32::MAX as f64)
        };
        for i in (1..arr.len()).rev() {
            let j = (rng() * (i as f64 + 1.0)).floor() as usize;
            arr.swap(i, j);
        }
    }

    // budget
    {
        let states = plane_size * layers;
        let connection_factor = (s.unsolved_segs.len() as f64).sqrt();
        let requested = input.max_iterations.max(1) as f64;
        let base_computed_max = clampf(
            js_round(states as f64 * (8.0 + 1.2 * connection_factor)),
            150_000.0,
            12_000_000.0,
        );
        let computed_max_iters = clampf(
            js_round(base_computed_max * input.effort),
            150_000.0,
            12_000_000.0,
        );
        let min_iteration_budget = clampf(
            js_round(requested * 0.2),
            150_000.0,
            2_000_000.0,
        );
        let max_iterations_iters = requested
            .min(min_iteration_budget.max(computed_max_iters))
            .max(1.0) as usize;
        s.max_iterations = max_iterations_iters;
        s.base_search_budget_iters = clampf(
            js_round(states as f64 * (10.0 + 0.8 * connection_factor) * input.effort),
            50_000.0,
            4_000_000.0,
        ) as usize;
    }

    if exceeds {
        s.failed = true;
        s.error = Some(format!(
            "Cell count {} exceeds maxCellCount {}",
            total_cells,
            input.max_cell_count.unwrap()
        ));
    }
    s
}

fn solve(input: &Input) -> Output {
    let mut s = new_solver(input);
    // main loop: _step does stepMultiplier stepOnces per step()
    let step_mult = input.step_multiplier.max(1);
    while !s.solved && !s.failed {
        if s.iterations >= s.max_iterations {
            s.failed = true;
            s.error = Some("MAX_ITERATIONS exceeded".to_string());
            break;
        }
        s.iterations += 1;
        for _ in 0..step_mult {
            if s.solved || s.failed {
                break;
            }
            s.step_once();
        }
    }

    // output transform
    let cols = input.cols;
    let rows = input.rows;
    let (a, c) = if cols > 1 {
        let a = input.width / ((cols - 1) as f64 * input.cell_size_mm);
        let c = input.grid_origin.x * (1.0 - a) - 0.5 * input.cell_size_mm * a;
        (a, c)
    } else {
        (1.0, input.grid_origin.x + input.width / 2.0 - (input.grid_origin.x + 0.5 * input.cell_size_mm))
    };
    let (e, f) = if rows > 1 {
        let e = input.height / ((rows - 1) as f64 * input.cell_size_mm);
        let f = input.grid_origin.y * (1.0 - e) - 0.5 * input.cell_size_mm * e;
        (e, f)
    } else {
        (1.0, input.grid_origin.y + input.height / 2.0 - (input.grid_origin.y + 0.5 * input.cell_size_mm))
    };

    let layer_to_z: HashMap<usize, i32> = input
        .available_z
        .iter()
        .enumerate()
        .map(|(i, &z)| (i, z))
        .collect();
    let routes_json = build_routes_json(&mut s, a, c, e, f, &layer_to_z);




    Output {
        solved: s.solved,
        failed: s.failed,
        error: s.error,
        iterations: s.iterations,
        routes_json,
    }
}

// ---------- FFI ----------

/// Solve an A01 intra-node routing problem.
/// input: JSON buffer (see Input). output: caller buffer for JSON Output.
/// Returns bytes written, or -1 if output too small, -2 on input error.
#[no_mangle]
pub extern "C" fn a01_solve(
    input_ptr: *const u8,
    input_len: usize,
    output_ptr: *mut u8,
    output_cap: usize,
) -> i64 {
    let input_bytes = unsafe { std::slice::from_raw_parts(input_ptr, input_len) };
    let root = match parse_json(input_bytes) {
        Ok(v) => v,
        Err(e) => {
            let msg = format!(
                "{{\"solved\":false,\"failed\":true,\"error\":\"input parse: {}\"}}",
                e
            );
            let bytes = msg.as_bytes();
            if bytes.len() > output_cap {
                return -1;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), output_ptr, bytes.len());
            }
            return bytes.len() as i64;
        }
    };
    let t_parse = std::time::Instant::now();
    let input = match Input::from_jval(&root) {
        Ok(v) => v,
        Err(e) => {
            let msg = format!(
                "{{\"solved\":false,\"failed\":true,\"error\":\"input fields: {}\"}}",
                e
            );
            let bytes = msg.as_bytes();
            if bytes.len() > output_cap {
                return -1;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), output_ptr, bytes.len());
            }
            return bytes.len() as i64;
        }
    };

    let t_fields = t_parse.elapsed().as_secs_f64() * 1000.0;
    let t_solve_start = std::time::Instant::now();
    let output = solve(&input);
    let t_solve = t_solve_start.elapsed().as_secs_f64() * 1000.0;
    let t_ser_start = std::time::Instant::now();
    let mut out_json = String::with_capacity(output.routes_json.len() + 128);
    out_json.push('{');
    write_json_string(&mut out_json, "solved");
    out_json.push(':');
    out_json.push_str(if output.solved { "true" } else { "false" });
    out_json.push(',');
    write_json_string(&mut out_json, "failed");
    out_json.push(':');
    out_json.push_str(if output.failed { "true" } else { "false" });
    out_json.push(',');
    write_json_string(&mut out_json, "error");
    out_json.push(':');
    match &output.error {
        Some(e) => write_json_string(&mut out_json, e),
        None => out_json.push_str("null"),
    }
    out_json.push(',');
    write_json_string(&mut out_json, "iterations");
    out_json.push(':');
    out_json.push_str(&output.iterations.to_string());
    out_json.push(',');
    write_json_string(&mut out_json, "routes");
    out_json.push(':');
    out_json.push_str(&output.routes_json);
    out_json.push('}');

    let t_ser = t_ser_start.elapsed().as_secs_f64() * 1000.0;
    if std::env::var("HDASTAR_TIMING").is_ok() {
        eprintln!("[hdastar] fields={:.1}ms solve={:.1}ms ser={:.1}ms", t_fields, t_solve, t_ser);
    }
    let bytes = out_json.as_bytes();
    if bytes.len() > output_cap {
        return -1;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), output_ptr, bytes.len());
    }
    bytes.len() as i64
}

fn build_routes_json(
    s: &mut Solver,
    a: f64,
    c: f64,
    e: f64,
    f: f64,
    layer_to_z: &HashMap<usize, i32>,
) -> String {
    let mut routes_json = String::from("[");
    let mut first_route = true;
    for &conn_id in &s.solved_insertion_order {
        let conn_routes = &s.solved_routes[&conn_id];
        let conn_name = &s.conn_id_to_name[conn_id as usize];
        for route in conn_routes {
            if !first_route {
                routes_json.push(',');
            }
            first_route = false;
            routes_json.push('{');
            write_json_string(&mut routes_json, "connectionName");
            routes_json.push(':');
            write_json_string(&mut routes_json, conn_name);
            routes_json.push(',');
            write_json_string(&mut routes_json, "rootConnectionName");
            routes_json.push(':');
            write_json_string(&mut routes_json, &s.conn_id_to_root_net[conn_id as usize]);
            routes_json.push(',');
            write_json_string(&mut routes_json, "regionId");
            routes_json.push(':');
            match &s.region_id {
                Some(rid) => write_json_string(&mut routes_json, rid),
                None => routes_json.push_str("null"),
            }
            routes_json.push(',');
            write_json_string(&mut routes_json, "traceThickness");
            routes_json.push(':');
            write_f64(&mut routes_json, s.trace_thickness);
            routes_json.push(',');
            write_json_string(&mut routes_json, "viaDiameter");
            routes_json.push(':');
            write_f64(&mut routes_json, s.via_diameter);
            routes_json.push(',');
            write_json_string(&mut routes_json, "route");
            routes_json.push(':');

            // route points: raw start, computed middle, raw end
            let mut pts_json = String::from("[");
            let n_cells = route.cells.len();
            for (pi, &cell) in route.cells.iter().enumerate() {
                if pi > 0 {
                    pts_json.push(',');
                }
                if pi == 0 {
                    write_jval(&mut pts_json, &route.start_point);
                    continue;
                }
                if pi == n_cells - 1 && n_cells > 1 {
                    write_jval(&mut pts_json, &route.end_point);
                    continue;
                }
                let raw_x = s.grid_origin.x + (cell.2 as f64 + 0.5) * s.cell_size_mm;
                let raw_y = s.grid_origin.y + (cell.1 as f64 + 0.5) * s.cell_size_mm;
                pts_json.push('{');
                write_json_string(&mut pts_json, "x");
                pts_json.push(':');
                write_f64(&mut pts_json, a * raw_x + c);
                pts_json.push(',');
                write_json_string(&mut pts_json, "y");
                pts_json.push(':');
                write_f64(&mut pts_json, e * raw_y + f);
                pts_json.push(',');
                write_json_string(&mut pts_json, "z");
                pts_json.push(':');
                let zv = *layer_to_z.get(&cell.0).unwrap_or(&(cell.0 as i32));
                pts_json.push_str(&zv.to_string());
                pts_json.push('}');
            }
            pts_json.push(']');
            routes_json.push_str(&pts_json);
            routes_json.push(',');
            write_json_string(&mut routes_json, "vias");
            routes_json.push_str(":[");

            for (vi, &via) in route.via_cells.iter().enumerate() {
                if vi > 0 {
                    routes_json.push(',');
                }
                let raw_x = s.grid_origin.x + (via.1 as f64 + 0.5) * s.cell_size_mm;
                let raw_y = s.grid_origin.y + (via.0 as f64 + 0.5) * s.cell_size_mm;
                routes_json.push('{');
                write_json_string(&mut routes_json, "x");
                routes_json.push(':');
                write_f64(&mut routes_json, a * raw_x + c);
                routes_json.push(',');
                write_json_string(&mut routes_json, "y");
                routes_json.push(':');
                write_f64(&mut routes_json, e * raw_y + f);
                routes_json.push('}');
            }
            routes_json.push_str("]}");
        }
    }
    routes_json.push(']');

    routes_json
}

// ---------- Stateful FFI (incremental solver for portfolio integration) ----------

pub struct A01Handle {
    solver: Box<Solver>,
    input: Input,
    step_mult: usize,
    grid_a: f64,
    grid_c: f64,
    grid_e: f64,
    grid_f: f64,
    layer_to_z: HashMap<usize, i32>,
}

/// Create a solver from JSON input. Returns handle index (>0), or 0 on error.
#[no_mangle]
pub extern "C" fn a01_create(input_ptr: *const u8, input_len: usize) -> u64 {
    let input_bytes = unsafe { std::slice::from_raw_parts(input_ptr, input_len) };
    let root = match parse_json(input_bytes) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let input = match Input::from_jval(&root) {
        Ok(v) => v,
        Err(_) => return 0,
    };
    let cols = input.cols;
    let rows = input.rows;
    let cell = input.cell_size_mm;
    let width = input.width;
    let height = input.height;
    let (a, c) = if cols > 1 {
        let a = width / ((cols - 1) as f64 * cell);
        (a, input.grid_origin.x * (1.0 - a) - 0.5 * cell * a)
    } else {
        (1.0, input.grid_origin.x + width / 2.0 - (input.grid_origin.x + 0.5 * cell))
    };
    let (e, f) = if rows > 1 {
        let e = height / ((rows - 1) as f64 * cell);
        (e, input.grid_origin.y * (1.0 - e) - 0.5 * cell * e)
    } else {
        (1.0, input.grid_origin.y + height / 2.0 - (input.grid_origin.y + 0.5 * cell))
    };
    let layer_to_z: HashMap<usize, i32> = input
        .available_z
        .iter()
        .enumerate()
        .map(|(i, &z)| (i, z))
        .collect();
    let step_mult = input.step_multiplier.max(1);
    let solver = Box::new(new_solver(&input));
    let handle = Box::new(A01Handle {
        solver,
        input,
        step_mult,
        grid_a: a,
        grid_c: c,
        grid_e: e,
        grid_f: f,
        layer_to_z,
    });
    Box::into_raw(handle) as u64
}

/// Advance the solver by n step() ticks (each = stepMultiplier stepOnces).
/// Returns 1 while running, 2 when solved, 3 when failed, 0 on bad handle.
#[no_mangle]
pub extern "C" fn a01_step(handle: u64, n: usize) -> i32 {
    if handle == 0 {
        return 0;
    }
    let h = unsafe { &mut *(handle as *mut A01Handle) };
    for _ in 0..n {
        if h.solver.solved || h.solver.failed {
            break;
        }
        if h.solver.iterations >= h.solver.max_iterations {
            h.solver.failed = true;
            h.solver.error = Some("MAX_ITERATIONS exceeded".to_string());
            break;
        }
        h.solver.iterations += 1;
        for _ in 0..h.step_mult {
            if h.solver.solved || h.solver.failed {
                break;
            }
            h.solver.step_once();
        }
    }
    if h.solver.solved {
        2
    } else if h.solver.failed {
        3
    } else {
        1
    }
}

/// Read solver state as JSON: {state, iterations, progress, error}
#[no_mangle]
pub extern "C" fn a01_state(handle: u64, output_ptr: *mut u8, output_cap: usize) -> i64 {
    if handle == 0 {
        return -2;
    }
    let h = unsafe { &mut *(handle as *mut A01Handle) };
    // solvedSegments count for the portfolio's getCandidateProgress
    let solved_segs: usize = h
        .solver
        .solved_routes
        .values()
        .map(|r| r.len())
        .sum();
    let mut out = String::with_capacity(160);
    out.push('{');
    write_json_string(&mut out, "state");
    out.push(':');
    out.push_str(if h.solver.solved {
        "2"
    } else if h.solver.failed {
        "3"
    } else {
        "1"
    });
    out.push(',');
    write_json_string(&mut out, "iterations");
    out.push(':');
    out.push_str(&h.solver.iterations.to_string());
    out.push(',');
    write_json_string(&mut out, "solvedSegments");
    out.push(':');
    out.push_str(&solved_segs.to_string());
    out.push(',');
    write_json_string(&mut out, "maxIterations");
    out.push(':');
    out.push_str(&h.solver.max_iterations.to_string());
    out.push(',');
    write_json_string(&mut out, "error");
    out.push(':');
    match &h.solver.error {
        Some(e) => write_json_string(&mut out, e),
        None => out.push_str("null"),
    }
    out.push('}');
    let bytes = out.as_bytes();
    if bytes.len() > output_cap {
        return -1;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), output_ptr, bytes.len());
    }
    bytes.len() as i64
}

/// Write solved routes JSON (getOutput shape) into output. Returns length.
#[no_mangle]
pub extern "C" fn a01_routes(handle: u64, output_ptr: *mut u8, output_cap: usize) -> i64 {
    if handle == 0 {
        return -2;
    }
    let h = unsafe { &mut *(handle as *mut A01Handle) };
    let routes_json = build_routes_json(
        &mut h.solver,
        h.grid_a,
        h.grid_c,
        h.grid_e,
        h.grid_f,
        &h.layer_to_z,
    );
    let bytes = routes_json.as_bytes();
    if bytes.len() > output_cap {
        return -1;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), output_ptr, bytes.len());
    }
    bytes.len() as i64
}

#[no_mangle]
pub extern "C" fn a01_destroy(handle: u64) {
    if handle == 0 {
        return;
    }
    unsafe {
        drop(Box::from_raw(handle as *mut A01Handle));
    }
}

impl A01Handle {
    fn input_conn_seg_count(&self) -> usize {
        self.solver.unsolved_segs.len()
            + self
                .solver
                .solved_routes
                .values()
                .map(|r| r.len())
                .sum::<usize>()
    }
}

/// Packed step: advance n ticks, return status+segment count without JSON.
/// bit 63 = failed, bit 62 = solved, bits 0..61 = solvedSegments.
#[no_mangle]
pub extern "C" fn a01_step_packed(handle: u64, n: usize) -> u64 {
    if handle == 0 {
        return 1 << 63;
    }
    let h = unsafe { &mut *(handle as *mut A01Handle) };
    for _ in 0..n {
        if h.solver.solved || h.solver.failed {
            break;
        }
        if h.solver.iterations >= h.solver.max_iterations {
            h.solver.failed = true;
            h.solver.error = Some("MAX_ITERATIONS exceeded".to_string());
            break;
        }
        h.solver.iterations += 1;
        for _ in 0..h.step_mult {
            if h.solver.solved || h.solver.failed {
                break;
            }
            h.solver.step_once();
        }
    }
    let segs: u64 = h
        .solver
        .solved_routes
        .values()
        .map(|r| r.len() as u64)
        .sum();
    let mut out = segs & 0x3FFF_FFFF_FFFF_FFFF;
    if h.solver.solved {
        out |= 1 << 62;
    }
    if h.solver.failed {
        out |= 1 << 63;
    }
    out
}

/// Read max_iterations (post-setup budget) without JSON.
#[no_mangle]
pub extern "C" fn a01_max_iterations(handle: u64) -> u64 {
    if handle == 0 {
        return 0;
    }
    let h = unsafe { &mut *(handle as *mut A01Handle) };
    h.solver.max_iterations as u64
}

/// Take the error string (if any). Returns bytes written, 0 if none.
#[no_mangle]
pub extern "C" fn a01_error(handle: u64, output_ptr: *mut u8, output_cap: usize) -> i64 {
    if handle == 0 {
        return -2;
    }
    let h = unsafe { &mut *(handle as *mut A01Handle) };
    match &h.solver.error {
        None => 0,
        Some(e) => {
            let bytes = e.as_bytes();
            if bytes.len() > output_cap {
                return -1;
            }
            unsafe {
                std::ptr::copy_nonoverlapping(bytes.as_ptr(), output_ptr, bytes.len());
            }
            bytes.len() as i64
        }
    }
}
