import type { DrcEvaluator } from "high-density-repair03/lib"
import {
  DRC_EVAL_STATS_ENABLED,
  noteDrcEval,
  noteDrcEvalMs,
} from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/drcEvalStats"
import { evaluateRelaxedDrc } from "lib/testing/evaluate-relaxed-drc"
import type { DrcConnectivityCache } from "lib/testing/getDrcErrors"
import type { CircuitJsonScaffoldCache } from "lib/testing/utils/convertToCircuitJson"
import type { SimpleRouteJson } from "lib/types"
import { attachPipeline7DrcDeltaEvaluator } from "./attachPipeline7DrcDeltaEvaluator"
import {
  convertPipeline7HdRoutesToSimplifiedPcbTraces,
  type ConvertPipeline7HdRoutesOptions,
} from "./convertPipeline7HdRoutesToSimplifiedPcbTraces"

/** Scores Pipeline7 repair candidates with the benchmark relaxed DRC. */
export const createPipeline7RelaxedDrcEvaluator = (
  conversionOptions: Omit<ConvertPipeline7HdRoutesOptions, "hdRoutes"> & {
    srjWithPointPairs: SimpleRouteJson
    originalSrj: SimpleRouteJson
    /**
     * Creates a faster scoring-variant evaluator for ranking repair
     * candidates: skips the trace-contiguity check (repair moves cannot fix
     * contiguity errors) and caches route-invariant connectivity/scaffolding
     * across candidate evaluations. Never use a scoring evaluator for final
     * (reported) DRC results — those must include contiguity errors.
     */
    scoring?: boolean
  },
): DrcEvaluator => {
  const { scoring, ...restConversionOptions } = conversionOptions
  const connectivityCache: DrcConnectivityCache | undefined = scoring
    ? {}
    : undefined
  const scaffoldCache: CircuitJsonScaffoldCache | undefined = scoring
    ? {}
    : undefined

  const evaluator: DrcEvaluator = ({ routes, hdRoutes }) => {
    const evaluatedRoutes = routes ?? hdRoutes
    if (!evaluatedRoutes) {
      throw new Error("Pipeline7 relaxed DRC evaluation requires HD routes")
    }

    const statsT0 = DRC_EVAL_STATS_ENABLED ? performance.now() : 0
    const traces = convertPipeline7HdRoutesToSimplifiedPcbTraces({
      ...restConversionOptions,
      hdRoutes: evaluatedRoutes,
    })
    if (DRC_EVAL_STATS_ENABLED) {
      noteDrcEval("evaluator")
      noteDrcEvalMs("evaluator.convertTraces", performance.now() - statsT0)
    }
    const { errors, errorsWithCenters } = evaluateRelaxedDrc({
      inputSrj: restConversionOptions.originalSrj,
      srjWithPointPairs: restConversionOptions.srjWithPointPairs,
      traces,
      ...(scoring
        ? { includeTraceContinuity: false, connectivityCache, scaffoldCache }
        : {}),
    })

    return {
      errors: errors as unknown as Record<string, unknown>[],
      errorsWithCenters: errorsWithCenters as unknown as Record<
        string,
        unknown
      >[],
    }
  }

  if (scoring && connectivityCache && scaffoldCache) {
    // Incremental candidate screen (TS_INCREMENTAL_DRC=1; no effect
    // otherwise — the solver only consults the property behind the flag).
    // Shares this evaluator's route-invariant caches so the delta path sees
    // exactly the same connectivity/scaffold state as the full path.
    attachPipeline7DrcDeltaEvaluator(evaluator, {
      ...restConversionOptions,
      connectivityCache,
      scaffoldCache,
    })
  }

  return evaluator
}
