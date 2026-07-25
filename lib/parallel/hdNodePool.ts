/**
 * Worker pool for NODE-level parallelism in the high-density stage
 * (TS_PARALLEL_HD_NODES=N).
 *
 * The shared context (connMap, obstacles, colour map, widths) is broadcast once
 * per worker at init; each task then carries only one node's port points, which
 * is a small payload. That is what makes this viable where the earlier
 * intra-node schemes were not: those paid session setup per node.
 */

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
}

type PoolWorker = {
  worker: Worker
  resultSab: SharedArrayBuffer
  header: Int32Array
  busyWith: string | null
}

export const parallelHdNodesEnabled = (): number => {
  if (typeof process === "undefined") return 0
  const n = Number(process.env.TS_PARALLEL_HD_NODES ?? 0) || 0
  return n > 0 ? Math.min(32, n) : 0
}

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
      this.workers.push({
        worker,
        resultSab,
        header: new Int32Array(resultSab, 0, 2),
        busyWith: null,
      })
    }
  }

  get inFlight(): number {
    return this.workers.reduce((n, w) => n + (w.busyWith ? 1 : 0), 0)
  }

  get size(): number {
    return this.workers.length
  }

  /** Hand a node to an idle worker. Returns false when all are busy. */
  tryDispatch(nodeWithPortPoints: any): boolean {
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
    const busy = this.workers.find((w) => w.busyWith !== null)
    if (!busy) return
    if (Atomics.load(busy.header, STATUS_OFFSET) !== 0) return
    Atomics.wait(busy.header, STATUS_OFFSET, 0, timeoutMs)
  }

  /** Collect every finished result without blocking. */
  poll(): HdNodeResult[] {
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
