/**
 * Worker pool for NODE-level parallelism in the high-density stage
 * (TS_PARALLEL_HD_NODES=N).
 *
 * The shared context (connMap, obstacles, colour map, widths) is broadcast once
 * per worker at init; each task then carries only one node's port points, which
 * is a small payload. That is what makes this viable where the earlier
 * intra-node schemes were not: those paid session setup per node.
 *
 * Lifecycle invariant (same pattern as a2Pool, 36c8ce8f): a worker is reused
 * ONLY after its previous task's result was fully harvested. Any error path
 * (fatal worker, throw in the pump) destroys the whole pool, because an
 * abandoned in-flight task can still write into its SAB at any later time —
 * reusing that worker would let a stale write be served as a later node's
 * result.
 */

import { resolveHdNodeParallelism } from "./autoEnable"

const RESULT_SAB_BYTES = 8 * 1024 * 1024
const STATUS_OFFSET = 0
const LENGTH_OFFSET = 1
const PAYLOAD_OFFSET = 16

export type HdNodeResult = {
  nodeId: string
  solved: boolean
  failed: boolean
  error: string | null
  routes: any[]
  stats: Record<string, unknown>
  /** Bookkeeping parity fields, computed worker-side (see hdNodeWorker). */
  iterations: number
  solverType: string
  routeCount: number
  growthAttempts: number
  /** Per-task deltas of the worker's private intra-node cache counters. */
  cacheHits: number
  cacheMisses: number
}

type PoolWorker = {
  worker: Worker
  resultSab: SharedArrayBuffer
  header: Int32Array
  busyWith: string | null
  fatal: Error | null
}

/**
 * Resolved worker count for the node-parallel HD path, 0 = sequential.
 * Explicit TS_PARALLEL_HD_NODES always wins; when unset, the G9 auto-enable
 * policy decides (see autoEnable.ts). HighDensitySolver additionally gates
 * auto mode on board size at dispatch time.
 */
export const parallelHdNodesEnabled = (): number =>
  resolveHdNodeParallelism().workerCount

export class HdNodePool {
  private workers: PoolWorker[] = []

  constructor(workerCount: number, sharedContext: Record<string, unknown>) {
    for (let i = 0; i < workerCount; i++) {
      const worker = new Worker(
        new URL("./hdNodeWorker.ts", import.meta.url).href,
      ) as Worker & { unref(): void }
      worker.unref?.()
      const resultSab = new SharedArrayBuffer(RESULT_SAB_BYTES)
      worker.postMessage({ type: "init", context: sharedContext })
      const entry: PoolWorker = {
        worker,
        resultSab,
        header: new Int32Array(resultSab, 0, 2),
        busyWith: null,
        fatal: null,
      }
      // Fires when the worker script fails to load/evaluate (the worker-side
      // try/catch only covers onmessage-time errors) — without this the pump
      // would poll status 0 forever.
      worker.addEventListener("error", (e: Event) => {
        const message = (e as ErrorEvent).message ?? "unknown worker error"
        entry.fatal = new Error(`hdNode worker error: ${message}`)
      })
      worker.addEventListener("close", () => {
        if (entry.busyWith !== null && entry.fatal === null) {
          entry.fatal = new Error("hdNode worker exited mid-task")
        }
      })
      this.workers.push(entry)
    }
  }

  get inFlight(): number {
    return this.workers.reduce((n, w) => n + (w.busyWith ? 1 : 0), 0)
  }

  get size(): number {
    return this.workers.length
  }

  /** A worker that died (or was abandoned mid-task) poisons the whole pool. */
  private throwIfFatal(): void {
    const dead = this.workers.find((w) => w.fatal !== null)
    if (dead) throw dead.fatal
  }

  /** Hand a node to an idle worker. Returns false when all are busy. */
  tryDispatch(nodeWithPortPoints: any): boolean {
    this.throwIfFatal()
    const idle = this.workers.find((w) => w.busyWith === null)
    if (!idle) return false
    Atomics.store(idle.header, STATUS_OFFSET, 0)
    Atomics.store(idle.header, LENGTH_OFFSET, 0)
    idle.busyWith = nodeWithPortPoints.capacityMeshNodeId
    idle.worker.postMessage({
      nodeWithPortPoints,
      resultSab: idle.resultSab,
    })
    return true
  }

  /**
   * Block up to timeoutMs for any in-flight worker to finish. Without this the
   * caller busy-spins: the pipeline pump would burn millions of iterations (and
   * a whole core) polling while workers do the real work.
   */
  waitForAny(timeoutMs: number): void {
    this.throwIfFatal()
    const busy = this.workers.find((w) => w.busyWith !== null)
    if (!busy) return
    if (Atomics.load(busy.header, STATUS_OFFSET) !== 0) return
    Atomics.wait(busy.header, STATUS_OFFSET, 0, timeoutMs)
  }

  /**
   * Collect every finished result without blocking. busyWith is cleared only
   * AFTER the payload has been fully read out of the SAB (the worker stores
   * status last, so status 1/4 means its writes are complete).
   */
  poll(): HdNodeResult[] {
    this.throwIfFatal()
    const done: HdNodeResult[] = []
    for (const w of this.workers) {
      if (!w.busyWith) continue
      const status = Atomics.load(w.header, STATUS_OFFSET)
      if (status !== 1 && status !== 4) continue
      const length = Atomics.load(w.header, LENGTH_OFFSET)
      const bytes = new Uint8Array(w.resultSab, PAYLOAD_OFFSET, length)
      let payload: any
      try {
        payload = JSON.parse(new TextDecoder().decode(bytes))
      } catch (err) {
        payload = { error: `unparseable worker payload: ${String(err)}` }
      }
      done.push({
        nodeId: payload?.nodeId ?? w.busyWith,
        solved: !!payload?.solved,
        failed: status === 4 || !!payload?.failed,
        error: payload?.error ?? null,
        routes: payload?.routes ?? [],
        stats: payload?.stats ?? {},
        iterations: payload?.iterations ?? 0,
        solverType: payload?.solverType ?? "unknown",
        routeCount: payload?.routeCount ?? payload?.routes?.length ?? 0,
        growthAttempts: payload?.growthAttempts ?? 0,
        cacheHits: payload?.cacheHits ?? 0,
        cacheMisses: payload?.cacheMisses ?? 0,
      })
      w.busyWith = null
      Atomics.store(w.header, STATUS_OFFSET, 0)
    }
    return done
  }

  terminate() {
    for (const w of this.workers) w.worker.terminate()
    this.workers = []
  }
}

let hdNodePool: HdNodePool | null = null

export const destroyHdNodePool = (): void => {
  if (!hdNodePool) return
  hdNodePool.terminate()
  hdNodePool = null
}

/**
 * Always serves a FRESH pool: the shared context is per-solve, worker-side
 * intra-node caches must not leak between solves, and a pool abandoned by a
 * previous solve may hold a busy or fatal worker whose in-flight task could
 * still write into a reused SAB. Destroy-then-respawn covers all three.
 */
export const getHdNodePool = (
  workerCount: number,
  sharedContext: Record<string, unknown>,
): HdNodePool => {
  destroyHdNodePool()
  hdNodePool = new HdNodePool(workerCount, sharedContext)
  return hdNodePool
}
