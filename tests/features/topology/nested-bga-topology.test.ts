import { expect, test } from "bun:test"
import {
  findNestedBgaObstacleGroups,
  findNestedBgaTopologyComponents,
} from "lib/solvers/TopologyPlanningSolver/find-nested-bga-topology-components"
import { createComponentSrj } from "lib/solvers/TopologyPlanningSolver/topologyPlanningShared"
import type { Obstacle, SimpleRouteJson } from "lib/types"

const createPad = (
  componentId: string,
  obstacleId: string,
  x: number,
  y: number,
  width = 0.2,
  height = 0.2,
): Obstacle => ({
  obstacleId,
  componentId,
  type: "rect",
  layers: ["top"],
  center: { x, y },
  width,
  height,
  connectedTo: [],
})

const createCompositePads = () => {
  const componentId = "U_COMPOSITE"
  const innerGrid = Array.from({ length: 25 }, (_, index) =>
    createPad(
      componentId,
      `inner-${index}`,
      index % 5,
      Math.floor(index / 5),
    ),
  )
  const perimeter = [
    ...Array.from({ length: 7 }, (_, index) =>
      createPad(componentId, `top-${index}`, index - 1, -2, 0.3, 0.15),
    ),
    ...Array.from({ length: 7 }, (_, index) =>
      createPad(componentId, `bottom-${index}`, index - 1, 6, 0.3, 0.15),
    ),
  ]
  return { innerGrid, perimeter, obstacles: [...innerGrid, ...perimeter] }
}

const createSrj = (obstacles: Obstacle[]): SimpleRouteJson => ({
  layerCount: 4,
  minTraceWidth: 0.1,
  obstacles,
  connections: [],
  bounds: { minX: -3, maxX: 7, minY: -3, maxY: 7 },
})

test("finds a complete nested BGA grid inside a mixed component", () => {
  const { innerGrid, obstacles } = createCompositePads()

  const groups = findNestedBgaObstacleGroups({ obstacles })

  expect(groups).toHaveLength(1)
  expect(groups[0]!.componentId).toBe("U_COMPOSITE")
  expect(
    groups[0]!.memberObstacles
      .map((obstacle) => obstacle.obstacleId)
      .sort(),
  ).toEqual(innerGrid.map((obstacle) => obstacle.obstacleId).sort())
})

test("does not turn a homogeneous BGA into a nested component", () => {
  const { innerGrid } = createCompositePads()

  expect(findNestedBgaObstacleGroups({ obstacles: innerGrid })).toEqual([])
})

test("does not classify a nearly complete subgrid as a nested BGA", () => {
  const { innerGrid, perimeter } = createCompositePads()

  expect(
    findNestedBgaObstacleGroups({
      obstacles: [...innerGrid.slice(1), ...perimeter],
    }),
  ).toEqual([])
})

test("nested BGA topology remaps only member pads to its synthetic component", () => {
  const { innerGrid, obstacles } = createCompositePads()
  const overlappingNonMember = createPad(
    "U_COMPOSITE",
    "overlapping-non-member",
    2.4,
    2.4,
    0.1,
    0.1,
  )
  const inputSrj = createSrj([...obstacles, overlappingNonMember])
  const [component] = findNestedBgaTopologyComponents({
    inputSrj,
    excludedComponentIds: new Set(),
  })

  expect(component).toBeDefined()
  const componentSrj = createComponentSrj({
    inputSrj,
    component: component!,
  })
  const remappedMemberIds = componentSrj.obstacles
    .filter((obstacle) => obstacle.componentId === component!.componentId)
    .map((obstacle) => obstacle.obstacleId)

  expect(remappedMemberIds.sort()).toEqual(
    innerGrid.map((obstacle) => obstacle.obstacleId).sort(),
  )
  expect(
    componentSrj.obstacles.find(
      (obstacle) => obstacle.obstacleId === "overlapping-non-member",
    )?.componentId,
  ).toBe("U_COMPOSITE")
})
