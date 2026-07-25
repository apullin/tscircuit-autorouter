/**
 * Is node infeasibility LEARNABLE from cheap geometry, given that no sound
 * analytic bound separates it?
 *
 * For each single feature, find the threshold that captures the most
 * failed-node WORK at ZERO false positives (never abandon a node that solves).
 * Zero-FP is the bar because a false abandon costs routing quality.
 */
const file = process.env.IN ?? `${process.env.HOME}/.perf-scratch/geom-8.json`
const stats: any[] = JSON.parse(await Bun.file(file).text())
const rows = stats
  .filter((s) => s.geom?.ports?.length)
  .map((s) => {
    const g = s.geom
    const byConn = new Map<string, any[]>()
    for (const p of g.ports) {
      const a = byConn.get(p.c) ?? []
      a.push(p)
      byConn.set(p.c, a)
    }
    const conns = byConn.size
    const minSide = Math.min(g.w, g.h)
    const area = g.w * g.h
    let layerChanging = 0
    for (const [, pts] of byConn) if (new Set(pts.map((p: any) => p.z)).size > 1) layerChanging++
    return {
      failed: !!s.nodeFailed,
      work: s.sumCandidateWork ?? 0,
      minSide,
      area,
      conns,
      ports: g.ports.length,
      areaPerConn: area / Math.max(1, conns),
      minSidePerConn: minSide / Math.max(1, conns),
      layerChanging,
      density: conns / Math.max(1e-6, area),
      aspect: Math.max(g.w, g.h) / Math.max(1e-6, minSide),
    }
  })

const failedWork = rows.filter((r) => r.failed).reduce((a, r) => a + r.work, 0)
const features = ["minSide", "area", "conns", "ports", "areaPerConn", "minSidePerConn", "layerChanging", "density", "aspect"] as const

console.log(`nodes ${rows.length} (failed ${rows.filter((r) => r.failed).length}), failed work ${failedWork}`)
console.log("\nbest single-feature rule at ZERO false positives:")
const out: any[] = []
for (const f of features) {
  for (const dir of ["gt", "lt"] as const) {
    const vals = [...new Set(rows.map((r) => r[f] as number))].sort((a, b) => a - b)
    let best = { thr: NaN, work: 0, n: 0 }
    for (const thr of vals) {
      const pred = (r: any) => (dir === "gt" ? r[f] > thr : r[f] < thr)
      const fp = rows.some((r) => !r.failed && pred(r))
      if (fp) continue
      const caught = rows.filter((r) => r.failed && pred(r))
      const w = caught.reduce((a, r) => a + r.work, 0)
      if (w > best.work) best = { thr, work: w, n: caught.length }
    }
    if (best.work > 0)
      out.push({
        rule: `${f} ${dir === "gt" ? ">" : "<"} ${best.thr.toFixed(3)}`,
        nodesCaught: best.n,
        workCaught: best.work,
        pctFailedWork: +((100 * best.work) / Math.max(1, failedWork)).toFixed(1),
      })
  }
}
console.table(out.sort((a, b) => b.workCaught - a.workCaught).slice(0, 10))

// two-feature conjunction, still at zero false positives
console.log("\nbest two-feature conjunction at ZERO false positives:")
let best2: any = null
for (let i = 0; i < features.length; i++) {
  for (let j = i + 1; j < features.length; j++) {
    const fa = features[i]!
    const fb = features[j]!
    const va = [...new Set(rows.map((r) => r[fa] as number))].sort((a, b) => a - b)
    const vb = [...new Set(rows.map((r) => r[fb] as number))].sort((a, b) => a - b)
    const sa = va.filter((_, k) => k % Math.ceil(va.length / 40) === 0)
    const sb = vb.filter((_, k) => k % Math.ceil(vb.length / 40) === 0)
    for (const ta of sa)
      for (const tb of sb) {
        const pred = (r: any) => r[fa] < ta && r[fb] < tb
        if (rows.some((r) => !r.failed && pred(r))) continue
        const caught = rows.filter((r) => r.failed && pred(r))
        const w = caught.reduce((a, r) => a + r.work, 0)
        if (!best2 || w > best2.work) best2 = { rule: `${fa} < ${ta.toFixed(3)} AND ${fb} < ${tb.toFixed(3)}`, work: w, n: caught.length }
      }
  }
}
if (best2)
  console.log(`  ${best2.rule} -> ${best2.n} nodes, ${best2.work} work (${((100 * best2.work) / Math.max(1, failedWork)).toFixed(1)}% of failed work), 0 false positives`)
