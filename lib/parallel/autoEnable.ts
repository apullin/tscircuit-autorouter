/**
 * Auto-enable policy for the landed worker parallelism (OUR_TODOS G9):
 * node-level HD parallelism (TS_PARALLEL_HD_NODES) and the A2 parallel DRC
 * branch portfolio (TS_PARALLEL_A2).
 *
 * Policy, in precedence order:
 *  1. EXPLICIT ENV ALWAYS WINS. TS_PARALLEL_HD_NODES=N (including 0) and
 *     TS_PARALLEL_A2=0/1 are honored verbatim; the board-size gate below does
 *     NOT apply to explicit values (benchmarks and experiments ask for exact
 *     configurations).
 *  2. When unset, auto-enable only when ALL of:
 *     a. not a browser context (process global present, a usable worker
 *        runtime — Bun's Worker, or node worker_threads with loadable worker
 *        entries (see runtime.nodeWorkerSupport) — and SharedArrayBuffer
 *        available),
 *     b. not benchmark/CI/test mode — the perf harness (benchmark.sh pins
 *        TS_BENCHMARK=1), CI runners (CI) and `bun test` (NODE_ENV=test) must
 *        stay on the sequential default so identity anchors and the suite do
 *        not move,
 *     c. hardware is sane: worker count = min(4, floor(cores/4)), and 0 when
 *        free memory is below 4 GB (a single HD solve can hold a GB-scale
 *        heap; memory, not cores, is the binding constraint on this
 *        workload),
 *  3. the board is worth it: HighDensitySolver gates dispatch on
 *     unsolvedNodePortPoints.length >= MIN_PARALLEL_HD_NODE_COUNT (small
 *     boards stay sequential — worker boot + IPC cannot pay for a handful of
 *     nodes).
 */

import { nodeWorkerRuntimeUsable } from "./runtime"

/** Boards with fewer unsolved nodes than this stay sequential when auto-enabled. */
export const MIN_PARALLEL_HD_NODE_COUNT = 8

/** Explicit TS_PARALLEL_HD_NODES values are capped here (unchanged from before). */
const MAX_EXPLICIT_WORKERS = 32
/** Auto mode never exceeds this many workers. */
const MAX_AUTO_WORKERS = 4
/** One auto worker per this many hardware threads. */
const CORES_PER_AUTO_WORKER = 4
/** Auto mode disables itself below this much free memory. */
const MIN_FREE_MEM_BYTES = 4 * 1024 ** 3

export type ParallelHardware = {
  cores: number
  freeMemBytes: number
  hasWorker: boolean
  hasSharedArrayBuffer: boolean
}

export type ParallelEnv = {
  TS_PARALLEL_HD_NODES?: string | undefined
  TS_PARALLEL_A2?: string | undefined
  TS_BENCHMARK?: string | undefined
  BENCHMARK?: string | undefined
  CI?: string | undefined
  NODE_ENV?: string | undefined
}

export type HdNodeParallelDecision = {
  /** 0 = sequential. */
  workerCount: number
  /** True when the value came from an explicit env var (gates bypassed). */
  explicit: boolean
  reason: string
}

export type A2ParallelDecision = {
  enabled: boolean
  explicit: boolean
  reason: string
}

/**
 * Hardware probe. node:os is pulled in lazily so this module stays importable
 * in browser bundles (hdNodePool is imported unconditionally by
 * HighDensitySolver); when os is unavailable we report 0 cores, which disables
 * auto mode.
 */
export const detectParallelHardware = (): ParallelHardware => {
  let cores = 0
  let freeMemBytes = 0
  try {
    // biome-ignore lint: lazy require is deliberate (browser import-safety)
    const os = require("node:os")
    cores =
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : (os.cpus()?.length ?? 0)
    freeMemBytes = typeof os.freemem === "function" ? os.freemem() : 0
  } catch {
    cores = 0
    freeMemBytes = 0
  }
  return {
    cores,
    freeMemBytes,
    // A global Worker means Bun (or a browser, which the SAB/process gates
    // handle). Without one, node still counts when worker_threads is present
    // AND the worker entries are actually loadable there (prebuilt bundles or
    // a bun CLI to build them — see runtime.nodeWorkerSupport); auto mode
    // must not enable a pool whose creation would throw.
    hasWorker: typeof Worker !== "undefined" || nodeWorkerRuntimeUsable(),
    hasSharedArrayBuffer: typeof SharedArrayBuffer !== "undefined",
  }
}

const envFlagOn = (value: string | undefined): boolean =>
  !!value && value !== "0"

/**
 * Benchmark/CI-like contexts: perf A/B runs must be sequential-by-default for
 * identity anchors, and `bun test` (NODE_ENV=test) must not spawn worker pools
 * inside the suite.
 */
export const isBenchmarkCiOrTestEnv = (env: ParallelEnv): boolean =>
  envFlagOn(env.TS_BENCHMARK) ||
  envFlagOn(env.BENCHMARK) ||
  envFlagOn(env.CI) ||
  env.NODE_ENV === "test"

const autoWorkerCount = (cores: number): number =>
  Math.min(
    MAX_AUTO_WORKERS,
    Math.max(0, Math.floor(cores / CORES_PER_AUTO_WORKER)),
  )

/** Shared auto-mode gates (browser, benchmark/CI/test, memory). Null = allowed. */
const autoDisabledReason = (
  env: ParallelEnv,
  hw: ParallelHardware,
): string | null => {
  if (!hw.hasWorker || !hw.hasSharedArrayBuffer) {
    return "Worker/SharedArrayBuffer unavailable"
  }
  if (isBenchmarkCiOrTestEnv(env)) return "benchmark/CI/test mode"
  if (hw.freeMemBytes < MIN_FREE_MEM_BYTES) {
    return `free memory below ${MIN_FREE_MEM_BYTES / 1024 ** 3}GB`
  }
  return null
}

export const resolveHdNodeParallelism = (
  env?: ParallelEnv,
  hw?: ParallelHardware,
): HdNodeParallelDecision => {
  if (typeof process === "undefined") {
    return { workerCount: 0, explicit: false, reason: "no process global" }
  }
  env ??= process.env
  const raw = env.TS_PARALLEL_HD_NODES
  if (raw !== undefined) {
    const n = Number(raw) || 0
    return {
      workerCount: n > 0 ? Math.min(MAX_EXPLICIT_WORKERS, n) : 0,
      explicit: true,
      reason: "explicit TS_PARALLEL_HD_NODES",
    }
  }
  hw ??= detectParallelHardware()
  const disabled = autoDisabledReason(env, hw)
  if (disabled) return { workerCount: 0, explicit: false, reason: disabled }
  const count = autoWorkerCount(hw.cores)
  return {
    workerCount: count,
    explicit: false,
    reason: count > 0 ? "auto" : `too few cores (${hw.cores})`,
  }
}

export const resolveA2Parallelism = (
  env?: ParallelEnv,
  hw?: ParallelHardware,
): A2ParallelDecision => {
  if (typeof process === "undefined") {
    return { enabled: false, explicit: false, reason: "no process global" }
  }
  env ??= process.env
  const raw = env.TS_PARALLEL_A2
  if (raw !== undefined) {
    return {
      enabled: envFlagOn(raw),
      explicit: true,
      reason: "explicit TS_PARALLEL_A2",
    }
  }
  hw ??= detectParallelHardware()
  const disabled = autoDisabledReason(env, hw)
  if (disabled) return { enabled: false, explicit: false, reason: disabled }
  // A2 spawns exactly 2 compute-heavy workers; require the same cores/4
  // formula to yield at least 2 (i.e. >= 8 hardware threads).
  const enabled = autoWorkerCount(hw.cores) >= 2
  return {
    enabled,
    explicit: false,
    reason: enabled ? "auto" : `too few cores (${hw.cores})`,
  }
}

/**
 * Board-size gate (policy item 3). Applies ONLY to auto mode: an explicit
 * TS_PARALLEL_HD_NODES=N must be able to force parallelism on tiny boards
 * (tests, experiments, benchmarks).
 */
export const gateHdNodeDecisionOnBoardSize = (
  decision: HdNodeParallelDecision,
  unsolvedNodeCount: number,
): HdNodeParallelDecision => {
  if (decision.explicit || decision.workerCount === 0) return decision
  if (unsolvedNodeCount >= MIN_PARALLEL_HD_NODE_COUNT) return decision
  return {
    ...decision,
    workerCount: 0,
    reason: `board below parallel threshold (${unsolvedNodeCount} < ${MIN_PARALLEL_HD_NODE_COUNT} nodes)`,
  }
}
