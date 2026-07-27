import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import type { GraphicsObject } from "graphics-debug"
import { getGlobalInMemoryCache } from "lib/cache/setupGlobalCaches"
import type { CapacityMeshNodeId } from "lib/types/capacity-mesh-types"
import { combineVisualizations } from "lib/utils/combineVisualizations"
import { mergeRouteSegments } from "lib/utils/mergeRouteSegments"
import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "../../types/high-density-types"
import type { Obstacle } from "../../types/srj-types"
import {
  type HdNodePool,
  type HdNodeResult,
  destroyHdNodePool,
  getHdNodePool,
} from "../../parallel/hdNodePool"
import {
  gateHdNodeDecisionOnBoardSize,
  resolveHdNodeParallelism,
} from "../../parallel/autoEnable"
import { BaseSolver } from "../BaseSolver"
import {
  DEFAULT_MAX_GROWTH_ATTEMPTS,
  GrowShrinkHighDensityIntraNodeSolver,
} from "../HyperHighDensitySolver/GrowShrinkHighDensityIntraNodeSolver"
import { PortfolioSingleIntraNodeSolver } from "../HyperHighDensitySolver/PortfolioSingleIntraNodeSolver"
import { safeTransparentize } from "../colors"
import { CachedIntraNodeRouteSolver } from "./CachedIntraNodeRouteSolver"
import { IntraNodeRouteSolver } from "./IntraNodeSolver"

type HighDensityIntraNodeSolver =
  | IntraNodeRouteSolver
  | PortfolioSingleIntraNodeSolver
  | GrowShrinkHighDensityIntraNodeSolver

const connectionLabel = (
  connectionName: string,
  rootConnectionName?: string,
  extraLines: string[] = [],
) =>
  [
    connectionName,
    rootConnectionName
      ? `rootConnectionName: ${rootConnectionName}`
      : undefined,
    ...extraLines,
  ]
    .filter(Boolean)
    .join("\n")

export class HighDensitySolver extends BaseSolver {
  override getSolverName(): string {
    return "HighDensitySolver"
  }

  unsolvedNodePortPoints: NodeWithPortPoints[]
  routes: HighDensityIntraNodeRoute[]
  colorMap: Record<string, string>

  // Defaults as specified: viaDiameter of 0.3 and traceThickness of 0.15
  readonly defaultViaDiameter = 0.3
  readonly defaultTraceThickness = 0.15
  viaDiameter: number
  traceWidth: number
  obstacleMargin: number
  effort: number
  obstacles: Obstacle[]
  layerCount: number
  useGrowShrinkHighDensityIntraNodeSolver: boolean
  preserveTerminalPcbPortIds: boolean
  growShrinkMaxInnerIterationsPerGrowthAttempt?: number
  growShrinkFallbackToInvalidGeometryOnFailure: boolean

  failedSolvers: HighDensityIntraNodeSolver[]
  private nodePool: HdNodePool | null = null
  private parallelWorkerCount: number | null = null
  private dispatchedNodes = new Map<string, NodeWithPortPoints>()
  private solvedNodeIds = new Set<string>()
  activeSubSolver: HighDensityIntraNodeSolver | null = null
  connMap?: ConnectivityMap
  nodePfById: Map<CapacityMeshNodeId, number | null>
  nodeSolveMetadataById: Map<
    CapacityMeshNodeId,
    {
      node: NodeWithPortPoints
      status: "solved" | "failed"
      solverType: string
      iterations: number
      routeCount: number
      nodePf: number | null
      error?: string
    }
  >

  constructor({
    nodePortPoints,
    colorMap,
    connMap,
    viaDiameter,
    traceWidth,
    obstacleMargin,
    effort,
    nodePfById,
    obstacles,
    layerCount,
    useGrowShrinkHighDensityIntraNodeSolver,
    preserveTerminalPcbPortIds,
    growShrinkMaxInnerIterationsPerGrowthAttempt,
    growShrinkFallbackToInvalidGeometryOnFailure,
  }: {
    nodePortPoints: NodeWithPortPoints[]
    colorMap?: Record<string, string>
    connMap?: ConnectivityMap
    viaDiameter?: number
    traceWidth?: number
    obstacleMargin?: number
    effort?: number
    obstacles?: Obstacle[]
    layerCount?: number
    useGrowShrinkHighDensityIntraNodeSolver?: boolean
    preserveTerminalPcbPortIds?: boolean
    growShrinkMaxInnerIterationsPerGrowthAttempt?: number
    growShrinkFallbackToInvalidGeometryOnFailure?: boolean
    nodePfById?:
      | Map<CapacityMeshNodeId, number | null>
      | Record<string, number | null>
  }) {
    super()
    this.unsolvedNodePortPoints = nodePortPoints
    this.colorMap = colorMap ?? {}
    this.connMap = connMap
    this.routes = []
    this.failedSolvers = []
    this.effort = effort ?? 1
    this.viaDiameter = viaDiameter ?? this.defaultViaDiameter
    this.traceWidth = traceWidth ?? this.defaultTraceThickness
    this.obstacleMargin = obstacleMargin ?? 0.15
    this.obstacles = obstacles ?? []
    this.layerCount = layerCount ?? 2
    this.useGrowShrinkHighDensityIntraNodeSolver =
      useGrowShrinkHighDensityIntraNodeSolver ?? false
    this.preserveTerminalPcbPortIds = preserveTerminalPcbPortIds ?? false
    this.growShrinkMaxInnerIterationsPerGrowthAttempt =
      growShrinkMaxInnerIterationsPerGrowthAttempt
    this.growShrinkFallbackToInvalidGeometryOnFailure =
      growShrinkFallbackToInvalidGeometryOnFailure ?? false
    this.MAX_ITERATIONS =
      10e6 *
      this.effort *
      (this.useGrowShrinkHighDensityIntraNodeSolver
        ? DEFAULT_MAX_GROWTH_ATTEMPTS + 1
        : 1)
    this.nodePfById =
      nodePfById instanceof Map
        ? new Map(nodePfById)
        : new Map(Object.entries(nodePfById ?? {}))
    this.nodeSolveMetadataById = new Map()
    this.stats = {
      solverNodeCount: {} as Record<string, number>,
      difficultNodePfs: {} as Record<string, number[]>,
      highDensityResizeCount: 0,
    }
  }

  private getSolvedNodeSolverType(solver: HighDensityIntraNodeSolver): string {
    if (
      solver instanceof GrowShrinkHighDensityIntraNodeSolver &&
      solver.winningSolver
    ) {
      return this.getSolvedNodeSolverType(solver.winningSolver)
    }
    if (
      solver instanceof PortfolioSingleIntraNodeSolver &&
      solver.winningSolver
    ) {
      return this.getConcreteSolverTypeName(solver.winningSolver as BaseSolver)
    }
    return this.getConcreteSolverTypeName(solver)
  }

  private recordNodeSolveMetadata(
    solver: HighDensityIntraNodeSolver,
    status: "solved" | "failed",
  ) {
    const node = solver.nodeWithPortPoints
    const nodePf = this.nodePfById.get(node.capacityMeshNodeId) ?? null
    this.nodeSolveMetadataById.set(node.capacityMeshNodeId, {
      node,
      status,
      solverType: this.getSolvedNodeSolverType(solver),
      iterations: solver.iterations,
      routeCount: solver.solvedRoutes.length,
      nodePf,
      error: solver.error ?? undefined,
    })
  }

  private createNodeMarkerLabel(
    capacityMeshNodeId: CapacityMeshNodeId,
    metadata: {
      status: "solved" | "failed"
      solverType: string
      iterations: number
      routeCount: number
      nodePf: number | null
      node: NodeWithPortPoints
      error?: string
    },
  ): string {
    return [
      "hd_node_marker",
      `node: ${capacityMeshNodeId}`,
      `status: ${metadata.status}`,
      `solver: ${metadata.solverType}`,
      `iterations: ${metadata.iterations}`,
      `routes: ${metadata.routeCount}`,
      `nodePf: ${metadata.nodePf ?? "n/a"}`,
      `portPoints: ${metadata.node.portPoints.length}`,
      ...(metadata.error ? [`error: ${metadata.error}`] : []),
    ].join("\n")
  }

  private getConcreteSolverTypeName(solver: BaseSolver): string {
    if (solver instanceof CachedIntraNodeRouteSolver) {
      const concreteName = this.getIntraNodeStrategyName(solver.hyperParameters)
      return solver.cacheHit ? `${concreteName} [cached]` : concreteName
    }

    if (solver instanceof IntraNodeRouteSolver) {
      return this.getIntraNodeStrategyName(solver.hyperParameters)
    }

    return solver.getSolverName()
  }

  private getIntraNodeStrategyName(
    hyperParameters: Record<string, any> | undefined,
  ): string {
    if (hyperParameters?.MULTI_HEAD_POLYLINE_SOLVER) {
      return "MultiHeadPolyLineIntraNodeSolver3"
    }
    if (hyperParameters?.SINGLE_LAYER_NO_DIFFERENT_ROOT_INTERSECTIONS) {
      return "SingleLayerNoDifferentRootIntersectionsIntraNodeSolver"
    }
    if (hyperParameters?.CLOSED_FORM_SINGLE_TRANSITION) {
      return "SingleTransitionIntraNodeSolver"
    }
    if (hyperParameters?.CLOSED_FORM_TWO_TRACE_SAME_LAYER) {
      return "TwoCrossingRoutesHighDensitySolver"
    }
    if (hyperParameters?.CLOSED_FORM_TWO_TRACE_TRANSITION_CROSSING) {
      return "SingleTransitionCrossingRouteSolver"
    }
    if (hyperParameters?.HIGH_DENSITY_A01) {
      return "HighDensitySolverA01"
    }
    if (hyperParameters?.HIGH_DENSITY_A03) {
      return "HighDensitySolverA03"
    }
    return "SingleHighDensityRouteSolver6_VertHorzLayer_FutureCost"
  }

  private recordSolvedNodeStats(
    solver: HighDensityIntraNodeSolver,
    node: NodeWithPortPoints,
  ) {
    const solverType = this.getSolvedNodeSolverType(solver)
    const solverNodeCount = this.stats.solverNodeCount as Record<string, number>
    const difficultNodePfs = this.stats.difficultNodePfs as Record<
      string,
      number[]
    >

    solverNodeCount[solverType] = (solverNodeCount[solverType] ?? 0) + 1

    const pf = this.nodePfById.get(node.capacityMeshNodeId) ?? null
    if (pf !== null && pf > 0.05) {
      if (!difficultNodePfs[solverType]) {
        difficultNodePfs[solverType] = []
      }
      difficultNodePfs[solverType].push(pf)
    }
  }

  private recordResizeStats(solver: HighDensityIntraNodeSolver) {
    if (!(solver instanceof GrowShrinkHighDensityIntraNodeSolver)) return
    this.stats.highDensityResizeCount =
      (this.stats.highDensityResizeCount ?? 0) + solver.growthAttempts
  }

  private getSolvedRoutesWithTerminalPcbPortIds(
    solver: HighDensityIntraNodeSolver,
  ): HighDensityIntraNodeRoute[] {
    return this.annotateRoutesWithTerminalPcbPortIds(
      solver.nodeWithPortPoints,
      solver.solvedRoutes,
    )
  }

  /**
   * Same terminal-id annotation, reachable without a solver instance so the
   * node-parallel path (which only gets serialized routes back from a worker)
   * produces identical output to the sequential path.
   */
  private annotateRoutesWithTerminalPcbPortIds(
    nodeWithPortPoints: NodeWithPortPoints,
    solvedRoutes: HighDensityIntraNodeRoute[],
  ): HighDensityIntraNodeRoute[] {
    const terminalPortPoints = nodeWithPortPoints.portPoints.filter(
      (portPoint) => portPoint.pcb_port_id !== undefined,
    )
    if (terminalPortPoints.length === 0) return solvedRoutes

    const getTerminalPcbPortId = (
      route: HighDensityIntraNodeRoute,
      point: HighDensityIntraNodeRoute["route"][number],
    ) => {
      const matchingTerminals = terminalPortPoints.filter(
        (terminal) =>
          terminal.connectionName === route.connectionName &&
          terminal.x === point.x &&
          terminal.y === point.y &&
          terminal.z === point.z,
      )
      if (matchingTerminals.length > 1) {
        throw new Error(
          `HighDensitySolver found multiple PCB terminals at an endpoint of "${route.connectionName}"`,
        )
      }
      const terminal = matchingTerminals[0]
      if (!terminal?.pcb_port_id) return undefined
      return terminal.pcb_port_id
    }
    return solvedRoutes.map((route) => ({
      ...route,
      startPcbPortId: route.route[0]
        ? getTerminalPcbPortId(route, route.route[0])
        : undefined,
      endPcbPortId:
        route.route.length > 1
          ? getTerminalPcbPortId(route, route.route[route.route.length - 1]!)
          : undefined,
    }))
  }

  /**
   * Decides once per solve whether the node-parallel path is taken, and with
   * how many workers. Explicit TS_PARALLEL_HD_NODES always wins (any board);
   * auto mode (G9) additionally requires a board worth parallelizing — small
   * boards stay sequential. Cached: env/hardware must not be re-probed on
   * every pump iteration, and the choice must not flip mid-solve.
   */
  private resolveParallelWorkerCount(): number {
    if (this.parallelWorkerCount !== null) return this.parallelWorkerCount
    const decision = gateHdNodeDecisionOnBoardSize(
      resolveHdNodeParallelism(),
      this.unsolvedNodePortPoints.length,
    )
    this.parallelWorkerCount = decision.workerCount
    return this.parallelWorkerCount
  }

  /**
   * Parallel-path equivalent of recordNodeSolveMetadata: the winning solver
   * instance cannot cross the worker boundary, so the worker computes the
   * display fields (solverType via a mirror of getSolvedNodeSolverType, plus
   * iterations and routeCount) and this side supplies the node and nodePf it
   * owns. After this, visualize() emits the same node-boundary markers for
   * parallel runs as for sequential ones.
   */
  private recordParallelNodeSolveMetadata(
    result: HdNodeResult,
    node: NodeWithPortPoints | undefined,
    status: "solved" | "failed",
  ) {
    // nodeId always originates from tryDispatch, so the node is always
    // present; a miss would indicate a pool bug, and metadata needs the node.
    if (!node) return
    this.nodeSolveMetadataById.set(result.nodeId, {
      node,
      status,
      solverType: result.solverType,
      iterations: result.iterations,
      routeCount: result.routeCount,
      nodePf: this.nodePfById.get(result.nodeId) ?? null,
      error: result.error ?? undefined,
    })
  }

  /** Parallel-path equivalent of recordSolvedNodeStats. */
  private recordParallelSolvedNodeStats(
    result: HdNodeResult,
    node: NodeWithPortPoints | undefined,
  ) {
    const solverNodeCount = this.stats.solverNodeCount as Record<
      string,
      number
    >
    solverNodeCount[result.solverType] =
      (solverNodeCount[result.solverType] ?? 0) + 1
    if (!node) return
    const pf = this.nodePfById.get(node.capacityMeshNodeId) ?? null
    if (pf !== null && pf > 0.05) {
      const difficultNodePfs = this.stats.difficultNodePfs as Record<
        string,
        number[]
      >
      if (!difficultNodePfs[result.solverType]) {
        difficultNodePfs[result.solverType] = []
      }
      difficultNodePfs[result.solverType].push(pf)
    }
  }

  /**
   * NODE-level parallel path (TS_PARALLEL_HD_NODES=N).
   *
   * Nodes are independent - each solver receives only its own port points plus
   * shared read-only context - so they can be solved concurrently in any order.
   * Keeps every worker fed and drains completed results each step.
   *
   * Any throw in this pump destroys the pool (a2Pool lifecycle pattern,
   * 36c8ce8f): an abandoned in-flight task can still write into its SAB at any
   * later time, so a pool that survived a throw must never be reused.
   */
  private parallelNodeStep(): void {
    try {
      if (!this.nodePool) {
        this.nodePool = getHdNodePool(this.resolveParallelWorkerCount(), {
          colorMap: this.colorMap,
          connMap: this.connMap,
          viaDiameter: this.viaDiameter,
          traceWidth: this.traceWidth,
          obstacleMargin: this.obstacleMargin,
          effort: this.effort,
          obstacles: this.obstacles,
          layerCount: this.layerCount,
          maxInnerIterationsPerGrowthAttempt:
            this.growShrinkMaxInnerIterationsPerGrowthAttempt,
          fallbackToInvalidGeometryOnFailure:
            this.growShrinkFallbackToInvalidGeometryOnFailure,
          useGrowShrink: this.useGrowShrinkHighDensityIntraNodeSolver,
        })
      }
      const pool = this.nodePool

      for (const result of pool.poll()) {
        const node = this.dispatchedNodes.get(result.nodeId)
        this.dispatchedNodes.delete(result.nodeId)
        if (result.solved) {
          const routes = result.routes as HighDensityIntraNodeRoute[]
          this.routes.push(
            ...(this.preserveTerminalPcbPortIds && node
              ? this.annotateRoutesWithTerminalPcbPortIds(node, routes)
              : routes),
          )
          this.solvedNodeIds.add(result.nodeId)
          this.recordParallelNodeSolveMetadata(result, node, "solved")
          this.recordParallelSolvedNodeStats(result, node)
        } else {
          // failedSolvers parity: the failing solver instance lives (and is
          // gone) inside the worker, so record a structural stand-in carrying
          // exactly the fields the failure path reads (nodeWithPortPoints for
          // the id list, error for err0). Cast reason: a real solver instance
          // cannot cross the worker boundary — never call solver methods on
          // this stand-in.
          const failedNode = node ?? {
            capacityMeshNodeId: result.nodeId,
            portPoints: [],
            center: { x: 0, y: 0 },
            width: 0,
            height: 0,
          }
          this.failedSolvers.push({
            nodeWithPortPoints: failedNode,
            error: result.error,
            iterations: result.iterations,
            solvedRoutes: [],
            failed: true,
            solved: false,
          } as unknown as HighDensityIntraNodeSolver)
          this.error ??= `Failed to solve node ${result.nodeId}: ${result.error}`
          this.recordParallelNodeSolveMetadata(result, node, "failed")
        }
        // recordResizeStats parity: the sequential path adds growthAttempts on
        // both the solved and failed branches (0 for non-GrowShrink nodes).
        this.stats.highDensityResizeCount =
          (this.stats.highDensityResizeCount ?? 0) + result.growthAttempts
        // updateCacheStats parity: the sequential path reads the MAIN-process
        // global cache counters, which worker solves never touch, so the
        // parallel path accumulates the per-task deltas reported by workers.
        // Not 1:1 comparable with sequential counters — each worker has a
        // private success-only cache, so cross-node reuse is per worker.
        this.stats.intraNodeCacheHits =
          (this.stats.intraNodeCacheHits ?? 0) + result.cacheHits
        this.stats.intraNodeCacheMisses =
          (this.stats.intraNodeCacheMisses ?? 0) + result.cacheMisses
      }

      while (this.unsolvedNodePortPoints.length > 0) {
        const next =
          this.unsolvedNodePortPoints[this.unsolvedNodePortPoints.length - 1]!
        if (!pool.tryDispatch(next)) break
        this.dispatchedNodes.set(next.capacityMeshNodeId, next)
        this.unsolvedNodePortPoints.pop()
      }

      // Nothing to hand out and nothing finished: wait on a worker rather than
      // spinning, so the pump does not exhaust MAX_ITERATIONS while workers run.
      if (pool.inFlight > 0 && this.unsolvedNodePortPoints.length === 0) {
        pool.waitForAny(20)
      } else if (pool.inFlight === pool.size) {
        pool.waitForAny(5)
      }

      if (this.unsolvedNodePortPoints.length === 0 && pool.inFlight === 0) {
        destroyHdNodePool()
        this.nodePool = null
        if (this.failedSolvers.length > 0) {
          this.failed = true
          // Same message shape as the sequential failure path.
          this.error = `Failed to solve ${this.failedSolvers.length} nodes, ${this.failedSolvers.slice(0, 5).map((fs) => fs.nodeWithPortPoints.capacityMeshNodeId)}. err0: ${this.failedSolvers[0]?.error}.`
          return
        }
        this.solved = true
      }
    } catch (err) {
      destroyHdNodePool()
      this.nodePool = null
      throw err
    }
  }

  /**
   * Each iteration, pop an unsolved node and attempt to find the routes inside
   * of it.
   */
  _step() {
    if (this.resolveParallelWorkerCount() > 0) {
      this.parallelNodeStep()
      return
    }
    if (this.activeSubSolver) {
      this.activeSubSolver.step()
      if (this.activeSubSolver.solved) {
        this.routes.push(
          ...(this.preserveTerminalPcbPortIds
            ? this.getSolvedRoutesWithTerminalPcbPortIds(this.activeSubSolver)
            : this.activeSubSolver.solvedRoutes),
        )
        this.recordNodeSolveMetadata(this.activeSubSolver, "solved")
        this.recordSolvedNodeStats(
          this.activeSubSolver,
          this.activeSubSolver.nodeWithPortPoints,
        )
        this.recordResizeStats(this.activeSubSolver)
        this.activeSubSolver = null
        this.updateCacheStats()
      } else if (this.activeSubSolver.failed) {
        this.recordNodeSolveMetadata(this.activeSubSolver, "failed")
        this.recordResizeStats(this.activeSubSolver)
        this.failedSolvers.push(this.activeSubSolver)
        this.activeSubSolver = null
        this.updateCacheStats()
      }
      return
    }
    if (this.unsolvedNodePortPoints.length === 0) {
      if (this.failedSolvers.length > 0) {
        this.solved = false
        this.failed = true
        // debugger
        this.error = `Failed to solve ${this.failedSolvers.length} nodes, ${this.failedSolvers.slice(0, 5).map((fs) => fs.nodeWithPortPoints.capacityMeshNodeId)}. err0: ${this.failedSolvers[0].error}.`
        this.updateCacheStats()
        return
      }

      this.solved = true
      this.updateCacheStats()
      return
    }
    const node = this.unsolvedNodePortPoints.pop()!

    const intraNodeSolverParams = {
      nodeWithPortPoints: node,
      colorMap: this.colorMap,
      connMap: this.connMap,
      viaDiameter: this.viaDiameter,
      traceWidth: this.traceWidth,
      obstacleMargin: this.obstacleMargin,
      effort: this.effort,
      obstacles: this.obstacles,
      layerCount: this.layerCount,
      maxInnerIterationsPerGrowthAttempt:
        this.growShrinkMaxInnerIterationsPerGrowthAttempt,
      fallbackToInvalidGeometryOnFailure:
        this.growShrinkFallbackToInvalidGeometryOnFailure,
    }
    this.activeSubSolver = this.useGrowShrinkHighDensityIntraNodeSolver
      ? new GrowShrinkHighDensityIntraNodeSolver(intraNodeSolverParams)
      : new PortfolioSingleIntraNodeSolver(intraNodeSolverParams)
    this.updateCacheStats()
  }

  private updateCacheStats() {
    const cacheProvider = getGlobalInMemoryCache()
    this.stats.intraNodeCacheHits = cacheProvider.cacheHits
    this.stats.intraNodeCacheMisses = cacheProvider.cacheMisses
  }

  visualize(): GraphicsObject {
    let graphics: GraphicsObject = {
      lines: [],
      points: [],
      rects: [],
      circles: [],
    }
    for (const route of this.routes) {
      // Merge segments based on z-coordinate
      const mergedSegments = mergeRouteSegments(
        route.route,
        route.connectionName,
        this.colorMap[route.connectionName],
      )

      // Add merged segments to graphics
      for (const segment of mergedSegments) {
        graphics.lines!.push({
          points: segment.points,
          label: connectionLabel(
            route.connectionName,
            route.rootConnectionName,
          ),
          strokeColor:
            segment.z === 0
              ? segment.color
              : safeTransparentize(segment.color, 0.5),
          layer: `z${segment.z}`,
          strokeWidth: route.traceThickness,
          strokeDash: segment.z !== 0 ? [0.1, 0.3] : undefined,
        })
      }
      for (const via of route.vias) {
        graphics.circles!.push({
          center: via,
          layer: "z0,1",
          radius: route.viaDiameter / 2,
          fill: this.colorMap[route.connectionName],
          label: connectionLabel(
            route.connectionName,
            route.rootConnectionName,
            ["via"],
          ),
        })
      }
    }
    if (this.solved || this.failed) {
      for (const [capacityMeshNodeId, metadata] of this.nodeSolveMetadataById) {
        const left = metadata.node.center.x - metadata.node.width / 2
        const right = metadata.node.center.x + metadata.node.width / 2
        const top = metadata.node.center.y - metadata.node.height / 2
        const bottom = metadata.node.center.y + metadata.node.height / 2

        const label = this.createNodeMarkerLabel(capacityMeshNodeId, metadata)
        const markerColor = metadata.status === "solved" ? "blue" : "red"

        graphics.lines!.push(
          {
            points: [
              { x: left, y: top },
              { x: right, y: top },
            ],
            layer: "hd_node_boundaries",
            strokeColor: markerColor,
            strokeDash: "6, 4",
            strokeWidth: 0.03,
            label,
          },
          {
            points: [
              { x: right, y: top },
              { x: right, y: bottom },
            ],
            layer: "hd_node_boundaries",
            strokeColor: markerColor,
            strokeDash: "6, 4",
            strokeWidth: 0.03,
            label,
          },
          {
            points: [
              { x: right, y: bottom },
              { x: left, y: bottom },
            ],
            layer: "hd_node_boundaries",
            strokeColor: markerColor,
            strokeDash: "6, 4",
            strokeWidth: 0.03,
            label,
          },
          {
            points: [
              { x: left, y: bottom },
              { x: left, y: top },
            ],
            layer: "hd_node_boundaries",
            strokeColor: markerColor,
            strokeDash: "6, 4",
            strokeWidth: 0.03,
            label,
          },
        )

        if (metadata.status === "solved") {
          graphics.points!.push({
            x: metadata.node.center.x,
            y: metadata.node.center.y,
            color: markerColor,
            layer: "hd_node_markers",
            label,
          })
        } else {
          graphics.lines!.push({
            points: [
              { x: 0, y: 0 },
              {
                x: metadata.node.center.x,
                y: metadata.node.center.y,
              },
            ],
            layer: "hd_failed_node_guides",
            strokeColor: "red",
            strokeDash: "8, 6",
            strokeWidth: 0.05,
            label,
          })
          const rectWidth = Math.max(metadata.node.width * 0.1, 0.12)
          const rectHeight = Math.max(metadata.node.height * 0.1, 0.12)
          graphics.rects!.push({
            center: metadata.node.center,
            layer: "hd_node_markers",
            width: rectWidth,
            height: rectHeight,
            fill: "red",
            label,
          })
        }
      }
    }
    if (this.activeSubSolver) {
      graphics = combineVisualizations(
        graphics,
        this.activeSubSolver.visualize(),
      )
    }
    return graphics
  }
}
