/**
 * Incremental DRC candidate delta evaluation (TS_INCREMENTAL_DRC=1) —
 * design doc perf-artifacts/incremental-drc-design.md §3 D1.
 *
 * Implements DrcEvaluator.evaluateCandidateDelta for the Pipeline7 scoring
 * evaluator. Given a candidate that differs from the base snapshot's routes
 * only at `dirtyRouteIndexes`, the candidate's absolute
 * (count, issueScore, viaIssueCount) are computed as
 *
 *   base aggregates
 *   − (base errors involving dirty geometry)
 *   + (candidate errors involving dirty geometry)
 *
 * where the candidate-side errors come from running THE SAME five check
 * functions over a pruned element subset: the dirty traces plus every
 * element within interaction distance of the dirty geometry (both its base
 * and candidate positions).
 *
 * Soundness relies on properties verified by reading the patched
 * @tscircuit/checks@0.0.145 dist (and empirically by
 * TS_INCREMENTAL_DRC_VERIFY=1):
 *
 * 1. Every check is pairwise: an error exists iff its participant pair
 *    violates a clearance, so errors NOT involving dirty geometry are
 *    identical between base and candidate (net semantics are
 *    route-invariant: the netMap base partition comes from scaffold
 *    elements, and via→trace merges only join fresh via ids into their
 *    owner trace's net).
 * 2. Global via location-dedup (convertToCircuitJson extractViasFromRoutes)
 *    means a dirty route's via can be suppressed by — or can suppress — an
 *    identical-location via of a clean route, and via OWNERSHIP
 *    (pcb_via_id → pcb_trace_id, which feeds net classification) can change
 *    at such locations. Therefore "dirty geometry" includes every via
 *    LOCATION contributed by a dirty trace in EITHER the base or candidate
 *    state, on both sides of the difference.
 * 3. The candidate circuit json is built in FULL (conversion is a few % of
 *    eval cost); only the check INPUT is pruned. Via ids/numbering and the
 *    connectivity map are therefore byte-identical to a full evaluation,
 *    and element filtering preserves relative order, which makes the
 *    SpatialObjectIndex bucket visit sequences subset-stable — the
 *    first-violating-pair dedup in the trace-overlap check picks the same
 *    representative (same gap, same message) as a full run for every pair
 *    whose participants are both in the pruned set.
 * 4. Severity comes from the message-string regex; the pruned run reuses
 *    the real check code, so messages (and severities) match a full run.
 */
import {
  getDrcErrorSeverity,
  isViaDrcError,
} from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/solverHelpers"
import type {
  DrcCandidateDeltaAggregates,
  DrcCandidateDeltaInput,
  DrcError,
  DrcEvaluator,
} from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/types"
import { RELAXED_DRC_OPTIONS } from "lib/testing/drcPresets"
import {
  createDrcConnectivityMap,
  getDrcErrors,
  type DrcConnectivityCache,
} from "lib/testing/getDrcErrors"
import {
  convertToCircuitJson,
  extractViasFromRoutes,
  isLayerName,
  resolveViaDimensionsForConversion,
  type CircuitJsonScaffoldCache,
} from "lib/testing/utils/convertToCircuitJson"
import type { SimplifiedPcbTrace } from "lib/types"
import type { HighDensityRoute } from "lib/types/high-density-types"
import {
  convertPipeline7HdRoutesToSimplifiedPcbTraces,
  type ConvertPipeline7HdRoutesOptions,
} from "./convertPipeline7HdRoutesToSimplifiedPcbTraces"

type Box = { minX: number; minY: number; maxX: number; maxY: number }

/**
 * Interaction radius between element boxes already inflated by their own
 * copper half-extents: clearance + the checks' EPSILON (5e-3) + slack.
 * Over-inclusion is always safe (extra clean-pair errors are filtered out);
 * under-inclusion is not, hence the generous slack.
 */
const PRUNE_MARGIN_SLACK = 0.025
const CHECKS_EPSILON = 5e-3
/** Candidates dirtying more routes than this fall back to a full eval. */
const MAX_DIRTY_ROUTES = 16
/** Max route points folded into one pruning box before starting a new one. */
const CHUNK_POINT_LIMIT = 12

const boxesIntersectWithMargin = (a: Box, b: Box, margin: number): boolean =>
  a.minX - margin <= b.maxX &&
  b.minX - margin <= a.maxX &&
  a.minY - margin <= b.maxY &&
  b.minY - margin <= a.maxY

const nearAnyBox = (box: Box, boxes: Box[], margin: number): boolean => {
  for (let i = 0; i < boxes.length; i += 1) {
    if (boxesIntersectWithMargin(box, boxes[i]!, margin)) return true
  }
  return false
}

/** Via identity key — must match extractViasFromRoutes' locationKey format. */
const getViaLocationKey = (
  x: number,
  y: number,
  fromLayer: string,
  toLayer: string,
): string => `${x},${y},${fromLayer},${toLayer}`

/**
 * Pruning boxes for one trace: chains of consecutive wire points (jumper /
 * through_obstacle entries are skipped WITHOUT breaking the chain — the
 * circuit-json conversion drops them, making the surrounding wires adjacent,
 * so the checks see a segment spanning the gap) chunked into boxes inflated
 * by the max half-width seen, plus one box per via segment inflated by its
 * pad radius.
 */
const buildTraceBoxes = (
  trace: SimplifiedPcbTrace,
  defaultViaDiameter: number,
): Box[] => {
  const boxes: Box[] = []
  let minX = 0
  let minY = 0
  let maxX = 0
  let maxY = 0
  let half = 0
  let points = 0
  const flush = () => {
    if (points === 0) return
    boxes.push({
      minX: minX - half,
      minY: minY - half,
      maxX: maxX + half,
      maxY: maxY + half,
    })
  }
  for (const segment of trace.route) {
    if (segment.route_type === "wire") {
      if (points === 0) {
        minX = maxX = segment.x
        minY = maxY = segment.y
        half = segment.width / 2
        points = 1
      } else {
        if (segment.x < minX) minX = segment.x
        if (segment.x > maxX) maxX = segment.x
        if (segment.y < minY) minY = segment.y
        if (segment.y > maxY) maxY = segment.y
        if (segment.width / 2 > half) half = segment.width / 2
        points += 1
      }
      if (points >= CHUNK_POINT_LIMIT) {
        flush()
        // Seed the next chunk with this point so the connecting segment is
        // covered by the new chunk too.
        minX = maxX = segment.x
        minY = maxY = segment.y
        half = segment.width / 2
        points = 1
      }
    } else if (segment.route_type === "via") {
      const radius = (segment.via_diameter ?? defaultViaDiameter) / 2
      boxes.push({
        minX: segment.x - radius,
        minY: segment.y - radius,
        maxX: segment.x + radius,
        maxY: segment.y + radius,
      })
    }
    // jumper / through_obstacle: skipped, chain continues (see doc above)
  }
  flush()
  return boxes
}

/** Via location keys contributed by one trace (pre-dedup). */
const getTraceViaKeys = (trace: SimplifiedPcbTrace): string[] => {
  const keys: string[] = []
  for (const segment of trace.route) {
    if (segment.route_type !== "via") continue
    if (!isLayerName(segment.from_layer) || !isLayerName(segment.to_layer)) {
      continue
    }
    keys.push(
      getViaLocationKey(segment.x, segment.y, segment.from_layer, segment.to_layer),
    )
  }
  return keys
}

/** Conservative half-extent of a pad-like element (covers any rotation). */
const getPadHalfExtent = (pad: Record<string, unknown>): number => {
  const width = typeof pad.width === "number" ? pad.width : 0
  const height = typeof pad.height === "number" ? pad.height : 0
  const rectWidth =
    typeof pad.rect_pad_width === "number" ? pad.rect_pad_width : 0
  const rectHeight =
    typeof pad.rect_pad_height === "number" ? pad.rect_pad_height : 0
  const outer =
    typeof pad.outer_diameter === "number" ? pad.outer_diameter : 0
  return Math.max(
    Math.hypot(width, height) / 2,
    Math.hypot(rectWidth, rectHeight) / 2,
    outer / 2,
  )
}

/**
 * Error participants: trace ids plus via ids plus the "other" id encoded in
 * trace-overlap error ids (which may be a trace, via, or pad id — tested
 * against both dirty sets; pads are never dirty). Returns undefined for
 * unrecognized error shapes — the caller then declines the delta.
 */
type ErrorParticipants = {
  traceIds: string[]
  viaOrOtherIds: string[]
}

const parseErrorParticipants = (
  error: DrcError,
): ErrorParticipants | undefined => {
  const type =
    typeof error.type === "string"
      ? error.type
      : typeof error.error_type === "string"
        ? error.error_type
        : undefined
  if (type === "pcb_trace_error") {
    const traceId = error.pcb_trace_id
    const errorId = error.pcb_trace_error_id
    if (typeof traceId !== "string" || typeof errorId !== "string") {
      return undefined
    }
    const prefix = `overlap_${traceId}_`
    if (!errorId.startsWith(prefix)) return undefined
    return { traceIds: [traceId], viaOrOtherIds: [errorId.slice(prefix.length)] }
  }
  if (type === "pcb_via_trace_clearance_error") {
    const viaId = error.pcb_via_id
    const traceId = error.pcb_trace_id
    if (typeof viaId !== "string" || typeof traceId !== "string") {
      return undefined
    }
    return { traceIds: [traceId], viaOrOtherIds: [viaId] }
  }
  if (type === "pcb_pad_trace_clearance_error") {
    const traceId = error.pcb_trace_id
    if (typeof traceId !== "string") return undefined
    return { traceIds: [traceId], viaOrOtherIds: [] }
  }
  if (type === "pcb_via_clearance_error") {
    const viaIds = error.pcb_via_ids
    if (
      !Array.isArray(viaIds) ||
      viaIds.some((viaId) => typeof viaId !== "string")
    ) {
      return undefined
    }
    return { traceIds: [], viaOrOtherIds: viaIds as string[] }
  }
  return undefined
}

const isParticipantsDirty = (
  participants: ErrorParticipants,
  dirtyTraceIds: ReadonlySet<string>,
  dirtyViaIds: ReadonlySet<string>,
): boolean => {
  for (const traceId of participants.traceIds) {
    if (dirtyTraceIds.has(traceId)) return true
  }
  for (const id of participants.viaOrOtherIds) {
    if (dirtyViaIds.has(id) || dirtyTraceIds.has(id)) return true
  }
  return false
}

type BaseErrorInfo = {
  participants: ErrorParticipants
  severity: number
  isViaError: boolean
}

type BaseContext = {
  usable: boolean
  traceIdByRouteIndex: Array<string | undefined>
  tracesById: Map<string, SimplifiedPcbTrace>
  viaIdByLocationKey: Map<string, string>
  viaKeysByTraceId: Map<string, string[]>
  boxesByTraceId: Map<string, Box[]>
  errorInfos: BaseErrorInfo[]
}

export type AttachDeltaEvaluatorOptions = Omit<
  ConvertPipeline7HdRoutesOptions,
  "hdRoutes" | "traceIdByRouteIndexOut"
> & {
  srjWithPointPairs: import("lib/types").SimpleRouteJson
  originalSrj: import("lib/types").SimpleRouteJson
  connectivityCache: DrcConnectivityCache
  scaffoldCache: CircuitJsonScaffoldCache
}

/**
 * Attaches evaluateCandidateDelta to a Pipeline7 scoring evaluator. Shares
 * the evaluator's connectivity/scaffold caches so the delta path sees the
 * exact same route-invariant state as the full path.
 */
export const attachPipeline7DrcDeltaEvaluator = (
  evaluator: DrcEvaluator,
  options: AttachDeltaEvaluatorOptions,
): void => {
  const {
    srjWithPointPairs,
    originalSrj,
    connectivityCache,
    scaffoldCache,
    ...conversionOptions
  } = options
  const { resolvedMinViaDiameter, resolvedMinViaHoleDiameter } =
    resolveViaDimensionsForConversion(srjWithPointPairs, {
      minViaDiameter: originalSrj.minViaDiameter,
    })
  const pruneMargin =
    Math.max(
      RELAXED_DRC_OPTIONS.traceClearance ?? 0.1,
      RELAXED_DRC_OPTIONS.viaClearance ?? 0.1,
    ) +
    CHECKS_EPSILON +
    PRUNE_MARGIN_SLACK

  const baseContexts = new WeakMap<DrcError[], BaseContext>()

  const convertRoutes = (
    hdRoutes: HighDensityRoute[],
    traceIdByRouteIndexOut?: Array<string | undefined>,
  ): SimplifiedPcbTrace[] =>
    convertPipeline7HdRoutesToSimplifiedPcbTraces({
      ...conversionOptions,
      hdRoutes,
      traceIdByRouteIndexOut,
    })

  const buildBaseContext = (
    baseRoutes: HighDensityRoute[],
    baseErrors: DrcError[],
  ): BaseContext => {
    const traceIdByRouteIndex: Array<string | undefined> = new Array(
      baseRoutes.length,
    )
    const traces = convertRoutes(baseRoutes, traceIdByRouteIndex)
    const vias = extractViasFromRoutes(
      traces,
      srjWithPointPairs.layerCount,
      resolvedMinViaDiameter,
      resolvedMinViaHoleDiameter,
    )
    const viaIdByLocationKey = new Map<string, string>()
    for (const via of vias) {
      viaIdByLocationKey.set(
        getViaLocationKey(
          via.x,
          via.y,
          via.layers[0] as string,
          via.layers[1] as string,
        ),
        via.pcb_via_id,
      )
    }
    const tracesById = new Map<string, SimplifiedPcbTrace>()
    const viaKeysByTraceId = new Map<string, string[]>()
    const boxesByTraceId = new Map<string, Box[]>()
    for (const trace of traces) {
      tracesById.set(trace.pcb_trace_id, trace)
      viaKeysByTraceId.set(trace.pcb_trace_id, getTraceViaKeys(trace))
      boxesByTraceId.set(
        trace.pcb_trace_id,
        buildTraceBoxes(trace, resolvedMinViaDiameter),
      )
    }
    let usable = true
    const errorInfos: BaseErrorInfo[] = []
    for (const error of baseErrors) {
      const participants = parseErrorParticipants(error)
      if (!participants) {
        usable = false
        break
      }
      errorInfos.push({
        participants,
        severity: getDrcErrorSeverity(error),
        isViaError: isViaDrcError(error),
      })
    }
    return {
      usable,
      traceIdByRouteIndex,
      tracesById,
      viaIdByLocationKey,
      viaKeysByTraceId,
      boxesByTraceId,
      errorInfos,
    }
  }

  evaluator.evaluateCandidateDelta = (
    input: DrcCandidateDeltaInput,
  ): DrcCandidateDeltaAggregates | undefined => {
    const {
      routes,
      baseRoutes,
      baseErrors,
      baseCount,
      baseIssueScore,
      baseViaIssueCount,
      dirtyRouteIndexes,
    } = input
    if (dirtyRouteIndexes.length > MAX_DIRTY_ROUTES) return undefined

    let baseContext = baseContexts.get(baseErrors)
    if (!baseContext) {
      baseContext = buildBaseContext(baseRoutes, baseErrors)
      baseContexts.set(baseErrors, baseContext)
    }
    if (!baseContext.usable) return undefined

    // Candidate conversion + FULL circuit json + connectivity map: identical
    // ids, via numbering and net semantics to a full evaluation.
    const candidateTraceIdByRouteIndex: Array<string | undefined> = new Array(
      routes.length,
    )
    const candidateTraces = convertRoutes(routes, candidateTraceIdByRouteIndex)
    const candidateCircuitJson = convertToCircuitJson(
      srjWithPointPairs,
      candidateTraces,
      {
        minTraceWidth: originalSrj.minTraceWidth,
        minViaDiameter: originalSrj.minViaDiameter,
        scaffoldCache,
      },
    )
    const connMap = createDrcConnectivityMap(
      candidateCircuitJson,
      connectivityCache,
    )

    const candidateTracesById = new Map<string, SimplifiedPcbTrace>()
    for (const trace of candidateTraces) {
      candidateTracesById.set(trace.pcb_trace_id, trace)
    }

    // Dirty sets. Trace ids are identical between base and candidate (same
    // array order, same connection grouping).
    const dirtyTraceIds = new Set<string>()
    for (const routeIndex of dirtyRouteIndexes) {
      const traceId = candidateTraceIdByRouteIndex[routeIndex]
      if (traceId !== undefined) dirtyTraceIds.add(traceId)
    }
    if (dirtyTraceIds.size === 0) {
      // Every dirty route is invisible to DRC (no matching connection): the
      // candidate evaluates exactly like the base.
      return {
        count: baseCount,
        issueScore: baseIssueScore,
        viaIssueCount: baseViaIssueCount,
      }
    }

    const dirtyViaKeys = new Set<string>()
    const dirtyBoxes: Box[] = []
    for (const traceId of dirtyTraceIds) {
      const baseKeys = baseContext.viaKeysByTraceId.get(traceId)
      if (baseKeys) for (const key of baseKeys) dirtyViaKeys.add(key)
      const candidateTrace = candidateTracesById.get(traceId)
      if (candidateTrace) {
        for (const key of getTraceViaKeys(candidateTrace)) {
          dirtyViaKeys.add(key)
        }
        dirtyBoxes.push(
          ...buildTraceBoxes(candidateTrace, resolvedMinViaDiameter),
        )
      }
      const baseBoxes = baseContext.boxesByTraceId.get(traceId)
      if (baseBoxes) dirtyBoxes.push(...baseBoxes)
    }

    const baseDirtyViaIds = new Set<string>()
    for (const key of dirtyViaKeys) {
      const viaId = baseContext.viaIdByLocationKey.get(key)
      if (viaId !== undefined) baseDirtyViaIds.add(viaId)
    }

    // Prune: keep scaffold elements, dirty traces, and geometry within the
    // interaction margin of the dirty boxes. Filtering preserves order.
    const candidateDirtyViaIds = new Set<string>()
    const prunedCircuitJson = candidateCircuitJson.filter((element) => {
      if (element.type === "pcb_trace") {
        const traceId = (element as { pcb_trace_id: string }).pcb_trace_id
        if (dirtyTraceIds.has(traceId)) return true
        const boxes =
          baseContext.boxesByTraceId.get(traceId) ??
          // Trace unknown to the base (should not happen — trace set is
          // route-invariant) — keep it to stay conservative.
          undefined
        if (!boxes) return true
        for (const box of boxes) {
          if (nearAnyBox(box, dirtyBoxes, pruneMargin)) return true
        }
        return false
      }
      if (element.type === "pcb_via") {
        const via = element as {
          pcb_via_id: string
          x: number
          y: number
          outer_diameter: number
          layers: string[]
        }
        const key = getViaLocationKey(
          via.x,
          via.y,
          via.layers[0] as string,
          via.layers[1] as string,
        )
        const isDirty = dirtyViaKeys.has(key)
        if (isDirty) candidateDirtyViaIds.add(via.pcb_via_id)
        if (isDirty) return true
        const radius = via.outer_diameter / 2
        return nearAnyBox(
          {
            minX: via.x - radius,
            minY: via.y - radius,
            maxX: via.x + radius,
            maxY: via.y + radius,
          },
          dirtyBoxes,
          pruneMargin,
        )
      }
      if (element.type === "pcb_smtpad" || element.type === "pcb_plated_hole") {
        const pad = element as unknown as Record<string, unknown> & {
          x: number
          y: number
        }
        const halfExtent = getPadHalfExtent(pad)
        return nearAnyBox(
          {
            minX: pad.x - halfExtent,
            minY: pad.y - halfExtent,
            maxX: pad.x + halfExtent,
            maxY: pad.y + halfExtent,
          },
          dirtyBoxes,
          pruneMargin,
        )
      }
      // source_trace, pcb_port and anything else route-invariant: keep.
      return true
    })

    const pruned = getDrcErrors(prunedCircuitJson, {
      ...RELAXED_DRC_OPTIONS,
      includeTraceContinuity: false,
      prebuiltConnMap: connMap,
    })

    // Difference the dirty-involved error multisets.
    let deltaCount = 0
    let deltaViaIssueCount = 0
    const beforeSeverities: number[] = []
    const afterSeverities: number[] = []
    for (const info of baseContext.errorInfos) {
      if (
        !isParticipantsDirty(info.participants, dirtyTraceIds, baseDirtyViaIds)
      ) {
        continue
      }
      deltaCount -= 1
      if (info.isViaError) deltaViaIssueCount -= 1
      beforeSeverities.push(info.severity)
    }
    for (const error of pruned.errorsWithCenters as unknown as DrcError[]) {
      const participants = parseErrorParticipants(error)
      if (!participants) return undefined
      if (
        !isParticipantsDirty(participants, dirtyTraceIds, candidateDirtyViaIds)
      ) {
        continue
      }
      deltaCount += 1
      if (isViaDrcError(error)) deltaViaIssueCount += 1
      afterSeverities.push(getDrcErrorSeverity(error))
    }

    // issueScore: short-circuit equal severity multisets to the exact base
    // score (the common rejected-candidate case), avoiding float summation
    // noise entirely.
    let issueScore: number
    let multisetEqual = beforeSeverities.length === afterSeverities.length
    if (multisetEqual && beforeSeverities.length > 0) {
      beforeSeverities.sort((a, b) => a - b)
      afterSeverities.sort((a, b) => a - b)
      for (let i = 0; i < beforeSeverities.length; i += 1) {
        if (beforeSeverities[i] !== afterSeverities[i]) {
          multisetEqual = false
          break
        }
      }
    }
    if (multisetEqual) {
      issueScore = baseIssueScore
    } else {
      let beforeSum = 0
      for (const severity of beforeSeverities) beforeSum += severity
      let afterSum = 0
      for (const severity of afterSeverities) afterSum += severity
      issueScore = baseIssueScore - beforeSum + afterSum
    }

    return {
      count: baseCount + deltaCount,
      issueScore,
      viaIssueCount: baseViaIssueCount + deltaViaIssueCount,
    }
  }
}
