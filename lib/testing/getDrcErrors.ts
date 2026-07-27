import {
  checkDifferentNetViaSpacing,
  checkEachPcbTraceNonOverlapping,
  checkPadTraceClearance,
  checkSameNetViaSpacing,
  checkTracesAreContiguous,
  checkViaTraceClearance,
} from "@tscircuit/checks"
import type {
  AnyCircuitElement,
  PcbPadTraceClearanceError,
  PcbTraceError,
  PcbViaClearanceError,
  PcbViaTraceClearanceError,
} from "circuit-json"
import {
  ConnectivityMap,
  getFullConnectivityMapFromCircuitJson,
} from "circuit-json-to-connectivity-map"
import { Point } from "graphics-debug"
import {
  DRC_EVAL_STATS_ENABLED,
  noteDrcEval,
  noteDrcEvalMs,
} from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/drcEvalStats"

type CircuitJson = AnyCircuitElement[]
type CircuitJsonElement = CircuitJson[number]
type PcbViaWithTraceId = CircuitJsonElement & {
  type: "pcb_via"
  pcb_via_id: string
  pcb_trace_id: string
}

type DrcError =
  | PcbTraceError
  | PcbViaTraceClearanceError
  | PcbPadTraceClearanceError
  | PcbViaClearanceError

type DrcErrorWithCenter = DrcError & { center?: Point }

type LocationAwareDrcError = DrcError & { center: Point }

export const MIN_VIA_TO_VIA_CLEARANCE = 0.1
export const PREFERRED_VIA_TO_VIA_CLEARANCE = 0.2

export interface GetDrcErrorsResult {
  errors: DrcError[]
  errorsWithCenters: DrcErrorWithCenter[]
  locationAwareErrors: LocationAwareDrcError[]
}

/**
 * Caches the via-independent net partition (source traces, ports, pads and
 * pcb_trace/source_trace links) across getDrcErrors calls whose non-via
 * elements are identical — e.g. DRC repair candidate scoring, where only
 * route geometry changes while element ids and source links stay fixed.
 * Per-candidate via connections are always added onto a fresh clone, so the
 * cached partition is never mutated.
 */
export interface DrcConnectivityCache {
  baseNetMap?: Record<string, string[]>
}

export interface GetDrcErrorsOptions {
  viaClearance?: number
  traceClearance?: number
  includeTraceContinuity?: boolean
  includeTypedTraceClearance?: boolean
  /**
   * Reuses the via-independent connectivity across calls. Only pass this when
   * every call sees the same non-via circuit elements (see
   * DrcConnectivityCache); intended for repair candidate scoring.
   */
  connectivityCache?: DrcConnectivityCache
  /**
   * Uses this connectivity map instead of building one from the circuit
   * json. Used by the incremental DRC delta path, which builds the map from
   * the FULL candidate circuit json (identical net semantics to a full
   * evaluation) and then runs the checks over a pruned element subset.
   */
  prebuiltConnMap?: ConnectivityMap
}

const cloneNetMap = (
  netMap: Record<string, string[]>,
): Record<string, string[]> => {
  const cloned: Record<string, string[]> = {}
  for (const netId in netMap) {
    cloned[netId] = netMap[netId].slice()
  }
  return cloned
}

export const createDrcConnectivityMap = (
  circuitJson: CircuitJson,
  cache?: DrcConnectivityCache,
): ConnectivityMap => {
  let connMap: ConnectivityMap
  if (cache) {
    cache.baseNetMap ??=
      getFullConnectivityMapFromCircuitJson(circuitJson).netMap
    connMap = new ConnectivityMap(cloneNetMap(cache.baseNetMap))
  } else {
    connMap = getFullConnectivityMapFromCircuitJson(circuitJson)
  }
  const viaTraceConnections = circuitJson
    .filter(
      (element): element is PcbViaWithTraceId =>
        element.type === "pcb_via" && typeof element.pcb_trace_id === "string",
    )
    .map((via) => [via.pcb_via_id, via.pcb_trace_id])

  connMap.addConnections(viaTraceConnections)
  return connMap
}

export const getDrcErrors = (
  circuitJson: CircuitJson,
  options: GetDrcErrorsOptions = {},
): GetDrcErrorsResult => {
  // TS_DRC_EVAL_STATS=1 per-step wall timers (drcEvalStats singleton, shared
  // with the high-density-repair03 snapshot counters). Off: dead branches.
  const statsT0 = DRC_EVAL_STATS_ENABLED ? performance.now() : 0
  let statsPrev = statsT0
  const connMap =
    options.prebuiltConnMap ??
    createDrcConnectivityMap(circuitJson, options.connectivityCache)
  if (DRC_EVAL_STATS_ENABLED) {
    noteDrcEval("getDrcErrors")
    const now = performance.now()
    noteDrcEvalMs("getDrcErrors.connMap", now - statsPrev)
    statsPrev = now
  }
  const viaClearance = Math.max(
    options.viaClearance ?? MIN_VIA_TO_VIA_CLEARANCE,
    MIN_VIA_TO_VIA_CLEARANCE,
  )
  const traceErrors = checkEachPcbTraceNonOverlapping(circuitJson, {
    connMap,
    minClearance: options.traceClearance,
  })
  if (DRC_EVAL_STATS_ENABLED) {
    const now = performance.now()
    noteDrcEvalMs("getDrcErrors.checkTraceOverlap", now - statsPrev)
    statsPrev = now
  }
  const includeTypedTraceClearance =
    options.includeTypedTraceClearance !== false
  const viaTraceErrors = includeTypedTraceClearance
    ? checkViaTraceClearance(circuitJson, {
        connMap,
        minClearance: options.traceClearance,
      })
    : []
  if (DRC_EVAL_STATS_ENABLED) {
    const now = performance.now()
    noteDrcEvalMs("getDrcErrors.checkViaTrace", now - statsPrev)
    statsPrev = now
  }
  const padTraceErrors = includeTypedTraceClearance
    ? checkPadTraceClearance(circuitJson, {
        connMap,
        minClearance: options.traceClearance,
      })
    : []
  if (DRC_EVAL_STATS_ENABLED) {
    const now = performance.now()
    noteDrcEvalMs("getDrcErrors.checkPadTrace", now - statsPrev)
    statsPrev = now
  }
  const viaErrors = [
    ...checkSameNetViaSpacing(circuitJson, {
      connMap,
      minClearance: viaClearance,
    }),
    ...checkDifferentNetViaSpacing(circuitJson, {
      connMap,
      minClearance: viaClearance,
    }),
  ]
  if (DRC_EVAL_STATS_ENABLED) {
    const now = performance.now()
    noteDrcEvalMs("getDrcErrors.checkViaSpacing", now - statsPrev)
    statsPrev = now
  }

  // Hoisted out of the array literal (unchanged execution effect: spreading
  // the precomputed arrays has no side effects) so the check is timeable.
  const contiguityErrors =
    options.includeTraceContinuity === false
      ? []
      : checkTracesAreContiguous(circuitJson)
  if (DRC_EVAL_STATS_ENABLED) {
    const now = performance.now()
    noteDrcEvalMs("getDrcErrors.checkContiguity", now - statsPrev)
    statsPrev = now
  }

  const errors: DrcError[] = [
    ...traceErrors,
    ...contiguityErrors,
    ...viaTraceErrors,
    ...padTraceErrors,
    ...viaErrors,
  ]

  const vias = circuitJson.filter(
    (
      element,
    ): element is CircuitJsonElement & {
      type: "pcb_via"
      pcb_via_id: string
      x: number
      y: number
    } => element.type === "pcb_via",
  )

  const viasById = new Map(vias.map((via) => [via.pcb_via_id, via]))

  const errorsWithCenters = errors.map((error) => {
    if (
      error.type === "pcb_via_trace_clearance_error" &&
      typeof error.pcb_via_id === "string"
    ) {
      const via = viasById.get(error.pcb_via_id)

      if (via) {
        return {
          ...error,
          center: { x: via.x, y: via.y },
        }
      }
    }

    if ("center" in error && error.center) {
      return error as DrcErrorWithCenter
    }

    if ("pcb_center" in error && error.pcb_center) {
      return {
        ...error,
        center: error.pcb_center,
      }
    }

    if ("pcb_via_ids" in error && Array.isArray(error.pcb_via_ids)) {
      const [viaAId, viaBId] = error.pcb_via_ids
      const viaA = viasById.get(viaAId)
      const viaB = viasById.get(viaBId)

      if (viaA && viaB) {
        return {
          ...error,
          center: {
            x: (viaA.x + viaB.x) / 2,
            y: (viaA.y + viaB.y) / 2,
          },
        }
      }
    }

    if (
      "pcb_error_id" in error &&
      typeof error.pcb_error_id === "string" &&
      (error.pcb_error_id.startsWith("same_net_vias_close_") ||
        error.pcb_error_id.startsWith("different_net_vias_close_"))
    ) {
      const viaIds = error.pcb_error_id
        .replace("same_net_vias_close_", "")
        .replace("different_net_vias_close_", "")
        .split("_")
        .filter(Boolean)

      if (viaIds.length === 2) {
        const viaA = viasById.get(viaIds[0])
        const viaB = viasById.get(viaIds[1])

        if (viaA && viaB) {
          return {
            ...error,
            center: {
              x: (viaA.x + viaB.x) / 2,
              y: (viaA.y + viaB.y) / 2,
            },
          }
        }
      }
    }

    return error
  }) as DrcErrorWithCenter[]

  const locationAwareErrors = errorsWithCenters.filter(
    (error): error is LocationAwareDrcError => Boolean(error.center),
  )

  if (DRC_EVAL_STATS_ENABLED) {
    const now = performance.now()
    noteDrcEvalMs("getDrcErrors.decorateCenters", now - statsPrev)
    noteDrcEvalMs("getDrcErrors.total", now - statsT0)
  }

  return {
    errors,
    errorsWithCenters,
    locationAwareErrors,
  }
}
