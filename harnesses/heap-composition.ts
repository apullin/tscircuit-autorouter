/**
 * Heap composition at peak: what is the live set actually made of?
 *
 * Runs a sample, and at the step where live memory peaks takes a heap snapshot
 * and aggregates retained bytes by object type. Answers two questions:
 *   1. is the live set dominated by coordinate storage (typed arrays) or by
 *      object graphs (Node objects, routes, graphics)?
 *   2. how much would f64 -> f32 storage actually save?
 *
 * Usage: REPO=/path SAMPLE=8 bun heap-composition.ts
 */
const REPO = process.env.REPO ?? "/home/pullin/personal/awt-r3"
const sample = Number(process.env.SAMPLE ?? 8)
const gcEveryMs = Number(process.env.GC_EVERY_MS ?? 3000)

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

let peakLive = 0
let peakSnapshot: any = null
let lastGc = Date.now()

while (!solver.solved && !solver.failed) {
  solver.step()
  const now = Date.now()
  if (now - lastGc >= gcEveryMs) {
    lastGc = now
    Bun.gc(true)
    const live = process.memoryUsage().heapUsed
    if (live > peakLive) {
      peakLive = live
      peakSnapshot = Bun.generateHeapSnapshot()
    }
  }
}

const mb = (b: number) => +(b / 1024 / 1024).toFixed(1)
const out: Record<string, unknown> = {
  repo: REPO.split("/").pop(),
  sample,
  peakLiveMb: mb(peakLive),
}

if (peakSnapshot?.nodes && peakSnapshot?.nodeClassNames) {
  // Bun snapshot: nodes is a flat array, 6 fields per node, field 1 = class
  // index, field 2 = size. Aggregate bytes and counts per class name.
  const FIELDS = peakSnapshot.nodes.length / peakSnapshot.nodeCount
  const byClass: Record<string, { bytes: number; count: number }> = {}
  for (let i = 0; i < peakSnapshot.nodeCount; i++) {
    const base = i * FIELDS
    const classIndex = peakSnapshot.nodes[base + 1]
    const size = peakSnapshot.nodes[base + 2]
    const name = peakSnapshot.nodeClassNames[classIndex] ?? `class${classIndex}`
    const e = (byClass[name] ??= { bytes: 0, count: 0 })
    e.bytes += size
    e.count++
  }
  const top = Object.entries(byClass)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 20)
    .map(([name, v]) => ({ type: name, mb: mb(v.bytes), count: v.count }))
  out.fieldsPerNode = FIELDS
  out.topTypes = top
  const total = Object.values(byClass).reduce((a, v) => a + v.bytes, 0)
  out.snapshotTotalMb = mb(total)
} else {
  out.snapshotKeys = peakSnapshot ? Object.keys(peakSnapshot) : null
}

console.log(JSON.stringify(out, null, 1))
