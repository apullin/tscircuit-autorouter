/**
 * Deterministic memory probe.
 *
 * Peak RSS is a bad metric on this workload: JSC grows the heap
 * opportunistically when the machine has free memory, so the same code swings
 * 3x between runs. This measures what the program actually retains:
 *
 *   peakLiveMb - heapUsed after a forced full GC, sampled periodically
 *                (the peak of those samples = worst-case live set)
 *   peakHeapMb - peak heapUsed without forcing GC (live + uncollected garbage)
 *   peakRssMb  - for continuity with earlier numbers
 *
 * Usage: REPO=/path/to/checkout SAMPLE=8 bun mem-probe.ts
 */
const REPO = process.env.REPO ?? "/home/pullin/personal/awt-r3"
const sample = Number(process.env.SAMPLE ?? 8)
const gcEveryMs = Number(process.env.GC_EVERY_MS ?? 2000)

const { AutoroutingPipelineSolver7_MultiGraph } = await import(
  `${REPO}/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts`
)
const { loadScenarioBySampleNumber } = await import(
  `${REPO}/scripts/benchmark/scenarios`
)

const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const solver: any = new AutoroutingPipelineSolver7_MultiGraph(
  structuredClone(scenario) as any,
)

let peakHeap = 0
let peakLive = 0
let peakRss = 0
let samples = 0
let lastGc = Date.now()
const t0 = Date.now()

while (!solver.solved && !solver.failed) {
  solver.step()
  const now = Date.now()
  if (now - lastGc >= gcEveryMs) {
    lastGc = now
    const mu = process.memoryUsage()
    if (mu.heapUsed > peakHeap) peakHeap = mu.heapUsed
    if (mu.rss > peakRss) peakRss = mu.rss
    Bun.gc(true)
    const after = process.memoryUsage()
    if (after.heapUsed > peakLive) peakLive = after.heapUsed
    samples++
  }
}

Bun.gc(true)
const final = process.memoryUsage()
const mb = (b: number) => +(b / 1024 / 1024).toFixed(1)
console.log(
  JSON.stringify({
    repo: REPO.split("/").pop(),
    sample,
    solved: solver.solved,
    wallS: +((Date.now() - t0) / 1000).toFixed(1),
    gcSamples: samples,
    peakLiveMb: mb(peakLive),
    peakHeapMb: mb(peakHeap),
    peakRssMb: mb(peakRss),
    finalLiveMb: mb(final.heapUsed),
  }),
)
