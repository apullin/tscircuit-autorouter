/**
 * Dedicated 2-worker pool for the parallel DRC branch portfolio (A2).
 * Same SAB result-channel mechanics as PortfolioRacePool, with larger
 * buffers (full-board route arrays cross the boundary).
 */
const RESULT_SAB_BYTES = 64 * 1024 * 1024
const STATUS_OFFSET = 0
const LENGTH_OFFSET = 1
const PAYLOAD_OFFSET = 16

type A2Worker = {
  worker: Worker
  resultSab: SharedArrayBuffer
  header: Int32Array
  busy: boolean
}

let a2Pool: A2Worker[] | null = null

const getA2Pool = (): A2Worker[] => {
  if (!a2Pool) {
    a2Pool = []
    for (let i = 0; i < 2; i++) {
      const worker = new Worker(
        new URL("./a2BranchWorker.ts", import.meta.url).href,
      ) as Worker & { unref(): void }
      worker.unref()
      const resultSab = new SharedArrayBuffer(RESULT_SAB_BYTES)
      a2Pool.push({
        worker,
        resultSab,
        header: new Int32Array(resultSab, 0, 2),
        busy: false,
      })
    }
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

  dispatch(pool[0]!, { branch: "baseline", ...tasks.baseline })
  dispatch(pool[1]!, { branch: "broad", ...tasks.broad })
  pool[0]!.busy = true
  pool[1]!.busy = true

  const branches = ["baseline", "broad"] as const
  while (results.baseline === undefined || results.broad === undefined) {
    let progressed = false
    for (let i = 0; i < 2; i++) {
      const w = pool[i]!
      const branch = branches[i]!
      if (results[branch] !== undefined) continue
      if (Atomics.load(w.header, STATUS_OFFSET) === 0) continue
      progressed = true
      const status = Atomics.load(w.header, STATUS_OFFSET)
      const length = Atomics.load(w.header, LENGTH_OFFSET)
      const payload = JSON.parse(
        new TextDecoder().decode(
          new Uint8Array(w.resultSab, PAYLOAD_OFFSET, length),
        ),
      )
      w.busy = false
      if (status !== 1) {
        throw new Error(
          `A2 ${branch} branch worker failed: ${String(payload.error)}`,
        )
      }
      results[branch] = payload as A2BranchResult
    }
    if (!progressed) Bun.sleepSync(1)
  }

  return results as { baseline: A2BranchResult; broad: A2BranchResult }
}

export const parallelA2Enabled = (): boolean =>
  typeof process !== "undefined" &&
  !!process.env.TS_PARALLEL_A2 &&
  process.env.TS_PARALLEL_A2 !== "0"
