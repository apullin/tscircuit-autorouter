/**
 * Is the input geometry already on an integer grid?
 *
 * If every coordinate is (within float dust) a multiple of 1um / 10nm, then
 * converting the geometry layer to exact integer arithmetic is lossless: the
 * values ARE integers today, they just carry accumulated float error. If they
 * are arbitrary reals, quantization changes the problem and needs a quality
 * gate.
 */
import { loadScenarioBySampleNumber } from "/home/pullin/personal/awt-r3/scripts/benchmark/scenarios"

const samples = (process.env.SAMPLES ?? "5,8,6,13").split(",").map(Number)
const grids = [
  { name: "1um   (0.001mm)", step: 0.001 },
  { name: "100nm (0.0001mm)", step: 0.0001 },
  { name: "10nm  (0.00001mm)", step: 0.00001 },
]

const collect = (obj: any, out: number[], depth = 0) => {
  if (depth > 8 || obj == null) return
  if (Array.isArray(obj)) {
    for (const v of obj) collect(v, out, depth + 1)
    return
  }
  if (typeof obj !== "object") return
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "number") {
      if (k === "x" || k === "y" || k === "width" || k === "height") out.push(v)
    } else collect(v, out, depth + 1)
  }
}

for (const sample of samples) {
  const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
  const coords: number[] = []
  collect(scenario, coords)
  const row: Record<string, unknown> = { sample, coords: coords.length }
  for (const g of grids) {
    let onGrid = 0
    let maxDust = 0
    for (const c of coords) {
      const q = Math.round(c / g.step)
      const dust = Math.abs(c - q * g.step)
      // dust relative to the grid step; exact multiples land at ~1e-13 or less
      if (dust < g.step * 1e-6) onGrid++
      else if (dust > maxDust) maxDust = dust
    }
    row[g.name] = `${((100 * onGrid) / coords.length).toFixed(2)}%`
    if (onGrid < coords.length) row[g.name + " worstOff"] = maxDust.toExponential(2)
  }
  console.log(JSON.stringify(row))
}
