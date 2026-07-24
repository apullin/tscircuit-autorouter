import { expect, test } from "bun:test"
import { isDeepStrictEqual } from "node:util"
import { createPipeline7RelaxedDrcEvaluator } from "lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/create-pipeline7-relaxed-drc-evaluator"
import { convertPipeline7HdRoutesToSimplifiedPcbTraces } from "lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/convertPipeline7HdRoutesToSimplifiedPcbTraces"
import { evaluateRelaxedDrc } from "lib/testing/evaluate-relaxed-drc"
import type { SimpleRouteJson } from "lib/types"
import type { HighDensityRoute } from "lib/types/high-density-types"
import { getConnectivityMapFromSimpleRouteJson } from "lib/utils/getConnectivityMapFromSimpleRouteJson"

test("Pipeline7 repair uses the benchmark relaxed DRC path", () => {
  const srjWithPointPairs: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -2, minY: -2, maxX: 2, maxY: 2 },
    obstacles: [],
    connections: [
      {
        name: "trace",
        pointsToConnect: [
          { x: -1, y: 0.2, layer: "top", pointId: "start" },
          { x: 1, y: 0.2, layer: "top", pointId: "end" },
        ],
      },
    ],
  }
  const inputSrj: SimpleRouteJson = {
    ...srjWithPointPairs,
    obstacles: [
      {
        type: "rect",
        layers: ["top"],
        center: { x: 0, y: 0 },
        width: 0.2,
        height: 0.2,
        connectedTo: ["pcb_smtpad_foreign"],
      },
    ],
  }
  const connMap = getConnectivityMapFromSimpleRouteJson(srjWithPointPairs)
  const conversionOptions = {
    connections: srjWithPointPairs.connections,
    originalConnections: inputSrj.connections,
    layerCount: srjWithPointPairs.layerCount,
    obstacles: srjWithPointPairs.obstacles,
    defaultViaHoleDiameter: 0.15,
    connMap,
    srjWithPointPairs,
    originalSrj: inputSrj,
  }
  const route: HighDensityRoute = {
    connectionName: "trace",
    route: [
      { x: -1, y: 0.2, z: 0 },
      { x: 1, y: 0.2, z: 0 },
    ],
    vias: [],
    traceThickness: 0.1,
    viaDiameter: 0.3,
  }
  const traces = convertPipeline7HdRoutesToSimplifiedPcbTraces({
    ...conversionOptions,
    hdRoutes: [route],
  })
  const benchmarkResult = evaluateRelaxedDrc({
    inputSrj,
    srjWithPointPairs,
    traces,
  })
  const exactEvaluator = createPipeline7RelaxedDrcEvaluator({
    ...conversionOptions,
  })
  const exactResult = exactEvaluator({ traces: [], routes: [route] })

  if (Array.isArray(exactResult)) {
    throw new Error("Exact DRC evaluator returned errors without centers")
  }

  expect(isDeepStrictEqual(exactResult.errors, benchmarkResult.errors)).toBe(
    true,
  )
  expect(
    isDeepStrictEqual(
      exactResult.errorsWithCenters,
      benchmarkResult.errorsWithCenters,
    ),
  ).toBe(true)
  expect(
    benchmarkResult.errors.some(
      (error) => error.type === "pcb_pad_trace_clearance_error",
    ),
  ).toBe(false)
  expect(
    benchmarkResult.errors.some(
      (error) =>
        "error_type" in error && error.error_type === "pcb_trace_error",
    ),
  ).toBe(true)
})

test("Pipeline7 scoring evaluator skips contiguity and stays stable across candidates", () => {
  const srjWithPointPairs: SimpleRouteJson = {
    layerCount: 2,
    minTraceWidth: 0.1,
    bounds: { minX: -2, minY: -2, maxX: 2, maxY: 2 },
    obstacles: [
      {
        type: "rect",
        layers: ["top", "bottom"],
        center: { x: -1, y: 0 },
        width: 0.4,
        height: 0.4,
        connectedTo: ["pcb_plated_hole_start", "pcb_port_start"],
      },
      {
        type: "rect",
        layers: ["top", "bottom"],
        center: { x: 1, y: 0 },
        width: 0.4,
        height: 0.4,
        connectedTo: ["pcb_plated_hole_end", "pcb_port_end"],
      },
    ],
    connections: [
      {
        name: "trace",
        pointsToConnect: [
          {
            x: -1,
            y: 0,
            layer: "top",
            pointId: "start",
            pcb_port_id: "pcb_port_start",
          },
          {
            x: 1,
            y: 0,
            layer: "top",
            pointId: "end",
            pcb_port_id: "pcb_port_end",
          },
        ],
      },
    ],
  }
  const connMap = getConnectivityMapFromSimpleRouteJson(srjWithPointPairs)
  const conversionOptions = {
    connections: srjWithPointPairs.connections,
    originalConnections: srjWithPointPairs.connections,
    layerCount: srjWithPointPairs.layerCount,
    obstacles: srjWithPointPairs.obstacles,
    defaultViaHoleDiameter: 0.15,
    connMap,
    srjWithPointPairs,
    originalSrj: srjWithPointPairs,
  }
  // Candidate A stops short of the end pad -> contiguity (missing connection) error
  const shortRoute: HighDensityRoute = {
    connectionName: "trace",
    route: [
      { x: -1, y: 0, z: 0 },
      { x: 0.5, y: 0, z: 0 },
    ],
    vias: [],
    traceThickness: 0.1,
    viaDiameter: 0.3,
  }
  // Candidate B reaches both pads and includes a via (exercises the per-call
  // via connections layered onto the cached base connectivity)
  const viaRoute: HighDensityRoute = {
    connectionName: "trace",
    route: [
      { x: -1, y: 0, z: 0 },
      { x: 0, y: 0, z: 0 },
      { x: 0, y: 0, z: 1 },
      { x: 1, y: 0, z: 1 },
    ],
    vias: [{ x: 0, y: 0 }],
    traceThickness: 0.1,
    viaDiameter: 0.3,
  }

  const strictEvaluator = createPipeline7RelaxedDrcEvaluator(conversionOptions)
  const scoringEvaluator = createPipeline7RelaxedDrcEvaluator({
    ...conversionOptions,
    scoring: true,
  })
  const evaluate = (
    evaluator: ReturnType<typeof createPipeline7RelaxedDrcEvaluator>,
    route: HighDensityRoute,
  ) => {
    const result = evaluator({ traces: [], routes: [route] })
    if (Array.isArray(result)) {
      throw new Error("DRC evaluator returned errors without centers")
    }
    return result
  }

  const isContiguityError = (error: Record<string, unknown>) =>
    typeof error.pcb_trace_error_id === "string" &&
    (error.pcb_trace_error_id.startsWith("missing_connection_") ||
      error.pcb_trace_error_id.startsWith("misaligned_via_"))

  const strictShortResult = evaluate(strictEvaluator, shortRoute)
  expect(strictShortResult.errors.some(isContiguityError)).toBe(true)

  const scoringShortResult = evaluate(scoringEvaluator, shortRoute)
  expect(scoringShortResult.errors.some(isContiguityError)).toBe(false)
  expect(
    isDeepStrictEqual(
      scoringShortResult.errors,
      strictShortResult.errors.filter((error) => !isContiguityError(error)),
    ),
  ).toBe(true)

  // Re-evaluating different candidates through the same scoring evaluator
  // must match a fresh scoring evaluator (caches never leak between calls)
  const scoringViaResult = evaluate(scoringEvaluator, viaRoute)
  const freshScoringViaResult = evaluate(
    createPipeline7RelaxedDrcEvaluator({ ...conversionOptions, scoring: true }),
    viaRoute,
  )
  expect(isDeepStrictEqual(scoringViaResult, freshScoringViaResult)).toBe(true)

  const scoringShortRepeat = evaluate(scoringEvaluator, shortRoute)
  expect(isDeepStrictEqual(scoringShortRepeat, scoringShortResult)).toBe(true)

  // Strict evaluation of the via candidate must match the scoring evaluation
  // once contiguity errors are filtered out (same connectivity decisions)
  const strictViaResult = evaluate(strictEvaluator, viaRoute)
  expect(
    isDeepStrictEqual(
      scoringViaResult.errors,
      strictViaResult.errors.filter((error) => !isContiguityError(error)),
    ),
  ).toBe(true)
})
