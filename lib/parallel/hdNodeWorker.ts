import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import { GrowShrinkHighDensityIntraNodeSolver } from "../solvers/HyperHighDensitySolver/GrowShrinkHighDensityIntraNodeSolver"
import { PortfolioSingleIntraNodeSolver } from "../solvers/HyperHighDensitySolver/PortfolioSingleIntraNodeSolver"

/**
 * Worker entry for NODE-level parallelism in the high-density stage.
 *
 * High-density nodes are independent: HighDensitySolver hands each one only its
 * own port points plus shared read-only context (connMap, obstacles, widths).
 * No routes from other nodes are passed, so nodes can be solved concurrently
 * and in any order.
 *
 * Measured ceiling (experiments/node-parallel-ceiling.ts): stage 5.09x / board
 * 1.82x on srj18 sample 8 and stage 3.32x / board 1.81x on sample 6, saturating
 * at 4-8 workers because one node dominates the makespan (12.2s and 62.5s
 * respectively).
 *
 * Protocol: one "init" message carrying the shared context, then one message
 * per node. Results come back through a per-worker SharedArrayBuffer so the
 * synchronous pipeline pump can poll without an event-loop turn.
 *   resultSab: Int32 header [status, payloadLength] then UTF-8 JSON.
 *   status: 0 idle/running, 1 done, 4 error
 */

const STATUS_OFFSET = 0
const LENGTH_OFFSET = 1
const PAYLOAD_OFFSET = 16

let sharedContext: Record<string, unknown> | null = null

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
  const msg = e.data as Record<string, any>

  if (msg.type === "init") {
    sharedContext = msg.context
    const connMap = sharedContext!.connMap as ConnectivityMap | undefined
    if (connMap) Object.setPrototypeOf(connMap, ConnectivityMap.prototype)
    return
  }

  const resultSab = msg.resultSab as SharedArrayBuffer
  try {
    if (!sharedContext) throw new Error("hdNodeWorker received a task before init")

    const params = {
      ...sharedContext,
      nodeWithPortPoints: msg.nodeWithPortPoints,
    } as any

    const solver = params.useGrowShrink
      ? new GrowShrinkHighDensityIntraNodeSolver(params)
      : new PortfolioSingleIntraNodeSolver(params)
    solver.solve()

    writeResult(resultSab, 1, {
      nodeId: msg.nodeWithPortPoints?.capacityMeshNodeId,
      solved: solver.solved,
      failed: solver.failed,
      error: solver.error ?? null,
      routes: solver.solvedRoutes ?? [],
      stats: solver.stats ?? {},
    })
  } catch (err) {
    writeResult(resultSab, 4, {
      nodeId: msg.nodeWithPortPoints?.capacityMeshNodeId,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
