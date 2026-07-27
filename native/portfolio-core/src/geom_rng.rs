//! M0 `geom-rng` (PORT-SPEC.md §8) — foundation module, agent A.
//!
//! Contents (spec's M0 list, all in this one file because lib.rs declares the
//! single module `geom_rng`):
//!   1. JS number-semantics helpers: `js_round`, `js_max`, `js_min`,
//!      `or_zero`, `js_to_fixed6`, `is_safe_integer` (§6.3, §6.7, §6.9).
//!   2. Vendored @tscircuit/math-utils subset: `distance`,
//!      `point_to_segment_distance`, `orientation`/`on_segment`/
//!      `do_segments_intersect` with the RELATIVE 1e-12 collinearity epsilon
//!      (node_modules/@tscircuit/math-utils/dist/chunk-PUVNW6C2.js:11-75,
//!      §6.12).
//!   3. `SeededRandom` + `clone_and_shuffle` (+ PRESHUFFLED tables), the only
//!      PRNG in the dominant-class closure (lib/utils/cloneAndShuffleArray.ts,
//!      §6.1) — bit-exact with JS int32 semantics.
//!   4. Node utils over the shared contract types:
//!      `get_bounds_from_node_with_port_points`
//!      (lib/utils/getBoundsFromNodeWithPortPoints.ts) and
//!      `get_min_dist_between_entering_points`
//!      (lib/utils/getMinDistBetweenEnteringPoints.ts).
//!
//! The interned ConnSlice with the asymmetric `are_ids_connected` (§6.11) —
//! also on M0's spec list — was already implemented inside
//! `contract::ConnSlice` by the contract-file author; it is consumed, not
//! duplicated, here.
//!
//! Every helper mirrors OBSERVED engine behavior (bun = JSC; V8 agrees on all
//! cases below), not an idealized spec reading. `x ** 2` in JS sources is
//! written `x * x` here: for any finite x both are fl(x^2) (JSC/V8 lower
//! `** 2` to a multiply; a correct pow returns the exactly-representable
//! square), so bit patterns are identical.

use crate::contract::{Bounds, NodeSession};

// ===========================================================================
// 1. JS number semantics (§6.3, §6.7, §6.9)
// ===========================================================================

/// JS `Math.round(x)` — rounds half toward +Infinity (PORT-SPEC §6.7).
///
/// `Math.round(-2.5) === -2` while Rust `f64::round(-2.5) == -3.0`, so
/// `f64::round` must NEVER be used on ported paths.
///
/// CORRECTED 2026-07-27 (coordinator): the naive `floor(x + 0.5)` form is NOT
/// what engines do — the `+ 0.5` addition itself rounds, so
/// `floor(0.49999999999999994 + 0.5) == 1` while BOTH engines return 0
/// per exact ECMA semantics. Probed on this box:
///   node/V8 24.13:  Math.round(0.49999999999999994) === 0
///   bun/JSC 1.3.14: Math.round(0.49999999999999994) === 0, round(-0.5) = -0,
///                   round(2.5) = 3, round(-2.5) = -2
/// This delegates to js_num::js_round (exact form: f = floor(x); f+1 iff
/// x - f >= 0.5, where x - f is exact for the coordinate ranges used).
///
/// Divergence note (harmless): for x in [-0.5, -0.0], JS returns -0 where
/// this returns +0. The result only feeds arithmetic (packed node
/// keys, grid snapping) where -0 and +0 behave identically, and -0 vs 0
/// stringify identically in JSON.
///
/// Used at: SingleHighDensityRouteSolver.ts:209-216 (key-range setup),
/// :266-277 (initial node snap), :698-706 (packed node key),
/// CachedIntraNodeRouteSolver.ts:16 (cache-key roundCoord, M2).
#[inline]
pub fn js_round(x: f64) -> f64 {
    crate::js_num::js_round(x)
}

/// JS `Math.max(a, b)` — NaN-poisoning, and +0 is considered larger than -0.
///
/// Rust `f64::max` returns the non-NaN operand when one side is NaN; JS
/// returns NaN. The difference is LOAD-BEARING: the B2 finding (PORT-SPEC
/// §6.3) relies on `Math.max(x, NaN) -> NaN` inside
/// SingleHighDensityRouteSolver.computeProgress (:855-863).
#[inline]
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        // ES Math.max: +0 > -0
        if a.is_sign_negative() && b.is_sign_negative() {
            return -0.0;
        }
        return 0.0;
    }
    if a > b {
        a
    } else {
        b
    }
}

/// JS `Math.min(a, b)` — NaN-poisoning, and -0 is considered smaller than +0.
#[inline]
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a == 0.0 && b == 0.0 {
        // ES Math.min: -0 < +0
        if a.is_sign_negative() || b.is_sign_negative() {
            return -0.0;
        }
        return 0.0;
    }
    if a < b {
        a
    } else {
        b
    }
}

/// JS `x || 0` on a number — falsy (NaN, +0, -0) becomes +0, everything else
/// passes through. The NaN->0 arm is the load-bearing half of the progress
/// pipeline (PORT-SPEC §6.3): `IntraNodeRouteSolver.computeProgress` reads
/// `this.activeSubSolver?.progress || 0` (IntraNodeSolver.ts:214-219) where
/// `progress` is NaN after every sub-solver step.
#[inline]
pub fn or_zero(x: f64) -> f64 {
    if x.is_nan() || x == 0.0 {
        0.0
    } else {
        x
    }
}

/// JS `Number.isSafeInteger(x)` (SingleHighDensityRouteSolver.ts:231-238
/// packed-key guard).
#[inline]
pub fn is_safe_integer(x: f64) -> bool {
    x.is_finite() && x.floor() == x && x.abs() <= 9007199254740991.0
}

/// JS `Number.prototype.toFixed(6)` — exact ES algorithm (PORT-SPEC §6.9).
///
/// Rust `format!("{:.6}")` rounds ties-to-even on the exact binary value; JS
/// ToFixed picks "the larger n" on exact ties (round half UP after the sign
/// is stripped). Exact ties DO occur for dyadic values (e.g. 0.0078125
/// -> JS "0.007813", Rust {:.6} "0.007812"), so this implements the spec
/// algorithm on the exact bit decomposition:
///   n = the integer minimizing |n / 10^6 - x|, ties -> larger n,
/// computed as round-half-up of (m * 5^6) * 2^(e+6) in u128 (exact: m < 2^53,
/// 5^6 = 15625 < 2^14).
///
/// JS edge behaviors preserved: NaN -> "NaN"; -0 -> "0.000000" (the `x < 0`
/// test is false for -0); tiny negatives -> "-0.000000".
/// |x| >= 1e21 falls back to Rust Display (spec says ToString(x); unreachable
/// for board coordinates — documented approximation).
///
/// Consumers: point-key dedupe (IntraNodeSolver.ts:35-50, M2) and the repair
/// graph (repairDisconnectedSameRootPortPoints.ts:7-8, TS-side).
pub fn js_to_fixed6(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    let neg = x < 0.0; // false for -0.0, matching JS step "if x < 0"
    let ax = if neg { -x } else { x };
    if ax >= 1e21 {
        if ax.is_infinite() {
            return if neg {
                "-Infinity".to_string()
            } else {
                "Infinity".to_string()
            };
        }
        return format!("{}{}", if neg { "-" } else { "" }, ax);
    }
    // Exact decomposition ax = m * 2^e (m includes the implicit bit).
    let bits = ax.to_bits();
    let raw_exp = ((bits >> 52) & 0x7ff) as i64;
    let mantissa = (bits & 0x000f_ffff_ffff_ffff) as u128;
    let (m, e) = if raw_exp == 0 {
        (mantissa, -1074i64)
    } else {
        (mantissa | (1u128 << 52), raw_exp - 1075)
    };
    // ax * 10^6 = (m * 5^6) * 2^(e + 6)
    let v = m * 15625u128;
    let k = e + 6;
    let n: u128 = if k >= 0 {
        // ax < 1e21 -> n < 10^27 < 2^90: no u128 overflow possible.
        v << (k as u32)
    } else {
        let sh = (-k) as u32;
        if sh >= 128 {
            // v < 2^67 << 2^(sh-1): rounds to 0.
            0
        } else {
            let q = v >> sh;
            let r = v - (q << sh);
            let half = 1u128 << (sh - 1);
            if r >= half {
                q + 1 // ties (r == half) round UP: "pick the larger n"
            } else {
                q
            }
        }
    };
    let int_part = n / 1_000_000;
    let frac_part = n % 1_000_000;
    format!("{}{}.{:06}", if neg { "-" } else { "" }, int_part, frac_part)
}

// ===========================================================================
// 2. Vendored @tscircuit/math-utils subset
//    (node_modules/@tscircuit/math-utils/dist/chunk-PUVNW6C2.js:11-75)
//    Points are scalar (x, y) pairs in the SAME argument order as the JS
//    functions to keep call sites auditable.
// ===========================================================================

/// chunk-PUVNW6C2.js:25 — relative collinearity epsilon (PORT-SPEC §6.12:
/// port exactly; a spurious 0 here changes obstacle rejection).
pub const COLINEAR_RELATIVE_EPSILON: f64 = 1e-12;

/// `distance(p1, p2)` — chunk-PUVNW6C2.js:71-75.
/// dx = p1.x - p2.x; dy = p1.y - p2.y; sqrt(dx*dx + dy*dy).
/// sqrt is IEEE-exact (PORT-SPEC §6.8), so this is bit-stable.
#[inline]
pub fn distance(p1x: f64, p1y: f64, p2x: f64, p2y: f64) -> f64 {
    let dx = p1x - p2x;
    let dy = p1y - p2y;
    (dx * dx + dy * dy).sqrt()
}

/// `pointToSegmentDistance(p, v, w)` — chunk-PUVNW6C2.js:60-70.
#[inline]
pub fn point_to_segment_distance(px: f64, py: f64, vx: f64, vy: f64, wx: f64, wy: f64) -> f64 {
    let dwx = wx - vx; // :61  const wx = w.x - v.x
    let dwy = wy - vy; // :62
    let l2 = dwx * dwx + dwy * dwy; // :63  wx ** 2 + wy ** 2 (fl-identical)
    if l2 == 0.0 {
        return distance(px, py, vx, vy); // :64
    }
    let mut t = ((px - vx) * dwx + (py - vy) * dwy) / l2; // :65
    t = js_max(0.0, js_min(1.0, t)); // :66  Math.max(0, Math.min(1, t))
    let dx = px - (vx + t * dwx); // :67
    let dy = py - (vy + t * dwy); // :68
    (dx * dx + dy * dy).sqrt() // :69
}

/// `orientation(p, q, r)` — chunk-PUVNW6C2.js:26-35.
/// Returns 0 collinear (within the RELATIVE 1e-12 epsilon), 1 clockwise,
/// 2 counter-clockwise.
#[inline]
pub fn orientation(px: f64, py: f64, qx: f64, qy: f64, rx: f64, ry: f64) -> i32 {
    let term1 = (qy - py) * (rx - qx); // :27
    let term2 = (qx - px) * (ry - qy); // :28
    let val = term1 - term2; // :29
    let abs_term1 = term1.abs(); // :30
    let abs_term2 = term2.abs(); // :31
    let scale = if abs_term1 > abs_term2 { abs_term1 } else { abs_term2 }; // :32
    if val.abs() <= COLINEAR_RELATIVE_EPSILON * scale {
        return 0; // :33
    }
    if val > 0.0 {
        1
    } else {
        2
    } // :34
}

/// `onSegment(p, q, r)` — chunk-PUVNW6C2.js:36-38: is q inside the bounding
/// box of segment (p, r). Math.max/Math.min mirrored via js_max/js_min.
#[inline]
pub fn on_segment(px: f64, py: f64, qx: f64, qy: f64, rx: f64, ry: f64) -> bool {
    qx <= js_max(px, rx) && qx >= js_min(px, rx) && qy <= js_max(py, ry) && qy >= js_min(py, ry)
}

/// `doSegmentsIntersect(p1, q1, p2, q2)` — chunk-PUVNW6C2.js:11-24.
/// Orientation-call order preserved (each call can hit the epsilon branch).
#[allow(clippy::too_many_arguments)]
pub fn do_segments_intersect(
    p1x: f64,
    p1y: f64,
    q1x: f64,
    q1y: f64,
    p2x: f64,
    p2y: f64,
    q2x: f64,
    q2y: f64,
) -> bool {
    let o1 = orientation(p1x, p1y, q1x, q1y, p2x, p2y); // :12
    let o2 = orientation(p1x, p1y, q1x, q1y, q2x, q2y); // :13
    let o3 = orientation(p2x, p2y, q2x, q2y, p1x, p1y); // :14
    let o4 = orientation(p2x, p2y, q2x, q2y, q1x, q1y); // :15
    if o1 != o2 && o3 != o4 {
        return true; // :16-18
    }
    if o1 == 0 && on_segment(p1x, p1y, p2x, p2y, q1x, q1y) {
        return true; // :19
    }
    if o2 == 0 && on_segment(p1x, p1y, q2x, q2y, q1x, q1y) {
        return true; // :20
    }
    if o3 == 0 && on_segment(p2x, p2y, p1x, p1y, q2x, q2y) {
        return true; // :21
    }
    if o4 == 0 && on_segment(p2x, p2y, q1x, q1y, q2x, q2y) {
        return true; // :22
    }
    false // :23
}

// ===========================================================================
// 3. Seeded shuffle — lib/utils/cloneAndShuffleArray.ts (PORT-SPEC §6.1: the
//    ONLY PRNG in the dominant-class closure)
// ===========================================================================
//
// JS int32 semantics notes (why this is exact):
// - Warm-up (`seededRandom` :1-14) runs in JS f64: `s * 16807` stays below
//   2^46 and `seed * 69069 + 1` below 2^48 for any i32 seed, so every
//   intermediate is an exact integer — i64 arithmetic is bit-identical. JS
//   `%` keeps the dividend's sign, exactly like Rust `%` on i64.
// - The generator (:17-32) mixes with JS bitwise ops: `^` and `<<` operate on
//   ToInt32 values (wrapping i32), `>>>` on ToUint32 values. States may go
//   negative. Rust i32 `<<` discards high bits exactly like the 32-bit JS
//   shift; `(x as u32) >> n` mirrors `>>>`.
// - `(state0 + state1) / 4294967296` adds two i32-valued numbers (exact in
//   f64) and divides by 2^32 (exact scaling); `result - Math.floor(result)`
//   maps to `result - result.floor()`.

/// `seededRandom(seed)` — cloneAndShuffleArray.ts:1-33.
/// LCG warm-up, then xorshift128+ with JS int32 semantics.
#[derive(Clone, Debug)]
pub struct SeededRandom {
    state0: i32,
    state1: i32,
}

impl SeededRandom {
    pub fn new(seed: i32) -> SeededRandom {
        // :2-7  first state: 10 rounds of s = (s * 16807) % 2147483647
        let mut s: i64 = seed as i64;
        for _ in 0..10 {
            s = (s * 16807) % 2147483647;
        }
        let state0 = s as i32; // |s| <= 2147483646: fits i32

        // :9-14  second state: s = (seed * 69069 + 1) % 2147483647, then
        // 10 rounds of s = (s * 48271) % 2147483647
        let mut s2: i64 = (seed as i64) * 69069 + 1;
        s2 %= 2147483647;
        for _ in 0..10 {
            s2 = (s2 * 48271) % 2147483647;
        }
        let state1 = s2 as i32;

        SeededRandom { state0, state1 }
    }

    /// The returned closure — cloneAndShuffleArray.ts:17-32.
    pub fn next(&mut self) -> f64 {
        let mut s1: i32 = self.state0; // :19
        let s0: i32 = self.state1; // :20
        self.state0 = s0; // :22
        s1 ^= s1 << 23; // :23  JS << wraps to i32
        s1 ^= ((s1 as u32) >> 17) as i32; // :24  JS >>> (result < 2^15, i32-safe)
        s1 ^= s0; // :25
        s1 ^= ((s0 as u32) >> 26) as i32; // :26  JS >>> on two's-complement u32
        self.state1 = s1; // :27

        // :30-31  exact f64: |state0 + state1| < 2^32, /2^32 is exact scaling
        let result = (self.state0 as f64 + self.state1 as f64) / 4294967296.0;
        result - result.floor()
    }
}

// PRESHUFFLED_CASES — cloneAndShuffleArray.ts:38-78, transcribed verbatim.
const PRESHUFFLED_1: [[usize; 1]; 1] = [[0]];
const PRESHUFFLED_2: [[usize; 2]; 2] = [[0, 1], [1, 0]];
const PRESHUFFLED_3: [[usize; 3]; 6] = [
    [0, 1, 2],
    [2, 0, 1],
    [1, 0, 2],
    [0, 2, 1],
    [1, 2, 0],
    [2, 1, 0],
];
const PRESHUFFLED_4: [[usize; 4]; 24] = [
    [0, 1, 2, 3],
    [2, 0, 1, 3],
    [1, 3, 2, 0],
    [3, 0, 1, 2],
    [0, 2, 1, 3],
    [2, 1, 3, 0],
    [3, 0, 2, 1],
    [1, 2, 0, 3],
    [3, 1, 0, 2],
    [0, 3, 2, 1],
    [2, 3, 0, 1],
    [2, 3, 1, 0],
    [1, 2, 3, 0],
    [3, 1, 2, 0],
    [0, 1, 3, 2],
    [0, 2, 3, 1],
    [0, 3, 1, 2],
    [1, 0, 2, 3],
    [1, 0, 3, 2],
    [1, 3, 0, 2],
    [2, 0, 3, 1],
    [2, 1, 0, 3],
    [3, 2, 0, 1],
    [3, 2, 1, 0],
];

/// `cloneAndShuffleArray(arr, seed)` — cloneAndShuffleArray.ts:80-105.
/// (Exported under the name lib.rs's M0 NOTE specifies; see also the
/// TS-named alias below.)
///
/// - `seed == 0` returns the array UNSHUFFLED (:81 — the TS returns the SAME
///   reference; the Rust clone is content/order-identical). NOTE the CALLER
///   side also has a falsy skip: `SHUFFLE_SEED: 0` skips shuffling entirely
///   (IntraNodeSolver.ts:153, M2's concern).
/// - Lengths 1-4 use the PRESHUFFLED_CASES table indexed by
///   `seed % options.length` (:84-90).
/// - Longer arrays run the seeded swap loop (:98-104): for each i,
///   `i1 = floor(random() * len)`, `i2 = floor(random() * (i + 1))`, swap.
///   `random() <= 1 - 2^-32` and len << 2^32, so `random() * len` can never
///   round up to len: the floor is always a valid index.
///
/// Per-connection point shuffles use seed `i * 7117 + SHUFFLE_SEED`
/// (IntraNodeSolver.ts:161-169; applied by M2).
pub fn clone_and_shuffle<T: Clone>(arr: &[T], seed: i32) -> Vec<T> {
    if seed == 0 {
        return arr.to_vec(); // :81
    }
    if arr.is_empty() {
        return arr.to_vec(); // :82
    }

    if arr.len() <= 4 {
        // :84-90
        let options_len: i64 = match arr.len() {
            1 => 1,
            2 => 2,
            3 => 6,
            _ => 24,
        };
        let idx = (seed as i64) % options_len; // JS % (sign of dividend)
        // A negative seed would make preshuffledOptions[idx] undefined and TS
        // would throw a TypeError on .map; seeds are non-negative in the
        // portfolio (SHUFFLE_SEED 0-119, i*7117+seed — PORT-SPEC §1, §6.1).
        let idx = usize::try_from(idx)
            .expect("cloneAndShuffleArray: negative seed with len <= 4 (TS throws TypeError here)");
        let case: &[usize] = match arr.len() {
            1 => &PRESHUFFLED_1[idx],
            2 => &PRESHUFFLED_2[idx],
            3 => &PRESHUFFLED_3[idx],
            _ => &PRESHUFFLED_4[idx],
        };
        return case.iter().map(|&order_index| arr[order_index].clone()).collect(); // :89
    }

    let mut random = SeededRandom::new(seed); // :92
    let mut shuffled: Vec<T> = arr.to_vec(); // :98
    let len_f = shuffled.len() as f64;
    for i in 0..shuffled.len() {
        // :99-103 — note BOTH indices come from random(): i1 over the whole
        // array, i2 over [0, i]; the destructuring swap is a plain swap.
        let i1 = (random.next() * len_f).floor() as usize;
        let i2 = (random.next() * (i as f64 + 1.0)).floor() as usize;
        shuffled.swap(i1, i2);
    }
    shuffled
}

/// TS-named alias for greppability against cloneAndShuffleArray call sites.
#[inline]
pub fn clone_and_shuffle_array<T: Clone>(arr: &[T], seed: i32) -> Vec<T> {
    clone_and_shuffle(arr, seed)
}

// ===========================================================================
// 4. Node utils over the shared contract types
// ===========================================================================

/// `getBoundsFromNodeWithPortPoints(nodeWithPortPoints)` —
/// lib/utils/getBoundsFromNodeWithPortPoints.ts:3-32. Center/size box first
/// (:6-11), then expanded by any port points outside it (:16-29 — "leap"
/// points can sit outside the node).
pub fn get_bounds_from_node_with_port_points(node: &NodeSession) -> Bounds {
    let mut bounds = Bounds {
        min_x: node.center[0] - node.width / 2.0,  // :7
        max_x: node.center[0] + node.width / 2.0,  // :8
        min_y: node.center[1] - node.height / 2.0, // :9
        max_y: node.center[1] + node.height / 2.0, // :10
    };
    for pt in &node.port_points {
        if pt.x < bounds.min_x {
            bounds.min_x = pt.x; // :17-19
        }
        if pt.x > bounds.max_x {
            bounds.max_x = pt.x; // :20-22
        }
        if pt.y < bounds.min_y {
            bounds.min_y = pt.y; // :23-25
        }
        if pt.y > bounds.max_y {
            bounds.max_y = pt.y; // :26-28
        }
    }
    bounds
}

/// `getMinDistBetweenEnteringPoints(node)` —
/// lib/utils/getMinDistBetweenEnteringPoints.ts:3-34. All-pairs (i < j) over
/// port points, skipping different layers (:14-16) and same-root pairs
/// (:19-24; the JS truthiness of rootConnectionName maps to `Option::Some` —
/// the marshaling collapses "" to None, see contract::PortPoint docs).
/// Returns 0 when no eligible pair exists (:33).
pub fn get_min_dist_between_entering_points(node: &NodeSession) -> f64 {
    let mut min_dist = f64::INFINITY; // :4
    let points = &node.port_points; // :5
    for i in 0..points.len() {
        for j in (i + 1)..points.len() {
            let p1 = &points[i];
            let p2 = &points[j];
            if p1.z != p2.z {
                continue; // :14-16 (JS !==)
            }
            if p1.root_conn.is_some() && p1.root_conn == p2.root_conn {
                continue; // :19-24
            }
            let dx = p1.x - p2.x;
            let dy = p1.y - p2.y;
            let dist = (dx * dx + dy * dy).sqrt(); // :27  (p1.x-p2.x)**2 + … (fl-identical)
            min_dist = js_min(min_dist, dist); // :29  Math.min
        }
    }
    if min_dist == f64::INFINITY {
        0.0 // :33
    } else {
        min_dist
    }
}

// ===========================================================================
// Tests (smoke checks; the authoritative check is the TS-generated golden
// vector file per contract C0 — harness lands with M3)
// ===========================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_half_toward_positive_infinity() {
        assert_eq!(js_round(2.5), 3.0);
        assert_eq!(js_round(-2.5), -2.0); // f64::round would give -3
        assert_eq!(js_round(-2.6), -3.0);
        assert_eq!(js_round(0.4999), 0.0);
    }

    #[test]
    fn min_max_nan_poisoning_and_signed_zero() {
        assert!(js_max(1.0, f64::NAN).is_nan());
        assert!(js_min(f64::NAN, 1.0).is_nan());
        assert!(js_min(0.0, -0.0).is_sign_negative());
        assert!(js_max(-0.0, 0.0).is_sign_positive());
        assert_eq!(js_max(2.0, 3.0), 3.0);
        assert_eq!(js_min(2.0, 3.0), 2.0);
    }

    #[test]
    fn or_zero_falsy() {
        assert_eq!(or_zero(f64::NAN), 0.0);
        assert!(or_zero(-0.0).is_sign_positive());
        assert_eq!(or_zero(0.25), 0.25);
    }

    #[test]
    fn to_fixed6_matches_js() {
        assert_eq!(js_to_fixed6(0.0078125), "0.007813"); // exact tie: half-up, not ties-even
        assert_eq!(js_to_fixed6(0.1), "0.100000");
        assert_eq!(js_to_fixed6(2.0), "2.000000");
        assert_eq!(js_to_fixed6(-1e-10), "-0.000000");
        assert_eq!(js_to_fixed6(-0.0), "0.000000");
        assert_eq!(js_to_fixed6(f64::NAN), "NaN");
        assert_eq!(js_to_fixed6(1.5), "1.500000");
    }

    #[test]
    fn safe_integer_bounds() {
        assert!(is_safe_integer(9007199254740991.0));
        assert!(!is_safe_integer(9007199254740992.0));
        assert!(!is_safe_integer(1.5));
        assert!(!is_safe_integer(f64::INFINITY));
    }

    #[test]
    fn orientation_collinear_epsilon() {
        assert_eq!(orientation(0.0, 0.0, 1.0, 0.0, 2.0, 0.0), 0);
        assert_eq!(orientation(0.0, 0.0, 1.0, 0.0, 2.0, 1.0), 2);
        assert_eq!(orientation(0.0, 0.0, 1.0, 0.0, 2.0, -1.0), 1);
    }

    #[test]
    fn segment_intersection_basics() {
        assert!(do_segments_intersect(0.0, 0.0, 1.0, 1.0, 0.0, 1.0, 1.0, 0.0));
        assert!(!do_segments_intersect(0.0, 0.0, 1.0, 0.0, 0.0, 1.0, 1.0, 1.0));
        assert!(do_segments_intersect(0.0, 0.0, 2.0, 0.0, 1.0, 0.0, 3.0, 0.0));
    }

    #[test]
    fn point_segment_distance() {
        assert_eq!(point_to_segment_distance(0.0, 1.0, -1.0, 0.0, 1.0, 0.0), 1.0);
        assert_eq!(point_to_segment_distance(3.0, 4.0, 0.0, 0.0, 0.0, 0.0), 5.0);
    }

    #[test]
    fn seed_zero_is_identity() {
        let arr = vec![10, 20, 30, 40, 50];
        assert_eq!(clone_and_shuffle(&arr, 0), arr);
    }

    #[test]
    fn preshuffled_small_arrays() {
        // len 3, seed 1 -> PRESHUFFLED_CASES[3][1 % 6] = [2, 0, 1]
        assert_eq!(clone_and_shuffle(&['a', 'b', 'c'], 1), vec!['c', 'a', 'b']);
        // len 2, seed 7 -> [7 % 2 = 1] = [1, 0]
        assert_eq!(clone_and_shuffle(&[1, 2], 7), vec![2, 1]);
        // len 4, seed 24 -> [24 % 24 = 0] = identity
        assert_eq!(clone_and_shuffle(&[1, 2, 3, 4], 24), vec![1, 2, 3, 4]);
    }

    #[test]
    fn long_shuffle_is_deterministic_permutation() {
        let arr: Vec<i32> = (0..9).collect();
        let s1 = clone_and_shuffle(&arr, 100);
        let s2 = clone_and_shuffle(&arr, 100);
        assert_eq!(s1, s2);
        let mut sorted = s1.clone();
        sorted.sort();
        assert_eq!(sorted, arr);
    }

    #[test]
    fn generator_outputs_are_unit_interval() {
        let mut r = SeededRandom::new(117);
        for _ in 0..1000 {
            let v = r.next();
            assert!((0.0..1.0).contains(&v));
        }
    }
}
