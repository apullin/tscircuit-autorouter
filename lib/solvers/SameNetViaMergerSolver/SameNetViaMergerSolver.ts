import { ObstacleSpatialHashIndex } from "lib/data-structures/ObstacleTree"
import { BaseSolver } from "../BaseSolver"
import {
  HighDensityIntraNodeRoute,
  HighDensityRoute,
} from "lib/types/high-density-types"
import { Obstacle } from "lib/types"
import type { GraphicsObject } from "graphics-debug"
import { HighDensityRouteSpatialIndex } from "lib/data-structures/HighDensityRouteSpatialIndex"
import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import { createObjectsWithZLayers } from "lib/utils/createObjectsWithZLayers"
import { segmentToBoxMinDistance } from "@tscircuit/math-utils"
import {
  type SameNetViaMerge,
  visualizeSameNetViaMerger,
} from "./visualize-same-net-via-merger"

export interface SameNetViaMergerSolverInput {
  inputHdRoutes: HighDensityRoute[]
  obstacles: Obstacle[]
  colorMap: Record<string, string>
  layerCount: number
  connMap: ConnectivityMap
  outline?: Array<{ x: number; y: number }>
}

type Via = {
  x: number
  y: number
  diameter: number
  net: string
  routeIndex: number
  layers: number[]
}

const NEAR_VIA_MERGE_DISTANCE_MULTIPLIER = 2.5
const OBSTACLE_MARGIN = 0.1

const getNetForRoute = (
  connMap: ConnectivityMap,
  route: HighDensityRoute,
): string => {
  const net = connMap.idToNetMap[route.connectionName]
  if (!net) {
    throw new Error(
      `SameNetViaMergerSolver could not find net for route "${route.connectionName}"`,
    )
  }

  return net
}

const obstacleIsSameNet = (
  connMap: ConnectivityMap,
  obstacle: Obstacle,
  via: Via,
): boolean => {
  for (const connectedId of obstacle.connectedTo) {
    if (connectedId === via.net) return true
    if (connMap.idToNetMap[connectedId] === via.net) return true
    if (connMap.areIdsConnected(connectedId, via.net)) return true
  }

  return false
}

const canMoveViaTo = (
  viaToRemove: Via,
  viaKeep: Via,
  context: {
    connMap: ConnectivityMap
    mergedViaHdRoutes: HighDensityRoute[]
    hdRouteSHI: HighDensityRouteSpatialIndex
    obstacleSHI: ObstacleSpatialHashIndex
  },
): boolean => {
  const route = context.mergedViaHdRoutes[viaToRemove.routeIndex]
  if (!route) {
    throw new Error(
      `SameNetViaMergerSolver could not find route for via at index ${viaToRemove.routeIndex}`,
    )
  }

  const transitionLayers = new Set<number>()
  for (let i = 1; i < route.route.length; i++) {
    const prev = route.route[i - 1]
    const curr = route.route[i]
    if (prev.z === curr.z) continue
    if (prev.x !== viaToRemove.x || prev.y !== viaToRemove.y) continue
    if (curr.x !== viaToRemove.x || curr.y !== viaToRemove.y) continue

    transitionLayers.add(prev.z)
    transitionLayers.add(curr.z)
  }

  if (transitionLayers.size === 0) {
    throw new Error(
      `SameNetViaMergerSolver could not find transition layers for via at (${viaToRemove.x}, ${viaToRemove.y})`,
    )
  }

  for (const z of transitionLayers) {
    const traceThickness = route.traceThickness
    const start = { x: viaToRemove.x, y: viaToRemove.y, z }
    const end = { x: viaKeep.x, y: viaKeep.y, z }

    if (start.x === end.x && start.y === end.y) continue

    const conflictingRoutes = context.hdRouteSHI.getConflictingRoutesForSegment(
      start,
      end,
      traceThickness / 2,
    )

    for (const { conflictingRoute, distance } of conflictingRoutes) {
      if (conflictingRoute.connectionName === route.connectionName) continue
      if (getNetForRoute(context.connMap, conflictingRoute) === viaToRemove.net)
        continue

      const minDistance =
        traceThickness / 2 + conflictingRoute.traceThickness / 2
      if (distance < minDistance) return false
    }

    const segmentBox = {
      centerX: (start.x + end.x) / 2,
      centerY: (start.y + end.y) / 2,
      width: Math.abs(start.x - end.x),
      height: Math.abs(start.y - end.y),
    }
    const searchMargin = traceThickness / 2 + OBSTACLE_MARGIN
    const obstacles = context.obstacleSHI.searchArea(
      segmentBox.centerX,
      segmentBox.centerY,
      segmentBox.width + searchMargin * 2,
      segmentBox.height + searchMargin * 2,
    )

    for (const obstacle of obstacles) {
      if (!obstacle.__zLayers) {
        throw new Error(
          `SameNetViaMergerSolver found obstacle without zLayers near via at (${viaToRemove.x}, ${viaToRemove.y})`,
        )
      }
      if (!obstacle.__zLayers.includes(z)) continue
      if (obstacleIsSameNet(context.connMap, obstacle, viaToRemove)) continue
      if (segmentToBoxMinDistance(start, end, obstacle) < searchMargin) {
        return false
      }
    }
  }

  return true
}

export class SameNetViaMergerSolver extends BaseSolver {
  override getSolverName(): string {
    return "SameNetViaMergerSolver"
  }

  inputHdRoutes: HighDensityRoute[]
  mergedViaHdRoutes: HighDensityRoute[]
  unprocessedRoutes: HighDensityRoute[]
  vias: Via[]
  offendingVias: [Via, Via][]
  viaMerges: SameNetViaMerge[] = []
  currentViaRoutes: HighDensityIntraNodeRoute[] = []
  connMap: ConnectivityMap
  colorMap: Record<string, string>
  outline?: Array<{ x: number; y: number }>
  obstacles: Obstacle[]
  viasByNet: Map<string, Via[]>

  obstacleSHI: ObstacleSpatialHashIndex
  hdRouteSHI: HighDensityRouteSpatialIndex

  constructor(private input: SameNetViaMergerSolverInput) {
    super()
    if (!input.connMap) {
      throw new Error("SameNetViaMergerSolver requires connMap")
    }

    this.input = {
      ...input,
      obstacles: createObjectsWithZLayers(input.obstacles, input.layerCount),
    }
    this.MAX_ITERATIONS = 1e6
    this.inputHdRoutes = this.input.inputHdRoutes
    this.mergedViaHdRoutes = structuredClone(this.inputHdRoutes)
    this.unprocessedRoutes = [...this.input.inputHdRoutes]
    this.colorMap = this.input.colorMap
    this.outline = this.input.outline
    this.obstacles = this.input.obstacles

    this.obstacleSHI = new ObstacleSpatialHashIndex(
      "flatbush",
      this.input.obstacles,
    )
    this.hdRouteSHI = new HighDensityRouteSpatialIndex(this.inputHdRoutes)
    this.vias = []
    this.offendingVias = []
    this.connMap = input.connMap

    this.viasByNet = new Map<string, Via[]>()

    this.rebuildVias()
  }

  private rebuildVias(): void {
    this.vias = []
    this.viasByNet = new Map<string, Via[]>()

    for (let i = 0; i < this.mergedViaHdRoutes.length; i++) {
      const route = this.mergedViaHdRoutes[i]
      this.canonicalizeRouteVias(route)
      for (let j = 0; j < route.vias.length; j++) {
        const viaPoint = route.vias[j]
        const layers = [...new Set(route.route.map((p) => p.z))]
        if (layers.length === 0) {
          throw new Error(
            `SameNetViaMergerSolver found via on route "${route.connectionName}" with no route points`,
          )
        }

        const via: Via = {
          x: viaPoint.x,
          y: viaPoint.y,
          diameter: route.viaDiameter,
          net: getNetForRoute(this.connMap, route),
          layers,
          routeIndex: i,
        }
        this.vias.push(via)
        const list = this.viasByNet.get(via.net)
        if (list) list.push(via)
        else this.viasByNet.set(via.net, [via])
      }
    }
  }

  private getViaKey(via: Via): string {
    return [via.routeIndex, via.x, via.y, via.layers.join(","), via.net].join(
      ":",
    )
  }

  private canonicalizeRouteVias(route: HighDensityRoute): void {
    const originalRoute = route.route
    const canonicalRoute: HighDensityRoute["route"] = []

    for (
      let routePointIndex = 0;
      routePointIndex < originalRoute.length;
      routePointIndex++
    ) {
      const currentPoint = originalRoute[routePointIndex]!
      const previousPoint = originalRoute[routePointIndex - 1]
      // Route reconstruction can combine a declared via and its adjacent
      // planar segment into one XY/Z edge. Split it at the declared via.
      if (
        previousPoint &&
        previousPoint.z !== currentPoint.z &&
        previousPoint.toNextSegmentType !== "through_obstacle" &&
        (previousPoint.x !== currentPoint.x ||
          previousPoint.y !== currentPoint.y)
      ) {
        const hasViaAtPreviousPoint = route.vias.some(
          (via) => via.x === previousPoint.x && via.y === previousPoint.y,
        )
        const hasViaAtCurrentPoint = route.vias.some(
          (via) => via.x === currentPoint.x && via.y === currentPoint.y,
        )
        if (hasViaAtPreviousPoint === hasViaAtCurrentPoint) {
          throw new Error(
            `SameNetViaMergerSolver could not resolve a non-vertical layer transition on route "${route.connectionName}"`,
          )
        }

        if (hasViaAtPreviousPoint) {
          canonicalRoute.push({
            x: previousPoint.x,
            y: previousPoint.y,
            z: currentPoint.z,
            ...(currentPoint.traceThickness !== undefined
              ? { traceThickness: currentPoint.traceThickness }
              : {}),
          })
        } else {
          canonicalRoute.push({
            x: currentPoint.x,
            y: currentPoint.y,
            z: previousPoint.z,
            ...(previousPoint.traceThickness !== undefined
              ? { traceThickness: previousPoint.traceThickness }
              : {}),
          })
        }
      }
      canonicalRoute.push(currentPoint)
    }

    route.route = canonicalRoute
    const seenViaLocations = new Set<string>()
    const canonicalVias: HighDensityRoute["vias"] = []
    for (
      let routePointIndex = 1;
      routePointIndex < canonicalRoute.length;
      routePointIndex++
    ) {
      const previousPoint = canonicalRoute[routePointIndex - 1]!
      const currentPoint = canonicalRoute[routePointIndex]!
      if (previousPoint.z === currentPoint.z) continue
      if (previousPoint.toNextSegmentType === "through_obstacle") continue
      if (
        previousPoint.x !== currentPoint.x ||
        previousPoint.y !== currentPoint.y
      ) {
        throw new Error(
          `SameNetViaMergerSolver found a non-vertical layer transition on route "${route.connectionName}"`,
        )
      }

      const key = `${previousPoint.x}:${previousPoint.y}`
      if (seenViaLocations.has(key)) continue
      seenViaLocations.add(key)
      canonicalVias.push({ x: previousPoint.x, y: previousPoint.y })
    }
    route.vias = canonicalVias
  }

  private getOffendingViaGroupsBatch(): Array<{ keep: Via; remove: Via[] }> {
    const groups: Array<{ keep: Via; remove: Via[] }> = []
    const touchedViaKeys = new Set<string>()
    const candidateGroups: Array<{ keep: Via; remove: Via[] }> = []

    for (const viasInNet of this.viasByNet.values()) {
      if (viasInNet.length < 2) continue

      const maxDiameter = Math.max(
        1e-6,
        ...viasInNet.map((via) => via.diameter),
      )
      const cellSize = maxDiameter
      const buckets = new Map<string, number[]>()

      // Build stars instead of connected components so a via is only moved to
      // another via that directly overlaps or has a clear short same-net merge.
      for (let viaIndex = 0; viaIndex < viasInNet.length; viaIndex++) {
        const via = viasInNet[viaIndex]
        const cellX = Math.floor(via.x / cellSize)
        const cellY = Math.floor(via.y / cellSize)
        const bucketKey = `${cellX}:${cellY}`
        const bucket = buckets.get(bucketKey)
        if (bucket) bucket.push(viaIndex)
        else buckets.set(bucketKey, [viaIndex])
      }

      for (let viaIndex = 0; viaIndex < viasInNet.length; viaIndex++) {
        const keep = viasInNet[viaIndex]
        const cellX = Math.floor(keep.x / cellSize)
        const cellY = Math.floor(keep.y / cellSize)
        const neighborCellRadius = Math.ceil(NEAR_VIA_MERGE_DISTANCE_MULTIPLIER)
        const remove: Via[] = []

        for (let dx = -neighborCellRadius; dx <= neighborCellRadius; dx++) {
          for (let dy = -neighborCellRadius; dy <= neighborCellRadius; dy++) {
            const bucket = buckets.get(`${cellX + dx}:${cellY + dy}`)
            if (!bucket) continue

            for (const candidateIndex of bucket) {
              if (candidateIndex === viaIndex) continue

              const candidate = viasInNet[candidateIndex]

              const pairDx = keep.x - candidate.x
              const pairDy = keep.y - candidate.y
              const squaredDistance = pairDx * pairDx + pairDy * pairDy
              const directOverlapDistance =
                keep.diameter / 2 + candidate.diameter / 2
              const nearMergeDistance =
                directOverlapDistance * NEAR_VIA_MERGE_DISTANCE_MULTIPLIER

              if (squaredDistance === 0) continue

              if (
                squaredDistance <=
                directOverlapDistance * directOverlapDistance
              ) {
                remove.push(candidate)
                continue
              }

              if (
                squaredDistance <= nearMergeDistance * nearMergeDistance &&
                canMoveViaTo(candidate, keep, {
                  connMap: this.connMap,
                  mergedViaHdRoutes: this.mergedViaHdRoutes,
                  hdRouteSHI: this.hdRouteSHI,
                  obstacleSHI: this.obstacleSHI,
                })
              ) {
                remove.push(candidate)
              }
            }
          }
        }

        if (remove.length > 0) candidateGroups.push({ keep, remove })
      }
    }

    candidateGroups.sort((a, b) => {
      if (b.remove.length !== a.remove.length) {
        return b.remove.length - a.remove.length
      }
      if (b.keep.layers.length !== a.keep.layers.length) {
        return b.keep.layers.length - a.keep.layers.length
      }

      return a.keep.routeIndex - b.keep.routeIndex
    })

    for (const candidateGroup of candidateGroups) {
      const keepKey = this.getViaKey(candidateGroup.keep)
      if (touchedViaKeys.has(keepKey)) continue

      const remove = candidateGroup.remove.filter(
        (viaToRemove) => !touchedViaKeys.has(this.getViaKey(viaToRemove)),
      )
      if (remove.length === 0) continue

      groups.push({ keep: candidateGroup.keep, remove })
      touchedViaKeys.add(keepKey)
      for (const viaToRemove of remove) {
        touchedViaKeys.add(this.getViaKey(viaToRemove))
      }
    }

    return groups
  }

  private moveViaTo(viaToRemove: Via, viaKeep: Via, rebuildVias = true): void {
    const routeToUpdate = this.mergedViaHdRoutes[viaToRemove.routeIndex]
    if (!routeToUpdate) {
      throw new Error(
        `SameNetViaMergerSolver could not find route for via at index ${viaToRemove.routeIndex}`,
      )
    }

    const route = routeToUpdate.route
    const routePointIndexesToMove = new Set<number>()
    let replacedVia = false

    for (let j = route.length - 1; j >= 1; j--) {
      const prev = route[j - 1]
      const curr = route[j]
      if (prev.z === curr.z) continue
      if (prev.x !== viaToRemove.x || prev.y !== viaToRemove.y) continue
      if (curr.x !== viaToRemove.x || curr.y !== viaToRemove.y) continue

      let clusterStartIndex = j - 1
      while (
        clusterStartIndex > 0 &&
        route[clusterStartIndex - 1]!.x === viaToRemove.x &&
        route[clusterStartIndex - 1]!.y === viaToRemove.y
      ) {
        clusterStartIndex--
      }

      let clusterEndIndex = j
      while (
        clusterEndIndex < route.length - 1 &&
        route[clusterEndIndex + 1]!.x === viaToRemove.x &&
        route[clusterEndIndex + 1]!.y === viaToRemove.y
      ) {
        clusterEndIndex++
      }

      for (let k = clusterStartIndex; k <= clusterEndIndex; k++) {
        routePointIndexesToMove.add(k)
      }
    }

    if (routePointIndexesToMove.size === 0) {
      throw new Error(
        `SameNetViaMergerSolver could not find route transition for via at (${viaToRemove.x}, ${viaToRemove.y}) on route "${routeToUpdate.connectionName}"`,
      )
    }

    for (const routePointIndex of routePointIndexesToMove) {
      const point = route[routePointIndex]
      route[routePointIndex] = { ...point, x: viaKeep.x, y: viaKeep.y }
    }

    routeToUpdate.vias = routeToUpdate.vias.map((vx) => {
      if (vx.x !== viaToRemove.x || vx.y !== viaToRemove.y) return vx
      replacedVia = true
      return { x: viaKeep.x, y: viaKeep.y }
    })
    if (!replacedVia) {
      throw new Error(
        `SameNetViaMergerSolver could not find via at (${viaToRemove.x}, ${viaToRemove.y}) on route "${routeToUpdate.connectionName}"`,
      )
    }

    this.viaMerges.push({
      connectionName: routeToUpdate.connectionName,
      from: { x: viaToRemove.x, y: viaToRemove.y },
      to: { x: viaKeep.x, y: viaKeep.y },
    })
    this.canonicalizeRouteVias(routeToUpdate)
    if (rebuildVias) this.rebuildVias()
  }

  _step(): void {
    const groups = this.getOffendingViaGroupsBatch()

    if (groups.length === 0) {
      this.solved = true
      return
    }

    let mergedViaCount = 0
    for (const group of groups) {
      for (const viaToRemove of group.remove) {
        this.moveViaTo(viaToRemove, group.keep, false)
        mergedViaCount++
      }
    }
    this.rebuildVias()
    this.hdRouteSHI = new HighDensityRouteSpatialIndex(this.mergedViaHdRoutes)
    this.stats.mergedViaGroups = groups.length
    this.stats.mergedViaCount = mergedViaCount
  }

  getMergedViaHdRoutes(): HighDensityRoute[] | null {
    return this.mergedViaHdRoutes
  }

  visualize(): GraphicsObject {
    return visualizeSameNetViaMerger({
      inputHdRoutes: this.inputHdRoutes,
      mergedViaHdRoutes: this.mergedViaHdRoutes,
      obstacles: this.input.obstacles,
      colorMap: this.colorMap,
      viaMerges: this.viaMerges,
    })
  }
}
