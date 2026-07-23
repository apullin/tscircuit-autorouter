import type { CapacityMeshNode } from "lib/types"
import type { Bounds } from "@tscircuit/math-utils"

const EPSILON = 1e-6

const overlapDimensions = (a: CapacityMeshNode, b: CapacityMeshNode) => ({
  width:
    Math.min(a.center.x + a.width / 2, b.center.x + b.width / 2) -
    Math.max(a.center.x - a.width / 2, b.center.x - b.width / 2),
  height:
    Math.min(a.center.y + a.height / 2, b.center.y + b.height / 2) -
    Math.max(a.center.y - a.height / 2, b.center.y - b.height / 2),
})

const containsNode = (
  container: CapacityMeshNode,
  contained: CapacityMeshNode,
) =>
  container.center.x - container.width / 2 <=
    contained.center.x - contained.width / 2 + EPSILON &&
  container.center.x + container.width / 2 >=
    contained.center.x + contained.width / 2 - EPSILON &&
  container.center.y - container.height / 2 <=
    contained.center.y - contained.height / 2 + EPSILON &&
  container.center.y + container.height / 2 >=
    contained.center.y + contained.height / 2 - EPSILON

const nodesOverlap = (a: CapacityMeshNode, b: CapacityMeshNode) => {
  const overlap = overlapDimensions(a, b)
  return overlap.width >= -EPSILON && overlap.height >= -EPSILON
}

const shareConnectionAlias = (a: CapacityMeshNode, b: CapacityMeshNode) => {
  const aliases = new Set(a._connectedTo ?? [])
  return (b._connectedTo ?? []).some((alias) => aliases.has(alias))
}

export const addViaAccessLayers = ({
  nodes,
  layerCount,
  viaDiameter,
  componentBounds = [],
}: {
  nodes: CapacityMeshNode[]
  layerCount: number
  viaDiameter: number
  componentBounds?: readonly Bounds[]
}) => {
  const allLayers = Array.from({ length: layerCount }, (_, z) => z)
  const originalAvailableZ = new Map(
    nodes.map((node) => [node.capacityMeshNodeId, [...node.availableZ]]),
  )
  const targetNodes = nodes.filter(
    (node) => node._containsTarget && node._containsObstacle,
  )
  const freeNodes = nodes.filter(
    (node) => !node._containsTarget && !node._containsObstacle,
  )
  const canFitViaInOverlap = (a: CapacityMeshNode, b: CapacityMeshNode) => {
    const overlap = overlapDimensions(a, b)
    return (
      overlap.width + EPSILON >= viaDiameter &&
      overlap.height + EPSILON >= viaDiameter
    )
  }
  const hasSameNetTargetOverlap = (node: CapacityMeshNode) =>
    targetNodes.some(
      (candidate) =>
        candidate !== node &&
        !candidate.availableZ.some((z) => node.availableZ.includes(z)) &&
        nodesOverlap(node, candidate) &&
        shareConnectionAlias(node, candidate),
    )
  const overlapsComponentTopology = (node: CapacityMeshNode) =>
    componentBounds.some(
      (bounds) =>
        node.center.x >= bounds.minX - EPSILON &&
        node.center.x <= bounds.maxX + EPSILON &&
        node.center.y >= bounds.minY - EPSILON &&
        node.center.y <= bounds.maxY + EPSILON,
    )

  const expandedTargetNodes = targetNodes.filter(
    (node) =>
      Math.min(node.width, node.height) + EPSILON >= viaDiameter &&
      componentBounds.length > 0 &&
      (hasSameNetTargetOverlap(node) ||
        (overlapsComponentTopology(node) &&
          freeNodes.some((candidate) => canFitViaInOverlap(node, candidate)))),
  )
  for (const node of expandedTargetNodes) {
    const availableZ = hasSameNetTargetOverlap(node)
      ? allLayers
      : [
          ...new Set([
            ...node.availableZ,
            ...freeNodes
              .filter((candidate) => canFitViaInOverlap(node, candidate))
              .flatMap(
                (candidate) =>
                  originalAvailableZ.get(candidate.capacityMeshNodeId) ?? [],
              ),
          ]),
        ].sort((a, b) => a - b)
    if (availableZ.length === node.availableZ.length) continue
    node.availableZ = availableZ
    node.layer = `z${availableZ.join(",")}`
    node._isViaAccess = true
  }

  const freeNodesByLayer = allLayers.map((z) =>
    freeNodes.filter((node) =>
      (originalAvailableZ.get(node.capacityMeshNodeId) ?? []).includes(z),
    ),
  )
  const freeViaPortalNodes = freeNodes.filter(
    (node) =>
      overlapsComponentTopology(node) &&
      (node.availableZ.includes(0) ||
        node.availableZ.includes(layerCount - 1)) &&
      Math.min(node.width, node.height) + EPSILON >= viaDiameter &&
      allLayers.every((z) =>
        freeNodesByLayer[z]!.some((candidate) => containsNode(candidate, node)),
      ),
  )
  for (const node of freeViaPortalNodes) {
    node.availableZ = [...allLayers]
    node.layer = `z${node.availableZ.join(",")}`
    node._isViaPortal = true
  }

  return {
    expandedTargetNodeCount: expandedTargetNodes.length,
    freeViaPortalNodeCount: freeViaPortalNodes.length,
  }
}
