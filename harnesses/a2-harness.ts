import { AutoroutingPipelineSolver7_MultiGraph } from "/home/pullin/personal/awt-r3/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts"
import { loadScenarioBySampleNumber } from "/home/pullin/personal/awt-r3/scripts/benchmark/scenarios"
const sample = Number(process.env.SAMPLE ?? 8)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const solver = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(scenario) as any)
const t0 = Date.now()
solver.solve()
const wall = (Date.now() - t0) / 1000
const stage = (solver as any).exactGeometryDrcForceImproveSolver
const out = solver.getOutputSimplifiedPcbTraces.call(solver)
const json = JSON.stringify(out)
let h = 0x811c9dc5
for (let i = 0; i < json.length; i++) { h ^= json.charCodeAt(i); h = Math.imul(h, 0x01000193) }
const stageStats = stage?.stats ?? {}
console.log(JSON.stringify({
  sample, solved: solver.solved, failed: solver.failed, wall: +wall.toFixed(1),
  hash: (h >>> 0).toString(16), len: json.length,
  stageIterations: stage?.iterations,
  broadAttempted: stageStats.drcBranchPortfolioBroadBranchAttempted,
  broadAccepted: stageStats.drcBranchPortfolioBroadBranchAccepted,
  initialCount: stageStats.drcBranchPortfolioInitialDrcIssueCount,
  baselineCount: stageStats.drcBranchPortfolioBaselineDrcIssueCount,
  finalCount: stageStats.drcBranchPortfolioFinalDrcIssueCount,
}, null, 1))
