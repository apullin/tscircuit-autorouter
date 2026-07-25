/**
 * Does the decomposition cause the doomed nodes?
 *
 * calculateOptimalCapacityDepth (built on getTunedTotalCapacity1, "tuned for
 * two layers") sets the mesh subdivision depth. Finer subdivision = smaller
 * nodes = fewer nets committed through each. If the pathological nodes are an
 * artifact of over-coarse decomposition, +1/+2 depth should make them vanish.
 *
 * Measures per depth: wall, DRC, failed HD nodes and the search work they burn.
 */
const REPO = "/home/pullin/personal/awt-r3"
const { AutoroutingPipelineSolver7_MultiGraph } = await import(
  `${REPO}/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts`
)
const { loadScenarioBySampleNumber } = await import(`${REPO}/scripts/benchmark/scenarios`)
const { calculateOptimalCapacityDepth } = await import(`${REPO}/lib/utils/getTunedTotalCapacity1.ts`)

const sample = Number(process.env.SAMPLE ?? 8)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)

const bounds = (scenario as any).bounds
const maxWH = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY)
const baseDepth = calculateOptimalCapacityDepth(maxWH, 0.5)
const deltas = (process.env.DELTAS ?? "0,1,2").split(",").map(Number)

console.log(`sample ${sample}: board ${maxWH.toFixed(1)}mm, default capacityDepth ${baseDepth}`)

for (const d of deltas) {
  const depth = baseDepth + d
  ;(globalThis as any).__supervisorStats = []
  const t0 = Date.now()
  const solver: any = new AutoroutingPipelineSolver7_MultiGraph(
    structuredClone(scenario) as any,
    { capacityDepth: depth } as any,
  )
  let err: string | null = null
  try {
    solver.solve()
  } catch (e) {
    err = (e as Error).message
  }
  const wall = (Date.now() - t0) / 1000
  const stats: any[] = (globalThis as any).__supervisorStats ?? []
  const failed = stats.filter((s) => s.nodeFailed)
  const work = stats.reduce((a, s) => a + (s.sumCandidateWork ?? 0), 0)
  const failWork = failed.reduce((a, s) => a + (s.sumCandidateWork ?? 0), 0)
  // final DRC via the pipeline's own output
  let drc = -1
  try {
    const out = solver.getOutputSimplifiedPcbTraces?.call(solver)
    drc = Array.isArray(out) ? -1 : -1
  } catch {}
  console.log(
    JSON.stringify({
      depth,
      delta: d,
      wallS: +wall.toFixed(1),
      solved: solver.solved,
      failedPipeline: solver.failed,
      error: err,
      hdNodes: stats.length,
      failedNodes: failed.length,
      totalCandidateWork: work,
      failedNodeWork: failWork,
      failedShare: +((100 * failWork) / Math.max(1, work)).toFixed(1),
    }),
  )
}
