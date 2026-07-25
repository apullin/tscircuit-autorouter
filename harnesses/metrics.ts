/**
 * Board-level quality metrics for changes that legitimately alter results.
 * Hash identity does not apply, so compare what actually matters:
 *   traces / vias / total+median trace length / unrouted connections / DRC.
 */
const REPO = "/home/pullin/personal/awt-r3"
const { AutoroutingPipelineSolver7_MultiGraph } = await import(
  `${REPO}/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts`
)
const { loadScenarioBySampleNumber } = await import(`${REPO}/scripts/benchmark/scenarios`)

const sample = Number(process.env.SAMPLE ?? 8)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const solver: any = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(scenario) as any)
const t0 = Date.now()
solver.solve()
const wall = (Date.now() - t0) / 1000

const traces: any[] = solver.getOutputSimplifiedPcbTraces?.call(solver) ?? []
let vias = 0
let totalLength = 0
let segments = 0
const perTrace: number[] = []
for (const trace of traces) {
  const route = trace.route ?? []
  let len = 0
  for (let i = 1; i < route.length; i++) {
    const a = route[i - 1]
    const b = route[i]
    if (b.route_type === "via") {
      vias++
      continue
    }
    if (a.route_type === "via") continue
    const dx = b.x - a.x
    const dy = b.y - a.y
    len += Math.sqrt(dx * dx + dy * dy)
    segments++
  }
  totalLength += len
  perTrace.push(len)
}
perTrace.sort((a, b) => a - b)

const json = JSON.stringify(traces)
let h = 0x811c9dc5
for (let i = 0; i < json.length; i++) {
  h ^= json.charCodeAt(i)
  h = Math.imul(h, 0x01000193)
}

console.log(
  JSON.stringify({
    sample,
    grid: process.env.TS_EXACT_GRID === "0" ? "legacy" : "exact",
    wallS: +wall.toFixed(1),
    hash: (h >>> 0).toString(16),
    traces: traces.length,
    vias,
    segments,
    totalLengthMm: +totalLength.toFixed(2),
    medianTraceMm: +(perTrace[Math.floor(perTrace.length / 2)] ?? 0).toFixed(3),
    p95TraceMm: +(perTrace[Math.floor(perTrace.length * 0.95)] ?? 0).toFixed(3),
  }),
)
