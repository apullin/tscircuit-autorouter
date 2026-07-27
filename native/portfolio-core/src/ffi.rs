//! C ABI (contract C3, flag TS_NATIVE_PORTFOLIO). Export style mirrors
//! native/replay-core and the awt-r3 hdastar recipe: u64 opaque handles,
//! negative error codes, a last-error string endpoint, caller-provided out
//! buffers. Loaded from bun via bun:ffi (see ../driver.ts).
//!
//!   pf_create(num_threads)                    -> session handle (0 = error)
//!       One session per process; owns the rayon pool AND the cross-node
//!       SharedCache. Cache hits are across solves (§5 "Interaction
//!       structure"), so the cache must outlive individual nodes — this is
//!       why C3's per-node "pf_session" sketch is realized as create-once +
//!       load-node-per-node (see README "ABI notes").
//!   pf_load_node(handle, node_json, len)      -> 0 | -1 error | -2 bad handle
//!       Node-shared input, crosses ONCE per node (1-6 KB typical, §3).
//!   pf_run_portfolio(handle, hp_json, len, tsrec_json, len)
//!                                             -> result byte length
//!                                                | -1 error | -2 bad handle
//!                                                | -3 no node loaded
//!   pf_get_result(handle, out_ptr, out_cap)   -> bytes written
//!                                                | -1 small/null buffer
//!                                                | -2 no result/bad handle
//!       Result JSON = {nodeId, winnerIndex, solved, winnerSource, error,
//!       routes (winner's), perCandidate, replay, cache} — this is the
//!       "get-winner-routes" call; routes ride inside the result document.
//!   pf_last_error(out_ptr, out_cap)           -> bytes | 0 none | -1 small
//!   pf_free(handle)
//!
//! Threading: the FFI itself is single-caller (bun's main thread), like
//! replay-core/hdastar; parallelism lives INSIDE pf_run_portfolio (the
//! session's rayon pool). Panics — including todo!() from pending sibling
//! modules until M1/M2 land — are caught at this boundary and surfaced
//! through pf_last_error instead of unwinding into bun.

use crate::cache::SharedCache;
use crate::contract::NodeSession;
use crate::runtime;
use std::sync::Mutex;

static LAST_ERROR: Mutex<String> = Mutex::new(String::new());

fn set_last_error(msg: String) {
    if let Ok(mut g) = LAST_ERROR.lock() {
        *g = msg;
    }
}

pub struct PfSession {
    pool: rayon::ThreadPool,
    cache: SharedCache,
    node: Option<NodeSession>,
    result: Option<Vec<u8>>,
}

fn default_threads() -> usize {
    // Gate B measures at 8 threads and the box's proven ceiling for heavy
    // concurrent workers is 8; pass num_threads explicitly to override.
    std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1)
        .min(8)
}

/// Create a session: rayon pool (num_threads; 0 = min(available, 8)) plus
/// the cross-node SharedCache. Returns an opaque handle, 0 on error.
#[no_mangle]
pub extern "C" fn pf_create(num_threads: u32) -> u64 {
    let threads = if num_threads == 0 {
        default_threads()
    } else {
        num_threads as usize
    };
    match rayon::ThreadPoolBuilder::new().num_threads(threads).build() {
        Ok(pool) => Box::into_raw(Box::new(PfSession {
            pool,
            cache: SharedCache::new(),
            node: None,
            result: None,
        })) as u64,
        Err(e) => {
            set_last_error(format!("pf_create: {}", e));
            0
        }
    }
}

/// Load the node-shared input (accepted JSON documented on
/// runtime::parse_node_session — the TS_GOLDEN_DUMP "node" line shape).
/// Replaces any previously loaded node and clears the previous result.
#[no_mangle]
pub extern "C" fn pf_load_node(handle: u64, node_json_ptr: *const u8, node_json_len: usize) -> i32 {
    if handle == 0 {
        return -2;
    }
    if node_json_ptr.is_null() || node_json_len == 0 {
        set_last_error("pf_load_node: null/empty buffer".to_string());
        return -1;
    }
    let sess = unsafe { &mut *(handle as *mut PfSession) };
    let bytes = unsafe { std::slice::from_raw_parts(node_json_ptr, node_json_len) };
    sess.result = None;
    match runtime::parse_node_session(bytes) {
        Ok(node) => {
            sess.node = Some(node);
            0
        }
        Err(e) => {
            sess.node = None;
            set_last_error(format!("pf_load_node: {}", e));
            -1
        }
    }
}

/// Run the portfolio for the loaded node. hp_json is the
/// {"initialCount", "externalMaxIterations"?, "emitAllRoutes"?, "hps": [...]}
/// wrapper (hps = full marshaled candidate list in TS enumeration order);
/// tsrec_json is the array of TS-executed candidate records (may be null /
/// zero-length / "null" / "[]"). Returns the result JSON's byte length
/// (fetch with pf_get_result), or a negative error code.
#[no_mangle]
pub extern "C" fn pf_run_portfolio(
    handle: u64,
    hp_json_ptr: *const u8,
    hp_json_len: usize,
    tsrec_json_ptr: *const u8,
    tsrec_json_len: usize,
) -> i64 {
    if handle == 0 {
        return -2;
    }
    let sess = unsafe { &mut *(handle as *mut PfSession) };
    // Split borrows: node (shared) + cache (mut, for the §5 commit) + pool.
    let PfSession {
        pool,
        cache,
        node,
        result,
    } = sess;
    let Some(node) = node.as_ref() else {
        set_last_error("pf_run_portfolio: no node loaded".to_string());
        return -3;
    };
    if hp_json_ptr.is_null() || hp_json_len == 0 {
        set_last_error("pf_run_portfolio: null/empty hp list".to_string());
        return -1;
    }
    let hp_bytes = unsafe { std::slice::from_raw_parts(hp_json_ptr, hp_json_len) };
    let ts_bytes: &[u8] = if tsrec_json_ptr.is_null() || tsrec_json_len == 0 {
        &[]
    } else {
        unsafe { std::slice::from_raw_parts(tsrec_json_ptr, tsrec_json_len) }
    };

    // Panic barrier: pending sibling stubs (todo!) and contract violations
    // become error codes, never unwinds across the C boundary.
    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        runtime::run_portfolio(node, cache, pool, hp_bytes, ts_bytes)
    }));
    match outcome {
        Ok(Ok(json)) => {
            let bytes = json.into_bytes();
            let len = bytes.len() as i64;
            *result = Some(bytes);
            len
        }
        Ok(Err(e)) => {
            set_last_error(format!("pf_run_portfolio: {}", e));
            -1
        }
        Err(payload) => {
            let msg = if let Some(s) = payload.downcast_ref::<&str>() {
                (*s).to_string()
            } else if let Some(s) = payload.downcast_ref::<String>() {
                s.clone()
            } else {
                "unknown panic".to_string()
            };
            set_last_error(format!("pf_run_portfolio: panic: {}", msg));
            -1
        }
    }
}

/// Copy the last pf_run_portfolio result JSON into out_ptr. Returns bytes
/// written, -1 if the buffer is null/too small, -2 when there is no result
/// (or bad handle).
#[no_mangle]
pub extern "C" fn pf_get_result(handle: u64, out_ptr: *mut u8, out_cap: usize) -> i64 {
    if handle == 0 {
        return -2;
    }
    let sess = unsafe { &*(handle as *const PfSession) };
    let Some(bytes) = sess.result.as_ref() else {
        return -2;
    };
    if out_ptr.is_null() || bytes.len() > out_cap {
        return -1;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(bytes.as_ptr(), out_ptr, bytes.len());
    }
    bytes.len() as i64
}

/// Copy the last error message; returns bytes written (0 when there is no
/// error, -1 if the buffer is too small/null). Same shape as replay-core's
/// replay_last_error.
#[no_mangle]
pub extern "C" fn pf_last_error(out_ptr: *mut u8, out_cap: usize) -> i64 {
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

/// Free a session (pool, cache, node, result).
#[no_mangle]
pub extern "C" fn pf_free(handle: u64) {
    if handle == 0 {
        return;
    }
    unsafe {
        drop(Box::from_raw(handle as *mut PfSession));
    }
}
