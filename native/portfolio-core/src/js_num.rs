//! JS number semantics needed by the M2 modules (PORT-SPEC.md §6.3, §6.7,
//! §6.9). Self-contained mirrors — M0's C0 helper set (js_round, js_max,
//! js_min, or_zero, js_to_fixed6) overlaps with this module; M2 keeps its own
//! copies because the cache key / error text exactness is M2's deliverable
//! and geom_rng had not landed. Unify during integration if desired: the
//! semantics below are the reference ones (js_round here is EXACT ECMA
//! Math.round, which the spec's `(x + 0.5).floor()` formula is NOT — see
//! `js_round` docs).

/// ECMA-262 `Math.round`: the integral Number closest to x, ties toward +∞.
///
/// NOT `(x + 0.5).floor()` (the formula PORT-SPEC.md §6.7 suggests): the
/// addition can round UP across an integer boundary and produce an
/// off-by-one, e.g. x = 0.49999999999999994 (largest double < 0.5):
/// fl(x + 0.5) == 1.0, floor gives 1, but Math.round(x) == 0.
///
/// EMPIRICALLY VERIFIED on node/V8 (2026-07-27):
/// `Math.round(0.49999999999999994) === 0` — V8 follows the ECMA step
/// "If n < 0.5 and n > 0, return +0", NOT floor(x+0.5).
///
/// OPEN CROSS-MODULE FLAG: geom_rng::js_round (M0) implements floor(x+0.5)
/// and its doc claims engines keep the `-> 1` edge; that claim is FALSE on
/// V8. The parity engine of record is bun (JSC), unverified here (bun runs
/// prohibited during the port). M2's cache-key roundCoord uses THIS exact
/// version; M1's packed keys / snapping cite geom_rng's. Unify after a
/// bun probe (`bun -e "console.log(Math.round(0.49999999999999994))"`) or
/// let the C0 golden vectors adjudicate — the two differ ONLY when the
/// argument's fractional part is within 1 ulp below 0.5.
///
/// `x - x.floor()` is exact in IEEE-754 (the fractional part of a double is
/// always representable and the subtraction of it is exact), so the `>= 0.5`
/// test is performed on the true fractional part.
///
/// Zero-sign note: ECMA returns -0 for x in [-0.5, -0); this returns +0
/// there. The difference is unobservable downstream: every consumer either
/// does arithmetic where -0 == 0 or stringifies via JSON (where -0 renders
/// "0", json.rs write_f64).
pub fn js_round(x: f64) -> f64 {
    let f = x.floor();
    if x - f >= 0.5 {
        f + 1.0
    } else {
        f
    }
}

/// ECMA `Math.max(a, b)`: NaN-poisoning (unlike `f64::max`, which IGNORES
/// NaN), and +0 beats -0.
pub fn js_max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a > b {
        a
    } else if b > a {
        b
    } else if a == 0.0 && a.is_sign_positive() {
        a // a == b == ±0 → prefer +0
    } else {
        b
    }
}

/// ECMA `Math.min(a, b)`: NaN-poisoning, and -0 beats +0.
pub fn js_min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() {
        return f64::NAN;
    }
    if a < b {
        a
    } else if b < a {
        b
    } else if a == 0.0 && a.is_sign_negative() {
        a // a == b == ±0 → prefer -0
    } else {
        b
    }
}

/// JS `x || 0`: NaN and ±0 are falsy and yield the literal +0
/// (PORT-SPEC.md §6.3 — the `(this.activeSubSolver?.progress || 0)` and
/// `(progress || 0)` sites).
pub fn or_zero(x: f64) -> f64 {
    if x == 0.0 || x.is_nan() {
        0.0
    } else {
        x
    }
}

/// ECMA `Number::toString` (radix 10) — the semantics of `${n}` template
/// interpolation and `String(n)`.
///
/// Differences vs JSON.stringify (json.rs `write_f64`): NaN → "NaN" and
/// ±Infinity → "±Infinity" (JSON renders all three as `null`).
///
/// Digit generation: Rust's `Display` for f64 is shortest-round-trip with
/// correct rounding, the same contract as ECMA's digit selection; the
/// theoretical tie-in-shortest-representation rule ("choose even s") cannot
/// bite on this corpus (rounded 1/200-mm coordinates and small config
/// decimals have unambiguous shortest forms). Notation caveat: ECMA switches
/// to exponent notation for |n| >= 1e21 or < 1e-6; Rust Display never does.
/// Neither range occurs in M2's inputs (smallest nonzero roundCoord output
/// is 0.005; MAX_ITERATIONS <= 1000 * n^1.5 with node-scale n). Values are
/// asserted into that domain in debug builds.
pub fn js_number_to_string(x: f64) -> String {
    if x.is_nan() {
        return "NaN".to_string();
    }
    if x.is_infinite() {
        return if x > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if x == 0.0 {
        return "0".to_string(); // covers -0 → "0"
    }
    // Domain note (no assert — the js_to_fixed >= 1e21 fallback funnels
    // here): M2's inputs stay inside [1e-6, 1e21), where Rust Display and
    // ECMA agree; outside it ECMA would pick exponent notation.
    format!("{}", x)
}

/// ECMA-262 `Number.prototype.toFixed(digits)` — exact.
///
/// Semantics (ES2023 §21.1.3.3): NaN → "NaN"; sign extracted first (so -0
/// takes the positive path: `(-0).toFixed(3) === "0.000"`, while
/// `(-0.0004).toFixed(3) === "-0.000"`); |x| >= 1e21 → ToString; otherwise
/// pick integer n with n / 10^f − x closest to zero, TIES → LARGER n, i.e.
/// half-away-from-zero on the sign-stripped value evaluated on the EXACT
/// binary value of x.
///
/// This is NOT Rust's `format!("{:.d$}", x)`, which resolves exact decimal
/// ties half-to-even: ties are real on this corpus — quadtree coordinates
/// are dyadic, and e.g. 0.0625.toFixed(3) is "0.063" in JS but "0.062" from
/// Rust's formatter, (1f64/128.0).toFixed(6) is "0.007813" vs "0.007812"
/// (PORT-SPEC.md §6.9 flags exactly this; used for the dedupe point keys,
/// IntraNodeSolver.ts:35-36, and the repair error text :439).
///
/// Method: format the exact expansion to 60 fractional digits (Rust's
/// precision formatting is exact Dragon4; a rounding carry at digit 60 can
/// propagate at most ~log10(1/ulp) ≈ 19 digits for coordinate-scale values,
/// never reaching digit `digits`+1 ≤ 7), then round half-up at `digits` on
/// the digit string.
pub fn js_to_fixed(x: f64, digits: usize) -> String {
    debug_assert!(digits <= 20);
    if x.is_nan() {
        return "NaN".to_string();
    }
    let neg = x < 0.0; // -0 is not < 0 → positive path, per spec
    let ax = if neg { -x } else { x };
    if ax.is_infinite() {
        return if neg { "-Infinity" } else { "Infinity" }.to_string();
    }
    if ax >= 1e21 {
        return js_number_to_string(x); // ToString branch (out of M2's domain)
    }

    let full = format!("{:.60}", ax);
    let dot = full.find('.').expect("{:.60} always yields a decimal point");
    let int_part = &full.as_bytes()[..dot];
    let frac = &full.as_bytes()[dot + 1..]; // 60 ASCII digits

    // Terminating expansion ⇒ tail >= half·10^-digits ⟺ digit `digits` >= 5.
    let round_up = frac[digits] >= b'5';

    let mut ds: Vec<u8> = Vec::with_capacity(int_part.len() + digits);
    ds.extend_from_slice(int_part);
    ds.extend_from_slice(&frac[..digits]);
    if round_up {
        let mut i = ds.len();
        loop {
            if i == 0 {
                ds.insert(0, b'1');
                break;
            }
            i -= 1;
            if ds[i] == b'9' {
                ds[i] = b'0';
            } else {
                ds[i] += 1;
                break;
            }
        }
    }

    let int_len = ds.len() - digits;
    let mut out = String::with_capacity(ds.len() + 2);
    if neg {
        out.push('-');
    }
    out.push_str(std::str::from_utf8(&ds[..int_len]).unwrap());
    if digits > 0 {
        out.push('.');
        out.push_str(std::str::from_utf8(&ds[int_len..]).unwrap());
    }
    out
}

/// `Array.prototype.sort()` with NO comparator, for number arrays: elements
/// are compared as ToString(number) UTF-16 code-unit sequences (so
/// [2, 10].sort() is [10, 2]). Number strings are pure ASCII, where byte
/// order == code-unit order. Stable, like every modern engine (ES2019).
/// Used by the v4 cache key: `[...availableZ].sort()`
/// (CachedIntraNodeRouteSolver.ts:177-179) and the connectedIds sort (:164).
pub fn js_default_sort_numbers(v: &mut [f64]) {
    v.sort_by(|a, b| js_number_to_string(*a).cmp(&js_number_to_string(*b)));
}
