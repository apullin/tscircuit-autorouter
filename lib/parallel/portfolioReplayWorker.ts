import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import { PortfolioSingleIntraNodeSolver } from "../solvers/HyperHighDensitySolver/PortfolioSingleIntraNodeSolver"
import { extractWinningRoutes } from "../solvers/HyperHighDensitySolver/extractWinningRoutes"

/**
 * P2-replay worker (perf-artifacts/parallelism-design.md §5): runs portfolio
 * candidates to completion and streams back per-iteration progress
 * trajectories so the main thread can replay the sequential fitness
 * schedule deterministically.
 *
 * Protocol:
 *   "session" — { constructorParams } per node: rebuilds the factory.
 *   "task"    — { hyperParameters, resultSab }: construct + setup + run one
 *               candidate to completion, logging progress every iteration.
 *
 * resultSab layout (Int32 view):
 *   [0] status (0 running, 1 solved, 2 failed, 4 error)
 *   [1] solveIteration (iterations at completion; == final count)
 *   [2] maxIterations (post-setup MAX_ITERATIONS)
 *   [3] trajLen (number of logged progress samples)
 *   [4] solvedSegments (final solved-segment count for getCandidateProgress)
 *   [5] routesBytes (JSON length, 0 if failed)
 * Float32 progress samples at byte offset 32; routes JSON after samples.
 */

type SessionMsg = {
  kind: "session"
  constructorParams: Record<string, unknown>
}
type TaskMsg = {
  kind: "task"
  hyperParameters: Record<string, unknown>
  resultSab: SharedArrayBuffer
}

const HEADER_INTS = 8
const HEADER_BYTES = HEADER_INTS * 4

const writeHeader = (
  resultSab: SharedArrayBuffer,
  values: Partial<Record<number, number>>,
) => {
  const header = new Int32Array(resultSab, 0, HEADER_INTS)
  for (const [k, v] of Object.entries(values)) header[Number(k)] = v!
}

declare var self: Worker

let factory: PortfolioSingleIntraNodeSolver | null = null

self.onmessage = (e: MessageEvent) => {
  const msg = e.data as SessionMsg | TaskMsg

  if (msg.kind === "session") {
    const constructorParams = { ...msg.constructorParams }
    if (constructorParams.connMap) {
      Object.setPrototypeOf(
        constructorParams.connMap,
        ConnectivityMap.prototype,
      )
    }
    factory = new PortfolioSingleIntraNodeSolver(
      constructorParams as ConstructorParameters<
        typeof PortfolioSingleIntraNodeSolver
      >[0],
    )
    return
  }

  const { resultSab } = msg
  const header = new Int32Array(resultSab, 0, HEADER_INTS)
  try {
    if (!factory) throw new Error("task before session")
    const solver = factory.generateSolver(msg.hyperParameters)
    if ("setup" in solver && typeof solver.setup === "function") {
      ;(solver.setup as () => void).call(solver)
    }
    const maxIterations = solver.MAX_ITERATIONS

    // Trajectory log: progress sampled per solver.iterations tick.
    const progressSamples = new Float32Array(resultSab, HEADER_BYTES)
    const sampleCap = progressSamples.length
    let trajLen = 0

    const solvedSegmentsOf = (): number => {
      const map = (
        solver as unknown as {
          solvedConnectionsMap?: Map<unknown, unknown>
        }
      ).solvedConnectionsMap
      if (!(map instanceof Map)) return -1
      let count = 0
      for (const routes of map.values()) {
        if (Array.isArray(routes)) count += routes.length
      }
      return count
    }

    while (!solver.solved && !solver.failed) {
      solver.step()
      if (trajLen < sampleCap) {
        const p = solver.progress || 0 // NaN collapses to 0, as downstream
        progressSamples[trajLen++] = Number.isFinite(p) ? p : 0
      } else {
        trajLen++
      }
    }

    const solvedSegments = solvedSegmentsOf()
    let routesBytes = 0
    if (solver.solved) {
      const routes = extractWinningRoutes(solver, factory.nodeWithPortPoints)
      const encoded = new TextEncoder().encode(JSON.stringify(routes))
      const offset = HEADER_BYTES + Math.min(trajLen, sampleCap) * 4
      const capacity = resultSab.byteLength - offset
      if (encoded.length > capacity) {
        writeHeader(resultSab, { 0: 4 })
        return
      }
      new Uint8Array(resultSab, offset, encoded.length).set(encoded)
      routesBytes = encoded.length
    } else {
      const encoded = new TextEncoder().encode(
        JSON.stringify({ error: solver.error ?? "failed" }),
      )
      const offset = HEADER_BYTES + Math.min(trajLen, sampleCap) * 4
      if (encoded.length <= resultSab.byteLength - offset) {
        new Uint8Array(resultSab, offset, encoded.length).set(encoded)
        routesBytes = encoded.length
      }
    }

    writeHeader(resultSab, {
      0: solver.solved ? 1 : 2,
      1: solver.iterations,
      2: maxIterations,
      3: Math.min(trajLen, sampleCap),
      4: solvedSegments,
      5: routesBytes,
    })
    Atomics.notify(header, 0)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("portfolioReplayWorker error:", err)
    const encoded = new TextEncoder().encode(JSON.stringify({ error: msg }))
    const offset = HEADER_BYTES
    if (encoded.length <= resultSab.byteLength - offset) {
      new Uint8Array(resultSab, offset, encoded.length).set(encoded)
      writeHeader(resultSab, { 0: 4, 1: 0, 2: 0, 3: 0, 4: -1, 5: encoded.length })
    } else {
      writeHeader(resultSab, { 0: 4, 1: 0, 2: 0, 3: 0, 4: -1, 5: 0 })
    }
    Atomics.notify(header, 0)
  }
}
