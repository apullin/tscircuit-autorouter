import { BaseSolver } from "../BaseSolver"
import { HighDensityRoute } from "lib/types/high-density-types"
import { Obstacle } from "lib/types"
import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import { UselessViaRemovalSolver } from "lib/solvers/UselessViaRemovalSolver/UselessViaRemovalSolver"
import { MultiSimplifiedPathSolver } from "lib/solvers/SimplifiedPathSolver/MultiSimplifiedPathSolver"
import { SameNetViaMergerSolver } from "lib/solvers/SameNetViaMergerSolver/SameNetViaMergerSolver"
import { GraphicsObject } from "graphics-debug"
import { getJumpersGraphics } from "lib/utils/getJumperGraphics"
import { createObjectsWithZLayers } from "lib/utils/createObjectsWithZLayers"

type Phase = "via_removal" | "via_merging" | "path_simplification"

const VIA_INSIDE_OBSTACLE_TOLERANCE = 1e-6

const pointInsideObstacle = (
  point: { x: number; y: number },
  obstacle: Obstacle,
) =>
  Math.abs(point.x - obstacle.center.x) <=
    obstacle.width / 2 + VIA_INSIDE_OBSTACLE_TOLERANCE &&
  Math.abs(point.y - obstacle.center.y) <=
    obstacle.height / 2 + VIA_INSIDE_OBSTACLE_TOLERANCE

const isMultilayerObstacle = (obstacle: Obstacle) =>
  (obstacle.__zLayers?.length ?? obstacle.layers?.length ?? 0) > 1

interface RouteFootprint {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

/**
 * One-sided expansion applied to each route footprint when testing for
 * geometric interaction. SingleSimplifiedPathSolver5's widest filter margin
 * is OBSTACLE_MARGIN + TRACE_THICKNESS = 0.25 measured from one route's
 * bounds; expanding BOTH footprints by 0.25 over-covers it.
 */
const DIRTY_INTERACTION_MARGIN = 0.25

/** Covers half the largest jumper pad extent (1206: 3.2mm long). */
const DIRTY_JUMPER_PAD_ALLOWANCE = 2

const computeRouteFootprint = (route: HighDensityRoute): RouteFootprint => {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of route.route) {
    if (point.x < minX) minX = point.x
    if (point.x > maxX) maxX = point.x
    if (point.y < minY) minY = point.y
    if (point.y > maxY) maxY = point.y
  }
  const viaRadius = route.viaDiameter / 2
  for (const via of route.vias) {
    if (via.x - viaRadius < minX) minX = via.x - viaRadius
    if (via.x + viaRadius > maxX) maxX = via.x + viaRadius
    if (via.y - viaRadius < minY) minY = via.y - viaRadius
    if (via.y + viaRadius > maxY) maxY = via.y + viaRadius
  }
  for (const jumper of route.jumpers ?? []) {
    for (const pad of [jumper.start, jumper.end]) {
      if (pad.x - DIRTY_JUMPER_PAD_ALLOWANCE < minX)
        minX = pad.x - DIRTY_JUMPER_PAD_ALLOWANCE
      if (pad.x + DIRTY_JUMPER_PAD_ALLOWANCE > maxX)
        maxX = pad.x + DIRTY_JUMPER_PAD_ALLOWANCE
      if (pad.y - DIRTY_JUMPER_PAD_ALLOWANCE < minY)
        minY = pad.y - DIRTY_JUMPER_PAD_ALLOWANCE
      if (pad.y + DIRTY_JUMPER_PAD_ALLOWANCE > maxY)
        maxY = pad.y + DIRTY_JUMPER_PAD_ALLOWANCE
    }
  }
  return {
    minX: minX - DIRTY_INTERACTION_MARGIN,
    minY: minY - DIRTY_INTERACTION_MARGIN,
    maxX: maxX + DIRTY_INTERACTION_MARGIN,
    maxY: maxY + DIRTY_INTERACTION_MARGIN,
  }
}

const footprintsOverlap = (a: RouteFootprint, b: RouteFootprint) =>
  a.minX <= b.maxX && b.minX <= a.maxX && a.minY <= b.maxY && b.minY <= a.maxY

/** Canonical value signature of a route's geometry. */
const computeRouteSignature = (route: HighDensityRoute): string =>
  JSON.stringify([route.route, route.vias, route.jumpers ?? null])

/**
 * TraceSimplificationSolver consolidates trace optimization by iteratively applying
 * via removal, via merging, and path simplification phases. It reduces redundant vias
 * and simplifies routing paths through configurable iterations.
 *
 * The solver operates in three alternating phases per iteration:
 * 1. "via_removal" - Removes unnecessary vias from routes using UselessViaRemovalSolver
 * 2. "via_merging" - Merges redundant vias on the same net using SameNetViaMergerSolver
 * 3. "path_simplification" - Simplifies routing paths using MultiSimplifiedPathSolver
 *
 * Each iteration consists of all phases executed sequentially.
 */
export class TraceSimplificationSolver extends BaseSolver {
  override getSolverName(): string {
    return "TraceSimplificationSolver"
  }

  hdRoutes: HighDensityRoute[] = []

  /**
   * Obstacles pre-filtered to multilayer ones, computed once at
   * construction. isMultilayerObstacle is a pure function of the obstacle
   * and every consumer below requires it, so this order-preserving filter
   * cannot change find/some results.
   */
  private multilayerObstacles: Obstacle[]

  simplificationPipelineLoops = 0

  MAX_SIMPLIFICATION_PIPELINE_LOOPS: number = 2

  PHASE_ORDER: Phase[] = ["via_removal", "via_merging", "path_simplification"]

  currentPhase: Phase = "via_removal"

  /** Callback to extract results from the active sub-solver */
  extractResult: ((solver: BaseSolver) => HighDensityRoute[]) | null = null

  /**
   * Dirty tracking across the outer loops (TS_SIMP_DIRTY=1, default OFF).
   *
   * When enabled, the second (and any later) path_simplification pass skips
   * routes that did not change since the previous path_simplification pass
   * and do not geometrically interact — by conservatively expanded bounding
   * boxes, propagated transitively — with any route that did change.
   *
   * This is NOT result-identical, which is why it defaults off. Measured on
   * srj18 sample 8 (TS_BENCHMARK=1): loop-2 via_removal changed 3/361 routes
   * and via_merging 0/361, yet the baseline's loop-2 path_simplification
   * still changed 247/361 routes. Re-simplification is not idempotent: in
   * pass 1 each route sees the routes after it in raw (pre-simplification)
   * form, in pass 2 it sees them simplified, and the head/tail walk finds
   * further shortcuts on its own output. Skipping an "unchanged" route
   * therefore freezes geometry the baseline would keep improving; the output
   * stays DRC-valid but is not byte-identical.
   */
  private readonly dirtyTrackingEnabled = process.env.TS_SIMP_DIRTY === "1"

  /** Per-connection route signatures after the last path_simplification pass. */
  private lastSimplifiedSignatures: Map<string, string> | null = null

  /** Per-connection route footprints after the last path_simplification pass. */
  private lastSimplifiedFootprints: Map<string, RouteFootprint> | null = null

  /** Returns the simplified routes. This is the primary output of the solver. */
  get simplifiedHdRoutes(): HighDensityRoute[] {
    return this.hdRoutes
  }

  /**
   * Creates a new TraceSimplificationSolver
   * @param simplificationConfig Configuration object containing:
   *   - hdRoutes: Initial high-density routes to simplify
   *   - obstacles: Board obstacles to avoid during simplification
   *   - connMap: Connectivity map for routing validation
   *   - colorMap: Mapping of net names to colors for visualization
   *   - outline: Optional board outline boundary
   *   - defaultViaDiameter: Default diameter for vias
   *   - layerCount: Number of routing layers
   *   - minTraceToPadEdgeClearance: Minimum trace-edge clearance to pads/vias
   *   - iterations: Number of complete simplification iterations (default: 2)
   */
  constructor(
    private readonly simplificationConfig: {
      readonly hdRoutes: ReadonlyArray<HighDensityRoute>
      readonly obstacles: ReadonlyArray<Obstacle>
      readonly connMap: ConnectivityMap
      readonly colorMap: Readonly<Record<string, string>>
      readonly outline?: ReadonlyArray<{ x: number; y: number }>
      readonly defaultViaDiameter: number
      readonly layerCount: number
      readonly minTraceToPadEdgeClearance?: number
    },
  ) {
    super()
    this.simplificationConfig = {
      ...simplificationConfig,
      obstacles: createObjectsWithZLayers(
        simplificationConfig.obstacles,
        simplificationConfig.layerCount,
      ),
    }
    this.multilayerObstacles = this.simplificationConfig.obstacles.filter(
      isMultilayerObstacle,
    )
    this.hdRoutes = this.markThroughObstacleSegments(
      simplificationConfig.hdRoutes,
    )
    this.MAX_ITERATIONS = 100e6
  }

  private isSameNetObstacle(route: HighDensityRoute, obstacle: Obstacle) {
    const { connMap } = this.simplificationConfig
    const connectionName = route.connectionName
    const rootConnectionName = route.rootConnectionName
    // Hoist the route-side net lookups out of the connectedTo loop: they are
    // invariant per (route, obstacle) pair. The checks below mirror
    // connMap.areIdsConnected semantics exactly: id1 === id2 is connected; a
    // falsy net on either side is not connected; otherwise
    // net1 === net2 || net2 === id1.
    const connectionNetId = connMap.getNetConnectedToId(connectionName)
    const rootNetId =
      rootConnectionName !== undefined
        ? connMap.getNetConnectedToId(rootConnectionName)
        : undefined
    const connectedTo = obstacle.connectedTo
    for (let i = 0; i < connectedTo.length; i++) {
      const connectedId = connectedTo[i]!
      if (
        connectedId === connectionName ||
        connectedId === rootConnectionName
      ) {
        return true
      }
      if (!connectionNetId && !rootNetId) continue
      const connectedNetId = connMap.getNetConnectedToId(connectedId)
      if (!connectedNetId) continue
      if (
        connectionNetId &&
        (connectionNetId === connectedNetId ||
          connectedNetId === connectionName)
      ) {
        return true
      }
      if (
        rootConnectionName !== undefined &&
        rootNetId &&
        (rootNetId === connectedNetId || connectedNetId === rootConnectionName)
      ) {
        return true
      }
    }
    return false
  }

  private getSameNetObstacleForSegment(
    sameNetObstacles: ReadonlyArray<Obstacle>,
    start: { x: number; y: number },
    end: { x: number; y: number },
  ) {
    for (let i = 0; i < sameNetObstacles.length; i++) {
      const obstacle = sameNetObstacles[i]!
      if (
        pointInsideObstacle(start, obstacle) &&
        pointInsideObstacle(end, obstacle)
      ) {
        return obstacle
      }
    }
    return undefined
  }

  private isViaInsideSameNetObstacle(
    sameNetObstacles: ReadonlyArray<Obstacle>,
    via: { x: number; y: number },
  ) {
    for (let i = 0; i < sameNetObstacles.length; i++) {
      if (pointInsideObstacle(via, sameNetObstacles[i]!)) return true
    }
    return false
  }

  markThroughObstacleSegments(
    routes: ReadonlyArray<HighDensityRoute>,
  ): HighDensityRoute[] {
    return routes.map((route) => {
      // Resolve the same-net multilayer obstacles once per route: route
      // connection names and obstacle nets are invariant across the route's
      // segments and vias. Order is preserved, so find/some semantics are
      // unchanged.
      const sameNetObstacles = this.multilayerObstacles.filter((obstacle) =>
        this.isSameNetObstacle(route, obstacle),
      )
      return {
        ...route,
        route: route.route.map((point, index, points) => {
          const nextPoint = points[index + 1]
          if (
            nextPoint &&
            point.z !== nextPoint.z &&
            this.getSameNetObstacleForSegment(
              sameNetObstacles,
              point,
              nextPoint,
            )
          ) {
            return {
              ...point,
              toNextSegmentType: "through_obstacle" as const,
            }
          }

          return { ...point }
        }),
        vias: route.vias.filter(
          (via) => !this.isViaInsideSameNetObstacle(sameNetObstacles, via),
        ),
      }
    })
  }

  /**
   * Indices into hdRoutes that are safe to skip under the dirty-tracking
   * policy (see dirtyTrackingEnabled), or undefined when everything must be
   * processed (first pass, or tracking disabled).
   */
  private computeCleanRouteIndices(): Set<number> | undefined {
    const lastSignatures = this.lastSimplifiedSignatures
    const lastFootprints = this.lastSimplifiedFootprints
    if (!lastSignatures || !lastFootprints) return undefined

    const n = this.hdRoutes.length
    const footprints = this.hdRoutes.map(computeRouteFootprint)
    const dirty: boolean[] = new Array(n).fill(false)

    // Seed: routes whose geometry changed since the last simplification pass
    // (via removal / merging touched them), plus routes we have no record of.
    const seenConnections = new Set<string>()
    for (let i = 0; i < n; i++) {
      const route = this.hdRoutes[i]
      seenConnections.add(route.connectionName)
      const lastSignature = lastSignatures.get(route.connectionName)
      if (
        lastSignature === undefined ||
        lastSignature !== computeRouteSignature(route)
      ) {
        dirty[i] = true
      }
    }

    // Routes that disappeared since the last pass leave a changed region.
    for (const [connectionName, footprint] of lastFootprints) {
      if (seenConnections.has(connectionName)) continue
      for (let i = 0; i < n; i++) {
        if (!dirty[i] && footprintsOverlap(footprint, footprints[i])) {
          dirty[i] = true
        }
      }
    }

    // Conservative closure: dirtiness spreads through geometric interaction.
    // A dirty route may be re-simplified into new geometry, so neighbors of
    // both its current footprint and its last-recorded footprint are dirty.
    let spread = true
    while (spread) {
      spread = false
      for (let i = 0; i < n; i++) {
        if (!dirty[i]) continue
        const oldFootprint = lastFootprints.get(
          this.hdRoutes[i].connectionName,
        )
        for (let j = 0; j < n; j++) {
          if (dirty[j] || j === i) continue
          if (
            footprintsOverlap(footprints[i], footprints[j]) ||
            (oldFootprint && footprintsOverlap(oldFootprint, footprints[j]))
          ) {
            dirty[j] = true
            spread = true
          }
        }
      }
    }

    const clean = new Set<number>()
    for (let i = 0; i < n; i++) {
      if (!dirty[i]) clean.add(i)
    }
    if (process.env.TS_SIMP_DIAG) {
      let seedCount = 0
      for (let i = 0; i < n; i++) {
        const route = this.hdRoutes[i]
        const lastSignature = lastSignatures.get(route.connectionName)
        if (
          lastSignature === undefined ||
          lastSignature !== computeRouteSignature(route)
        )
          seedCount++
      }
      console.error(
        `[dirty-diag] seeds=${seedCount}/${n} clean=${clean.size}/${n}`,
      )
    }
    return clean
  }

  /** Records post-pass route state for the next pass's dirty computation. */
  private recordSimplifiedRouteState() {
    const signatures = new Map<string, string>()
    const footprints = new Map<string, RouteFootprint>()
    for (const route of this.hdRoutes) {
      signatures.set(route.connectionName, computeRouteSignature(route))
      footprints.set(route.connectionName, computeRouteFootprint(route))
    }
    this.lastSimplifiedSignatures = signatures
    this.lastSimplifiedFootprints = footprints
  }

  _step() {
    if (
      this.simplificationPipelineLoops >= this.MAX_SIMPLIFICATION_PIPELINE_LOOPS
    ) {
      this.solved = true
      return
    }

    // If we have an active sub-solver, let it run
    if (this.activeSubSolver) {
      this.activeSubSolver.step()

      if (!this.activeSubSolver.failed && !this.activeSubSolver.solved) {
        return
      }

      if (this.activeSubSolver.solved) {
        // Capture output using the registered callback
        if (this.extractResult) {
          this.hdRoutes = this.markThroughObstacleSegments(
            this.extractResult(this.activeSubSolver),
          )
        }

        if (
          this.dirtyTrackingEnabled &&
          this.currentPhase === "path_simplification"
        ) {
          const skipped = (this.activeSubSolver as MultiSimplifiedPathSolver)
            .stats?.dirtySkippedRoutes
          this.stats.dirtySkippedRoutesByPass = [
            ...((this.stats.dirtySkippedRoutesByPass as number[]) ?? []),
            (skipped as number) ?? 0,
          ]
          this.recordSimplifiedRouteState()
        }

        // Clear activeSubSolver
        this.activeSubSolver = null
        this.extractResult = null

        // Advance phase
        if (this.currentPhase === "via_removal") {
          this.currentPhase = "via_merging"
        } else if (this.currentPhase === "via_merging") {
          this.currentPhase = "path_simplification"
        } else {
          this.currentPhase = "via_removal"
          this.simplificationPipelineLoops++
        }

        // Check if all iterations are complete
        if (
          this.simplificationPipelineLoops >=
          this.MAX_SIMPLIFICATION_PIPELINE_LOOPS
        ) {
          this.solved = true
          return
        }
      } else if (this.activeSubSolver.failed) {
        this.failed = true
        this.error =
          this.activeSubSolver.error ??
          "Sub-solver failed without error message"
        return
      }
    }

    // No active sub-solver, start the next one
    if (!this.activeSubSolver && !this.solved) {
      switch (this.currentPhase) {
        case "via_removal":
          this.activeSubSolver = new UselessViaRemovalSolver({
            unsimplifiedHdRoutes: this.hdRoutes,
            obstacles: [...this.simplificationConfig.obstacles],
            colorMap: { ...this.simplificationConfig.colorMap },
            layerCount: this.simplificationConfig.layerCount,
            connMap: this.simplificationConfig.connMap,
            outline: this.simplificationConfig.outline
              ? [...this.simplificationConfig.outline]
              : undefined,
            geometryShortcutTraceMargin: 0.1,
            geometryShortcutObstacleMargin:
              this.simplificationConfig.minTraceToPadEdgeClearance ?? 0.15,
            // Delay the quadratic anchor search until the first path pass has
            // reduced the route point count.
            enableGeometryShortcuts: this.simplificationPipelineLoops > 0,
          })
          this.extractResult = (s) =>
            (s as UselessViaRemovalSolver).getOptimizedHdRoutes() ?? []
          break

        case "via_merging":
          this.activeSubSolver = new SameNetViaMergerSolver({
            inputHdRoutes: this.hdRoutes,
            obstacles: [...this.simplificationConfig.obstacles],
            colorMap: { ...this.simplificationConfig.colorMap },
            layerCount: this.simplificationConfig.layerCount,
            connMap: this.simplificationConfig.connMap,
            outline: this.simplificationConfig.outline
              ? [...this.simplificationConfig.outline]
              : undefined,
          })
          this.extractResult = (s) =>
            (s as SameNetViaMergerSolver).getMergedViaHdRoutes() ?? []
          break

        case "path_simplification":
          this.activeSubSolver = new MultiSimplifiedPathSolver({
            unsimplifiedHdRoutes: this.hdRoutes,
            obstacles: [...this.simplificationConfig.obstacles],
            connMap: this.simplificationConfig.connMap,
            colorMap: { ...this.simplificationConfig.colorMap },
            outline: this.simplificationConfig.outline
              ? [...this.simplificationConfig.outline]
              : undefined,
            defaultViaDiameter: this.simplificationConfig.defaultViaDiameter,
            cleanRouteIndices: this.dirtyTrackingEnabled
              ? this.computeCleanRouteIndices()
              : undefined,
          })
          this.extractResult = (s) =>
            (s as MultiSimplifiedPathSolver).simplifiedHdRoutes
          break

        default:
          this.failed = true
          this.error = `Unknown phase: ${this.currentPhase}`
          break
      }
    }
  }

  visualize(): GraphicsObject {
    if (this.activeSubSolver) {
      return this.activeSubSolver.visualize()
    }

    const visualization: GraphicsObject & {
      lines: NonNullable<GraphicsObject["lines"]>
      points: NonNullable<GraphicsObject["points"]>
      rects: NonNullable<GraphicsObject["rects"]>
      circles: NonNullable<GraphicsObject["circles"]>
    } = {
      lines: [],
      points: [],
      rects: [],
      circles: [],
      coordinateSystem: "cartesian",
      title: "Trace Simplification Solver",
    }

    // Visualize obstacles
    for (const obstacle of this.simplificationConfig.obstacles) {
      let fillColor = "rgba(128, 128, 128, 0.2)"
      const isOnLayer0 = obstacle.__zLayers?.includes(0)
      const isOnLayer1 = obstacle.__zLayers?.includes(1)

      if (isOnLayer0 && isOnLayer1) {
        fillColor = "rgba(128, 0, 128, 0.2)"
      } else if (isOnLayer0) {
        fillColor = "rgba(255, 0, 0, 0.2)"
      } else if (isOnLayer1) {
        fillColor = "rgba(0, 0, 255, 0.2)"
      }

      visualization.rects.push({
        center: obstacle.center,
        width: obstacle.width,
        height: obstacle.height,
        fill: fillColor,
        label: `Obstacle (Z: ${obstacle.__zLayers?.join(", ")})`,
      })
    }

    // Draw output routes and vias
    for (const route of this.hdRoutes) {
      if (route.route.length === 0) continue

      // Draw lines connecting route points on the same layer
      for (let i = 0; i < route.route.length - 1; i++) {
        const current = route.route[i]
        const next = route.route[i + 1]

        if (current.z === next.z) {
          visualization.lines.push({
            points: [
              { x: current.x, y: current.y },
              { x: next.x, y: next.y },
            ],
            strokeColor: current.z === 0 ? "red" : "blue",
            strokeWidth: route.traceThickness,
            label: `${route.connectionName} (z=${current.z})`,
          })
        }
      }

      // Draw circles for vias
      for (const via of route.vias) {
        visualization.circles.push({
          center: { x: via.x, y: via.y },
          radius: route.viaDiameter / 2,
          fill: "rgba(255, 0, 255, 0.5)",
          label: `${route.connectionName} via`,
        })
      }

      // Draw jumpers
      if (route.jumpers && route.jumpers.length > 0) {
        const jumperGraphics = getJumpersGraphics(route.jumpers, {
          color: "orange",
          label: route.connectionName,
        })
        visualization.rects.push(...(jumperGraphics.rects ?? []))
        visualization.lines.push(...(jumperGraphics.lines ?? []))
      }
    }

    return visualization
  }
}
