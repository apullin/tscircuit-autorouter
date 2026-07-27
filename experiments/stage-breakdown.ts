/**
 * Where does the wall time ACTUALLY sit after the round-1..3 perf work?
 *
 * The whole campaign targeted the high-density stage, which was 56-64% of wall
 * on samples 8/6 BEFORE any of it landed. A ~2.5x on that stage reshuffles the
 * residual, and Amdahl caps whatever is left. This reads the pipeline's own
 * timeSpentOnPhase so the answer is measured, not modelled.
 */
const REPO = "/home/pullin/personal/awt-perf-stack"
const { AutoroutingPipelineSolver7_MultiGraph } = await import(
  `${REPO}/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts`
)
const { loadScenarioBySampleNumber } = await import(`${REPO}/scripts/benchmark/scenarios`)

const sample = Number(process.env.SAMPLE ?? 8)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const pipeline: any = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(scenario) as any)

const t0 = Date.now()
pipeline.solve()
const wall = (Date.now() - t0) / 1000

const phases: Record<string, number> = pipeline.timeSpentOnPhase ?? {}
const rows = Object.entries(phases)
  .map(([name, ms]) => ({ name, s: +(ms / 1000).toFixed(1), pct: +((100 * ms) / (wall * 1000)).toFixed(1) }))
  .filter((r) => r.s > 0)
  .sort((a, b) => b.s - a.s)

const accounted = rows.reduce((a, r) => a + r.s, 0)
console.log(JSON.stringify({ sample, wall, accounted: +accounted.toFixed(1), unaccounted: +(wall - accounted).toFixed(1) }))
console.table(rows)

// Amdahl: if the named stage went to zero, what is the best possible speedup?
console.log("ceiling if each stage were FREE:")
for (const r of rows.slice(0, 6)) {
  console.log(`  ${r.name.padEnd(34)} ${(wall / (wall - r.s)).toFixed(2)}x`)
}
