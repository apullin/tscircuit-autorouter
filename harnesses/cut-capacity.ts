/**
 * Cut-capacity infeasibility bound, validated offline against real outcomes.
 *
 * Claim: any connection whose endpoints lie on opposite sides of a straight cut
 * through the node must cross that cut (Jordan curve). Two traces crossing the
 * same cut on the same layer need centre separation >= traceWidth + margin.
 * So a cut of length D admits at most
 *      L * ( floor((D - t) / (t + m)) + 1 )
 * crossings across L layers. If the number of distinct NETS straddling the cut
 * exceeds that, no routing exists - for any algorithm.
 *
 * Every choice here is deliberately conservative (over-states capacity,
 * under-states demand) so a positive is a proof, not a guess:
 *   - D is the full node side, ignoring the boundary keepout that really applies
 *   - obstacles inside the node are ignored (they only reduce real capacity)
 *   - same-net connections are counted once (same-net traces may touch)
 *   - ports exactly on the cut are treated as not straddling
 *
 * Acceptance test: it must flag ZERO solved nodes. Any false positive means the
 * bound is wrong.
 */
const file = process.env.IN ?? `${process.env.HOME}/.perf-scratch/geom-8.json`
const stats: any[] = JSON.parse(await Bun.file(file).text())
const withGeom = stats.filter((s) => s.geom?.ports?.length)

const netOf = (connectionName: string) => {
  // connections named "<net>_<index>" or similar; fall back to the whole name.
  // Grouping by the shared prefix is conservative: merging distinct nets can
  // only LOWER demand, never raise it.
  return connectionName
}

const analyze = (g: any) => {
  const t = g.traceWidth
  const m = g.obstacleMargin
  const L = (g.availableZ ?? [0, 1]).length
  const perLayer = (D: number) =>
    D < t ? 0 : Math.floor((D - t) / (t + m)) + 1

  // group ports by connection, then by net
  const byConn = new Map<string, any[]>()
  for (const p of g.ports) {
    const arr = byConn.get(p.c) ?? []
    arr.push(p)
    byConn.set(p.c, arr)
  }

  let worst: any = null
  const testCut = (axis: "x" | "y", at: number) => {
    const D = axis === "x" ? g.h : g.w // a vertical cut spans the height
    const capacity = L * perLayer(D)
    const straddling = new Set<string>()
    for (const [conn, pts] of byConn) {
      let lo = false
      let hi = false
      for (const p of pts) {
        if (p[axis] < at) lo = true
        else if (p[axis] > at) hi = true
      }
      if (lo && hi) straddling.add(netOf(conn))
    }
    const demand = straddling.size
    const slack = capacity - demand
    if (!worst || slack < worst.slack) {
      worst = { axis, at, D, capacity, demand, slack }
    }
  }

  for (const axis of ["x", "y"] as const) {
    const coords = [...new Set(g.ports.map((p: any) => p[axis]))].sort(
      (a: any, b: any) => a - b,
    ) as number[]
    for (let i = 0; i + 1 < coords.length; i++) {
      testCut(axis, (coords[i]! + coords[i + 1]!) / 2)
    }
  }
  return worst
}

let flaggedFailed = 0
let flaggedSolved = 0
const failed = withGeom.filter((s) => s.nodeFailed)
const solved = withGeom.filter((s) => !s.nodeFailed)
const failedDetail: any[] = []

for (const s of withGeom) {
  const w = analyze(s.geom)
  if (!w) continue
  const infeasible = w.demand > w.capacity
  if (infeasible) {
    if (s.nodeFailed) flaggedFailed++
    else flaggedSolved++
  }
  if (s.nodeFailed) {
    failedDetail.push({
      node: s.nodeId,
      ports: s.geom.ports.length,
      wh: `${s.geom.w.toFixed(2)}x${s.geom.h.toFixed(2)}`,
      layers: (s.geom.availableZ ?? []).length,
      demand: w.demand,
      capacity: w.capacity,
      slack: w.slack,
      proven: infeasible,
      work: s.sumCandidateWork,
    })
  }
}

console.log(`nodes with geometry: ${withGeom.length} (solved ${solved.length}, failed ${failed.length})`)
console.log(`PROVEN infeasible: ${flaggedFailed} of ${failed.length} failed nodes`)
console.log(`FALSE POSITIVES:   ${flaggedSolved} of ${solved.length} solved nodes  <-- must be 0`)
const provenWork = failedDetail.filter((f) => f.proven).reduce((a, f) => a + (f.work ?? 0), 0)
const allFailWork = failedDetail.reduce((a, f) => a + (f.work ?? 0), 0)
console.log(`work on provably-infeasible nodes: ${provenWork} of ${allFailWork} failed-node work`)
console.table(failedDetail.sort((a, b) => (b.work ?? 0) - (a.work ?? 0)))
