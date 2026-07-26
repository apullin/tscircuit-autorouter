/**
 * Separates PROVEN defects from inferred ones.
 *
 * Two hypotheses were read out of the code but never demonstrated:
 *   (A) per-node edge margin is obstacleMargin/2 = 0.075mm, while two traces on
 *       opposite sides of a shared node boundary need 0.125mm each to keep the
 *       0.1mm DRC gap. If real, violations should pair traces from DIFFERENT
 *       nodes across a boundary.
 *   (B) scaleRoute() shrinks a grown node's geometry by 1/scaleFactor without
 *       shrinking traceThickness, so a 2x solve returns a 0mm gap. If real,
 *       violations should cluster INSIDE nodes that were grown.
 *
 * This measures actual pairwise clearances in the final output and attributes
 * each violation to a node (or node pair), cross-referenced with which nodes
 * the portfolio failed at 1x (i.e. which ones GrowShrink had to grow).
 */
const REPO = "/home/pullin/personal/awt-exp"
const { AutoroutingPipelineSolver7_MultiGraph } = await import(
  `${REPO}/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts`
)
const { loadScenarioBySampleNumber } = await import(`${REPO}/scripts/benchmark/scenarios`)

const sample = Number(process.env.SAMPLE ?? 8)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const srj: any = scenario
const pipeline: any = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(srj) as any)
pipeline.solve()

const stats: any[] = (globalThis as any).__supervisorStats ?? []
const grownNodes = new Set<string>()
const nodeBoxes: Array<{ id: string; cx: number; cy: number; w: number; h: number }> = []
for (const s of stats) {
  if (s.nodeFailed) grownNodes.add(s.nodeId)
  if (s.geom) nodeBoxes.push({ id: s.nodeId, cx: s.geom.cx, cy: s.geom.cy, w: s.geom.w, h: s.geom.h })
}
const nodeAt = (x: number, y: number) =>
  nodeBoxes.find(
    (n) => x >= n.cx - n.w / 2 && x <= n.cx + n.w / 2 && y >= n.cy - n.h / 2 && y <= n.cy + n.h / 2,
  )

const traces = pipeline.getOutputSimplifiedPcbTraces()
const traceWidth = srj.minTraceWidth ?? 0.1
const required = 0.1 // relaxed DRC trace clearance

// collect same-layer segments
type Seg = { net: string; layer: string; ax: number; ay: number; bx: number; by: number }
const segs: Seg[] = []
for (const t of traces as any[]) {
  for (let i = 1; i < t.route.length; i++) {
    const a = t.route[i - 1]
    const b = t.route[i]
    if (a.route_type !== "wire" || b.route_type !== "wire") continue
    if (a.layer !== b.layer) continue
    segs.push({ net: t.connection_name, layer: a.layer, ax: a.x, ay: a.y, bx: b.x, by: b.y })
  }
}

const segDist = (p: Seg, q: Seg) => {
  const d2 = (px: number, py: number, x1: number, y1: number, x2: number, y2: number) => {
    const dx = x2 - x1, dy = y2 - y1
    const l2 = dx * dx + dy * dy
    let t = l2 === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / l2
    t = t < 0 ? 0 : t > 1 ? 1 : t
    return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
  }
  return Math.min(
    d2(p.ax, p.ay, q.ax, q.ay, q.bx, q.by),
    d2(p.bx, p.by, q.ax, q.ay, q.bx, q.by),
    d2(q.ax, q.ay, p.ax, p.ay, p.bx, p.by),
    d2(q.bx, q.by, p.ax, p.ay, p.bx, p.by),
  )
}

let sameNode = 0, crossNode = 0, sameNodeGrown = 0, noNode = 0, total = 0
const examples: any[] = []
for (let i = 0; i < segs.length; i++) {
  for (let j = i + 1; j < segs.length; j++) {
    const p = segs[i]!, q = segs[j]!
    if (p.net === q.net || p.layer !== q.layer) continue
    // bounding-box reject
    if (Math.min(p.ax, p.bx) - Math.max(q.ax, q.bx) > 0.5) continue
    if (Math.min(q.ax, q.bx) - Math.max(p.ax, p.bx) > 0.5) continue
    if (Math.min(p.ay, p.by) - Math.max(q.ay, q.by) > 0.5) continue
    if (Math.min(q.ay, q.by) - Math.max(p.ay, p.by) > 0.5) continue
    const gap = segDist(p, q) - traceWidth
    if (gap >= required) continue
    total++
    const mx = (p.ax + p.bx + q.ax + q.bx) / 4
    const my = (p.ay + p.by + q.ay + q.by) / 4
    const np = nodeAt((p.ax + p.bx) / 2, (p.ay + p.by) / 2)
    const nq = nodeAt((q.ax + q.bx) / 2, (q.ay + q.by) / 2)
    if (!np || !nq) noNode++
    else if (np.id === nq.id) {
      sameNode++
      if (grownNodes.has(np.id)) sameNodeGrown++
    } else crossNode++
    if (examples.length < 5) examples.push({ gap: +gap.toFixed(4), nodeP: np?.id, nodeQ: nq?.id, grown: np ? grownNodes.has(np.id) : false, at: `${mx.toFixed(2)},${my.toFixed(2)}` })
  }
}

console.log(JSON.stringify({
  sample,
  segments: segs.length,
  nodesTracked: nodeBoxes.length,
  nodesGrown: grownNodes.size,
  clearanceViolations: total,
  attribution: {
    sameNode,
    ofWhichGrown: sameNodeGrown,
    crossNodeBoundary: crossNode,
    unattributed: noNode,
  },
}, null, 1))
console.log("examples:", JSON.stringify(examples, null, 1))
