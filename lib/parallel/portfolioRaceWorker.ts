import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import { PortfolioSingleIntraNodeSolver } from "../solvers/HyperHighDensitySolver/PortfolioSingleIntraNodeSolver"
import { extractWinningRoutes } from "../solvers/HyperHighDensitySolver/extractWinningRoutes"

/**
 * Worker entry for the parallel intra-node portfolio race
 * (perf-artifacts/parallelism-design.md, P1). Receives one candidate per
 * task message, steps it synchronously in chunks, and reports the result
 * through a SharedArrayBuffer so the main thread can poll it without an
 * event-loop turn (the pipeline pump is fully synchronous).
 *
 * resultSab layout: Int32 header [status, payloadLength] then UTF-8 JSON.
 *   status: 0 idle/running, 1 solved, 2 failed, 3 cancelled, 4 error
 * cancelSab layout: Int32 [cancelFlag] (1 = stop at next chunk boundary)
 */

type RaceTask = {
  taskId: number
  hyperParameters: Record<string, unknown>
  constructorParams: Record<string, unknown>
  resultSab: SharedArrayBuffer
  cancelSab: SharedArrayBuffer
}

const STATUS_OFFSET = 0
const LENGTH_OFFSET = 1
const PAYLOAD_OFFSET = 16
const CHUNK_STEPS = 512

const writeResult = (
  resultSab: SharedArrayBuffer,
  status: number,
  payload: unknown,
) => {
  const header = new Int32Array(resultSab, 0, 2)
  const encoded = new TextEncoder().encode(JSON.stringify(payload ?? null))
  const capacity = resultSab.byteLength - PAYLOAD_OFFSET
  if (encoded.length > capacity) {
    const overflow = new TextEncoder().encode(
      JSON.stringify({ error: `result too large: ${encoded.length} bytes` }),
    )
    new Uint8Array(resultSab, PAYLOAD_OFFSET, overflow.length).set(overflow)
    Atomics.store(header, LENGTH_OFFSET, overflow.length)
    Atomics.store(header, STATUS_OFFSET, 4)
  } else {
    new Uint8Array(resultSab, PAYLOAD_OFFSET, encoded.length).set(encoded)
    Atomics.store(header, LENGTH_OFFSET, encoded.length)
    Atomics.store(header, STATUS_OFFSET, status)
  }
  Atomics.notify(header, STATUS_OFFSET)
}

declare var self: Worker

self.onmessage = (e: MessageEvent) => {
  const task = e.data as RaceTask
  const { resultSab, cancelSab } = task
  const cancelFlag = new Int32Array(cancelSab, 0, 1)
  try {
    const constructorParams = { ...task.constructorParams }
    // Structured clone strips class prototypes; restore ConnectivityMap.
    if (constructorParams.connMap) {
      Object.setPrototypeOf(
        constructorParams.connMap,
        ConnectivityMap.prototype,
      )
    }
    const factory = new PortfolioSingleIntraNodeSolver(
      constructorParams as ConstructorParameters<
        typeof PortfolioSingleIntraNodeSolver
      >[0],
    )
    const solver = factory.generateSolver(task.hyperParameters)
    // Some candidate solvers expose an idempotent budget setup phase.
    if ("setup" in solver && typeof solver.setup === "function") {
      ;(solver.setup as () => void).call(solver)
    }

    while (!solver.solved && !solver.failed) {
      for (let i = 0; i < CHUNK_STEPS && !solver.solved && !solver.failed; i++) {
        solver.step()
      }
      if (Atomics.load(cancelFlag, 0) === 1) {
        writeResult(resultSab, 3, { taskId: task.taskId })
        return
      }
    }

    if (solver.solved) {
      const routes = extractWinningRoutes(
        solver as Parameters<typeof extractWinningRoutes>[0],
        factory.nodeWithPortPoints,
      )
      writeResult(resultSab, 1, {
        taskId: task.taskId,
        iterations: solver.iterations,
        routes,
      })
    } else {
      writeResult(resultSab, 2, {
        taskId: task.taskId,
        iterations: solver.iterations,
        error: solver.error ?? "failed",
      })
    }
  } catch (err) {
    writeResult(resultSab, 4, {
      taskId: task.taskId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
