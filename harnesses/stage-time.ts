import { AutoroutingPipelineSolver7_MultiGraph } from "/home/pullin/personal/awt-r3/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts"
import { loadScenarioBySampleNumber } from "/home/pullin/personal/awt-r3/scripts/benchmark/scenarios"
import { writeFileSync } from "node:fs"

const sample = Number(process.env.SAMPLE ?? 6)
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, sample)
const pipeline: any = new AutoroutingPipelineSolver7_MultiGraph(
  structuredClone(scenario) as any,
)

const times: Record<string, number> = {}
const steps: Record<string, number> = {}
let last: string | null = null
let t = Date.now()
const t0 = t

while (!pipeline.solved && !pipeline.failed) {
  pipeline.step()
  const cur: string =
    pipeline.activeSubSolver?.constructor?.name ??
    `stage${pipeline.currentPipelineStepIndex}`
  steps[cur] = (steps[cur] ?? 0) + 1
  if (cur !== last) {
    const now = Date.now()
    if (last !== null) times[last] = (times[last] ?? 0) + (now - t)
    t = now
    last = cur
  }
}
if (last !== null) times[last] = (times[last] ?? 0) + (Date.now() - t)

const wall = (Date.now() - t0) / 1000
const rows = Object.entries(times)
  .sort((a, b) => b[1] - a[1])
  .map(([stage, ms]) => ({
    stage,
    s: +(ms / 1000).toFixed(1),
    pct: +((100 * ms) / (wall * 1000)).toFixed(1),
    steps: steps[stage],
  }))
console.log(JSON.stringify({ sample, wall: +wall.toFixed(1), solved: pipeline.solved }))
console.table(rows)

const stats = (globalThis as any).__supervisorStats ?? []
writeFileSync(process.env.OUT ?? `/tmp/stage-${sample}.json`, JSON.stringify({ rows, stats }))
const failed = stats.filter((s: any) => s.nodeFailed)
const work = stats.map((s: any) => Number(s.totalCandidateWork) || 0)
work.sort((a: number, b: number) => b - a)
console.log(
  "nodes:", stats.length,
  "failed:", failed.length,
  "total candidate work:", work.reduce((a: number, b: number) => a + b, 0).toExponential(2),
  "top-10 work share:",
  (
    (100 * work.slice(0, 10).reduce((a: number, b: number) => a + b, 0)) /
    Math.max(1, work.reduce((a: number, b: number) => a + b, 0))
  ).toFixed(1) + "%",
)
console.log("worst nodes:", JSON.stringify(
  stats
    .slice()
    .sort((a: any, b: any) => (b.totalCandidateWork ?? 0) - (a.totalCandidateWork ?? 0))
    .slice(0, 8)
    .map((s: any) => ({
      id: s.nodeId,
      pts: s.points,
      work: s.totalCandidateWork,
      failed: !!s.nodeFailed,
      kind: s.winnerKind,
      exp: s.expanded,
    })),
))
