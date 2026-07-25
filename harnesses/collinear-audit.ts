import { AutoroutingPipelineSolver7_MultiGraph } from "/home/pullin/personal/awt-r3/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts"
import { loadScenarioBySampleNumber } from "/home/pullin/personal/awt-r3/scripts/benchmark/scenarios"
const sample = Number(process.env.SAMPLE ?? 5)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const s = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(scenario) as any)
s.solve()
const a = (globalThis as any).__cAudit ?? { trues: 0, spurious: 0, dists: [] }
const ds = a.dists.slice().sort((x: number, y: number) => x - y)
console.log(JSON.stringify({
  sample,
  intersectTrueCount: a.trues,
  spuriousCount: a.spurious,
  spuriousPct: +(100 * a.spurious / Math.max(1, a.trues)).toFixed(1),
  spuriousDistMm: { p50: ds[Math.floor(ds.length * 0.5)], p90: ds[Math.floor(ds.length * 0.9)], max: ds[ds.length - 1] },
}))
