/**
 * Dedicated 2-worker pool for the parallel DRC branch portfolio (A2).
 * Same SAB result-channel mechanics as PortfolioRacePool, with larger
 * buffers (full-board route arrays cross the boundary).
 *
 * Lifecycle invariant: a worker is reused ONLY after its previous task's
 * result was fully harvested. Any error path (branch failure, torn payload,
 * worker load error, unexpected exit) destroys the whole pool, because an
 * abandoned in-flight task can still write into its SAB at any later time —
 * reusing that worker would let a stale write be served as a later call's
 * result (observed failure mode: board N's routes returned for board N+1).
 */
import { resolveA2Parallelism } from "./autoEnable"

const RESULT_SAB_BYTES = 64 * 1024 * 1024
const STATUS_OFFSET = 0
const LENGTH_OFFSET = 1
const PAYLOAD_OFFSET = 16

type A2Worker = {
  worker: Worker
  resultSab: SharedArrayBuffer
  header: Int32Array
  busy: boolean
  fatal: Error | null
}

let a2Pool: A2Worker[] | null = null

const destroyA2Pool = (): void => {
  if (!a2Pool) return
  for (const w of a2Pool) w.worker.terminate()
  a2Pool = null
}

const getA2Pool = (): A2Worker[] => {
  // A worker still marked busy (a previous call threw mid-flight) or one
  // that reported a fatal error must never be dispatched to again.
  if (a2Pool && a2Pool.some((w) => w.busy || w.fatal !== null)) {
    destroyA2Pool()
  }
  if (!a2Pool) {
    const pool: A2Worker[] = []
    for (let i = 0; i < 2; i++) {
      const worker = new Worker(
        new URL("./a2BranchWorker.ts", import.meta.url).href,
      ) as Worker & { unref(): void }
      worker.unref()
      const resultSab = new SharedArrayBuffer(RESULT_SAB_BYTES)
      const entry: A2Worker = {
        worker,
        resultSab,
        header: new Int32Array(resultSab, 0, 2),
        busy: false,
        fatal: null,
      }
      // Fires when the worker script fails to load/evaluate (the worker-side
      // try/catch only covers onmessage-time errors) — without this the pump
      // would poll status 0 forever.
      worker.addEventListener("error", (e: Event) => {
        const message = (e as ErrorEvent).message ?? "unknown worker error"
        entry.fatal = new Error(`A2 worker error: ${message}`)
      })
      worker.addEventListener("close", () => {
        if (entry.busy && entry.fatal === null) {
          entry.fatal = new Error("A2 worker exited mid-task")
        }
      })
      pool.push(entry)
    }
    a2Pool = pool
  }
  return a2Pool
}

export type A2BranchResult = Record<string, unknown> & {
  routes: unknown[]
  count: number
  broadInputCount?: number
}

/**
 * Run both branches concurrently and block (sleep-poll) until both report.
 * Deterministic: each branch is an independent deterministic computation.
 */
export const runA2Branches = (tasks: {
  baseline: Record<string, unknown>
  broad: Record<string, unknown>
}): { baseline: A2BranchResult; broad: A2BranchResult } => {
  const pool = getA2Pool()
  const results: Partial<{ baseline: A2BranchResult; broad: A2BranchResult }> =
    {}

  const dispatch = (w: A2Worker, task: Record<string, unknown>) => {
    Atomics.store(w.header, STATUS_OFFSET, 0)
    w.busy = true
    w.worker.postMessage({ ...task, resultSab: w.resultSab })
  }

  try {
    dispatch(pool[0]!, { branch: "baseline", ...tasks.baseline })
    dispatch(pool[1]!, { branch: "broad", ...tasks.broad })

    const branches = ["baseline", "broad"] as const
    while (results.baseline === undefined || results.broad === undefined) {
      let progressed = false
      for (let i = 0; i < 2; i++) {
        const w = pool[i]!
        const branch = branches[i]!
        if (results[branch] !== undefined) continue
        if (w.fatal !== null) throw w.fatal
        if (Atomics.load(w.header, STATUS_OFFSET) === 0) continue
        progressed = true
        const status = Atomics.load(w.header, STATUS_OFFSET)
        const length = Atomics.load(w.header, LENGTH_OFFSET)
        const payload = JSON.parse(
          new TextDecoder().decode(
            new Uint8Array(w.resultSab, PAYLOAD_OFFSET, length),
          ),
        )
        if (status !== 1) {
          throw new Error(
            `A2 ${branch} branch worker failed: ${String(payload.error)}`,
          )
        }
        w.busy = false
        results[branch] = payload as A2BranchResult
      }
      if (!progressed) Bun.sleepSync(1)
    }

    return results as { baseline: A2BranchResult; broad: A2BranchResult }
  } catch (err) {
    // The sibling branch may still be computing into its SAB; the pool must
    // not survive to serve that write to a later call.
    destroyA2Pool()
    throw err
  }
}

/**
 * Explicit TS_PARALLEL_A2 always wins; when unset, the G9 auto-enable policy
 * decides (see autoEnable.ts — off in browser, benchmark/CI/test contexts,
 * and on hardware with < 8 threads or < 4GB free).
 */
export const parallelA2Enabled = (): boolean => resolveA2Parallelism().enabled
