/**
 * Crossing-structure (circle graph) analysis.
 *
 * Order the port points around the node boundary. Two 2-terminal connections
 * whose endpoints INTERLEAVE around that cycle (a b a b) cannot both be routed
 * on one layer without crossing. The connections therefore form a circle graph,
 * and a set of mutually-interleaving connections (a clique) needs that many
 * distinct layers - unless a connection changes layer mid-route via a via.
 *
 * This is a lower bound on layer demand, so it is only a proof of infeasibility
 * when vias cannot rescue it; here it is measured purely as a SIGNAL: how well
 * does max-clique separate the nodes that fail from the nodes that solve?
 */
const file = process.env.IN ?? `${process.env.HOME}/.perf-scratch/geom-8.json`
const stats: any[] = JSON.parse(await Bun.file(file).text())
const withGeom = stats.filter((s) => s.geom?.ports?.length)

/** angle of a boundary point around the node centre, for cyclic ordering */
const angleOf = (p: any, g: any) => Math.atan2(p.y - g.cy, p.x - g.cx)

const analyze = (g: any) => {
  const byConn = new Map<string, any[]>()
  for (const p of g.ports) {
    const arr = byConn.get(p.c) ?? []
    arr.push(p)
    byConn.set(p.c, arr)
  }
  // keep 2-terminal connections; multi-terminal ones only add crossings
  const conns = [...byConn.entries()]
    .filter(([, pts]) => pts.length === 2)
    .map(([c, pts]) => ({
      c,
      a: angleOf(pts[0], g),
      b: angleOf(pts[1], g),
      sameLayer: pts[0].z === pts[1].z,
    }))
  const n = conns.length
  const interleaves = (i: number, j: number) => {
    const [a1, b1] = [conns[i]!.a, conns[i]!.b].sort((x, y) => x - y)
    const [a2, b2] = [conns[j]!.a, conns[j]!.b].sort((x, y) => x - y)
    // strictly interleaved: exactly one of a2,b2 lies inside (a1,b1)
    const inside = (t: number) => t > a1 && t < b1
    return inside(a2) !== inside(b2)
  }
  const adj: number[][] = Array.from({ length: n }, () => [])
  let edges = 0
  for (let i = 0; i < n; i++)
    for (let j = i + 1; j < n; j++)
      if (interleaves(i, j)) {
        adj[i]!.push(j)
        adj[j]!.push(i)
        edges++
      }
  // exact max clique (n is tiny: <= ~10)
  let best = 0
  const grow = (clique: number[], cand: number[]) => {
    if (clique.length > best) best = clique.length
    for (let k = 0; k < cand.length; k++) {
      const v = cand[k]!
      const nextCand = cand.slice(k + 1).filter((u) => adj[v]!.includes(u))
      grow([...clique, v], nextCand)
    }
  }
  grow([], Array.from({ length: n }, (_, i) => i))
  return { conns: n, edges, maxClique: best, layers: (g.availableZ ?? [0, 1]).length }
}

const rows: any[] = []
for (const s of withGeom) {
  const a = analyze(s.geom)
  rows.push({ failed: !!s.nodeFailed, ...a, work: s.sumCandidateWork ?? 0, node: s.nodeId })
}
const failed = rows.filter((r) => r.failed)
const solved = rows.filter((r) => !r.failed)
const dist = (arr: any[], k: string) => {
  const h: Record<number, number> = {}
  for (const r of arr) h[r[k]] = (h[r[k]] ?? 0) + 1
  return Object.entries(h).sort((a, b) => Number(a[0]) - Number(b[0])).map(([v, c]) => `${v}:${c}`).join("  ")
}
console.log("maxClique distribution (interleaving connections that need distinct layers)")
console.log("  failed nodes:", dist(failed, "maxClique"))
console.log("  solved nodes:", dist(solved, "maxClique"))
console.log("\nratio maxClique/layers")
for (const thr of [1, 1.5, 2, 2.5, 3]) {
  const f = failed.filter((r) => r.maxClique / r.layers > thr).length
  const s = solved.filter((r) => r.maxClique / r.layers > thr).length
  const w = failed.filter((r) => r.maxClique / r.layers > thr).reduce((a, r) => a + r.work, 0)
  const wAll = failed.reduce((a, r) => a + r.work, 0)
  console.log(`  > ${thr}: flags ${f}/${failed.length} failed (${((100 * w) / Math.max(1, wAll)).toFixed(0)}% of failed work), ${s}/${solved.length} solved`)
}
console.table(failed.sort((a, b) => b.work - a.work).map((r) => ({ node: r.node, conns: r.conns, crossings: r.edges, maxClique: r.maxClique, layers: r.layers, work: r.work })))
