import type { AnyCircuitElement } from "circuit-json"
import type { SimpleRouteJson, SimplifiedPcbTrace } from "lib/types"
import { RELAXED_DRC_OPTIONS } from "./drcPresets"
import {
  getDrcErrors,
  type DrcConnectivityCache,
  type GetDrcErrorsResult,
} from "./getDrcErrors"
import {
  convertToCircuitJson,
  type CircuitJsonScaffoldCache,
} from "./utils/convertToCircuitJson"

/** Inputs used by the benchmark's relaxed DRC evaluation. */
export interface EvaluateRelaxedDrcInput {
  inputSrj: SimpleRouteJson
  srjWithPointPairs: SimpleRouteJson
  traces: SimplifiedPcbTrace[]
  /**
   * Scoring-only knobs used by the DRC repair candidate evaluator. Final
   * (reported) evaluations must leave these unset so results stay strict:
   * - includeTraceContinuity: false skips the contiguity check (repair moves
   *   cannot fix contiguity errors anyway)
   * - connectivityCache / scaffoldCache reuse route-invariant work across
   *   candidate evaluations of the same board
   */
  includeTraceContinuity?: boolean
  connectivityCache?: DrcConnectivityCache
  scaffoldCache?: CircuitJsonScaffoldCache
}

/** Benchmark relaxed DRC errors and the Circuit JSON evaluated to produce them. */
export interface EvaluateRelaxedDrcResult extends GetDrcErrorsResult {
  circuitJson: AnyCircuitElement[]
}

/** Converts routed traces and evaluates them using the benchmark relaxed DRC. */
export const evaluateRelaxedDrc = ({
  inputSrj,
  srjWithPointPairs,
  traces,
  includeTraceContinuity,
  connectivityCache,
  scaffoldCache,
}: EvaluateRelaxedDrcInput): EvaluateRelaxedDrcResult => {
  const circuitJson = convertToCircuitJson(srjWithPointPairs, traces, {
    minTraceWidth: inputSrj.minTraceWidth,
    minViaDiameter: inputSrj.minViaDiameter,
    scaffoldCache,
  })

  return {
    circuitJson,
    ...getDrcErrors(circuitJson, {
      ...RELAXED_DRC_OPTIONS,
      includeTraceContinuity,
      connectivityCache,
    }),
  }
}
