import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import { GlobalDrcForceImproveSolver } from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/GlobalDrcForceImproveSolver"
import { getDrcSnapshot } from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/drc-snapshot"
import { applyBroadRepulsionForces } from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/solverHelpers"
import { createPipeline7RelaxedDrcEvaluator } from "../autorouter-pipelines/AutoroutingPipeline7_MultiGraph/create-pipeline7-relaxed-drc-evaluator"

/**
 * Worker entry for the parallel DRC branch portfolio (A2;
 * perf-artifacts/parallelism-design.md). Runs ONE branch per task:
 *   "baseline" — GlobalDrcForceImproveSolver on the input routes
 *   "broad"    — applyBroadRepulsionForces + speculative broad solver
 * Returns routes + DRC issue count via SharedArrayBuffer so the synchronous
 * pipeline pump can poll without an event-loop turn.
 *
 * resultSab layout: Int32 header [status, payloadLength] then UTF-8 JSON.
 *   status: 0 running, 1 done, 4 error
 */

type BranchTask = {
  branch: "baseline" | "broad"
  srj: unknown
  hdRoutes: unknown[]
  connMap: unknown
  evaluatorConfig: Record<string, unknown>
  solverParams: Record<string, unknown>
  effort: number
  broadPassMultiplier: number
  resultSab: SharedArrayBuffer
}

const STATUS_OFFSET = 0
const LENGTH_OFFSET = 1
const PAYLOAD_OFFSET = 16

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
  const task = e.data as BranchTask
  try {
    const connMap = task.connMap as ConnectivityMap
    Object.setPrototypeOf(connMap, ConnectivityMap.prototype)

    const drcEvaluator = createPipeline7RelaxedDrcEvaluator({
      ...(task.evaluatorConfig as Parameters<
        typeof createPipeline7RelaxedDrcEvaluator
      >[0]),
      connMap,
    })

    const srj = task.srj as Parameters<typeof getDrcSnapshot>[0]

    if (task.branch === "baseline") {
      const solver = new GlobalDrcForceImproveSolver({
        ...(task.solverParams as Record<string, unknown>),
        srj,
        hdRoutes: task.hdRoutes,
        connMap,
        drcEvaluator,
        enableViaInPadLayerMoves: false,
      } as ConstructorParameters<typeof GlobalDrcForceImproveSolver>[0])
      solver.solve()
      if (solver.failed) throw new Error(`baseline branch failed: ${solver.error}`)
      const routes = solver.getOutput()
      const snapshot = getDrcSnapshot(srj, routes, drcEvaluator, connMap)
      writeResult(task.resultSab, 1, { routes, count: snapshot.count })
      return
    }

    // broad: repulsion + input snapshot + speculative broad solve
    const broadInputRoutes = applyBroadRepulsionForces(
      srj,
      task.hdRoutes as Parameters<typeof applyBroadRepulsionForces>[1],
      task.effort,
      task.broadPassMultiplier,
      connMap,
    )
    const broadInputSnapshot = getDrcSnapshot(
      srj,
      broadInputRoutes,
      drcEvaluator,
      connMap,
    )
    const broadSolver = new GlobalDrcForceImproveSolver({
      ...(task.solverParams as Record<string, unknown>),
      srj,
      hdRoutes: broadInputRoutes,
      connMap,
      drcEvaluator,
      enableViaInPadLayerMoves: false,
    } as ConstructorParameters<typeof GlobalDrcForceImproveSolver>[0])
    broadSolver.solve()
    if (broadSolver.failed) throw new Error(`broad branch failed: ${broadSolver.error}`)
    const broadRoutes = broadSolver.getOutput()
    const broadSnapshot = getDrcSnapshot(srj, broadRoutes, drcEvaluator, connMap)
    writeResult(task.resultSab, 1, {
      routes: broadRoutes,
      count: broadSnapshot.count,
      broadInputCount: broadInputSnapshot.count,
      broadInputRoutes,
    })
  } catch (err) {
    writeResult(task.resultSab, 4, {
      error: err instanceof Error ? err.message : String(err),
    })
  }
}
