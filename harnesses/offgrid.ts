import { loadScenarioBySampleNumber } from "/home/pullin/personal/awt-r3/scripts/benchmark/scenarios"

const sample = Number(process.env.SAMPLE ?? 6)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)

const hits: Array<{ path: string; key: string; v: number }> = []
const walk = (obj: any, path: string, depth = 0) => {
  if (depth > 8 || obj == null) return
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) walk(obj[i], `${path}[${i}]`, depth + 1)
    return
  }
  if (typeof obj !== "object") return
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number") {
      if (k === "x" || k === "y" || k === "width" || k === "height") {
        hits.push({ path, key: k, v })
      }
    } else walk(v, `${path}.${k}`, depth + 1)
  }
}
walk(scenario, "$")

const um = (v: number) => v * 1000
const offBy = (v: number) => {
  const u = um(v)
  return Math.abs(u - Math.round(u))
}
const off = hits.filter((h) => offBy(h.v) > 1e-6)
console.log(`sample ${sample}: ${hits.length} coords, ${off.length} off the 1um grid (${((100 * off.length) / hits.length).toFixed(1)}%)`)

// what do the off-grid values look like, and where do they come from?
const byPath: Record<string, number> = {}
for (const h of off) {
  const p = h.path.replace(/\[\d+\]/g, "[]")
  byPath[p] = (byPath[p] ?? 0) + 1
}
console.log("\nsources of off-grid coords:")
for (const [p, n] of Object.entries(byPath).sort((a, b) => b[1] - a[1]).slice(0, 8)) {
  console.log(`  ${n.toString().padStart(5)}  ${p}`)
}
console.log("\nexample off-grid values (mm -> um):")
for (const h of off.slice(0, 12)) {
  console.log(`  ${h.key}=${h.v}  -> ${um(h.v)} um  (off by ${offBy(h.v).toFixed(6)} um)`)
}
const dust = off.filter((h) => offBy(h.v) < 1e-3).length
const halves = off.filter((h) => Math.abs(offBy(h.v) - 0.5) < 1e-6).length
console.log(`\nof the off-grid values: ${dust} are float dust (<0.001um off), ${halves} sit exactly on a half-micron`)
console.log(`worst deviation from 1um grid: ${Math.max(...off.map(offBy)).toFixed(4)} um`)
