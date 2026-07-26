/**
 * TS_GOLDEN_DUMP capture sink for the Rust portfolio port (native/PORT-SPEC.md,
 * RUST-PLAN.md section 1).
 *
 * Called (lazily, via require) from the TS_GOLDEN_DUMP-gated hook in
 * lib/solvers/HyperHighDensitySolver/PortfolioSingleIntraNodeSolver.ts
 * parallelReplayStep — the same completion point as the RPLYDS01 capture
 * (capture-hook.patch): every candidate has run to completion, so final
 * routes, iterations and full trajectories exist for ALL candidate classes.
 *
 * Output: JSON-lines at $TS_GOLDEN_DUMP, appended per node (a killed run keeps
 * every fully written node). Line kinds:
 *   {"t":"board", obstacles, layerCount}          — once per process
 *   {"t":"node", nodeId, nodeSegmentCount, initialCount, winnerIndex,
 *    node: <nodeWithPortPoints>, params: {traceWidth, viaDiameter,
 *    obstacleMargin, effort}, connMap: {idToNet, nets}}
 *      — per node: the node-shared input. connMap is the slice the solve can
 *        observe — net ids for the node's connection names plus those nets'
 *        member lists (and netMap[connectionName] where a connection name is
 *        itself a net id: the cache key calls getIdsConnectedToNet with
 *        connection names). Shared input + per-candidate hp fully determines
 *        each candidate; generateSolver derives everything else.
 *   {"t":"cand", nodeId, i, hp, solved, iterations, maxIterations,
 *    solvedSegments, routes, error, traj}
 *      — per candidate; traj is the per-100-iteration schedule-grid
 *        trajectory (datasetFormat.decimateTrajectory — bit-exact for the
 *        replay; f32 samples widen exactly into JSON doubles).
 *
 * This module deliberately imports nothing from lib/ so the patched solver
 * file gains no new dependency edges beyond this directory.
 */

import { appendFileSync, writeFileSync } from "node:fs"
import { decimateTrajectory } from "./datasetFormat"

/** Structural subset of lib/parallel/replayPool.ts ReplayCandidateResult. */
export type GoldenCandidate = {
  hyperParameters: Record<string, unknown>
  solved: boolean
  iterations: number
  maxIterations: number
  progress: Float32Array
  solvedSegments: number
  routes: unknown
  error?: string
}

export type GoldenNode = {
  nodeId: string
  nodeSegmentCount: number
  initialCount: number
  winnerIndex: number
  constructorParams: Record<string, unknown>
  results: GoldenCandidate[]
}

let started = false

const connMapSlice = (
  connMap: unknown,
  connectionNames: string[],
): {
  idToNet: Record<string, string>
  nets: Record<string, string[]>
} | null => {
  const m = connMap as
    | {
        idToNetMap?: Record<string, string>
        netMap?: Record<string, string[]>
      }
    | undefined
  if (!m?.idToNetMap || !m?.netMap) return null
  const idToNet: Record<string, string> = {}
  const nets: Record<string, string[]> = {}
  for (const name of connectionNames) {
    const net = m.idToNetMap[name]
    if (net !== undefined) {
      idToNet[name] = net
      if (!(net in nets)) nets[net] = m.netMap[net] ?? []
    }
    // The cache key calls getIdsConnectedToNet(connectionName), treating the
    // connection name itself as a net id. Preserve that lookup too.
    if (name in m.netMap && !(name in nets)) nets[name] = m.netMap[name]!
  }
  return { idToNet, nets }
}

export const recordGoldenDump = (node: GoldenNode): void => {
  const dumpPath = process.env.TS_GOLDEN_DUMP
  if (!dumpPath) return
  // Only the main thread writes (workers inherit the env; a nested portfolio
  // must not interleave writes into the main dump).
  const bun = (globalThis as { Bun?: { isMainThread?: boolean } }).Bun
  if (bun && bun.isMainThread === false) return

  const p = node.constructorParams as Record<string, any>
  const nwpp = p.nodeWithPortPoints as
    | { portPoints?: Array<{ connectionName: string }> }
    | undefined
  const connectionNames = [
    ...new Set((nwpp?.portPoints ?? []).map((pt) => pt.connectionName)),
  ]

  const lines: string[] = []
  if (!started) {
    started = true
    writeFileSync(dumpPath, "") // truncate any previous capture
    lines.push(
      JSON.stringify({
        t: "board",
        obstacles: p.obstacles ?? null,
        layerCount: p.layerCount ?? null,
      }),
    )
  }
  lines.push(
    JSON.stringify({
      t: "node",
      nodeId: node.nodeId,
      nodeSegmentCount: node.nodeSegmentCount,
      initialCount: node.initialCount,
      winnerIndex: node.winnerIndex,
      node: p.nodeWithPortPoints ?? null,
      params: {
        traceWidth: p.traceWidth,
        viaDiameter: p.viaDiameter,
        obstacleMargin: p.obstacleMargin,
        effort: p.effort,
      },
      connMap: connMapSlice(p.connMap, connectionNames),
    }),
  )
  for (let i = 0; i < node.results.length; i++) {
    const r = node.results[i]!
    lines.push(
      JSON.stringify({
        t: "cand",
        nodeId: node.nodeId,
        i,
        hp: r.hyperParameters,
        solved: r.solved,
        iterations: r.iterations,
        maxIterations: r.maxIterations,
        solvedSegments: r.solvedSegments,
        routes: r.routes ?? null,
        error: r.error,
        traj: Array.from(decimateTrajectory(r.progress, r.iterations)),
      }),
    )
  }
  appendFileSync(dumpPath, `${lines.join("\n")}\n`)
}
