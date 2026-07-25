const REPO = "/home/pullin/personal/awt-exp"
const { AutoroutingPipelineSolver7_MultiGraph } = await import(`${REPO}/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts`)
const { loadScenarioBySampleNumber } = await import(`${REPO}/scripts/benchmark/scenarios`)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, Number(process.env.SAMPLE ?? 8))
const p: any = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(scenario) as any)
p.solve()
const stats = (globalThis as any).__supervisorStats ?? []
console.log(JSON.stringify({
  salvage: (globalThis as any).__salvage ?? "fallback never reached",
  portfolioFailures: stats.filter((s: any) => s.nodeFailed).length,
}))
