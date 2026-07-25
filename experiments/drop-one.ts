/**
 * EXPERIMENT R1-gate: are the doomed nodes UNROUTABLE, or merely OVER-COMMITTED?
 *
 * A dozen nodes per board consume 68-88% of all high-density search, exhaust
 * every candidate, and fail. No local property distinguishes them from nodes
 * that solve (four analytic bounds and a learned rule all failed).
 *
 * This asks the question directly: remove ONE connection from a doomed node and
 * re-run the same portfolio. If the remainder routes, the node was never
 * unroutable - the planner simply committed one net too many, and a global
 * re-plan (negotiated congestion) would fix it. If it still fails with any
 * single connection removed, the geometry is genuinely hostile and re-planning
 * buys less than hoped.
 *
 * Usage: PERF_SUPERVISOR_STATS=1 PERF_CAPTURE_FAILED=1 SAMPLE=8 bun experiments/drop-one.ts
 */
const REPO = "/home/pullin/personal/awt-exp"
const { AutoroutingPipelineSolver7_MultiGraph } = await import(
  `${REPO}/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts`
)
const { PortfolioSingleIntraNodeSolver } = await import(
  `${REPO}/lib/solvers/HyperHighDensitySolver/PortfolioSingleIntraNodeSolver.ts`
)
const { loadScenarioBySampleNumber } = await import(`${REPO}/scripts/benchmark/scenarios`)

const sample = Number(process.env.SAMPLE ?? 8)
const perSubsetBudgetMs = Number(process.env.SUBSET_BUDGET_MS ?? 20000)

const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const pipeline: any = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(scenario) as any)
const t0 = Date.now()
pipeline.solve()
console.log(`baseline solve: ${((Date.now() - t0) / 1000).toFixed(1)}s`)

const failedParams: any[] = (globalThis as any).__failedNodeParams ?? []
console.log(`captured ${failedParams.length} failed nodes\n`)

/** run a portfolio to completion or a wall-clock budget */
const trySolve = (params: any, budgetMs: number) => {
  const solver: any = new PortfolioSingleIntraNodeSolver(params)
  const start = Date.now()
  let steps = 0
  while (!solver.solved && !solver.failed) {
    solver.step()
    steps++
    if ((steps & 0xff) === 0 && Date.now() - start > budgetMs) {
      return { outcome: "budget", ms: Date.now() - start }
    }
  }
  return { outcome: solver.solved ? "solved" : "failed", ms: Date.now() - start }
}

const results: any[] = []
for (const params of failedParams) {
  const node = params.nodeWithPortPoints
  const connections = [...new Set(node.portPoints.map((p: any) => p.connectionName))] as string[]

  // sanity: reproduce the failure standalone
  const base = trySolve(params, perSubsetBudgetMs)

  const rescued: string[] = []
  const still: string[] = []
  for (const drop of connections) {
    const trimmed = {
      ...params,
      nodeWithPortPoints: {
        ...node,
        portPoints: node.portPoints.filter((p: any) => p.connectionName !== drop),
      },
    }
    const r = trySolve(trimmed, perSubsetBudgetMs)
    if (r.outcome === "solved") rescued.push(drop)
    else still.push(`${drop}:${r.outcome}`)
  }

  results.push({
    node: node.capacityMeshNodeId,
    connections: connections.length,
    baseline: base.outcome,
    rescuedBy: rescued.length,
    rescuedFraction: +(rescued.length / connections.length).toFixed(2),
  })
  console.log(
    `${node.capacityMeshNodeId}: ${connections.length} connections, baseline ${base.outcome} -> ` +
      `${rescued.length}/${connections.length} single removals RESCUE the node`,
  )
}

const anyRescued = results.filter((r) => r.rescuedBy > 0).length
console.log(`\n=== R1 GATE ===`)
console.log(`nodes where removing ONE connection makes the rest routable: ${anyRescued}/${results.length}`)
console.log(
  anyRescued / Math.max(1, results.length) > 0.5
    ? "=> OVER-COMMITTED. The nodes are routable; the assignment is wrong. Global re-planning is the fix."
    : "=> GENUINELY HOSTILE. Re-planning would have to move much more than one net.",
)
console.table(results)
