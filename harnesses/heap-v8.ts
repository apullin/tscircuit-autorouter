/**
 * Live-set composition via the self-describing V8 snapshot format.
 * Answers: is retained memory coordinate storage (where f32/integer packing
 * would help) or object graphs (where it would not)?
 */
const REPO = process.env.REPO ?? "/home/pullin/personal/awt-r3"
const sample = Number(process.env.SAMPLE ?? 8)
const atStep = Number(process.env.AT_STEP ?? 0) // 0 = at peak live

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
let snap: string | null = null
let lastGc = Date.now()
while (!solver.solved && !solver.failed) {
  solver.step()
  if (Date.now() - lastGc >= 4000) {
    lastGc = Date.now()
    Bun.gc(true)
    const live = process.memoryUsage().heapUsed
    if (live > peakLive) {
      peakLive = live
      snap = Bun.generateHeapSnapshot("v8") as unknown as string
    }
  }
}

const mb = (b: number) => +(b / 1024 / 1024).toFixed(1)
const out: Record<string, unknown> = { sample, peakLiveMb: mb(peakLive) }

if (snap) {
  const s = JSON.parse(snap)
  const fields: string[] = s.snapshot.meta.node_fields
  const types: string[] = s.snapshot.meta.node_types[0]
  const stride = fields.length
  const iType = fields.indexOf("type")
  const iName = fields.indexOf("name")
  const iSize = fields.indexOf("self_size")
  const strings: string[] = s.strings
  const agg: Record<string, { bytes: number; count: number }> = {}
  for (let i = 0; i < s.nodes.length; i += stride) {
    const t = types[s.nodes[i + iType]] ?? "?"
    const nm = strings[s.nodes[i + iName]] ?? ""
    const size = s.nodes[i + iSize]
    // group typed arrays and plain objects by their constructor-ish name
    const key = t === "object" || t === "native" ? `${t}:${nm}` : t
    const e = (agg[key] ??= { bytes: 0, count: 0 })
    e.bytes += size
    e.count++
  }
  const total = Object.values(agg).reduce((a, v) => a + v.bytes, 0)
  out.snapshotTotalMb = mb(total)
  out.top = Object.entries(agg)
    .sort((a, b) => b[1].bytes - a[1].bytes)
    .slice(0, 18)
    .map(([k, v]) => ({ what: k.slice(0, 46), mb: mb(v.bytes), pct: +(100 * v.bytes / total).toFixed(1), count: v.count }))
}
console.log(JSON.stringify(out, null, 1))
