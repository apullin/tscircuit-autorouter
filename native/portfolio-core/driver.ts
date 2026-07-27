/**
 * bun:ffi driver for the Rust portfolio runtime (native/portfolio-core) —
 * contract C3, flag TS_NATIVE_PORTFOLIO. Loading pattern mirrors
 * native/replay-core/harness.ts and awt-r3/native/hdastar/a01NativeDriver.ts.
 *
 * TWO ROLES IN ONE FILE (the M3 deliverable allows exactly one TS file):
 *
 *  1) Library: `nativePortfolioStep(solver)` — the drop-in native path for
 *     PortfolioSingleIntraNodeSolver.
 *
 *     INTEGRATION POINT (coordinator wires this; lib/ is NOT modified here).
 *     In lib/solvers/HyperHighDensitySolver/PortfolioSingleIntraNodeSolver.ts
 *     `_step()`, FIRST lines — same gate pattern as parallelPortfolioEnabled
 *     (the sequential supervisor remains the fallback when the flag is off):
 *
 *       override _step() {
 *         if (
 *           typeof process !== "undefined" &&
 *           (Number(process.env.TS_NATIVE_PORTFOLIO ?? 0) || 0) > 0
 *         ) {
 *           // Lazy require keeps the main build free of native/ deps.
 *           const { nativePortfolioStep } =
 *             require("../../../native/portfolio-core/driver")
 *           nativePortfolioStep(this)
 *           return
 *         }
 *         ...existing body...
 *       }
 *
 *     TS_NATIVE_PORTFOLIO=1 enables with auto thread count (min(cores, 8));
 *     TS_NATIVE_PORTFOLIO=N (N>1) pins N rayon threads. Parity runs must
 *     leave the section-3 global knobs unset (TS_MAX_EXHAUSTIONS,
 *     TS_ABANDON_MAX_PROGRESS, TS_NODE_WORK_CAP, TS_LEAN_PORTFOLIO) — this
 *     path mirrors parallelReplayStep, which ignores them.
 *
 *     SEQUENTIAL MODE (post-Gate-B): TS_NATIVE_PORTFOLIO=seq (or
 *     TS_NATIVE_PORTFOLIO_SEQ=1 alongside TS_NATIVE_PORTFOLIO=1) selects the
 *     live-sequential supervisor mirror (src/seq.rs, hp-wrapper
 *     "mode":"seq"): single-threaded, work-avoiding, winner-identical to the
 *     live TS schedule. Expensive non-dominant candidates (A01/A03/polyline)
 *     ship as ctor-state stubs and are executed TS-side only when the native
 *     schedule picks one (needTsCandidates retry loop) — see
 *     INSTANT_HP_KEYS.
 *
 *  2) CLI: the golden-verification comparator (PORT-SPEC section 7):
 *       bun native/portfolio-core/driver.ts <golden.jsonl>
 *            [--lib <so>] [--threads N] [--shared-cache] [--max-nodes N]
 *            [--verbose]
 *     Feeds every golden node through the native runtime (golden records of
 *     non-dominant candidates become tsrec), then compares per Rust
 *     candidate: solved, iterations, maxIterations (validates the n**1.5
 *     budget), traj (exact f64 equality — both sides are exact f32
 *     widenings), routes deep-equal AFTER TS-side extractWinningRoutes
 *     normalization (the golden stores post-extract routes,
 *     portfolioReplayWorker.ts:112), and the winner index.
 *     Exit codes: 0 parity, 1 mismatches, 2 usage/load error.
 */

import { dlopen, FFIType, suffix } from "bun:ffi"
import { createReadStream } from "node:fs"
import { createInterface } from "node:readline"
import path from "node:path"
import { decimateTrajectory, SAMPLE_STRIDE } from "../replay-core/datasetFormat"
import { extractWinningRoutes } from "../../lib/solvers/HyperHighDensitySolver/extractWinningRoutes"

// ---------------------------------------------------------------------------
// FFI plumbing
// ---------------------------------------------------------------------------

const defaultLibPath = path.join(
  import.meta.dir,
  "target",
  "release",
  `libportfolio_core.${suffix}`,
)

const openLib = (libPath: string) =>
  dlopen(libPath, {
    pf_create: { args: [FFIType.u32], returns: FFIType.u64 },
    pf_load_node: {
      args: [FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
    pf_run_portfolio: {
      args: [FFIType.u64, FFIType.ptr, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    pf_get_result: {
      args: [FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    pf_last_error: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    pf_free: { args: [FFIType.u64], returns: FFIType.void },
  })

type PfLib = ReturnType<typeof openLib>

const errBuf = new Uint8Array(8192)
const enc = new TextEncoder()
const dec = new TextDecoder()

const lastError = (lib: PfLib): string => {
  const n = Number(lib.symbols.pf_last_error(errBuf, errBuf.byteLength))
  return n > 0 ? dec.decode(errBuf.subarray(0, n)) : "(no error message)"
}

export type NativePortfolioResult = {
  nodeId: string
  /** "seq" results carry the mode marker; rtc results omit it. */
  mode?: "seq"
  /**
   * seq mode only: the schedule PICKED one of these tsrec stubs and needs
   * the real record — run them TS-side (runTsCandidate) and re-run the node
   * (nothing was committed; the re-run replays deterministically from the
   * identical pre-node cache). See src/seq.rs DIFF-3.
   */
  needTsCandidates?: number[]
  winnerIndex: number
  solved: boolean
  winnerSource: "rust" | "ts" | null
  error: string | null
  routes: unknown[] | null
  perCandidate: Array<{
    i: number
    source: "rust" | "ts"
    solved: boolean
    /** seq mode: current live failed state (rtc encodes failure as !solved). */
    failed?: boolean
    iterations: number
    maxIterations: number
    solvedSegments: number
    /** seq mode: the schedule picked this candidate at least once. */
    stepped?: boolean
    /** seq mode: reached a terminal state under the sequential schedule. */
    completed?: boolean
    /** seq mode: this record was still a ctor-state stub at the end. */
    stub?: boolean
    traj?: number[]
    error?: string
    routes?: unknown[]
  }>
  replay: {
    expanded: boolean
    totalCandidateWork: number
    rounds: number
    ceilingHit: boolean
    replayCoreDetail: unknown
  }
  cache: { pending: number; committed: number; size: number }
}

export type TsCandidateRecord = {
  i: number
  solved: boolean
  iterations: number
  maxIterations: number
  solvedSegments: number
  traj: number[]
  routes: unknown[] | null
  error?: string
  /**
   * seq-mode ctor-state stub (runTsCandidateStub): maxIterations + the
   * construction-time solved/failed flags only; iterations 0, traj empty.
   * The native schedule aborts with needTsCandidates when it first PICKS a
   * stub. Invalid in rtc mode.
   */
  stub?: boolean
  /** Stubs only: failed AT CONSTRUCTION (e.g. ineligible singleLayer). */
  failed?: boolean
}

export class NativePortfolioSession {
  private lib: PfLib
  private handle: bigint

  constructor(opts: { threads?: number; libPath?: string } = {}) {
    this.lib = openLib(opts.libPath ?? defaultLibPath)
    this.handle = this.lib.symbols.pf_create(
      opts.threads ?? 0,
    ) as unknown as bigint
    if (this.handle === 0n) {
      throw new Error(`pf_create failed: ${lastError(this.lib)}`)
    }
  }

  loadNode(nodeInput: Record<string, unknown>): void {
    const bytes = enc.encode(JSON.stringify(nodeInput))
    const rc = this.lib.symbols.pf_load_node(
      this.handle,
      bytes,
      bytes.byteLength,
    ) as number
    if (rc !== 0) {
      throw new Error(`pf_load_node failed (${rc}): ${lastError(this.lib)}`)
    }
  }

  runPortfolio(run: {
    initialCount: number
    hps: Array<Record<string, unknown>>
    tsrec: TsCandidateRecord[]
    externalMaxIterations?: number | null
    emitAllRoutes?: boolean
    /** "rtc" (default) or "seq" — src/runtime.rs RunMode. */
    mode?: "rtc" | "seq"
  }): NativePortfolioResult {
    const hpJson = enc.encode(
      JSON.stringify({
        initialCount: run.initialCount,
        externalMaxIterations: run.externalMaxIterations ?? null,
        emitAllRoutes: run.emitAllRoutes ?? false,
        mode: run.mode ?? "rtc",
        hps: run.hps,
      }),
    )
    const tsJson = enc.encode(JSON.stringify(run.tsrec))
    const len = Number(
      this.lib.symbols.pf_run_portfolio(
        this.handle,
        hpJson,
        hpJson.byteLength,
        tsJson,
        tsJson.byteLength,
      ),
    )
    if (len < 0) {
      throw new Error(`pf_run_portfolio failed (${len}): ${lastError(this.lib)}`)
    }
    const out = new Uint8Array(len)
    const written = Number(
      this.lib.symbols.pf_get_result(this.handle, out, out.byteLength),
    )
    if (written !== len) {
      throw new Error(`pf_get_result failed (${written}): ${lastError(this.lib)}`)
    }
    return JSON.parse(dec.decode(out)) as NativePortfolioResult
  }

  free(): void {
    if (this.handle !== 0n) {
      this.lib.symbols.pf_free(this.handle)
      this.handle = 0n
    }
  }
}

// ---------------------------------------------------------------------------
// Candidate-class split + TS-side execution (non-dominant classes)
// ---------------------------------------------------------------------------

/**
 * Marker keys that route generateSolver to a NON-default branch
 * (PortfolioSingleIntraNodeSolver.ts:969-1069). A candidate with none of
 * these is the dominant CachedIntraNodeRouteSolver class and runs in Rust.
 * The Rust side re-validates this split (runtime.rs NON_DOMINANT_HP_KEYS).
 */
const NON_DOMINANT_HP_KEYS = [
  "SINGLE_LAYER_NO_DIFFERENT_ROOT_INTERSECTIONS",
  "HIGH_DENSITY_A01",
  "HIGH_DENSITY_A03",
  "CLOSED_FORM_TWO_TRACE_SAME_LAYER",
  "CLOSED_FORM_TWO_TRACE_TRANSITION_CROSSING",
  "CLOSED_FORM_SINGLE_TRANSITION",
  "THROUGH_OBSTACLE",
  "MULTI_HEAD_POLYLINE_SOLVER",
] as const

export const isDominantHp = (hp: Record<string, unknown>): boolean =>
  !NON_DOMINANT_HP_KEYS.some((k) => hp[k])

/**
 * Seq-mode TS-side execution policy. The "instant" classes finish at 0-1
 * iterations (measured on golden-s8: throughObstacle/closedForm always 0,
 * singleLayer <= 1) — running them eagerly costs nothing and the live
 * schedule always steps them first anyway (indices 0-1, f = g(0) = 0). The
 * expensive classes (A01 mean ~50k iterations, A03 ~5k, polyline ~53) start
 * as ctor-state STUBS and are only run when the native schedule actually
 * PICKS one (needTsCandidates retry) — on golden-s8, 951/1209 winners land
 * at index 0-9, where the live schedule never touches A01/A03/polyline at
 * all; eager full pre-runs would re-create the Gate B work multiplier on
 * the TS side.
 */
const INSTANT_HP_KEYS = [
  "THROUGH_OBSTACLE",
  "SINGLE_LAYER_NO_DIFFERENT_ROOT_INTERSECTIONS",
  "CLOSED_FORM_SINGLE_TRANSITION",
  "CLOSED_FORM_TWO_TRACE_SAME_LAYER",
  "CLOSED_FORM_TWO_TRACE_TRANSITION_CROSSING",
] as const

const isInstantHp = (hp: Record<string, unknown>): boolean =>
  INSTANT_HP_KEYS.some((k) => hp[k])

/** Adaptive-expansion candidates: ORDERING_SHUFFLE_SEEDS.slice(1)
 * (PortfolioSingleIntraNodeSolver.ts:39, 548, 659-661). Keep in sync. */
const EXPANSION_SHUFFLE_SEEDS = [1, 2, 3, 4, 5]

/** Minimal structural view of PortfolioSingleIntraNodeSolver used here —
 * structural (not an import) so this module adds no lib/ dependency edge
 * beyond extractWinningRoutes. */
export type PortfolioLike = {
  nodeWithPortPoints: {
    capacityMeshNodeId?: string
    portPoints: Array<{ connectionName: string }>
  }
  constructorParams: Record<string, unknown>
  effort?: number
  externalMaxIterations?: number | null
  getHyperParameterDefs(): Array<{ name: string; possibleValues: unknown[] }>
  getCombinationDefs(): Array<string[]> | null
  getHyperParameterCombinations(
    defs?: Array<{ name: string; possibleValues: unknown[] }>,
  ): Array<Record<string, unknown>>
  generateSolver(hp: Record<string, unknown>): unknown
  solvedRoutes: unknown[]
  solved: boolean
  failed: boolean
  error: string | null
  progress: number
  stats: Record<string, unknown>
}

/** Mirror of the worker's solvedSegments probe (portfolioReplayWorker.ts:85-97). */
const solvedSegmentsOf = (solver: unknown): number => {
  const map = (solver as { solvedConnectionsMap?: Map<unknown, unknown> })
    .solvedConnectionsMap
  if (!(map instanceof Map)) return -1
  let count = 0
  for (const routes of map.values()) {
    if (Array.isArray(routes)) count += routes.length
  }
  return count
}

/**
 * Run one NON-dominant candidate in-process, exactly the replay-worker way
 * (portfolioReplayWorker.ts:74-131): generateSolver + idempotent setup +
 * step-to-completion with per-iteration progress samples, then decimate to
 * the schedule grid (bit-exact, datasetFormat.decimateTrajectory) and apply
 * extractWinningRoutes to solved routes (so tsrec routes are post-extract,
 * matching the worker and the golden capture).
 */
export const runTsCandidate = (
  portfolio: PortfolioLike,
  hp: Record<string, unknown>,
  index: number,
): TsCandidateRecord => {
  const solver = portfolio.generateSolver(hp) as {
    solved: boolean
    failed: boolean
    error?: string | null
    iterations: number
    MAX_ITERATIONS: number
    progress: number
    step(): void
    setup?: () => void
  }
  if ("setup" in solver && typeof solver.setup === "function") {
    solver.setup.call(solver)
  }
  const maxIterations = solver.MAX_ITERATIONS
  const progressSamples: number[] = []
  while (!solver.solved && !solver.failed) {
    solver.step()
    const p = solver.progress || 0 // NaN collapses to 0, as downstream
    progressSamples.push(Number.isFinite(p) ? p : 0)
  }
  const traj = Array.from(
    decimateTrajectory(Float32Array.from(progressSamples), solver.iterations),
  )
  return {
    i: index,
    solved: !!solver.solved,
    iterations: solver.iterations,
    maxIterations,
    solvedSegments: solvedSegmentsOf(solver),
    traj,
    routes: solver.solved
      ? (extractWinningRoutes(
          solver as object,
          portfolio.nodeWithPortPoints as never,
        ) as unknown[])
      : null,
    error: solver.failed ? (solver.error ?? "failed") : undefined,
  }
}

/**
 * Seq mode: build a ctor-state STUB for one non-dominant candidate —
 * generateSolver + idempotent setup, NO stepping. This is exactly the live
 * initializeSolvers cost for that candidate
 * (PortfolioSingleIntraNodeSolver.ts:509-528: construct + setup every
 * candidate before any step), and it captures everything the schedule can
 * observe before first picking it: post-setup MAX_ITERATIONS and the
 * ctor-time solved/failed flags.
 */
export const runTsCandidateStub = (
  portfolio: PortfolioLike,
  hp: Record<string, unknown>,
  index: number,
): TsCandidateRecord => {
  const solver = portfolio.generateSolver(hp) as {
    solved: boolean
    failed: boolean
    error?: string | null
    MAX_ITERATIONS: number
    setup?: () => void
  }
  if ("setup" in solver && typeof solver.setup === "function") {
    solver.setup.call(solver)
  }
  return {
    i: index,
    stub: true,
    solved: !!solver.solved,
    failed: !!solver.failed,
    iterations: 0,
    maxIterations: solver.MAX_ITERATIONS,
    solvedSegments: -1,
    traj: [],
    routes: null,
    error: solver.failed ? (solver.error ?? "failed") : undefined,
  }
}

// ---------------------------------------------------------------------------
// Node-shared input marshaling (the golden "node" line shape — the same
// object shape pf_load_node parses; see runtime.rs parse_node_session)
// ---------------------------------------------------------------------------

/** connMap slice — mirror of native/replay-core/goldenDump.ts:59-86. */
const connMapSlice = (
  connMap: unknown,
  connectionNames: string[],
): { idToNet: Record<string, string>; nets: Record<string, string[]> } | null => {
  const m = connMap as
    | { idToNetMap?: Record<string, string>; netMap?: Record<string, string[]> }
    | undefined
  if (!m?.idToNetMap || !m?.netMap) return null
  const idToNet: Record<string, string> = {}
  const nets: Record<string, string[]> = {}
  for (const name of connectionNames) {
    const net = m.idToNetMap[name]
    if (net !== undefined) {
      idToNet[name] = net
      if (!(net in nets)) nets[net] = m.netMap[net] ?? []
    }
    // The cache key calls getIdsConnectedToNet(connectionName), treating the
    // connection name itself as a net id. Preserve that lookup too.
    if (name in m.netMap && !(name in nets)) nets[name] = m.netMap[name]!
  }
  return { idToNet, nets }
}

export const buildNodeInput = (
  portfolio: PortfolioLike,
): Record<string, unknown> => {
  const p = portfolio.constructorParams as Record<string, unknown>
  const nwpp = portfolio.nodeWithPortPoints
  const connectionNames = [
    ...new Set(nwpp.portPoints.map((pt) => pt.connectionName)),
  ]
  return {
    nodeId: String(nwpp.capacityMeshNodeId ?? ""),
    node: nwpp,
    params: {
      traceWidth: p.traceWidth,
      viaDiameter: p.viaDiameter,
      obstacleMargin: p.obstacleMargin,
      effort: portfolio.effort ?? (p.effort as number | undefined),
    },
    connMap: connMapSlice(p.connMap, connectionNames),
  }
}

// ---------------------------------------------------------------------------
// The native portfolio step (library role)
// ---------------------------------------------------------------------------

let globalSession: NativePortfolioSession | null = null

/**
 * Sequential mode selector: TS_NATIVE_PORTFOLIO_SEQ=1, or
 * TS_NATIVE_PORTFOLIO=seq. The sequential schedule runs on the FFI caller's
 * thread — the session's rayon pool is never used in this mode (src/seq.rs).
 */
export const seqModeSelected = (): boolean =>
  typeof process !== "undefined" &&
  (process.env.TS_NATIVE_PORTFOLIO === "seq" ||
    (Number(process.env.TS_NATIVE_PORTFOLIO_SEQ ?? 0) || 0) > 0)

/** One session per process: the Rust SharedCache must persist across nodes
 * (all cache hits are across solves — PORT-SPEC section 5). */
export const getNativeSession = (): NativePortfolioSession => {
  if (!globalSession) {
    const flag = Number(process.env.TS_NATIVE_PORTFOLIO ?? 0) || 0
    globalSession = new NativePortfolioSession({
      // seq mode: single thread — the pool is idle by design; keep it
      // minimal instead of spawning min(cores, 8) sleeping workers.
      threads: seqModeSelected() ? 1 : flag > 1 ? flag : 0,
    })
  }
  return globalSession
}

/**
 * Replacement for one PortfolioSingleIntraNodeSolver._step under
 * TS_NATIVE_PORTFOLIO (see module doc for the exact integration snippet).
 *
 * The candidate enumeration below is executed through the SOLVER'S OWN
 * methods — a line mirror of parallelReplayStep
 * (PortfolioSingleIntraNodeSolver.ts:645-661) — so the hp list, its ORDER
 * (= the tie-break index) and the expansion tail are marshaled from TS,
 * never re-derived natively (PORT-SPEC section 2b).
 */
export const nativePortfolioStep = (portfolio: PortfolioLike): void => {
  const defs = portfolio.getHyperParameterDefs()
  const combinationDefs = portfolio.getCombinationDefs() ?? [
    defs.map((def) => def.name),
  ]
  const hyperParameterList: Array<Record<string, unknown>> = []
  for (const combinationDef of combinationDefs) {
    hyperParameterList.push(
      ...portfolio.getHyperParameterCombinations(
        defs.filter((hpd) => combinationDef.includes(hpd.name)),
      ),
    )
  }
  const initialCount = hyperParameterList.length
  for (const shuffleSeed of EXPANSION_SHUFFLE_SEEDS) {
    hyperParameterList.push({ HIGH_DENSITY_A01: true, SHUFFLE_SEED: shuffleSeed })
  }

  const seq = seqModeSelected()

  // Non-dominant classes run TS-side (increment 1 policy, PORT-SPEC 2b/C3);
  // their records merge into the same selection by index. rtc runs them all
  // to completion up-front; seq runs only the instant classes eagerly and
  // ships ctor-state stubs for the expensive ones (see INSTANT_HP_KEYS doc),
  // upgrading a stub to a full record only when the native schedule PICKS it
  // (needTsCandidates retry below).
  const tsrecByIndex = new Map<number, TsCandidateRecord>()
  for (let i = 0; i < hyperParameterList.length; i++) {
    const hp = hyperParameterList[i]!
    if (isDominantHp(hp)) continue
    tsrecByIndex.set(
      i,
      !seq || isInstantHp(hp)
        ? runTsCandidate(portfolio, hp, i)
        : runTsCandidateStub(portfolio, hp, i),
    )
  }

  const session = getNativeSession()
  session.loadNode(buildNodeInput(portfolio))
  let res: NativePortfolioResult
  let seqFetches = 0
  for (let attempt = 0; ; attempt++) {
    res = session.runPortfolio({
      initialCount,
      hps: hyperParameterList,
      tsrec: [...tsrecByIndex.values()],
      externalMaxIterations: portfolio.externalMaxIterations ?? null,
      mode: seq ? "seq" : "rtc",
    })
    const need = res.needTsCandidates
    if (!need || need.length === 0) break
    // The sequential schedule wants these candidates' real behavior: run
    // them TS-side (deterministic — the record equals what the live
    // schedule would have observed) and re-run the node. Nothing was
    // committed on the need path, so the re-run replays the identical
    // schedule prefix from the identical pre-node cache.
    if (attempt >= 8) {
      throw new Error(
        `native seq mode did not converge after ${attempt} tsrec fetch rounds (need=[${need.join(",")}])`,
      )
    }
    for (const i of need) {
      seqFetches++
      tsrecByIndex.set(i, runTsCandidate(portfolio, hyperParameterList[i]!, i))
    }
  }

  if (res.winnerIndex >= 0 && res.routes) {
    // Rust winners return RAW solvedRoutes: apply the TS-side normalization
    // once (extractWinningRoutes = rootConnectionName annotation + same-root
    // repair — PORT-SPEC section 2b). TS winners' routes are already
    // post-extract (runTsCandidate applied it, worker semantics).
    portfolio.solvedRoutes =
      res.winnerSource === "rust"
        ? (extractWinningRoutes(
            { solvedRoutes: res.routes } as object,
            portfolio.nodeWithPortPoints as never,
          ) as unknown[])
        : res.routes
    portfolio.solved = true
    portfolio.progress = 1
    portfolio.stats.nativePortfolio = true
    portfolio.stats.nativePortfolioWinnerIndex = res.winnerIndex
    portfolio.stats.nativePortfolioWinnerSource = res.winnerSource
    portfolio.stats.nativePortfolioCacheCommitted = res.cache.committed
  } else {
    portfolio.failed = true
    portfolio.error = res.error ?? "All candidates failed in native portfolio"
  }
  if (seq) {
    portfolio.stats.nativePortfolioSeq = true
    portfolio.stats.nativePortfolioSeqFetches = seqFetches
    portfolio.stats.nativePortfolioSeqRounds = res.replay.rounds
  }
}

// ---------------------------------------------------------------------------
// Golden comparator CLI (PORT-SPEC section 7 acceptance, Gate A feeder)
// ---------------------------------------------------------------------------

type GoldenNodeLine = {
  t: "node"
  nodeId: string
  nodeSegmentCount: number
  initialCount: number
  winnerIndex: number
  node: { portPoints: Array<{ connectionName: string }> }
  params: Record<string, unknown>
  connMap: unknown
}

type GoldenCandLine = {
  t: "cand"
  nodeId: string
  i: number
  hp: Record<string, unknown>
  solved: boolean
  iterations: number
  maxIterations: number
  solvedSegments: number
  routes: unknown[] | null
  error?: string
  traj: number[]
}

const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true
  if (typeof a !== typeof b) return false
  if (a === null || b === null) return false
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false
    }
    for (let i = 0; i < a.length; i++) {
      if (!deepEqual(a[i], b[i])) return false
    }
    return true
  }
  if (typeof a === "object") {
    const ao = a as Record<string, unknown>
    const bo = b as Record<string, unknown>
    for (const k of new Set([...Object.keys(ao), ...Object.keys(bo)])) {
      if (!deepEqual(ao[k], bo[k])) return false
    }
    return true
  }
  return false
}

const goldenMain = async () => {
  const args = process.argv.slice(2)
  let goldenPath: string | null = null
  let libPath = defaultLibPath
  let threads = 0
  let sharedCache = false
  let maxNodes = Infinity
  let verbose = false
  let mode: "rtc" | "seq" = "rtc"
  const nodeFilter = new Set<string>()
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--lib") libPath = args[++i] ?? libPath
    else if (a === "--threads") threads = Number(args[++i] ?? 0) || 0
    else if (a === "--shared-cache") sharedCache = true
    else if (a === "--max-nodes") maxNodes = Number(args[++i] ?? Infinity)
    else if (a === "--verbose") verbose = true
    else if (a === "--mode") {
      const m = args[++i]
      if (m !== "rtc" && m !== "seq") {
        console.error(`--mode must be rtc or seq, got: ${m}`)
        process.exit(2)
      }
      mode = m
    } else if (a === "--node") {
      // Repeatable and/or comma-separated golden nodeId filter — run only the
      // named nodes (cheap single-node iteration against the 122MB JSONL).
      for (const id of (args[++i] ?? "").split(",")) {
        if (id) nodeFilter.add(id)
      }
    } else if (!a.startsWith("--")) goldenPath = a
    else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }
  if (!goldenPath) {
    console.error(
      "usage: bun native/portfolio-core/driver.ts <golden.jsonl> " +
        "[--lib <so>] [--threads N] [--shared-cache] [--max-nodes N] " +
        "[--node id[,id...]] [--mode rtc|seq] [--verbose]",
    )
    process.exit(2)
  }

  // --shared-cache: ONE session for the whole file — the Rust SharedCache
  // evolves across nodes under commit-on-sequential-semantics (production
  // shape). Default: fresh session per node — every candidate computes from
  // a cold cache, so any iteration difference against a golden candidate
  // that HIT its worker-private cache (golden iterations == 1) is
  // cache-implicated by construction (549/550-class accounting, Gate A).
  let session: NativePortfolioSession | null = sharedCache
    ? new NativePortfolioSession({ threads, libPath })
    : null

  let nodes = 0
  let winnerMismatch = 0
  let candCompared = 0
  let candMismatch = 0
  let cacheImplicated = 0
  let captureArtifacts = 0
  let runErrors = 0
  // --mode seq counters. Golden winners are REPLAY-schedule winners, which
  // can legitimately differ from the live-sequential schedule on the known
  // cache/solved-at-0 classes (src/seq.rs live-vs-replay differences) — so
  // winner agreement is INFORMATIONAL for seq; the hard assertions are
  // per-candidate: every candidate the sequential schedule ran to completion
  // must match its golden record on solved+iterations (Gate A determinism),
  // and no still-running candidate may have stepped past its recorded
  // completion.
  let seqWinnerAgree = 0
  let seqCompletedCompared = 0
  const mismatchLines: string[] = []
  const artifactLines: string[] = []
  const winnerInfoLines: string[] = []

  const processNode = (nodeLine: GoldenNodeLine, cands: GoldenCandLine[]) => {
    nodes++
    for (let i = 0; i < cands.length; i++) {
      if (cands[i]!.i !== i) {
        throw new Error(
          `golden cand order broken at node ${nodeLine.nodeId}: line ${i} has i=${cands[i]!.i}`,
        )
      }
    }
    const hps = cands.map((c) => c.hp)
    const tsrec: TsCandidateRecord[] = cands
      .filter((c) => !isDominantHp(c.hp))
      .map((c) => ({
        i: c.i,
        solved: c.solved,
        iterations: c.iterations,
        maxIterations: c.maxIterations,
        solvedSegments: c.solvedSegments,
        traj: c.traj,
        routes: c.routes,
        error: c.error,
      }))

    const sess = session ?? new NativePortfolioSession({ threads, libPath })
    try {
      sess.loadNode(nodeLine as unknown as Record<string, unknown>)

      if (mode === "seq") {
        // Golden records provide full tsrec for every non-dominant
        // candidate, so the schedule must never ask for more.
        const res = sess.runPortfolio({
          initialCount: nodeLine.initialCount,
          hps,
          tsrec,
          mode: "seq",
        })
        if (res.needTsCandidates && res.needTsCandidates.length > 0) {
          candMismatch++
          mismatchLines.push(
            `NEED node ${nodeLine.nodeId}: seq asked for [${res.needTsCandidates.join(",")}] despite full golden tsrec`,
          )
          return
        }
        if (res.winnerIndex === nodeLine.winnerIndex) {
          seqWinnerAgree++
        } else {
          winnerInfoLines.push(
            `WINNER(info) node ${nodeLine.nodeId}: golden(replay)=${nodeLine.winnerIndex} seq(live)=${res.winnerIndex}`,
          )
        }
        for (const g of cands) {
          if (!isDominantHp(g.hp)) continue // tsrec candidates ARE the golden
          const rc = res.perCandidate[g.i]
          if (!rc || rc.source !== "rust") {
            candMismatch++
            mismatchLines.push(
              `CAND node ${nodeLine.nodeId} i=${g.i}: missing rust record`,
            )
            continue
          }
          if (rc.completed) {
            seqCompletedCompared++
            if (rc.solved !== g.solved || rc.iterations !== g.iterations) {
              // Same accounting as rtc: a side that completed at iteration 1
              // hit a cache (golden workers had worker-private caches; the
              // default fresh-per-node native session is cold).
              const cacheish = g.iterations === 1 || rc.iterations === 1
              if (cacheish) cacheImplicated++
              else candMismatch++
              mismatchLines.push(
                `SEQCAND node ${nodeLine.nodeId} i=${g.i} completed` +
                  `${cacheish ? " (cache-implicated)" : ""}` +
                  ` golden solved=${g.solved} iters=${g.iterations}` +
                  ` seq solved=${rc.solved} iters=${rc.iterations}`,
              )
            }
          } else if (rc.iterations > g.iterations) {
            // A still-running candidate can never exceed its deterministic
            // completion point.
            candMismatch++
            mismatchLines.push(
              `SEQCAND node ${nodeLine.nodeId} i=${g.i} running past golden:` +
                ` seq iters=${rc.iterations} > golden iters=${g.iterations}`,
            )
          }
        }
        if (verbose) {
          console.log(
            `node ${nodeLine.nodeId}: winner golden=${nodeLine.winnerIndex} seq=${res.winnerIndex}` +
              ` rounds=${res.replay.rounds} work=${res.replay.totalCandidateWork}` +
              ` expanded=${res.replay.expanded} committed=${res.cache.committed}`,
          )
        }
        return
      }

      const res = sess.runPortfolio({
        initialCount: nodeLine.initialCount,
        hps,
        tsrec,
        emitAllRoutes: true,
      })

      if (res.winnerIndex !== nodeLine.winnerIndex) {
        winnerMismatch++
        mismatchLines.push(
          `WINNER node ${nodeLine.nodeId}: golden=${nodeLine.winnerIndex} rust=${res.winnerIndex}`,
        )
      }

      for (const g of cands) {
        if (!isDominantHp(g.hp)) continue // tsrec candidates ARE the golden
        const rc = res.perCandidate[g.i]
        if (!rc || rc.source !== "rust") {
          candMismatch++
          mismatchLines.push(
            `CAND node ${nodeLine.nodeId} i=${g.i}: missing rust record`,
          )
          continue
        }
        candCompared++
        const faults: string[] = []
        const artifactSkips: string[] = []
        if (rc.solved !== g.solved) faults.push("solved")
        if (rc.iterations !== g.iterations) faults.push("iterations")
        if (rc.maxIterations !== g.maxIterations) faults.push("maxIterations")
        const rt = rc.traj ?? []
        // GOLDEN-CAPTURE ARTIFACT (torn SAB header), traj leg — normalized
        // HERE, not mirrored in Rust, because it is nondeterministic capture-
        // transport corruption, not solver semantics. Mechanism: the replay
        // worker publishes its result header with PLAIN Int32Array stores in
        // ascending slot order, status (slot 0) FIRST
        // (portfolioReplayWorker.ts:39-45 writeHeader / :133-141 call site),
        // while the pool polls slot 0 with Atomics.load and reads slots 1-5
        // immediately (replayPool.ts:174-183 -> :108-125 readResult). A read
        // that lands inside that window sees slot 3 (trajLen) still at the
        // dispatch-time reset zero (replayPool.ts:150-152), so the recorded
        // progress array is empty and decimateTrajectory's rawLen==0 early
        // return (datasetFormat.ts:80-81) makes the golden traj []. An empty
        // golden traj with iterations >= 1 is otherwise unreachable for
        // dominant-class candidates: BaseSolver.step() advances iterations by
        // exactly 1 per call (BaseSolver.ts:33-56), the worker records one
        // sample per step() call (portfolioReplayWorker.ts:99-107), and the
        // dominant CachedIntraNodeRouteSolver is never pre-solved at
        // construction (IntraNodeSolver.ts:190-196, fast path commented out)
        // — so the untorn golden traj has exactly
        // ceil(iterations/SAMPLE_STRIDE) samples (datasetFormat.ts:76-89).
        // The skip therefore fires ONLY when (a) golden traj is empty, (b)
        // golden iterations >= 1, (c) Rust agrees on iterations, and (d) the
        // Rust traj has exactly the length the untorn capture would have had
        // — a Rust emission bug cannot hide behind the artifact. The sample
        // VALUES were destroyed at capture time; nothing remains to compare.
        const trajTorn =
          g.traj.length === 0 &&
          g.iterations >= 1 &&
          rc.iterations === g.iterations &&
          rt.length === Math.ceil(g.iterations / SAMPLE_STRIDE)
        if (trajTorn) {
          artifactSkips.push("traj")
        } else if (rt.length !== g.traj.length) {
          faults.push("trajLen")
        } else {
          for (let k = 0; k < rt.length; k++) {
            if (rt[k] !== g.traj[k]) {
              faults.push(`traj[${k}]`)
              break
            }
          }
        }
        if (g.solved && rc.solved) {
          if (g.routes === null) {
            // GOLDEN-CAPTURE ARTIFACT (torn SAB header), routes leg — same
            // tear as above, one slot further: routesBytes (slot 5) read as
            // the dispatch-time reset zero (replayPool.ts:150-152), so
            // readResult never decodes the routes JSON and stores null
            // (replayPool.ts:118-133), which the golden dump records as
            // routes:null (goldenDump.ts:146). A solved candidate with null
            // routes is otherwise unreachable: the worker unconditionally
            // encodes and writes the routes JSON for solved candidates, and
            // its only bail-out (SAB capacity) flips status to 4/error
            // instead of leaving solved set (portfolioReplayWorker.ts:111-121).
            // The route payload was destroyed at capture time; solved,
            // iterations, maxIterations and (when intact) traj remain
            // compared above.
            artifactSkips.push("routes")
          } else {
            // Golden routes are post-extractWinningRoutes; normalize the Rust
            // raw routes the same way before comparing (PORT-SPEC section 7).
            const extracted = extractWinningRoutes(
              { solvedRoutes: rc.routes ?? [] } as object,
              nodeLine.node as never,
            )
            if (!deepEqual(extracted, g.routes)) faults.push("routes")
          }
        }
        if (artifactSkips.length > 0) {
          captureArtifacts++
          artifactLines.push(
            `ARTIFACT node ${nodeLine.nodeId} i=${g.i} skipped [${artifactSkips.join(",")}]` +
              ` (torn SAB result-header capture; see driver.ts normalization)` +
              ` golden iters=${g.iterations} rust iters=${rc.iterations}`,
          )
        }
        if (faults.length > 0) {
          candMismatch++
          const cacheish = g.iterations === 1 || rc.iterations === 1
          if (cacheish) cacheImplicated++
          mismatchLines.push(
            `CAND node ${nodeLine.nodeId} i=${g.i} [${faults.join(",")}]` +
              `${cacheish ? " (cache-implicated: a side completed at iteration 1)" : ""}` +
              ` golden iters=${g.iterations} rust iters=${rc.iterations}`,
          )
          if (verbose) {
            const show = (v: unknown, cap = 2400): string => {
              const s = JSON.stringify(v)
              return s === undefined
                ? "undefined"
                : s.length > cap
                  ? `${s.slice(0, cap)}...(${s.length} chars)`
                  : s
            }
            console.log(`DETAIL node ${nodeLine.nodeId} i=${g.i}`)
            console.log(`  golden traj (len ${g.traj.length}): ${show(g.traj)}`)
            console.log(`  rust   traj (len ${rt.length}): ${show(rt)}`)
            if (g.solved && rc.solved) {
              console.log(`  golden routes: ${show(g.routes)}`)
              console.log(
                `  rust routes (extracted): ${show(
                  extractWinningRoutes(
                    { solvedRoutes: rc.routes ?? [] } as object,
                    nodeLine.node as never,
                  ),
                )}`,
              )
            }
          }
        }
      }
      if (verbose) {
        console.log(
          `node ${nodeLine.nodeId}: winner golden=${nodeLine.winnerIndex} rust=${res.winnerIndex} cands=${cands.length} committed=${res.cache.committed}`,
        )
      }
    } catch (err) {
      runErrors++
      mismatchLines.push(`ERROR node ${nodeLine.nodeId}: ${err}`)
    } finally {
      if (!session) sess.free()
    }
  }

  const rl = createInterface({
    input: createReadStream(goldenPath),
    crlfDelay: Infinity,
  })
  let currentNode: GoldenNodeLine | null = null
  let currentCands: GoldenCandLine[] = []
  const remainingFilter = new Set(nodeFilter)
  for await (const line of rl) {
    if (nodes >= maxNodes) break
    if (nodeFilter.size > 0 && remainingFilter.size === 0 && !currentNode) break
    const t = line.trim()
    if (t.length === 0) continue
    // While no node is being collected (filtered out), skip candidate lines
    // without JSON.parse — the dominant cost of a single-node pass over the
    // 122MB golden file. Safe: goldenDump.ts writes `t` as the first key.
    if (currentNode === null && t.startsWith('{"t":"cand"')) continue
    const obj = JSON.parse(t) as { t: string }
    if (obj.t === "board") continue // throughObstacle input — TS-side classes
    if (obj.t === "node") {
      if (currentNode) {
        processNode(currentNode, currentCands)
        remainingFilter.delete(currentNode.nodeId)
      }
      const n = obj as GoldenNodeLine
      currentNode =
        nodeFilter.size === 0 || nodeFilter.has(n.nodeId) ? n : null
      currentCands = []
    } else if (obj.t === "cand") {
      if (currentNode) currentCands.push(obj as GoldenCandLine)
    }
  }
  if (currentNode && nodes < maxNodes) processNode(currentNode, currentCands)
  session?.free()

  if (mode === "seq") {
    console.log(
      `nodes: ${nodes} (mode seq)\n` +
        `winner agreement vs replay-path golden (informational): ${seqWinnerAgree}/${nodes}\n` +
        `completed rust candidates compared: ${seqCompletedCompared}\n` +
        `hard candidate mismatches: ${candMismatch}\n` +
        `cache-implicated deltas (soft): ${cacheImplicated}\n` +
        `run errors: ${runErrors}`,
    )
    for (const l of winnerInfoLines.slice(0, 20)) console.log(l)
    if (winnerInfoLines.length > 20) {
      console.log(`... and ${winnerInfoLines.length - 20} more winner infos`)
    }
    for (const l of mismatchLines.slice(0, 40)) console.log(l)
    if (mismatchLines.length > 40) {
      console.log(`... and ${mismatchLines.length - 40} more`)
    }
    const clean = candMismatch === 0 && runErrors === 0
    console.log(clean ? "SEQ GOLDEN CHECK: OK" : "SEQ GOLDEN CHECK: FAILED")
    process.exit(clean ? 0 : 1)
  }

  console.log(
    `nodes: ${nodes}, rust candidates compared: ${candCompared}\n` +
      `winner mismatches: ${winnerMismatch}\n` +
      `candidate mismatches: ${candMismatch} (cache-implicated: ${cacheImplicated})\n` +
      `golden-capture artifacts skipped: ${captureArtifacts}\n` +
      `run errors: ${runErrors}`,
  )
  for (const l of artifactLines) console.log(l)
  for (const l of mismatchLines.slice(0, 40)) console.log(l)
  if (mismatchLines.length > 40) {
    console.log(`... and ${mismatchLines.length - 40} more`)
  }
  const clean = winnerMismatch === 0 && candMismatch === 0 && runErrors === 0
  console.log(clean ? "GOLDEN PARITY: OK" : "GOLDEN PARITY: FAILED")
  process.exit(clean ? 0 : 1)
}

if (import.meta.main) {
  goldenMain()
}
