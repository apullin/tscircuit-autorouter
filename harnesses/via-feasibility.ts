/**
 * Via-feasibility infeasibility bound.
 *
 * A connection whose two endpoints sit on different layers REQUIRES at least
 * one via inside the node (the layer change has to happen somewhere, and
 * intra-node routing is confined to the node). A via needs a clear disc of
 * diameter viaDiameter + 2*obstacleMargin. If that disc cannot fit inside the
 * node at all, the connection is unroutable - no search can find a path.
 *
 * Conservative choices so a positive is a proof:
 *   - only counts connections whose endpoint layers actually differ
 *   - requires only ONE via to fit (ignores that several may be needed)
 *   - ignores obstacles and other traces (they only make it harder)
 *   - uses the node's larger dimension pair min(w,h) as the limiting span
 *
 * Acceptance test: ZERO solved nodes may be flagged.
 */
const file = process.env.IN ?? `${process.env.HOME}/.perf-scratch/geom-8.json`
const stats: any[] = JSON.parse(await Bun.file(file).text())
const withGeom = stats.filter((s) => s.geom?.ports?.length)

const analyze = (g: any) => {
  const byConn = new Map<string, any[]>()
  for (const p of g.ports) {
    const arr = byConn.get(p.c) ?? []
    arr.push(p)
    byConn.set(p.c, arr)
  }
  let layerChanging = 0
  for (const [, pts] of byConn) {
    const zs = new Set(pts.map((p: any) => p.z))
    if (zs.size > 1) layerChanging++
  }
  const viaSpan = g.viaDiameter + 2 * g.obstacleMargin
  const minSide = Math.min(g.w, g.h)
  return {
    layerChanging,
    viaSpan,
    minSide,
    viaFits: minSide >= viaSpan,
    proven: layerChanging > 0 && minSide < viaSpan,
  }
}

let provenFailed = 0
let falsePositive = 0
const failed = withGeom.filter((s) => s.nodeFailed)
const solved = withGeom.filter((s) => !s.nodeFailed)
const detail: any[] = []
let provenWork = 0
let allFailWork = 0

for (const s of withGeom) {
  const a = analyze(s.geom)
  if (a.proven) {
    if (s.nodeFailed) provenFailed++
    else falsePositive++
  }
  if (s.nodeFailed) {
    allFailWork += s.sumCandidateWork ?? 0
    if (a.proven) provenWork += s.sumCandidateWork ?? 0
    detail.push({
      node: s.nodeId,
      wh: `${s.geom.w.toFixed(2)}x${s.geom.h.toFixed(2)}`,
      minSide: +a.minSide.toFixed(2),
      viaSpan: +a.viaSpan.toFixed(2),
      layerChangingConns: a.layerChanging,
      proven: a.proven,
      work: s.sumCandidateWork,
    })
  }
}

console.log(`nodes: ${withGeom.length} (solved ${solved.length}, failed ${failed.length})`)
console.log(`PROVEN infeasible (via cannot fit): ${provenFailed} of ${failed.length} failed nodes`)
console.log(`FALSE POSITIVES: ${falsePositive} of ${solved.length} solved nodes  <-- must be 0`)
console.log(`work on proven nodes: ${provenWork} of ${allFailWork} (${((100 * provenWork) / Math.max(1, allFailWork)).toFixed(1)}%)`)
console.table(detail.sort((a, b) => (b.work ?? 0) - (a.work ?? 0)))

// how close are the solved nodes to the boundary? (is the bound tight?)
const solvedNarrow = solved
  .map((s) => ({ s, a: analyze(s.geom) }))
  .filter((x) => x.a.layerChanging > 0)
  .sort((a, b) => a.a.minSide - b.a.minSide)
  .slice(0, 5)
console.log("\nsolved nodes with layer changes, narrowest first (bound must stay below these):")
for (const { s, a } of solvedNarrow) {
  console.log(`  ${s.nodeId}: minSide=${a.minSide.toFixed(3)} viaSpan=${a.viaSpan.toFixed(3)} layerChanging=${a.layerChanging}`)
}
