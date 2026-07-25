/**
 * EXPERIMENT: where do the DRC errors actually come from?
 *
 * We assumed the nodes the portfolio gives up on. That is now disproven - the
 * invalid-geometry fallback never fires, because GrowShrink rescues those nodes
 * at 2x/4x scale. So the residual DRC errors have never been attributed.
 *
 * This maps every error's location onto the capacity-mesh node containing it
 * and cross-tabs against how that node was solved:
 *   - solved at 1x (normal)
 *   - failed at 1x, rescued by growth (the expensive ones)
 *   - no containing node (boundaries / stitching between nodes)
 */
const REPO = "/home/pullin/personal/awt-exp"
const { AutoroutingPipelineSolver7_MultiGraph } = await import(
  `${REPO}/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts`
)
const { loadScenarioBySampleNumber } = await import(`${REPO}/scripts/benchmark/scenarios`)
const { evaluateRelaxedDrc } = await import(`${REPO}/lib/testing/evaluate-relaxed-drc.ts`)

const sample = Number(process.env.SAMPLE ?? 8)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const pipeline: any = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(scenario) as any)
pipeline.solve()

const stats: any[] = (globalThis as any).__supervisorStats ?? []
// node id -> { failedAt1x, geom }
const nodeInfo = new Map<string, { failed: boolean; geom: any }>()
for (const s of stats) {
  if (!s.geom) continue
  const prev = nodeInfo.get(s.nodeId)
  nodeInfo.set(s.nodeId, {
    failed: (prev?.failed ?? false) || !!s.nodeFailed,
    geom: s.geom,
  })
}

const traces = pipeline.getOutputSimplifiedPcbTraces?.() ?? []
const drc = evaluateRelaxedDrc({
  inputSrj: scenario,
  srjWithPointPairs: pipeline.srjWithPointPairs ?? scenario,
  traces,
})

const errors = drc.errorsWithCenters ?? drc.errors ?? []
const containing = (x: number, y: number) => {
  for (const [id, info] of nodeInfo) {
    const g = info.geom
    if (
      x >= g.cx - g.w / 2 &&
      x <= g.cx + g.w / 2 &&
      y >= g.cy - g.h / 2 &&
      y <= g.cy + g.h / 2
    )
      return { id, ...info }
  }
  return null
}

// distance from an error to the nearest node boundary: if the boundary margin
// is the cause, errors should hug node edges rather than sit in interiors.
const distToNearestBoundary = (x: number, y: number) => {
  let best = Infinity
  for (const [, info] of nodeInfo) {
    const g = info.geom
    const insideX = x >= g.cx - g.w / 2 && x <= g.cx + g.w / 2
    const insideY = y >= g.cy - g.h / 2 && y <= g.cy + g.h / 2
    if (!insideX || !insideY) continue
    const d = Math.min(
      Math.abs(x - (g.cx - g.w / 2)),
      Math.abs(g.cx + g.w / 2 - x),
      Math.abs(y - (g.cy - g.h / 2)),
      Math.abs(g.cy + g.h / 2 - y),
    )
    if (d < best) best = d
  }
  return best
}
const boundaryDistances: number[] = []

const bucket = { failedNode: 0, solvedNode: 0, outsideAnyNode: 0, noLocation: 0 }
const byType: Record<string, { failed: number; solved: number; outside: number }> = {}
for (const e of errors as any[]) {
  const c = e.center ?? { x: e.x, y: e.y }
  const type = e.type ?? "unknown"
  byType[type] ??= { failed: 0, solved: 0, outside: 0 }
  if (typeof c?.x !== "number" || typeof c?.y !== "number") {
    bucket.noLocation++
    continue
  }
  const bd = distToNearestBoundary(c.x, c.y)
  if (Number.isFinite(bd)) boundaryDistances.push(bd)
  const node = containing(c.x, c.y)
  if (!node) {
    bucket.outsideAnyNode++
    byType[type].outside++
  } else if (node.failed) {
    bucket.failedNode++
    byType[type].failed++
  } else {
    bucket.solvedNode++
    byType[type].solved++
  }
}

console.log(
  JSON.stringify(
    {
      sample,
      totalErrors: errors.length,
      nodesTracked: nodeInfo.size,
      nodesFailedAt1x: [...nodeInfo.values()].filter((n) => n.failed).length,
      attribution: bucket,
    },
    null,
    1,
  ),
)
boundaryDistances.sort((a, b) => a - b)
const q = (f: number) => +(boundaryDistances[Math.floor(f * (boundaryDistances.length - 1))] ?? 0).toFixed(4)
console.log("distance from error to nearest node boundary (mm):")
console.log(`  min ${q(0)}  p25 ${q(0.25)}  median ${q(0.5)}  p75 ${q(0.75)}  max ${q(1)}`)
console.log(`  within 0.125mm of a boundary: ${boundaryDistances.filter((d) => d <= 0.125).length}/${boundaryDistances.length}`)
console.log(`  within 0.25mm  of a boundary: ${boundaryDistances.filter((d) => d <= 0.25).length}/${boundaryDistances.length}`)
console.table(
  Object.entries(byType)
    .sort((a, b) => b[1].failed + b[1].solved + b[1].outside - (a[1].failed + a[1].solved + a[1].outside))
    .map(([type, v]) => ({ type: type.slice(0, 44), inFailedNode: v.failed, inSolvedNode: v.solved, outsideNodes: v.outside })),
)
