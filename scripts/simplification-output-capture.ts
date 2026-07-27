#!/usr/bin/env bun
/**
 * Identity harness for the trace-simplification stage (perf/simplification).
 *
 * Runs pipeline 7 on one sample (same setup as scripts/eviction-probe.ts) and
 * writes a deterministically-stringified JSON capture of:
 *   - the TraceSimplificationSolver's simplified hd routes (direct stage output)
 *   - pipeline.getOutputSimplifiedPcbTraces() (final output)
 * so that a before/after byte-diff proves the change is result-identical.
 *
 * Iteration counts gate the upstream stages only; this captures the
 * simplification stage's own output directly.
 *
 * Usage:
 *   TS_BENCHMARK=1 bun scripts/simplification-output-capture.ts \
 *     --dataset srj18 --sample 5 --out /tmp/simp-s5.json
 *
 * TS_BENCHMARK=1 matters: it pins the auto-enabled worker parallelism off so
 * upstream stages are deterministic (see lib/parallel/autoEnable.ts).
 */
import { AutoroutingPipelineSolver7_MultiGraph } from "../lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph"
import {
  type DatasetName,
  loadScenarioBySampleNumber,
  parseDatasetName,
} from "./benchmark/scenarios"

const args = process.argv.slice(2)
const getArg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
const dataset: DatasetName = parseDatasetName(getArg("dataset", "srj18"))!
const sample = Number(getArg("sample", "5"))
const outPath = getArg("out", "")
if (!outPath) {
  console.error("--out <path> is required")
  process.exit(1)
}

/** Deterministic stringify: recursively sorts object keys. */
const stableStringify = (value: unknown): string => {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`
  }
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as any)[k])}`,
  )
  return `{${parts.join(",")}}`
}

const { scenario } = await loadScenarioBySampleNumber(dataset, sample)
const pipeline = new AutoroutingPipelineSolver7_MultiGraph(
  structuredClone(scenario),
)

const t0 = Date.now()
pipeline.solve()
const wallS = (Date.now() - t0) / 1000

if (!pipeline.solved || pipeline.failed) {
  console.error(
    `Pipeline did not solve (solved=${pipeline.solved} failed=${pipeline.failed} error=${pipeline.error})`,
  )
  process.exit(1)
}

const capture = {
  dataset,
  sample,
  iterations: pipeline.iterations,
  simplifiedHdRoutes:
    pipeline.traceSimplificationSolver?.simplifiedHdRoutes ?? null,
  outputSimplifiedPcbTraces: pipeline.getOutputSimplifiedPcbTraces(),
}

await Bun.write(outPath, stableStringify(capture))
console.log(
  JSON.stringify({
    dataset,
    sample,
    iterations: pipeline.iterations,
    wallS: +wallS.toFixed(1),
    simplificationWallS: pipeline.timeSpentOnPhase?.traceSimplificationSolver
      ? +(pipeline.timeSpentOnPhase.traceSimplificationSolver / 1000).toFixed(2)
      : null,
    routes: capture.simplifiedHdRoutes?.length ?? null,
    out: outPath,
  }),
)
