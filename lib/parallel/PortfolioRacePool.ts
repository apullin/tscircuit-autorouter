import type { HighDensityIntraNodeRoute } from "lib/types/high-density-types"

/**
 * Persistent Bun Worker pool that races intra-node portfolio candidates
 * (perf-artifacts/parallelism-design.md, P1). Results arrive through
 * per-worker SharedArrayBuffers so the synchronous pipeline pump can poll
 * them with Bun.sleepSync — no event-loop turn required.
 */

export type RaceCandidate = {
  hyperParameters: Record<string, unknown>
  constructorParams: Record<string, unknown>
}

export type RaceOutcome =
  | {
      status: "solved"
      routes: HighDensityIntraNodeRoute[]
      iterations: number
      winningHyperParameters: Record<string, unknown>
    }
  | { status: "all-failed"; errors: string[] }

const RESULT_SAB_BYTES = 16 * 1024 * 1024
const STATUS_OFFSET = 0
const LENGTH_OFFSET = 1
const PAYLOAD_OFFSET = 16

type PoolWorker = {
  worker: Worker
  resultSab: SharedArrayBuffer
  cancelSab: SharedArrayBuffer
  header: Int32Array
  cancelFlag: Int32Array
  taskId: number
}

export class PortfolioRacePool {
  private pool: PoolWorker[]
  private nextGlobalTaskId = 1

  constructor(size: number) {
    this.pool = []
    for (let i = 0; i < size; i++) {
      const worker = new Worker(
        new URL("./portfolioRaceWorker.ts", import.meta.url).href,
      ) as Worker & { unref(): void } // bun Worker has unref; DOM type lacks it
      worker.unref()
      const resultSab = new SharedArrayBuffer(RESULT_SAB_BYTES)
      const cancelSab = new SharedArrayBuffer(4)
      this.pool.push({
        worker,
        resultSab,
        cancelSab,
        header: new Int32Array(resultSab, 0, 2),
        cancelFlag: new Int32Array(cancelSab, 0, 1),
        taskId: -1,
      })
    }
  }

  get size(): number {
    return this.pool.length
  }

  private dispatch(w: PoolWorker, taskId: number, candidate: RaceCandidate) {
    Atomics.store(w.header, STATUS_OFFSET, 0)
    Atomics.store(w.cancelFlag, 0, 0)
    w.taskId = taskId
    w.worker.postMessage({
      taskId,
      hyperParameters: candidate.hyperParameters,
      constructorParams: candidate.constructorParams,
      resultSab: w.resultSab,
      cancelSab: w.cancelSab,
    })
  }

  private readResult(w: PoolWorker): {
    status: number
    payload: Record<string, unknown>
  } {
    const status = Atomics.load(w.header, STATUS_OFFSET)
    const length = Atomics.load(w.header, LENGTH_OFFSET)
    const json = new TextDecoder().decode(
      new Uint8Array(w.resultSab, PAYLOAD_OFFSET, length),
    )
    return { status, payload: JSON.parse(json) }
  }

  /**
   * Race all candidates; first solved wins. Synchronous — blocks the calling
   * (main) thread in a sleep-poll loop until a winner or exhaustion.
   * Workers still running a PREVIOUS race's cancelled task are skipped until
   * they acknowledge the cancel; their stale results are discarded (global
   * monotonic task ids prevent cross-race confusion).
   */
  race(candidates: RaceCandidate[]): RaceOutcome {
    const errors: string[] = []
    const taskMap = new Map<number, number>() // globalTaskId -> candidate index
    let active = 0
    let settled = 0

    const tryDispatch = (w: PoolWorker): boolean => {
      if (settled >= candidates.length) return false
      const globalId = this.nextGlobalTaskId++
      taskMap.set(globalId, settled)
      this.dispatch(w, globalId, candidates[settled]!)
      settled++
      active++
      return true
    }

    for (const w of this.pool) {
      if (w.taskId >= 0) continue // stale cancelled task still draining
      if (!tryDispatch(w)) break
    }
    if (active === 0 && settled >= candidates.length && candidates.length === 0) {
      return { status: "all-failed", errors: ["no candidates"] }
    }

    while (active > 0 || this.pool.some((w) => w.taskId >= 0 && settled < candidates.length)) {
      let progressed = false
      for (const w of this.pool) {
        if (w.taskId < 0) continue
        if (Atomics.load(w.header, STATUS_OFFSET) === 0) continue
        progressed = true
        const { status, payload } = this.readResult(w)
        const finishedTaskId = w.taskId
        w.taskId = -1

        const candidateIndex = taskMap.get(finishedTaskId)
        if (candidateIndex === undefined) {
          // Stale result from a previous race — discard, reuse the worker.
          tryDispatch(w)
          continue
        }
        active--

        if (status === 1) {
          // Winner: cancel everything else still running.
          for (const other of this.pool) {
            if (other.taskId >= 0) Atomics.store(other.cancelFlag, 0, 1)
          }
          return {
            status: "solved",
            routes: payload.routes as HighDensityIntraNodeRoute[],
            iterations: payload.iterations as number,
            winningHyperParameters: candidates[candidateIndex]!.hyperParameters,
          }
        }
        if (status === 4) {
          errors.push(
            `worker error on candidate ${candidateIndex}: ${String(payload.error)}`,
          )
        }
        // status 2 (failed) / 3 (cancelled) / 4 (error): dispatch next task
        tryDispatch(w)
      }
      if (!progressed) Bun.sleepSync(1)
    }

    return { status: "all-failed", errors }
  }
}

let globalPool: PortfolioRacePool | null = null

/** Lazily created process-wide pool; worker count from env (default 4). */
export const getGlobalRacePool = (): PortfolioRacePool => {
  if (!globalPool) {
    const size = Math.max(
      1,
      Math.min(16, Number(process.env.TS_PARALLEL_PORTFOLIO ?? 4) || 4),
    )
    globalPool = new PortfolioRacePool(size)
  }
  return globalPool
}

export const parallelPortfolioEnabled = (): boolean =>
  typeof process !== "undefined" &&
  !!process.env.TS_PARALLEL_PORTFOLIO &&
  process.env.TS_PARALLEL_PORTFOLIO !== "0"
