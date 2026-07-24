import { distance, pointToSegmentDistance } from "@tscircuit/math-utils"
import { SingleHighDensityRouteSolver } from "./SingleHighDensityRouteSolver"
import { Node } from "lib/data-structures/SingleRouteCandidatePriorityQueue"

export class SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost extends SingleHighDensityRouteSolver {
  FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR = 2
  FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR = 1
  FUTURE_CONNECTION_PROXIMITY_VD = 10
  MISALIGNED_DIST_PENALTY_FACTOR = 5
  VIA_PENALTY_FACTOR_2 = 1
  FLIP_TRACE_ALIGNMENT_DIRECTION = false
  FUTURE_CONNECTION_VIA_TRACE_CLEARANCE = 0.1

  // Every hyperparameter key PortfolioSingleIntraNodeSolver can send is
  // declared as a class field so the assignment loop in the constructor
  // never adds new properties (divergent hidden classes across A* instances
  // made the hot-loop property accesses polymorphic). Keys below are
  // consumed by other solvers in the portfolio, not by this class.
  // CELL_SIZE_FACTOR and VIA_PENALTY_FACTOR are declared on the base class.
  // The loop still accepts (and assigns) unknown keys; those would merely
  // cause a hidden-class transition again, not be dropped.
  SINGLE_LAYER_NO_DIFFERENT_ROOT_INTERSECTIONS: boolean | undefined = undefined
  SHUFFLE_SEED: number | undefined = undefined
  MULTI_HEAD_POLYLINE_SOLVER: boolean | undefined = undefined
  SEGMENTS_PER_POLYLINE: number | undefined = undefined
  BOUNDARY_PADDING: number | undefined = undefined
  ITERATION_PENALTY: number | undefined = undefined
  MINIMUM_FINAL_ACCEPTANCE_GAP: number | undefined = undefined
  THROUGH_OBSTACLE: boolean | undefined = undefined
  CLOSED_FORM_SINGLE_TRANSITION: boolean | undefined = undefined
  HIGH_DENSITY_A01: boolean | undefined = undefined
  HIGH_DENSITY_A03: boolean | undefined = undefined

  /**
   * Built once at construction: futureConnections and connMap are
   * constructor inputs and are not mutated while this solver is active.
   */
  futureConnectionSegments: Array<{
    connectionName: string
    start: { x: number; y: number; z: number }
    end: { x: number; y: number; z: number }
  }>

  /**
   * Single-entry memo shared between computeG and computeH, which the base
   * class calls back-to-back with the same freshly created node. Node
   * positions/parents never change after creation, so a stale hit could only
   * return exactly what a recompute would.
   */
  private sharedCostNode: Node | null = null
  private sharedCostGoalDist = 0
  private sharedCostFutureConnectionPenalty = 0

  /**
   * Precomputed per-segment bounding boxes (built once at construction).
   * Lets isViaTooCloseToFutureConnectionTrace reject segments whose bbox is
   * farther than the clearance without calling pointToSegmentDistance —
   * exact: bbox distance is a lower bound for true distance.
   */
  private futureConnectionSegmentBboxes: Array<{
    minX: number
    minY: number
    maxX: number
    maxY: number
  }>

  constructor(
    opts: ConstructorParameters<typeof SingleHighDensityRouteSolver>[0],
  ) {
    super({
      ...opts,
      nearbySegmentClearance:
        opts.nearbySegmentClearance ??
        (opts.traceThickness ?? 0.15) / 2 + (opts.obstacleMargin ?? 0.15),
    })
    for (const key in opts.hyperParameters) {
      // @ts-ignore
      this[key] = opts.hyperParameters[key]
    }

    // Ratio of available space determines via penalty
    const viasThatCanFitHorz = this.boundsSize.width / this.viaDiameter
    // Avoid division by zero when there are no routes
    const routeCount = Math.max(1, this.numRoutes)
    this.VIA_PENALTY_FACTOR =
      0.3 * (viasThatCanFitHorz / routeCount) * this.VIA_PENALTY_FACTOR_2
    // VIA_PENALTY_FACTOR (and VIA_PENALTY_FACTOR_2 via hyperparameters) are
    // final at this point, so the cached penalty distance can be refreshed
    this.updateViaPenaltyDistance()
    this.futureConnectionSegments = this.getFutureConnectionSegments()
    this.futureConnectionSegmentBboxes = this.futureConnectionSegments.map(
      (segment) => ({
        minX: Math.min(segment.start.x, segment.end.x),
        minY: Math.min(segment.start.y, segment.end.y),
        maxX: Math.max(segment.start.x, segment.end.x),
        maxY: Math.max(segment.start.y, segment.end.y),
      }),
    )
  }

  getClosestFutureConnectionPoint(node: Node) {
    let minDist = Infinity
    let closestPoint = null

    for (const futureConnection of this.futureConnections) {
      for (const point of futureConnection.points) {
        // Exact rejects (no float-semantics change): a point cannot beat
        // minDist if its z-mismatch penalty alone reaches it, or if either
        // axis delta does (euclidean >= |dx|, |dy|).
        const zPenalty = node.z !== point.z ? this.viaPenaltyDistance : 0
        if (zPenalty >= minDist) continue
        const dx = Math.abs(node.x - point.x)
        if (dx >= minDist) continue
        const dy = Math.abs(node.y - point.y)
        if (dy >= minDist) continue
        const dist = distance(node, point) + zPenalty
        if (dist < minDist) {
          minDist = dist
          closestPoint = point
        }
      }
    }

    return closestPoint
  }

  getFutureConnectionSegments() {
    const segments: Array<{
      connectionName: string
      start: { x: number; y: number; z: number }
      end: { x: number; y: number; z: number }
    }> = []

    // Hoist the route-side net lookup out of the loop: this.connectionName's
    // net is invariant across future connections. The check below mirrors
    // ConnectivityMap.areIdsConnected(this.connectionName, name) semantics
    // exactly: name === this.connectionName is connected; a falsy net on
    // either side is not connected; otherwise net1 === net2 || net2 === id1.
    const connMap = this.connMap
    const connectionName = this.connectionName
    const connectionNetId = connMap?.getNetConnectedToId?.(connectionName)

    for (const futureConnection of this.futureConnections) {
      const futureConnectionName = futureConnection.connectionName
      let isConnected = futureConnectionName === connectionName
      if (!isConnected && connectionNetId) {
        const futureNetId = connMap?.getNetConnectedToId?.(futureConnectionName)
        isConnected =
          !!futureNetId &&
          (connectionNetId === futureNetId || futureNetId === connectionName)
      }
      if (isConnected) continue

      const [start, ...rest] = futureConnection.points
      if (!start) continue

      for (const end of rest) {
        if (
          Math.abs(start.x - end.x) < 1e-9 &&
          Math.abs(start.y - end.y) < 1e-9
        ) {
          continue
        }
        segments.push({
          connectionName: futureConnection.connectionName,
          start,
          end,
        })
      }
    }

    return segments
  }

  isViaTooCloseToFutureConnectionTrace(node: Node) {
    const minCenterlineDistance =
      this.viaDiameter / 2 +
      this.traceThickness / 2 +
      this.FUTURE_CONNECTION_VIA_TRACE_CLEARANCE

    for (let i = 0; i < this.futureConnectionSegments.length; i++) {
      // Bbox reject with safety slack: point-to-segment distance is at least
      // the point-to-bbox distance; the 1+1e-9 factor makes the skip
      // provably safe against ulp-level differences between this squared
      // check and pointToSegmentDistance's internal arithmetic.
      const bbox = this.futureConnectionSegmentBboxes[i]!
      const bx = Math.max(bbox.minX - node.x, 0, node.x - bbox.maxX)
      if (bx >= minCenterlineDistance) continue
      const by = Math.max(bbox.minY - node.y, 0, node.y - bbox.maxY)
      if (by >= minCenterlineDistance) continue
      const slack = minCenterlineDistance * (1 + 1e-9)
      if (bx * bx + by * by >= slack * slack) {
        continue
      }
      const segment = this.futureConnectionSegments[i]!
      if (
        pointToSegmentDistance(node, segment.start, segment.end) <
        minCenterlineDistance
      ) {
        return true
      }
    }

    return false
  }

  override isNodeTooCloseToObstacle(
    node: Node,
    margin?: number,
    isVia?: boolean,
  ) {
    if (super.isNodeTooCloseToObstacle(node, margin, isVia)) {
      return true
    }

    if (isVia && this.isViaTooCloseToFutureConnectionTrace(node)) {
      return true
    }

    return false
  }

  /**
   * Rapidly approaches 0 as the goal distance approaches 0
   */
  diminishCloseToGoal(node: Node) {
    const goalDist = distance(node, this.B)
    return 1 - Math.exp((-goalDist / this.straightLineDistance) * 5)
  }

  /**
   * computeG and computeH both need distance(node, B) and the future
   * connection penalty for the same node with identical arguments; compute
   * them once per node and share.
   */
  private ensureSharedNodeCosts(node: Node) {
    if (this.sharedCostNode === node) return
    const goalDist = distance(node, this.B)
    this.sharedCostNode = node
    this.sharedCostGoalDist = goalDist
    this.sharedCostFutureConnectionPenalty = this.getFutureConnectionPenalty(
      node,
      node.z !== node.parent?.z,
      goalDist,
    )
  }

  getFutureConnectionPenalty(
    node: Node,
    isVia: boolean,
    goalDist = distance(node, this.B),
  ) {
    let futureConnectionPenalty = 0
    const closestFuturePoint = this.getClosestFutureConnectionPoint(node)
    if (closestFuturePoint) {
      const distToFuturePoint = distance(node, closestFuturePoint)
      if (goalDist <= distToFuturePoint) return 0
      const maxDist = this.viaDiameter * this.FUTURE_CONNECTION_PROXIMITY_VD
      const distRatio = distToFuturePoint / maxDist
      const maxPenalty = isVia
        ? this.straightLineDistance *
          this.FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR
        : this.straightLineDistance *
          this.FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR
      futureConnectionPenalty = maxPenalty * Math.exp(-distRatio * 5)
    }
    return futureConnectionPenalty
  }

  computeH(node: Node) {
    this.ensureSharedNodeCosts(node)
    const goalDist = this.sharedCostGoalDist ** 1.6

    // Base cost from original function
    const baseCost =
      goalDist + (node.z !== this.B.z ? this.viaPenaltyDistance : 0)

    return baseCost + this.sharedCostFutureConnectionPenalty
  }

  computeG(node: Node) {
    const dx = Math.abs(node.x - node.parent!.x)
    const dy = Math.abs(node.y - node.parent!.y)
    const dist = Math.sqrt(dx ** 2 + dy ** 2)

    // Even layers (0, 2, ...) prefer horizontal, odd layers (1, 3, ...) prefer vertical
    const isEvenLayer = node.z % 2 === 0
    const misalignedDist = !this.FLIP_TRACE_ALIGNMENT_DIRECTION
      ? isEvenLayer
        ? dy
        : dx
      : isEvenLayer
        ? dx
        : dy

    // Base cost from original function
    const baseCost =
      (node.parent?.g ?? 0) +
      (node.z === node.parent?.z ? 0 : this.viaPenaltyDistance) +
      dist +
      misalignedDist * this.MISALIGNED_DIST_PENALTY_FACTOR

    this.ensureSharedNodeCosts(node)
    return baseCost + this.sharedCostFutureConnectionPenalty
  }
}
