import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import { PortfolioSingleIntraNodeSolver } from "../solvers/HyperHighDensitySolver/PortfolioSingleIntraNodeSolver"
import { extractWinningRoutes } from "../solvers/HyperHighDensitySolver/extractWinningRoutes"

/**
 * P2-replay stage-2 worker: board-level connMap init ONCE, node session per
 * race, streaming progress trajectories (main replays the schedule online),
 * cancel-at-chunk-boundary.
 *
 * Messages:
 *   "board"   — { connMap } once per board/process
 *   "session" — { constructorParams } per node (connMap injected from board)
 *   "task"    — { hyperParameters, resultSab, cancelSab }
 *   "routes"  — { resultSab } re-send last solved routes (winner fetch)
 *
 * resultSab Int32 header:
 *   [0] status (0 running, 1 solved, 2 failed, 3 cancelled, 4 error)
 *   [1] solveIteration (final iteration count)
 *   [2] maxIterations (post-setup)
 *   [3] finalTrajLen (capped progress samples, written on completion)
 *   [4] solvedSegments
 *   [5] routesBytes
 *   [6] streamHead (atomically incremented as progress samples stream)
 * Float32 progress samples at byte 32; routes JSON after samples.
 */

type BoardMsg = { kind: "board"; connMap: unknown }
type SessionMsg = {
  kind: "session"
  constructorParams: Record<string, unknown>
}
type TaskMsg = {
  kind: "task"
  hyperParameters: Record<string, unknown>
  resultSab: SharedArrayBuffer
  cancelSab: SharedArrayBuffer
}
type RoutesMsg = { kind: "routes"; resultSab: SharedArrayBuffer }

const HEADER_INTS = 8
const HEADER_BYTES = HEADER_INTS * 4
const STREAM_FLUSH_EVERY = 64

declare var self: Worker

let boardConnMap: unknown = null
let factory: PortfolioSingleIntraNodeSolver | null = null
let lastSolvedRoutes: unknown = null

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

const runTask = (msg: TaskMsg) => {
  const { resultSab, cancelSab } = msg
  const header = new Int32Array(resultSab, 0, HEADER_INTS)
  const cancelFlag = new Int32Array(cancelSab, 0, 1)
  Atomics.store(header, 0, 0)
  Atomics.store(header, 6, 0)
  try {
    if (!factory) throw new Error("task before session")
    const solver = factory.generateSolver(msg.hyperParameters)
    if ("setup" in solver && typeof solver.setup === "function") {
      ;(solver.setup as () => void).call(solver)
    }
    const maxIterations = solver.MAX_ITERATIONS
    const samples = new Float32Array(resultSab, HEADER_BYTES)
    const sampleCap = samples.length
    let trajLen = 0

    while (!solver.solved && !solver.failed) {
      solver.step()
      if (trajLen < sampleCap) {
        const p = solver.progress || 0
        samples[trajLen] = Number.isFinite(p) ? p : 0
      }
      trajLen++
      if (trajLen % STREAM_FLUSH_EVERY === 0) {
        Atomics.store(header, 4, solvedSegmentsOf(solver))
        Atomics.store(header, 6, Math.min(trajLen, sampleCap))
      }
      if (Atomics.load(cancelFlag, 0) === 1) {
        Atomics.store(header, 6, Math.min(trajLen, sampleCap))
        Atomics.store(header, 1, solver.iterations)
        Atomics.store(header, 2, maxIterations)
        Atomics.store(header, 3, Math.min(trajLen, sampleCap))
        Atomics.store(header, 4, solvedSegmentsOf(solver))
        Atomics.store(header, 5, 0)
        Atomics.store(header, 0, 3)
        Atomics.notify(header, 0)
        return
      }
    }

    Atomics.store(header, 6, Math.min(trajLen, sampleCap))
    let routesBytes = 0
    lastSolvedRoutes = null
    if (solver.solved) {
      lastSolvedRoutes = extractWinningRoutes(
        solver as Parameters<typeof extractWinningRoutes>[0],
        factory.nodeWithPortPoints,
      )
      const encoded = new TextEncoder().encode(
        JSON.stringify(lastSolvedRoutes),
      )
      const offset = HEADER_BYTES + Math.min(trajLen, sampleCap) * 4
      if (encoded.length <= resultSab.byteLength - offset) {
        new Uint8Array(resultSab, offset, encoded.length).set(encoded)
        routesBytes = encoded.length
      }
    }
    Atomics.store(header, 1, solver.iterations)
    Atomics.store(header, 2, maxIterations)
    Atomics.store(header, 3, Math.min(trajLen, sampleCap))
    Atomics.store(header, 4, solvedSegmentsOf(solver))
    Atomics.store(header, 5, routesBytes)
    Atomics.store(header, 0, solver.solved ? 1 : 2)
    Atomics.notify(header, 0)
  } catch (err) {
    console.error("replay worker task error:", err)
    Atomics.store(header, 0, 4)
    Atomics.notify(header, 0)
  }
}

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as BoardMsg | SessionMsg | TaskMsg | RoutesMsg
  if (msg.kind === "board") {
    boardConnMap = msg.connMap
    Object.setPrototypeOf(boardConnMap, ConnectivityMap.prototype)
    return
  }
  if (msg.kind === "session") {
    const constructorParams = { ...msg.constructorParams }
    constructorParams.connMap = boardConnMap
    factory = new PortfolioSingleIntraNodeSolver(
      constructorParams as ConstructorParameters<
        typeof PortfolioSingleIntraNodeSolver
      >[0],
    )
    return
  }
  if (msg.kind === "routes") {
    const encoded = new TextEncoder().encode(JSON.stringify(lastSolvedRoutes))
    const header = new Int32Array(msg.resultSab, 0, HEADER_INTS)
    if (encoded.length <= msg.resultSab.byteLength - HEADER_BYTES) {
      new Uint8Array(msg.resultSab, HEADER_BYTES, encoded.length).set(encoded)
      Atomics.store(header, 5, encoded.length)
    } else {
      Atomics.store(header, 5, 0)
    }
    Atomics.store(header, 0, lastSolvedRoutes ? 1 : 4)
    Atomics.notify(header, 0)
    return
  }
  runTask(msg)
}
