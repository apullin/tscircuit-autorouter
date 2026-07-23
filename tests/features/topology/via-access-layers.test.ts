import { expect, test } from "bun:test"
import { getUndetectedCompactDenseComponentBounds } from "lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph"
import { CapacityMeshEdgeSolver } from "lib/solvers/CapacityMeshSolver/CapacityMeshEdgeSolver"
import { addViaAccessLayers } from "lib/solvers/TopologyMergingSolver/add-via-access-layers"
import type { CapacityMeshNode, Obstacle } from "lib/types"

const createNode = (
  capacityMeshNodeId: string,
  availableZ: number[],
  overrides: Partial<CapacityMeshNode> = {},
): CapacityMeshNode => ({
  capacityMeshNodeId,
  center: { x: 0, y: 0 },
  width: 1,
  height: 1,
  availableZ,
  layer: `z${availableZ.join(",")}`,
  ...overrides,
})

test("adds layer access to a target over a via-sized free overlap", () => {
  const target = createNode("target", [0], {
    _containsTarget: true,
    _containsObstacle: true,
  })
  const freeUnderTarget = createNode("free-under-target", [1])

  const stats = addViaAccessLayers({
    nodes: [target, freeUnderTarget],
    layerCount: 2,
    viaDiameter: 0.5,
    componentBounds: [{ minX: -1, maxX: 1, minY: -1, maxY: 1 }],
  })

  expect(target.availableZ).toEqual([0, 1])
  expect(target._isViaAccess).toBe(true)
  expect(stats.expandedTargetNodeCount).toBe(1)
})

test("connects a marked via-access overlap without requiring a shared border", () => {
  const viaAccessNode = createNode("via-access", [0, 1], {
    _containsTarget: true,
    _containsObstacle: true,
    _isViaAccess: true,
  })
  const overlappingFreeNode = createNode("overlapping-free", [1])
  const solver = new CapacityMeshEdgeSolver(
    [viaAccessNode, overlappingFreeNode],
    0.5,
  )

  solver.solve()

  expect(solver.edges).toHaveLength(1)
  expect(solver.edges[0]).toMatchObject({
    nodeIds: ["via-access", "overlapping-free"],
  })
})

test("does not expand same-net target overlaps without a qualifying component", () => {
  const topTarget = createNode("top-target", [0], {
    _containsTarget: true,
    _containsObstacle: true,
    _connectedTo: ["shared-net"],
  })
  const bottomTarget = createNode("bottom-target", [1], {
    _containsTarget: true,
    _containsObstacle: true,
    _connectedTo: ["shared-net"],
  })

  const stats = addViaAccessLayers({
    nodes: [topTarget, bottomTarget],
    layerCount: 2,
    viaDiameter: 0.5,
    componentBounds: [],
  })

  expect(topTarget.availableZ).toEqual([0])
  expect(bottomTarget.availableZ).toEqual([1])
  expect(topTarget._isViaAccess).toBeUndefined()
  expect(bottomTarget._isViaAccess).toBeUndefined()
  expect(stats.expandedTargetNodeCount).toBe(0)
})

test("enables same-net target via access when the board has a qualifying component", () => {
  const topTarget = createNode("top-target", [0], {
    _containsTarget: true,
    _containsObstacle: true,
    _connectedTo: ["shared-net"],
  })
  const bottomTarget = createNode("bottom-target", [1], {
    _containsTarget: true,
    _containsObstacle: true,
    _connectedTo: ["shared-net"],
  })

  const stats = addViaAccessLayers({
    nodes: [topTarget, bottomTarget],
    layerCount: 2,
    viaDiameter: 0.5,
    componentBounds: [{ minX: 10, maxX: 11, minY: 10, maxY: 11 }],
  })

  expect(topTarget.availableZ).toEqual([0, 1])
  expect(topTarget._isViaAccess).toBe(true)
  expect(stats.expandedTargetNodeCount).toBe(2)
})

test("only treats compact undetected dense components as BGA-like", () => {
  const createObstacles = (
    componentId: string,
    columns: number,
    rows: number,
  ): Obstacle[] =>
    Array.from({ length: columns * rows }, (_, index) => ({
      obstacleId: `${componentId}-${index}`,
      componentId,
      type: "rect",
      layers: ["top"],
      center: {
        x: index % columns,
        y: Math.floor(index / columns),
      },
      width: 0.2,
      height: 0.2,
      connectedTo: [],
    }))

  const compactObstacles = createObstacles("compact", 10, 9)
  const stripObstacles = createObstacles("strip", 45, 2)
  const connections = [
    {
      name: "cross-layer",
      pointsToConnect: [
        { x: 1, y: 1, layer: "top" as const },
        { x: 2, y: 2, layer: "bottom" as const },
      ],
    },
  ]

  const bounds = getUndetectedCompactDenseComponentBounds(
    [...compactObstacles, ...stripObstacles],
    new Set(),
    connections,
  )

  expect(bounds).toHaveLength(1)
  expect(bounds[0]!.maxX - bounds[0]!.minX).toBeCloseTo(9.2)
  expect(bounds[0]!.maxY - bounds[0]!.minY).toBeCloseTo(8.2)
})
