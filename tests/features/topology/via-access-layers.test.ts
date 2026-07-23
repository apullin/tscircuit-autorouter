import { expect, test } from "bun:test"
import { CapacityMeshEdgeSolver } from "lib/solvers/CapacityMeshSolver/CapacityMeshEdgeSolver"
import { addViaAccessLayers } from "lib/solvers/TopologyMergingSolver/add-via-access-layers"
import type { CapacityMeshNode } from "lib/types"

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
