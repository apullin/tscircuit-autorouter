/**
 * TS_REPLAY_DUMP capture sink for the replay-parity spike.
 *
 * Called (lazily, via require) from the flag-gated hook in
 * lib/solvers/HyperHighDensitySolver/PortfolioSingleIntraNodeSolver.ts
 * parallelReplayStep — see capture-hook.patch in this directory. The hook
 * fires once per node right after runReplayRace() returns, i.e. at the exact
 * point where every candidate's trajectory is complete and the live TS replay
 * has already computed its winner.
 *
 * Trajectories are decimated to the schedule grid IMMEDIATELY (100x smaller,
 * bit-exact for the replay — see datasetFormat.ts) so a full srj18 sample-8
 * capture stays tens of MB in memory. The RPLYDS01 file is written once, at
 * process exit.
 *
 * This module deliberately imports nothing from lib/ so the patched solver
 * file gains no new dependency edges beyond this directory.
 */

import { writeFileSync } from "node:fs"
import {
  type DatasetNode,
  decimateTrajectory,
  encodeDataset,
} from "./datasetFormat"

/** Structural subset of lib/parallel/replayPool.ts ReplayCandidateResult. */
export type CapturedCandidate = {
  hyperParameters: Record<string, unknown>
  solved: boolean
  iterations: number
  maxIterations: number
  /** raw per-iteration progress (possibly SAB-cap truncated) */
  progress: Float32Array
  solvedSegments: number
}

export type CapturedNode = {
  nodeId: string
  nodeSegmentCount: number
  initialCount: number
  /** outcome.winnerIndex from the live TS replay, -1 for none */
  capturedWinnerIndex: number
  results: CapturedCandidate[]
}

const pending: DatasetNode[] = []
let exitHookRegistered = false
let written = false

const flush = (dumpPath: string) => {
  if (written) return
  written = true
  try {
    const bytes = encodeDataset(pending)
    writeFileSync(dumpPath, bytes)
    console.error(
      `[replay-core] TS_REPLAY_DUMP: wrote ${pending.length} nodes ` +
        `(${bytes.byteLength} bytes) to ${dumpPath}`,
    )
  } catch (err) {
    console.error(`[replay-core] TS_REPLAY_DUMP write failed: ${err}`)
  }
}

export const recordReplayDump = (node: CapturedNode): void => {
  const dumpPath = process.env.TS_REPLAY_DUMP
  if (!dumpPath) return
  // Only the main thread writes the dump. (Workers inherit the env; the hook
  // should never fire in one, but if a nested portfolio ever does, it must
  // not clobber the main dump file at its own exit.)
  const bun = (globalThis as { Bun?: { isMainThread?: boolean } }).Bun
  if (bun && bun.isMainThread === false) return

  pending.push({
    nodeId: node.nodeId,
    nodeSegmentCount: node.nodeSegmentCount,
    initialCount: node.initialCount,
    capturedWinnerIndex: node.capturedWinnerIndex,
    candidates: node.results.map((r) => ({
      hp: r.hyperParameters,
      solved: r.solved,
      iterations: r.iterations,
      maxIterations: r.maxIterations,
      solvedSegments: r.solvedSegments,
      traj: decimateTrajectory(r.progress, r.iterations),
    })),
  })

  if (!exitHookRegistered) {
    exitHookRegistered = true
    process.on("exit", () => flush(dumpPath))
  }
}
