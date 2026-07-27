/**
 * Node smoke HARNESS: one pipeline-7 run on an srj18 sample, printing a
 * single machine-readable "RESULT {json}" line with the parity fields the
 * smoke compares (drcErrors, nodeSolveMetadataById key/status pairs).
 *
 * Not run directly — scripts/node-parallel-smoke.mjs bundles it with
 * `bun build --target=node` and runs the bundle under node (node cannot load
 * this repo's TS graph: TS-source git deps under node_modules, extensionless
 * imports). Do NOT import scripts/benchmark/scenarios.ts here: bundling it
 * would statically pull every dataset loader, including packages that exist
 * only as type shims. The srj18 slice of its loading logic (dataset unwrap,
 * /^sample\d{3}$/ keys, SRJ unwrap requiring `bounds`, name sort, 1-based
 * index) is mirrored inline instead.
 *
 * Usage (after bundling): node <bundle> --sample 5
 * Flags come from the environment (TS_PARALLEL_HD_NODES / TS_PARALLEL_A2).
 */
import { AutoroutingPipelineSolver7_MultiGraph } from "../lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph"
import { evaluateRelaxedDrc } from "../lib/testing/evaluate-relaxed-drc"
import type { SimpleRouteJson } from "../lib/types/srj-types"

const args = process.argv.slice(2)
const getArg = (name: string, fallback: string) => {
  const i = args.indexOf(`--${name}`)
  return i >= 0 ? (args[i + 1] ?? fallback) : fallback
}
const sample = Number(getArg("sample", "5"))

/** Mirror of scripts/benchmark/scenarios.ts toSimpleRouteJson. */
const toSimpleRouteJson = (value: unknown): SimpleRouteJson | null => {
  if (!value || typeof value !== "object") return null
  const asRecord = value as Record<string, unknown>
  const unwrappedValue =
    asRecord.default && typeof asRecord.default === "object"
      ? asRecord.default
      : value
  const unwrappedRecord = unwrappedValue as Record<string, unknown>
  const candidate =
    (unwrappedRecord.simpleRouteJson &&
      typeof unwrappedRecord.simpleRouteJson === "object" &&
      unwrappedRecord.simpleRouteJson) ||
    (unwrappedRecord.simple_route_json &&
      typeof unwrappedRecord.simple_route_json === "object" &&
      unwrappedRecord.simple_route_json) ||
    unwrappedValue
  if (!candidate || typeof candidate !== "object") return null
  return "bounds" in candidate ? (candidate as SimpleRouteJson) : null
}

const srj18Module = (await import("dataset-srj18")) as Record<string, unknown>
const datasetModule = (
  srj18Module.dataset && typeof srj18Module.dataset === "object"
    ? srj18Module.dataset
    : srj18Module
) as Record<string, unknown>

const scenarios = Object.entries(datasetModule)
  .map(([name, value]) => [name, toSimpleRouteJson(value)] as const)
  .filter((entry): entry is [string, SimpleRouteJson] => Boolean(entry[1]))
  .filter(([name]) => /^sample\d{3}$/.test(name))
  .sort(([a], [b]) => a.localeCompare(b))

const scenarioEntry = scenarios[sample - 1]
if (!scenarioEntry) {
  throw new Error(
    `sample ${sample} out of range for srj18 (${scenarios.length} samples)`,
  )
}
const scenario = scenarioEntry[1]

const pipeline = new AutoroutingPipelineSolver7_MultiGraph(
  structuredClone(scenario),
)

const t0 = Date.now()
pipeline.solve()
const wallS = (Date.now() - t0) / 1000

let drcErrors = "n/a"
if (pipeline.solved && !pipeline.failed) {
  const traces = pipeline.getOutputSimplifiedPcbTraces()
  const drc = evaluateRelaxedDrc({
    inputSrj: scenario,
    srjWithPointPairs: pipeline.srjWithPointPairs ?? scenario,
    traces,
  })
  drcErrors = String(drc.errors.length)
}

const hdSolver = pipeline.highDensityRouteSolver
const nodeStatuses = hdSolver
  ? Array.from(
      hdSolver.nodeSolveMetadataById,
      ([id, metadata]) => `${id}:${metadata.status}`,
    ).sort()
  : []

console.log(
  `RESULT ${JSON.stringify({
    runtime: `node ${process.version}`,
    sample,
    solved: pipeline.solved,
    failed: pipeline.failed,
    error: pipeline.failed ? (pipeline.error ?? null) : null,
    iterations: pipeline.iterations,
    wallS: +wallS.toFixed(1),
    hdStageWallS: pipeline.timeSpentOnPhase?.highDensityRouteSolver
      ? +(pipeline.timeSpentOnPhase.highDensityRouteSolver / 1000).toFixed(1)
      : null,
    drcErrors,
    // Cast reason: parallelWorkerCount is TS-private but is the ground truth
    // for which HD path (sequential vs node-parallel) this run actually took.
    hdParallelWorkerCount:
      (
        hdSolver as unknown as
          | { parallelWorkerCount: number | null }
          | undefined
      )?.parallelWorkerCount ?? null,
    envHdNodes: process.env.TS_PARALLEL_HD_NODES ?? "auto",
    envA2: process.env.TS_PARALLEL_A2 ?? "auto",
    nodeStatusCount: nodeStatuses.length,
    nodeStatuses,
  })}`,
)
