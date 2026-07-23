import type { Obstacle, SimpleRouteJson } from "lib/types"
import { mapZToLayerName } from "lib/utils/mapZToLayerName"
import type { SerializedTopologyComponentInput } from "./MultiGraphTopologyPlannerSolver"

const COORDINATE_EPSILON = 1e-3
const MIN_NESTED_BGA_AXIS_COUNT = 5
const MIN_NESTED_BGA_OCCUPANCY = 1
const MAX_AXIS_COUNT_RATIO = 1.5

const coordinateKey = (value: number) => Math.round(value / COORDINATE_EPSILON)

export const getTopologyObstacleKey = (obstacle: Obstacle) =>
  obstacle.obstacleId ??
  [
    obstacle.componentId ?? "no-component",
    coordinateKey(obstacle.center.x),
    coordinateKey(obstacle.center.y),
    coordinateKey(obstacle.width),
    coordinateKey(obstacle.height),
    obstacle.layers.join(","),
  ].join(":")

const getUniqueSortedCoordinates = (values: number[]) =>
  [
    ...new Map(values.map((value) => [coordinateKey(value), value])).values(),
  ].sort((left, right) => left - right)

const findCoordinate = (coordinates: number[], expected: number) =>
  coordinates.find(
    (coordinate) => Math.abs(coordinate - expected) <= COORDINATE_EPSILON,
  )

const getArithmeticCoordinateSequences = (coordinates: number[]) => {
  const sequences = new Map<string, number[]>()
  for (let startIndex = 0; startIndex < coordinates.length; startIndex++) {
    for (
      let secondIndex = startIndex + 1;
      secondIndex < coordinates.length;
      secondIndex++
    ) {
      const start = coordinates[startIndex]!
      const pitch = coordinates[secondIndex]! - start
      if (pitch <= COORDINATE_EPSILON) continue

      const sequence = [start]
      for (let step = 1; ; step++) {
        const coordinate = findCoordinate(coordinates, start + pitch * step)
        if (coordinate === undefined) break
        sequence.push(coordinate)
      }
      if (sequence.length < MIN_NESTED_BGA_AXIS_COUNT) continue
      sequences.set(sequence.map(coordinateKey).join(","), sequence)
    }
  }
  return [...sequences.values()]
}

const groupByPadGeometry = (obstacles: Obstacle[]) => {
  const groups = new Map<string, Obstacle[]>()
  for (const obstacle of obstacles) {
    const key = [
      coordinateKey(obstacle.width),
      coordinateKey(obstacle.height),
      obstacle.layers.join(","),
    ].join(":")
    const group = groups.get(key) ?? []
    group.push(obstacle)
    groups.set(key, group)
  }
  return [...groups.values()]
}

const findLargestCompleteGrid = (obstacles: Obstacle[]) => {
  const obstacleByCoordinate = new Map(
    obstacles.map((obstacle) => [
      `${coordinateKey(obstacle.center.x)}:${coordinateKey(obstacle.center.y)}`,
      obstacle,
    ]),
  )
  const xSequences = getArithmeticCoordinateSequences(
    getUniqueSortedCoordinates(obstacles.map((obstacle) => obstacle.center.x)),
  )
  const ySequences = getArithmeticCoordinateSequences(
    getUniqueSortedCoordinates(obstacles.map((obstacle) => obstacle.center.y)),
  )

  let best: Obstacle[] = []
  for (const xCoordinates of xSequences) {
    for (const yCoordinates of ySequences) {
      const axisRatio = Math.max(
        xCoordinates.length / yCoordinates.length,
        yCoordinates.length / xCoordinates.length,
      )
      if (axisRatio > MAX_AXIS_COUNT_RATIO) continue

      const members = xCoordinates.flatMap((x) =>
        yCoordinates.flatMap((y) => {
          const obstacle = obstacleByCoordinate.get(
            `${coordinateKey(x)}:${coordinateKey(y)}`,
          )
          return obstacle ? [obstacle] : []
        }),
      )
      const occupancy =
        members.length / (xCoordinates.length * yCoordinates.length)
      if (occupancy < MIN_NESTED_BGA_OCCUPANCY) continue
      if (members.length > best.length) best = members
    }
  }
  return best
}

export const findNestedBgaObstacleGroups = ({
  obstacles,
  excludedComponentIds = new Set<string>(),
}: {
  obstacles: Obstacle[]
  excludedComponentIds?: ReadonlySet<string>
}) => {
  const obstaclesByComponent = new Map<string, Obstacle[]>()
  for (const obstacle of obstacles) {
    if (
      !obstacle.componentId ||
      excludedComponentIds.has(obstacle.componentId)
    ) {
      continue
    }
    const componentObstacles =
      obstaclesByComponent.get(obstacle.componentId) ?? []
    componentObstacles.push(obstacle)
    obstaclesByComponent.set(obstacle.componentId, componentObstacles)
  }

  return [...obstaclesByComponent.entries()].flatMap(
    ([componentId, componentObstacles]) => {
      let best: Obstacle[] = []
      for (const geometryGroup of groupByPadGeometry(componentObstacles)) {
        const candidate = findLargestCompleteGrid(geometryGroup)
        if (candidate.length > best.length) best = candidate
      }
      if (best.length === 0 || best.length === componentObstacles.length) {
        return []
      }
      return [{ componentId, memberObstacles: best }]
    },
  )
}

export const findNestedBgaTopologyComponents = ({
  inputSrj,
  excludedComponentIds,
}: {
  inputSrj: SimpleRouteJson
  excludedComponentIds: ReadonlySet<string>
}): SerializedTopologyComponentInput[] =>
  findNestedBgaObstacleGroups({
    obstacles: inputSrj.obstacles,
    excludedComponentIds,
  }).map(({ componentId, memberObstacles }, index) => {
    const bounds = memberObstacles.reduce(
      (result, obstacle) => ({
        minX: Math.min(result.minX, obstacle.center.x - obstacle.width / 2),
        maxX: Math.max(result.maxX, obstacle.center.x + obstacle.width / 2),
        minY: Math.min(result.minY, obstacle.center.y - obstacle.height / 2),
        maxY: Math.max(result.maxY, obstacle.center.y + obstacle.height / 2),
      }),
      { minX: Infinity, maxX: -Infinity, minY: Infinity, maxY: -Infinity },
    )
    const nestedComponentId = `${componentId}__nested_bga_${index}`
    const replacementObstacle = {
      obstacleId: `${nestedComponentId}_bounds`,
      componentId: nestedComponentId,
      type: "rect" as const,
      layers: Array.from({ length: inputSrj.layerCount }, (_, z) =>
        mapZToLayerName(z, inputSrj.layerCount),
      ),
      __zLayers: Array.from({ length: inputSrj.layerCount }, (_, z) => z),
      center: {
        x: (bounds.minX + bounds.maxX) / 2,
        y: (bounds.minY + bounds.maxY) / 2,
      },
      width: bounds.maxX - bounds.minX,
      height: bounds.maxY - bounds.minY,
      connectedTo: [
        ...new Set(memberObstacles.flatMap((obstacle) => obstacle.connectedTo)),
      ],
    }

    return {
      componentId: nestedComponentId,
      componentKind: "bga",
      memberObstacleIds: memberObstacles.map(getTopologyObstacleKey),
      memberObstacles,
      replacementObstacle,
    }
  })
