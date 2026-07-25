/**
 * Amdahl ceiling for NODE-level parallelism in the high-density stage.
 *
 * Nodes are independent: HighDensitySolver passes each one only its own port
 * points plus shared read-only context (connMap, obstacles, widths). No routes
 * from other nodes are passed, so ordering cannot matter.
 *
 * Sequential cost = sum of per-node times. Parallel cost = makespan of list
 * scheduling (longest-processing-time-first) across W workers. The ratio is the
 * ceiling, and the board-level effect is bounded by the stage's share of wall.
 */
const REPO = "/home/pullin/personal/awt-exp"
const { AutoroutingPipelineSolver7_MultiGraph } = await import(`${REPO}/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts`)
const { loadScenarioBySampleNumber } = await import(`${REPO}/scripts/benchmark/scenarios`)
const sample = Number(process.env.SAMPLE ?? 8)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const t0 = Date.now()
const p: any = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(scenario) as any)
p.solve()
const boardMs = Date.now() - t0
const timings: any[] = (globalThis as any).__nodeTimings ?? []
const total = timings.reduce((a, t) => a + t.ms, 0)
const sorted = timings.map((t) => t.ms).sort((a, b) => b - a)
const makespan = (w: number) => {
  const load = new Float64Array(w)
  for (const ms of sorted) {
    let min = 0
    for (let i = 1; i < w; i++) if (load[i]! < load[min]!) min = i
    load[min]! += ms
  }
  return Math.max(...load)
}
const rows = [1, 2, 4, 8, 16, 32, 64].map((w) => {
  const m = makespan(w)
  const stageSpeedup = total / m
  const boardAfter = boardMs - total + m
  return { workers: w, stageMs: Math.round(m), stageSpeedup: +stageSpeedup.toFixed(2), boardMs: Math.round(boardAfter), boardSpeedup: +(boardMs / boardAfter).toFixed(2) }
})
console.log(JSON.stringify({ sample, boardMs, nodes: timings.length, hdStageMs: total, hdShare: +(100 * total / boardMs).toFixed(1) + "%", slowestNodeMs: sorted[0], top10Share: +(100 * sorted.slice(0, 10).reduce((a, b) => a + b, 0) / total).toFixed(1) + "%" }, null, 1))
console.table(rows)
