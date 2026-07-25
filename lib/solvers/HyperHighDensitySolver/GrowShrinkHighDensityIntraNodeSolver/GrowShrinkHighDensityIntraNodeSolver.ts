import type { GraphicsObject } from "graphics-debug"
import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
  PortPoint,
} from "lib/types/high-density-types"
import { BaseSolver } from "../../BaseSolver"

/** TS_SALVAGE_PARTIAL=1: route k-1 connections instead of surrendering a node. */
const SALVAGE_PARTIAL =
  typeof process !== "undefined" &&
  !!process.env.TS_SALVAGE_PARTIAL &&
  process.env.TS_SALVAGE_PARTIAL !== "0"
import { PortfolioSingleIntraNodeSolver } from "../PortfolioSingleIntraNodeSolver"
import {
  createInvalidDirectConnectionRoutes,
  createInvalidSameLayerCrossingRoutes,
  hasImpossibleSameLayerCrossingGeometry,
} from "./invalidSameLayerCrossingGeometry"

type PortfolioSingleIntraNodeSolverParams = ConstructorParameters<
  typeof PortfolioSingleIntraNodeSolver
>[0]

export const DEFAULT_MAX_GROWTH_ATTEMPTS = 3

export type GrowShrinkHighDensityIntraNodeSolverParams =
  PortfolioSingleIntraNodeSolverParams & {
    maxGrowthAttempts?: number
    maxInnerIterationsPerGrowthAttempt?: number
    fallbackToInvalidGeometryOnFailure?: boolean
  }

const scalePoint = <T extends { x: number; y: number }>(
  point: T,
  center: { x: number; y: number },
  scaleFactor: number,
): T => ({
  ...point,
  x: center.x + (point.x - center.x) * scaleFactor,
  y: center.y + (point.y - center.y) * scaleFactor,
})

const scalePortPoint = (
  portPoint: PortPoint,
  center: { x: number; y: number },
  scaleFactor: number,
): PortPoint => scalePoint(portPoint, center, scaleFactor)

const scaleNodeWithPortPoints = (
  node: NodeWithPortPoints,
  scaleFactor: number,
): NodeWithPortPoints => ({
  ...node,
  width: node.width * scaleFactor,
  height: node.height * scaleFactor,
  portPoints: node.portPoints.map((portPoint) =>
    scalePortPoint(portPoint, node.center, scaleFactor),
  ),
  portPointsInPairs: node.portPointsInPairs?.map(([start, end]) => [
    scalePortPoint(start, node.center, scaleFactor),
    scalePortPoint(end, node.center, scaleFactor),
  ]),
})

const scaleRoute = (
  route: HighDensityIntraNodeRoute,
  center: { x: number; y: number },
  scaleFactor: number,
): HighDensityIntraNodeRoute => ({
  ...route,
  route: route.route.map((point) => scalePoint(point, center, scaleFactor)),
  vias: route.vias.map((via) => scalePoint(via, center, scaleFactor)),
  jumpers: route.jumpers?.map((jumper) => ({
    ...jumper,
    start: scalePoint(jumper.start, center, scaleFactor),
    end: scalePoint(jumper.end, center, scaleFactor),
  })),
})

const routeColors = [
  "#dc2626",
  "#2563eb",
  "#16a34a",
  "#ca8a04",
  "#9333ea",
  "#0891b2",
]

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

export class GrowShrinkHighDensityIntraNodeSolver extends BaseSolver {
  override getSolverName(): string {
    return "GrowShrinkHighDensityIntraNodeSolver"
  }

  constructorParams: GrowShrinkHighDensityIntraNodeSolverParams
  nodeWithPortPoints: NodeWithPortPoints
  solvedRoutes: HighDensityIntraNodeRoute[] = []
  failedSolvers: PortfolioSingleIntraNodeSolver[] = []
  activeSubSolver: PortfolioSingleIntraNodeSolver | null = null
  winningSolver?: PortfolioSingleIntraNodeSolver
  scaleFactor = 1
  growthAttempts = 0
  maxGrowthAttempts: number

  constructor(params: GrowShrinkHighDensityIntraNodeSolverParams) {
    super()
    this.constructorParams = params
    this.nodeWithPortPoints = params.nodeWithPortPoints
    this.maxGrowthAttempts =
      params.maxGrowthAttempts ?? DEFAULT_MAX_GROWTH_ATTEMPTS
    this.MAX_ITERATIONS =
      20_000_000 * (params.effort ?? 1) * (this.maxGrowthAttempts + 1)

    if (hasImpossibleSameLayerCrossingGeometry(this.nodeWithPortPoints)) {
      this.solvedRoutes = createInvalidSameLayerCrossingRoutes(
        this.nodeWithPortPoints,
        params.traceWidth ?? 0.15,
        params.viaDiameter ?? 0.3,
      )
      this.solved = true
      this.progress = 1
      this.stats = {
        invalidGeometryFallback: true,
        reason: "single-layer node has same-layer crossings",
      }
    }
  }

  getConstructorParams() {
    return this.constructorParams
  }

  /**
   * Salvage a node that cannot be fully routed.
   *
   * The invalid-geometry fallback below emits straight-line routes for EVERY
   * connection in the node, and those become DRC errors downstream. But
   * experiments/drop-one.ts shows these nodes are over-committed rather than
   * unroutable: on srj18 sample 8, 40/40 captured failing-node instances became
   * routable when a single connection was removed (77% of individual removals
   * worked). So route k-1 connections properly and give only the dropped one
   * the invalid fallback, instead of surrendering all of them.
   */
  private tryPartialSalvage(): {
    routes: HighDensityIntraNodeRoute[]
    dropped: string
  } | null {
    const node = this.nodeWithPortPoints
    const connectionNames: string[] = []
    for (const portPoint of node.portPoints) {
      if (!connectionNames.includes(portPoint.connectionName)) {
        connectionNames.push(portPoint.connectionName)
      }
    }
    if (connectionNames.length < 2) return null

    const stepBudget = Number(process.env.TS_SALVAGE_STEPS ?? 200_000)
    for (const dropped of connectionNames) {
      const solver = new PortfolioSingleIntraNodeSolver({
        ...this.constructorParams,
        nodeWithPortPoints: {
          ...node,
          portPoints: node.portPoints.filter(
            (p) => p.connectionName !== dropped,
          ),
        },
      })
      let steps = 0
      while (!solver.solved && !solver.failed && steps < stepBudget) {
        solver.step()
        steps++
      }
      if (solver.solved) return { routes: solver.solvedRoutes, dropped }
    }
    return null
  }

  private createActiveSubSolver() {
    this.activeSubSolver = new PortfolioSingleIntraNodeSolver({
      ...this.constructorParams,
      nodeWithPortPoints: scaleNodeWithPortPoints(
        this.nodeWithPortPoints,
        this.scaleFactor,
      ),
    })
    if (this.constructorParams.maxInnerIterationsPerGrowthAttempt) {
      // Must be an external ceiling: the portfolio recomputes MAX_ITERATIONS
      // dynamically and would otherwise overwrite this immediately.
      this.activeSubSolver.externalMaxIterations =
        this.constructorParams.maxInnerIterationsPerGrowthAttempt
      this.activeSubSolver.MAX_ITERATIONS =
        this.constructorParams.maxInnerIterationsPerGrowthAttempt
    }
  }

  private acceptSolution(solver: PortfolioSingleIntraNodeSolver) {
    this.winningSolver = solver
    this.solvedRoutes =
      this.scaleFactor === 1
        ? solver.solvedRoutes
        : solver.solvedRoutes.map((route) =>
            scaleRoute(
              route,
              this.nodeWithPortPoints.center,
              1 / this.scaleFactor,
            ),
          )
    this.solved = true
    this.failed = false
  }

  computeProgress() {
    return Math.min(
      0.99,
      (this.growthAttempts + (this.activeSubSolver?.progress ?? 0)) /
        (this.maxGrowthAttempts + 1),
    )
  }

  _step() {
    if (!this.activeSubSolver) {
      this.createActiveSubSolver()
    }

    this.activeSubSolver!.step()

    if (this.activeSubSolver!.solved) {
      this.acceptSolution(this.activeSubSolver!)
      this.activeSubSolver = null
      return
    }

    if (!this.activeSubSolver!.failed) {
      return
    }

    this.failedSolvers.push(this.activeSubSolver!)
    this.error = this.activeSubSolver!.error
    this.activeSubSolver = null

    if (this.growthAttempts >= this.maxGrowthAttempts) {
      if (this.constructorParams.fallbackToInvalidGeometryOnFailure) {
        const traceWidth = this.constructorParams.traceWidth ?? 0.15
        const viaDiameter = this.constructorParams.viaDiameter ?? 0.3
        if (process.env.TS_SALVAGE_TRACE) {
          const g = globalThis as any
          g.__salvage ??= { fallbackHits: 0, salvaged: 0, failedSalvage: 0 }
          g.__salvage.fallbackHits++
        }
        const salvage = SALVAGE_PARTIAL ? this.tryPartialSalvage() : null
        if (process.env.TS_SALVAGE_TRACE) {
          const g = globalThis as any
          if (salvage) g.__salvage.salvaged++
          else g.__salvage.failedSalvage++
        }
        if (salvage) {
          // Every connection still gets a route (the stitcher requires it),
          // but only the dropped one is invalid geometry.
          const droppedNode = {
            ...this.nodeWithPortPoints,
            portPoints: this.nodeWithPortPoints.portPoints.filter(
              (p) => p.connectionName === salvage.dropped,
            ),
          }
          this.solvedRoutes = [
            ...salvage.routes,
            ...createInvalidDirectConnectionRoutes(
              droppedNode,
              traceWidth,
              viaDiameter,
            ),
          ]
          this.stats = {
            ...this.stats,
            invalidGeometryFallback: true,
            partialSalvage: true,
            salvagedConnections: salvage.routes.length,
            droppedConnection: salvage.dropped,
            reason: "growth attempts exhausted (partially salvaged)",
            lastError: this.error,
          }
        } else {
          this.solvedRoutes = createInvalidDirectConnectionRoutes(
            this.nodeWithPortPoints,
            traceWidth,
            viaDiameter,
          )
          this.stats = {
            ...this.stats,
            invalidGeometryFallback: true,
            reason: "growth attempts exhausted",
            lastError: this.error,
          }
        }
        this.solved = true
        this.failed = false
        this.progress = 1
        this.error = null
        return
      }

      this.failed = true
      this.error = `GrowShrinkHighDensityIntraNodeSolver failed after resizing to ${this.scaleFactor}x. Last error: ${this.error}`
      return
    }

    this.growthAttempts++
    this.scaleFactor *= 2
  }

  visualize(): GraphicsObject {
    const delegatedVisualization =
      this.activeSubSolver?.visualize() ?? this.winningSolver?.visualize()
    if (delegatedVisualization) return delegatedVisualization

    if (this.solvedRoutes.length > 0) {
      return {
        title: this.stats.invalidGeometryFallback
          ? "Invalid same-layer crossing geometry"
          : "Grow/shrink high density routes",
        lines: this.solvedRoutes.flatMap((route, routeIndex) =>
          route.route.slice(0, -1).map((point, pointIndex) => {
            const nextPoint = route.route[pointIndex + 1]
            return {
              points: [point, nextPoint],
              strokeColor: routeColors[routeIndex % routeColors.length],
              strokeWidth: route.traceThickness,
              layer: `z${point.z}`,
              label: connectionLabel(
                route.connectionName,
                route.rootConnectionName,
                [
                  `z${point.z}`,
                  this.stats.invalidGeometryFallback
                    ? "invalid fallback route"
                    : undefined,
                ].filter(Boolean) as string[],
              ),
            }
          }),
        ),
        points: this.nodeWithPortPoints.portPoints.map((point) => ({
          x: point.x,
          y: point.y,
          color:
            routeColors[
              Math.max(
                0,
                this.solvedRoutes.findIndex(
                  (route) => route.connectionName === point.connectionName,
                ),
              ) % routeColors.length
            ],
          label: connectionLabel(
            point.connectionName,
            point.rootConnectionName,
            [`z${point.z}`],
          ),
        })),
        rects: [
          {
            center: this.nodeWithPortPoints.center,
            width: this.nodeWithPortPoints.width,
            height: this.nodeWithPortPoints.height,
            fill: this.stats.invalidGeometryFallback
              ? "rgba(245, 158, 11, 0.12)"
              : "rgba(14, 165, 233, 0.08)",
            stroke: this.stats.invalidGeometryFallback
              ? "rgba(217, 119, 6, 0.8)"
              : "rgba(14, 165, 233, 0.55)",
            label: [
              this.nodeWithPortPoints.capacityMeshNodeId,
              this.stats.reason,
            ]
              .filter(Boolean)
              .join("\n"),
          },
        ],
        circles: [],
      }
    }

    return (
      delegatedVisualization ?? {
        lines: [],
        points: [],
        rects: [],
        circles: [],
      }
    )
  }
}
