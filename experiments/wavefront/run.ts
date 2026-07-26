/**
 * Runs the global wavefront router on a benchmark board and scores it with the
 * SAME relaxed-DRC evaluator the pipeline is judged by, so the comparison is
 * apples to apples. Speed is not the criterion here - quality is.
 */
const REPO = "/home/pullin/personal/awt-exp"
const { loadScenarioBySampleNumber } = await import(`${REPO}/scripts/benchmark/scenarios`)
const { evaluateRelaxedDrc } = await import(`${REPO}/lib/testing/evaluate-relaxed-drc.ts`)
const { routeBoard } = await import(`${REPO}/experiments/wavefront/router.ts`)

const sample = Number(process.env.SAMPLE ?? 5)
const cellSize = Number(process.env.CELL ?? 0.1)
const maxIterations = Number(process.env.ITERS ?? 6)

const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const srj: any = scenario

console.log(
  `sample ${sample}: ${srj.connections.length} nets, ${srj.obstacles.length} obstacles, ` +
    `${srj.layerCount} layers, cell ${cellSize}mm`,
)

const result = routeBoard(srj, { cellSize, maxIterations, verbose: true })

console.log(
  `routed ${result.traces.length}/${srj.connections.length} nets in ${result.iterations} iterations, ` +
    `${result.unroutable} unroutable, ${result.wallS.toFixed(1)}s, grid ${(result.gridCells / 1e6).toFixed(2)}M cells`,
)

let vias = 0
let length = 0
for (const t of result.traces as any[]) {
  for (let i = 1; i < t.route.length; i++) {
    const a = t.route[i - 1]
    const b = t.route[i]
    if (b.route_type === "via") { vias++; continue }
    if (a.route_type === "via") continue
    length += Math.hypot(b.x - a.x, b.y - a.y)
  }
}
console.log(`vias ${vias}, total trace length ${length.toFixed(1)}mm`)

try {
  const drc = evaluateRelaxedDrc({
    inputSrj: srj,
    srjWithPointPairs: srj,
    traces: result.traces as any,
  })
  const errs = drc.errors ?? []
  const byType: Record<string, number> = {}
  for (const e of errs as any[]) byType[e.type ?? "?"] = (byType[e.type ?? "?"] ?? 0) + 1
  console.log(`DRC errors: ${errs.length}`, JSON.stringify(byType))
} catch (err) {
  console.log(`DRC evaluation failed: ${(err as Error).message}`)
}
