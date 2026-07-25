/**
 * Hard ceiling on any candidate-racing scheme, measured from the sequential run.
 *
 * Today each node costs SUM(work over candidates). A perfect in-process race
 * (all candidates concurrent, losers cancelled the moment the winner lands)
 * costs MAX(work over candidates). The ratio bounds every racing design -
 * Rust threads, workers, anything - before writing one.
 */
import { writeFileSync } from "node:fs"
const REPO = "/home/pullin/personal/awt-r3"
const { AutoroutingPipelineSolver7_MultiGraph } = await import(
  `${REPO}/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts`
)
const { loadScenarioBySampleNumber } = await import(`${REPO}/scripts/benchmark/scenarios`)

const sample = Number(process.env.SAMPLE ?? 6)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const t0 = Date.now()
const solver: any = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(scenario) as any)
solver.solve()
const wall = (Date.now() - t0) / 1000

const stats: any[] = (globalThis as any).__supervisorStats ?? []
const withWork = stats.filter((s) => s.sumCandidateWork > 0)
const seqTotal = withWork.reduce((a, s) => a + s.sumCandidateWork, 0)
const racedTotal = withWork.reduce((a, s) => a + s.maxCandidateWork, 0)
const solvedNodes = withWork.filter((s) => !s.nodeFailed)
const failedNodes = withWork.filter((s) => s.nodeFailed)
const sum = (a: any[], k: string) => a.reduce((x, s) => x + (s[k] ?? 0), 0)

const perNode = withWork
  .map((s) => ({ ratio: s.sumCandidateWork / Math.max(1, s.maxCandidateWork), work: s.sumCandidateWork }))
  .sort((a, b) => b.work - a.work)

console.log(
  JSON.stringify(
    {
      sample,
      wallS: +wall.toFixed(1),
      nodes: withWork.length,
      solvedNodes: solvedNodes.length,
      failedNodes: failedNodes.length,
      seqCandidateWork: seqTotal,
      racedCandidateWork: racedTotal,
      // the ceiling: how much faster the HD candidate work could possibly get
      hdCeilingX: +(seqTotal / Math.max(1, racedTotal)).toFixed(2),
      onSolvedNodesX: +(sum(solvedNodes, "sumCandidateWork") / Math.max(1, sum(solvedNodes, "maxCandidateWork"))).toFixed(2),
      onFailedNodesX: +(sum(failedNodes, "sumCandidateWork") / Math.max(1, sum(failedNodes, "maxCandidateWork"))).toFixed(2),
      failedShareOfWork: +((100 * sum(failedNodes, "sumCandidateWork")) / Math.max(1, seqTotal)).toFixed(1),
      medianPerNodeRatio: +perNode[Math.floor(perNode.length / 2)]?.ratio.toFixed(2),
      top10WorkNodeRatios: perNode.slice(0, 10).map((p) => +p.ratio.toFixed(2)),
      avgCandidatesCounted: +(sum(withWork, "countedCandidates") / withWork.length).toFixed(1),
    },
    null,
    1,
  ),
)
writeFileSync(process.env.OUT ?? `${process.env.HOME}/.perf-scratch/race-ceiling-${sample}.json`, JSON.stringify(stats))
