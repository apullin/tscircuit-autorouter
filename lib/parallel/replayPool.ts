import type { HighDensityIntraNodeRoute } from "lib/types/high-density-types"

/**
 * P2-replay pool (stage 1: full trajectories + offline deterministic replay).
 * Runs every portfolio candidate in workers, then replays the sequential
 * fitness schedule over the recorded trajectories — the winner is
 * bit-identical to the sequential supervisor's.
 */

export type ReplayCandidateResult = {
  hyperParameters: Record<string, unknown>
  solved: boolean
  iterations: number
  maxIterations: number
  /** progress after each iteration tick (index i = after i+1 iterations) */
  progress: Float32Array
  solvedSegments: number // -1 if the candidate has no solvedConnectionsMap
  routes: HighDensityIntraNodeRoute[] | null
  error?: string
}

const HEADER_INTS = 8
const HEADER_BYTES = HEADER_INTS * 4
const RESULT_SAB_BYTES = 24 * 1024 * 1024

type ReplayWorker = {
  worker: Worker
  resultSab: SharedArrayBuffer
  header: Int32Array
  busy: boolean
}

let replayPool: ReplayWorker[] | null = null

const getReplayPool = (size: number): ReplayWorker[] => {
  if (!replayPool) {
    replayPool = []
    for (let i = 0; i < size; i++) {
      const worker = new Worker(
        new URL("./portfolioReplayWorker.ts", import.meta.url).href,
      ) as Worker & { unref(): void }
      worker.unref()
      const resultSab = new SharedArrayBuffer(RESULT_SAB_BYTES)
      replayPool.push({
        worker,
        resultSab,
        header: new Int32Array(resultSab, 0, HEADER_INTS),
        busy: false,
      })
    }
  }
  return replayPool
}

const GREEDY_MULTIPLIER = 5
const MIN_SUBSTEPS = 100

export type ReplayTask = {
  hyperParameters: Record<string, unknown>
  constructorParams: Record<string, unknown>
}

/** computeG override semantics from PortfolioSingleIntraNodeSolver. */
export const candidateG = (
  hyperParameters: Record<string, unknown>,
  iterations: number,
  maxIterations: number,
): number => {
  if (hyperParameters.HIGH_DENSITY_A01 || hyperParameters.HIGH_DENSITY_A03) {
    return iterations / 1_000_000
  }
  if (hyperParameters.MULTI_HEAD_POLYLINE_SOLVER) {
    return (
      1000 +
      (((hyperParameters.ITERATION_PENALTY as number) ?? 0) + iterations) /
        10_000 +
      10_000 * ((hyperParameters.SEGMENTS_PER_POLYLINE as number)! - 3)
    )
  }
  return iterations / 10_000
}

/**
 * Run all candidates and replay the sequential schedule. `nodeSegmentCount`
 * must equal PortfolioSingleIntraNodeSolver.getNodeSegmentCount() for the node.
 * `expansionBudget` must equal getDynamicExpansionWorkBudget() (max
 * MAX_ITERATIONS over the initial candidate set, computed post-setup).
 * `initialCount` = number of candidates in the initial portfolio; candidates
 * beyond that index are treated as adaptive-expansion candidates.
 */
export const runReplayRace = (
  tasks: ReplayTask[],
  opts: {
    workers?: number
    nodeSegmentCount: number
    initialCount: number
  },
): {
  winnerIndex: number | null
  routes: HighDensityIntraNodeRoute[] | null
  results: ReplayCandidateResult[]
} => {
  const pool = getReplayPool(opts.workers ?? 4)
  const results: ReplayCandidateResult[] = new Array(tasks.length)
  let next = 0
  let active = 0

  const readResult = (w: ReplayWorker, index: number) => {
    const h = w.header
    const status = Atomics.load(h, 0)
    const iterations = Atomics.load(h, 1)
    const maxIterations = Atomics.load(h, 2)
    const trajLen = Atomics.load(h, 3)
    const solvedSegments = Atomics.load(h, 4)
    const routesBytes = Atomics.load(h, 5)
    const progress = new Float32Array(trajLen)
    progress.set(new Float32Array(w.resultSab, HEADER_BYTES, trajLen))
    let routes: HighDensityIntraNodeRoute[] | null = null
    let routesOrErrorJson: string | null = null
    if (routesBytes > 0) {
      const offset = HEADER_BYTES + trajLen * 4
      routesOrErrorJson = new TextDecoder().decode(
        new Uint8Array(w.resultSab, offset, routesBytes),
      )
    }
    let error: string | undefined
    if (status === 1 && routesOrErrorJson !== null) {
      routes = JSON.parse(routesOrErrorJson)
    } else if (routesOrErrorJson !== null) {
      try {
        error = String((JSON.parse(routesOrErrorJson) as { error?: unknown }).error ?? "")
      } catch {}
    }
    results[index] = {
      hyperParameters: tasks[index]!.hyperParameters,
      solved: status === 1,
      iterations,
      maxIterations,
      progress,
      solvedSegments,
      routes,
      error,
    }
    w.busy = false
  }

  const dispatch = (w: ReplayWorker) => {
    if (next >= tasks.length) return
    const index = next++
    Atomics.store(w.header, 5, 0)
    Atomics.store(w.header, 3, 0)
    Atomics.store(w.header, 0, 0)
    w.busy = true
    active++
    w.worker.postMessage({
      kind: "task",
      hyperParameters: tasks[index]!.hyperParameters,
      resultSab: w.resultSab,
      __index: index,
    })
    // Track the index on the worker slot (JS closure per slot)
    ;(w as { __index?: number }).__index = index
  }

  // session broadcast (same constructorParams for all workers)
  for (const w of pool) {
    w.worker.postMessage({
      kind: "session",
      constructorParams: tasks[0]!.constructorParams,
    })
  }
  for (const w of pool) dispatch(w)

  while (active > 0) {
    let progressed = false
    for (const w of pool) {
      if (!w.busy) continue
      if (Atomics.load(w.header, 0) === 0) continue
      progressed = true
      active--
      readResult(w, (w as { __index?: number }).__index ?? -1)
      dispatch(w)
    }
    if (!progressed) Bun.sleepSync(1)
  }

  // --- Offline replay of the sequential fitness schedule ---
  const v = new Float64Array(tasks.length) // virtual iterations per candidate
  const expansionBudget = Math.max(
    1,
    ...results.slice(0, opts.initialCount).map((r) => r.maxIterations),
  )
  let expanded = false
  let totalCandidateWork = 0
  let winnerIndex: number | null = null

  const progressAt = (r: ReplayCandidateResult, vit: number): number => {
    if (expanded && r.solvedSegments >= 0) {
      // getCandidateProgress clamps to [0, 1]
      return Math.min(1, r.solvedSegments / opts.nodeSegmentCount)
    }
    if (vit <= 0) return 0
    const idx = Math.min(vit, r.progress.length) - 1
    // Raw progress (can exceed 1 — computeH uses `progress || 0` unclamped,
    // which is how winning candidates reach negative f and get re-stepped)
    return idx >= 0 ? r.progress[idx]! : 0
  }

  const isFailedAt = (r: ReplayCandidateResult, vit: number): boolean =>
    !r.solved && vit >= r.iterations

  for (let guard = 0; guard < 50_000_000; guard++) {
    // Expansion condition (mirrors expandAdaptiveSearch triggers)
    if (
      !expanded &&
      (totalCandidateWork >= expansionBudget ||
        !results.some(
          (r, i) =>
            i < opts.initialCount && !r.solved && !isFailedAt(r, v[i]!),
        ))
    ) {
      expanded = true
    }

    // Best fitness among viable candidates (first-lowest-f, index order).
    // Candidates never stepped have f = 0 (initializeSolvers sets h=0, f=g=0)
    // — the supervisor steps each candidate once in index order first.
    let best = -1
    let bestF = Infinity
    const limit = expanded ? results.length : opts.initialCount
    for (let i = 0; i < limit; i++) {
      const r = results[i]!
      // Skip candidates already virtually stepped to completion. A candidate
      // solved at 0 iterations stays eligible at v=0 — picking it declares
      // the winner in the same round.
      if (r.solved && v[i]! > 0 && v[i]! >= r.iterations) continue
      if (!r.solved && isFailedAt(r, v[i]!)) continue
      const f =
        v[i]! === 0
          ? candidateG(r.hyperParameters, 0, r.maxIterations)
          : candidateG(r.hyperParameters, v[i]!, r.maxIterations) +
            (1 - progressAt(r, v[i]!)) * GREEDY_MULTIPLIER
      if (f < bestF) {
        bestF = f
        best = i
      }
    }

    if (best === -1) break // all failed (or all solved-virtually)

    const r = results[best]!
    const advance = Math.min(MIN_SUBSTEPS, r.iterations - v[best]!)
    v[best]! += advance
    totalCandidateWork += Math.max(0, advance)

    if (r.solved && v[best]! >= r.iterations) {
      winnerIndex = best
      break
    }
  }

  return {
    winnerIndex,
    routes: winnerIndex !== null ? results[winnerIndex]!.routes : null,
    results,
  }
}

export const parallelReplayEnabled = (): number => {
  if (typeof process === "undefined") return 0
  const n = Number(process.env.TS_PARALLEL_REPLAY ?? 0) || 0
  return n > 0 ? Math.min(16, n) : 0
}
