#!/usr/bin/env bun
/**
 * G6 eviction+re-path probe: runs pipeline 7 on one sample and prints the
 * gate numbers — pipeline iterations (identity anchor when the flag is off),
 * wall, relaxed-DRC error count, and the HD stage's evictionRepath stats.
 *
 * Usage:
 *   bun scripts/eviction-probe.ts --dataset srj18 --sample 8
 *   TS_EVICT_REPATH=1 bun scripts/eviction-probe.ts --dataset srj18 --sample 8
 */
import {
  DRC_EVAL_STATS_ENABLED,
  getDrcEvalStatsSummary,
} from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/drcEvalStats"
import { AutoroutingPipelineSolver7_MultiGraph } from "../lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph"
import { evaluateRelaxedDrc } from "../lib/testing/evaluate-relaxed-drc"
import {
  type DatasetName,
  loadScenarioBySampleNumber,
  parseDatasetName,
} from "./benchmark/scenarios"

const args = process.argv.slice(2)
const getArg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
const dataset: DatasetName = parseDatasetName(getArg("dataset", "srj18"))!
const sample = Number(getArg("sample", "8"))
const targetMinCapacityArg = getArg("target-min-capacity", "")
const maxNodeDimensionArg = getArg("max-node-dimension", "")
const opts: {
  targetMinCapacity?: number
  maxNodeDimension?: number
  effort?: number
} = {}
if (targetMinCapacityArg) opts.targetMinCapacity = Number(targetMinCapacityArg)
if (maxNodeDimensionArg) opts.maxNodeDimension = Number(maxNodeDimensionArg)
const effortArg = getArg("effort", "")
if (effortArg) opts.effort = Number(effortArg)

const { scenario } = await loadScenarioBySampleNumber(dataset, sample)
const pipeline = new AutoroutingPipelineSolver7_MultiGraph(
  structuredClone(scenario),
  Object.keys(opts).length > 0 ? opts : undefined,
)

const t0 = Date.now()
pipeline.solve()
const wallS = (Date.now() - t0) / 1000

// Captured before the probe's own evaluateRelaxedDrc below so the summary
// covers exactly the pipeline's DRC evaluations (TS_DRC_EVAL_STATS=1 only).
const drcEvalStats = DRC_EVAL_STATS_ENABLED ? getDrcEvalStatsSummary() : null

const evictionStats = pipeline.highDensityRouteSolver?.stats?.evictionRepath as
  | {
      evictionsApplied: number
      evictionsRescued: number
      nodesGrownAfterEviction: number
      nodesWithoutPlan: number
      nodesWithoutVictim: number
      nodesWithRejectedPlans: number
      victims: Array<{ nodeId: string; connectionName: string }>
    }
  | undefined

let drcErrors = "n/a"
if (pipeline.solved && !pipeline.failed) {
  const traces = pipeline.getOutputSimplifiedPcbTraces()
  const drc = evaluateRelaxedDrc({
    inputSrj: scenario,
    srjWithPointPairs: pipeline.srjWithPointPairs ?? scenario,
    traces,
  })
  drcErrors = String(drc.errors.length)
}

const hdStats = pipeline.highDensityRouteSolver?.stats as
  | Record<string, unknown>
  | undefined
const meshNodeCount =
  pipeline.highDensityNodePortPoints?.length ??
  pipeline.uniformPortDistributionSolver?.getOutput().length ??
  null

console.log(
  JSON.stringify(
    {
      dataset,
      sample,
      solved: pipeline.solved,
      failed: pipeline.failed,
      error: pipeline.failed ? (pipeline.error ?? null) : null,
      failedStage: pipeline.failed
        ? pipeline.pipelineDef[pipeline.currentPipelineStepIndex]?.solverName
        : null,
      iterations: pipeline.iterations,
      wallS: +wallS.toFixed(1),
      drcErrors,
      evictRepath: process.env.TS_EVICT_REPATH ?? "0",
      targetMinCapacity: opts.targetMinCapacity ?? 0.5,
      maxNodeDimension: opts.maxNodeDimension ?? 16,
      effort: opts.effort ?? 1,
      capacityDepth: (pipeline as { opts?: { capacityDepth?: number } }).opts
        ?.capacityDepth,
      meshNodeCount,
      highDensityResizeCount: hdStats?.highDensityResizeCount ?? null,
      hdStageWallS: pipeline.timeSpentOnPhase?.highDensityRouteSolver
        ? +(pipeline.timeSpentOnPhase.highDensityRouteSolver / 1000).toFixed(1)
        : null,
      drcStage1WallS:
        pipeline.timeSpentOnPhase?.globalDrcForceImproveSolver !== undefined
          ? +(
              pipeline.timeSpentOnPhase.globalDrcForceImproveSolver / 1000
            ).toFixed(2)
          : null,
      drcStage2WallS:
        pipeline.timeSpentOnPhase?.exactGeometryDrcForceImproveSolver !==
        undefined
          ? +(
              pipeline.timeSpentOnPhase.exactGeometryDrcForceImproveSolver /
              1000
            ).toFixed(2)
          : null,
      drcEvalStats,
      evictionStats: evictionStats
        ? {
            applied: evictionStats.evictionsApplied,
            rescued: evictionStats.evictionsRescued,
            grownAfterEviction: evictionStats.nodesGrownAfterEviction,
            withoutPlan: evictionStats.nodesWithoutPlan,
            withoutVictim: evictionStats.nodesWithoutVictim,
            rejectedPlans: evictionStats.nodesWithRejectedPlans,
            victims: evictionStats.victims,
          }
        : null,
    },
    null,
    2,
  ),
)
