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

const { scenario } = await loadScenarioBySampleNumber(dataset, sample)
const pipeline = new AutoroutingPipelineSolver7_MultiGraph(
  structuredClone(scenario),
)

const t0 = Date.now()
pipeline.solve()
const wallS = (Date.now() - t0) / 1000

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

console.log(
  JSON.stringify(
    {
      dataset,
      sample,
      solved: pipeline.solved,
      failed: pipeline.failed,
      iterations: pipeline.iterations,
      wallS: +wallS.toFixed(1),
      drcErrors,
      evictRepath: process.env.TS_EVICT_REPATH ?? "0",
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
