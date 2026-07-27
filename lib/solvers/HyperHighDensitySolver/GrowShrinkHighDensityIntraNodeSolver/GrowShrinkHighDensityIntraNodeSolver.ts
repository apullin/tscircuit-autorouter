import type { GraphicsObject } from "graphics-debug"
import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
  PortPoint,
} from "lib/types/high-density-types"
import { BaseSolver } from "../../BaseSolver"
import { PortfolioSingleIntraNodeSolver } from "../PortfolioSingleIntraNodeSolver"
import {
  createInvalidDirectConnectionRoutes,
  createInvalidSameLayerCrossingRoutes,
  hasImpossibleSameLayerCrossingGeometry,
} from "./invalidSameLayerCrossingGeometry"

type PortfolioSingleIntraNodeSolverParams = ConstructorParameters<
  typeof PortfolioSingleIntraNodeSolver
>[0]

/** TS_MAX_GROWTH_ATTEMPTS: optional override of the growth-attempt cap (default 3).
 * Needed to make a 4th TS_GROWTH_SCHEDULE rung reachable. Unset = upstream. */
export const DEFAULT_MAX_GROWTH_ATTEMPTS =
  typeof process !== "undefined" &&
  process.env.TS_MAX_GROWTH_ATTEMPTS &&
  Number.isFinite(Number(process.env.TS_MAX_GROWTH_ATTEMPTS))
    ? Number(process.env.TS_MAX_GROWTH_ATTEMPTS)
    : 3

/**
 * TS_GROWTH_SCHEDULE: optional comma-separated absolute scale factors tried in
 * order (e.g. "1.2,2,4,8"), falling back to doubling past the end. Unset =
 * upstream behavior (scaleFactor *= 2, i.e. 2, 4, 8).
 *
 * Growth relaxes clearance by exactly the scale factor: the inner solver keeps
 * centres >= traceWidth + obstacleMargin (0.30mm) apart at scale s, and
 * scaleRoute() shrinks that to 0.30/s while trace width stays 0.15mm, giving a
 * gap of 0.30/s - 0.15. DRC's 0.1mm minimum therefore holds only for s <= 1.2,
 * so every upstream rung is illegal by construction; "1.2,2,4,8" leads with
 * the one legal rung and keeps the relaxed ones as backstop. NOTE: rungs
 * beyond maxGrowthAttempts (default 3) are unreachable — "1.2,2,4,8" is
 * effectively 1.2 -> 2 -> 4 unless maxGrowthAttempts is raised.
 */
const GROWTH_SCHEDULE: number[] | null = (() => {
  if (typeof process === "undefined" || !process.env.TS_GROWTH_SCHEDULE) {
    return null
  }
  const rungs = process.env.TS_GROWTH_SCHEDULE.split(",")
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 1)
  return rungs.length > 0 ? rungs : null
})()

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
      // dynamically on its first step and would otherwise discard this.
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
        this.solvedRoutes = createInvalidDirectConnectionRoutes(
          this.nodeWithPortPoints,
          this.constructorParams.traceWidth ?? 0.15,
          this.constructorParams.viaDiameter ?? 0.3,
        )
        this.solved = true
        this.failed = false
        this.progress = 1
        this.stats = {
          ...this.stats,
          invalidGeometryFallback: true,
          reason: "growth attempts exhausted",
          lastError: this.error,
        }
        this.error = null
        return
      }

      this.failed = true
      this.error = `GrowShrinkHighDensityIntraNodeSolver failed after resizing to ${this.scaleFactor}x. Last error: ${this.error}`
      return
    }

    if (GROWTH_SCHEDULE) {
      this.scaleFactor =
        GROWTH_SCHEDULE[this.growthAttempts] ?? this.scaleFactor * 2
    } else {
      this.scaleFactor *= 2
    }
    this.growthAttempts++
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
