import type { HighDensityIntraNodeRoute } from "lib/types/high-density-types"
import { candidateG } from "./replayPool"

/**
 * P2-replay stage 2: online deterministic replay with early exit.
 * Workers stream progress trajectories; the main thread replays the
 * sequential fitness schedule forward as data arrives; the moment the
 * simulated winner is known, all other candidates are cancelled. Winner is
 * bit-identical to the sequential supervisor (see stage-1 verification),
 * at a fraction of the total candidate work.
 */

export type OnlineReplayTask = {
  hyperParameters: Record<string, unknown>
  constructorParams: Record<string, unknown>
}

const HEADER_INTS = 8
const HEADER_BYTES = HEADER_INTS * 4
const RESULT_SAB_BYTES = 24 * 1024 * 1024
const GREEDY_MULTIPLIER = 5
const MIN_SUBSTEPS = 100

type Replay2Worker = {
  worker: Worker
  resultSab: SharedArrayBuffer
  cancelSab: SharedArrayBuffer
  header: Int32Array
  cancelFlag: Int32Array
  taskIndex: number // -1 = free
  boardConnMap: unknown
}

let replay2Pool: Replay2Worker[] | null = null
let poolConnMap: unknown = null

const getReplay2Pool = (size: number): Replay2Worker[] => {
  if (!replay2Pool) {
    replay2Pool = []
    for (let i = 0; i < size; i++) {
      const worker = new Worker(
        new URL("./portfolioReplayWorker2.ts", import.meta.url).href,
      ) as Worker & { unref(): void }
      worker.unref()
      const resultSab = new SharedArrayBuffer(RESULT_SAB_BYTES)
      const cancelSab = new SharedArrayBuffer(4)
      replay2Pool.push({
        worker,
        resultSab,
        cancelSab,
        header: new Int32Array(resultSab, 0, HEADER_INTS),
        cancelFlag: new Int32Array(cancelSab, 0, 1),
        taskIndex: -1,
        boardConnMap: null,
      })
    }
  }
  return replay2Pool
}

type CandidateState =
  | { kind: "queued"; hyperParameters: Record<string, unknown> }
  | {
      kind: "running"
      hyperParameters: Record<string, unknown>
      worker: Replay2Worker
    }
  | {
      kind: "done"
      hyperParameters: Record<string, unknown>
      solved: boolean
      iterations: number
      maxIterations: number
      trajLen: number
      solvedSegments: number
      samples: Float32Array
      routesJson: string | null
    }

export const runOnlineReplayRace = (
  tasks: OnlineReplayTask[],
  opts: {
    workers?: number
    nodeSegmentCount: number
    initialCount: number
    connMap: unknown
  },
): {
  winnerIndex: number | null
  routes: HighDensityIntraNodeRoute[] | null
  stats: { dispatched: number; completed: number; totalCandidates: number }
} => {
  const workerCount = opts.workers ?? 4
  const pool = getReplay2Pool(workerCount)

  // Board-level connMap broadcast (once per board across all races)
  if (poolConnMap !== opts.connMap) {
    for (const w of pool) {
      w.worker.postMessage({ kind: "board", connMap: opts.connMap })
      w.boardConnMap = opts.connMap
    }
    poolConnMap = opts.connMap
  }

  // Node session broadcast (constructorParams WITHOUT connMap)
  const { connMap: _cm, ...sessionParams } = tasks[0]!
    .constructorParams as Record<string, unknown>
  for (const w of pool) {
    w.worker.postMessage({ kind: "session", constructorParams: sessionParams })
  }

  const n = tasks.length
  const states: CandidateState[] = tasks.map((t) => ({
    kind: "queued",
    hyperParameters: t.hyperParameters,
  }))
  let nextQueue = 0
  let running = 0

  const dispatch = (w: Replay2Worker, index: number) => {
    Atomics.store(w.header, 5, 0)
    Atomics.store(w.header, 3, 0)
    Atomics.store(w.header, 6, 0)
    Atomics.store(w.cancelFlag, 0, 0)
    Atomics.store(w.header, 0, 0)
    w.taskIndex = index
    states[index] = {
      kind: "running",
      hyperParameters: tasks[index]!.hyperParameters,
      worker: w,
    }
    running++
    w.worker.postMessage({
      kind: "task",
      hyperParameters: tasks[index]!.hyperParameters,
      resultSab: w.resultSab,
      cancelSab: w.cancelSab,
    })
  }

  const freeWorker = (): Replay2Worker | null => {
    for (const w of pool) if (w.taskIndex < 0) return w
    return null
  }

  // initial wave
  while (nextQueue < n && nextQueue < workerCount) {
    const w = freeWorker()!
    dispatch(w, nextQueue)
    nextQueue++
  }

  // ---- online simulation ----
  const v = new Float64Array(n)
  let expanded = false
  let totalCandidateWork = 0
  let winnerIndex: number | null = null
  let expansionBudget = Infinity
  let completed = 0

  const samplesOf = (w: Replay2Worker) =>
    new Float32Array(w.resultSab, HEADER_BYTES)
  const streamHead = (w: Replay2Worker) => Atomics.load(w.header, 6)
  const status = (w: Replay2Worker) => Atomics.load(w.header, 0)

  const progressAt = (index: number, vit: number): number => {
    const st = states[index]!
    if (expanded) {
      const segs =
        st.kind === "done"
          ? st.solvedSegments
          : st.kind === "running"
            ? Atomics.load(st.worker.header, 4)
            : 0
      if (segs >= 0) return Math.min(1, segs / opts.nodeSegmentCount)
    }
    if (vit <= 0 || st.kind === "queued") return 0
    if (st.kind === "done") {
      const idx = Math.min(vit, st.trajLen) - 1
      return idx >= 0 ? st.samples[idx]! : 0
    }
    const w = st.worker
    const samples = samplesOf(w)
    const head = streamHead(w)
    const idx = Math.min(vit, head) - 1
    return idx >= 0 ? samples[idx]! : 0
  }

  const canAdvance = (index: number, advance: number): boolean => {
    const st = states[index]!
    if (st.kind === "done") return true
    if (st.kind === "queued") return false
    return streamHead(st.worker) >= v[index]! + advance
  }

  const finalIterationsOf = (index: number): number => {
    const st = states[index]!
    return st.kind === "done" ? st.iterations : Infinity
  }

  const isFailedAt = (index: number, vit: number): boolean => {
    const st = states[index]!
    if (st.kind !== "done") return false
    return !st.solved && vit >= st.iterations
  }

  const maxIterOf = (index: number): number => {
    const st = states[index]!
    return st.kind === "done"
      ? st.maxIterations
      : st.kind === "running"
        ? Atomics.load(st.worker.header, 2) || 1
        : 1
  }

  // harvest completions
  const harvest = (): boolean => {
    let changed = false
    for (let i = 0; i < n; i++) {
      const st = states[i]!
      if (st.kind !== "running") continue
      const w = st.worker
      const s = status(w)
      if (s === 0) continue
      changed = true
      running--
      completed++
      const done: CandidateState = {
        kind: "done",
        hyperParameters: st.hyperParameters,
        solved: s === 1,
        iterations: Atomics.load(w.header, 1),
        maxIterations: Atomics.load(w.header, 2) || 1,
        trajLen: Atomics.load(w.header, 3),
        solvedSegments: Atomics.load(w.header, 4),
        samples: new Float32Array(0),
        routesJson: null,
      }
      // Copy trajectory + routes out BEFORE the worker is redispatched —
      // the SAB gets overwritten by the next task.
      done.samples = samplesOf(w).slice(0, done.trajLen)
      const routesBytes = Atomics.load(w.header, 5)
      if (s === 1 && routesBytes > 0) {
        done.routesJson = new TextDecoder().decode(
          new Uint8Array(
            w.resultSab,
            HEADER_BYTES + done.trajLen * 4,
            routesBytes,
          ),
        )
      }
      states[i] = done
      w.taskIndex = -1
    }
    return changed
  }

  const viable = (index: number): boolean => {
    const st = states[index]!
    if (st.kind === "done") {
      // solved-at-0 stays selectable at v=0 (declares winner same round)
      if (st.solved && v[index]! > 0 && v[index]! >= st.iterations) return false
      if (!st.solved && isFailedAt(index, v[index]!)) return false
    }
    return true
  }

  for (let guard = 0; guard < 100_000_000; guard++) {
    harvest()

    // expansion budget once all initial candidates' maxIterations are known
    if (expansionBudget === Infinity) {
      let known = true
      let budget = 1
      for (let i = 0; i < opts.initialCount; i++) {
        const st = states[i]!
        if (st.kind === "queued") {
          known = false
          break
        }
        budget = Math.max(budget, maxIterOf(i))
      }
      if (known) expansionBudget = budget
    }

    const anyInitialViable = Array.from(
      { length: opts.initialCount },
      (_, i) => i,
    ).some((i) => viable(i))
    if (
      !expanded &&
      ((totalCandidateWork >= expansionBudget &&
        expansionBudget !== Infinity) ||
        !anyInitialViable)
    ) {
      expanded = true
    }

    // pick best fitness (first-lowest-f, index order)
    let best = -1
    let bestF = Infinity
    const limit = expanded ? n : opts.initialCount
    for (let i = 0; i < limit; i++) {
      if (!viable(i)) continue
      const hp = states[i]!.hyperParameters
      const f =
        v[i]! === 0
          ? candidateG(hp, 0, maxIterOf(i))
          : candidateG(hp, v[i]!, maxIterOf(i)) +
            (1 - progressAt(i, v[i]!)) * GREEDY_MULTIPLIER
      if (f < bestF) {
        bestF = f
        best = i
      }
    }

    if (best === -1) {
      // nothing viable in sim: if anything still queued/running, wait for it
      if (nextQueue < n || running > 0) {
        const w = freeWorker()
        if (w && nextQueue < n) {
          dispatch(w, nextQueue)
          nextQueue++
        } else {
          Bun.sleepSync(1)
        }
        continue
      }
      break // truly exhausted
    }

    // advance the picked candidate if data allows; else wait/dispatch
    const bestFinal = finalIterationsOf(best)
    const advance = Math.min(MIN_SUBSTEPS, Math.max(0, bestFinal - v[best]!))
    if (states[best]!.kind === "queued") {
      // picked a queued candidate: dispatch it now (out of queue order is
      // fine — it only affects when data arrives, not the simulation)
      const w = freeWorker()
      if (w) {
        dispatch(w, best)
        while (nextQueue < n && states[nextQueue]!.kind !== "queued") {
          nextQueue++
        }
      } else {
        Bun.sleepSync(1)
      }
      continue
    }
    if (bestFinal === Infinity && states[best]!.kind === "running") {
      // running but no trajectory data yet
      Bun.sleepSync(1)
      continue
    }
    if (!canAdvance(best, Math.max(1, advance))) {
      // need more trajectory data: ensure something useful runs, then wait
      const w = freeWorker()
      if (w && nextQueue < n) {
        dispatch(w, nextQueue)
        nextQueue++
      } else {
        Bun.sleepSync(1)
      }
      continue
    }

    v[best]! += advance
    totalCandidateWork += advance

    if (bestFinal !== Infinity && v[best]! >= bestFinal) {
      const st = states[best]!
      if (st.kind === "done" && st.solved) {
        winnerIndex = best
        break
      }
      // failed candidate: sim continues
    }
  }

  // cancel everything still running
  for (const w of pool) {
    if (w.taskIndex >= 0) Atomics.store(w.cancelFlag, 0, 1)
  }
  // wait for cancels to drain so the pool is reusable immediately
  for (const w of pool) {
    if (w.taskIndex < 0) continue
    while (status(w) === 0) Bun.sleepSync(1)
    w.taskIndex = -1
    running--
  }

  let routes: HighDensityIntraNodeRoute[] | null = null
  if (winnerIndex !== null) {
    const st = states[winnerIndex]!
    if (st.kind === "done" && st.routesJson !== null) {
      routes = JSON.parse(st.routesJson)
    }
  }

  return {
    winnerIndex,
    routes,
    stats: { dispatched: nextQueue, completed, totalCandidates: n },
  }
}

export const parallelReplay2Enabled = (): number => {
  if (typeof process === "undefined") return 0
  const n = Number(process.env.TS_PARALLEL_REPLAY2 ?? 0) || 0
  return n > 0 ? Math.min(16, n) : 0
}
