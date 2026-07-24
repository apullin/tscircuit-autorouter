import type { CapacityMeshEdge, CapacityMeshNodeId } from "../../types"

export function getNodeEdgeMap(
  edges: CapacityMeshEdge[],
): Map<CapacityMeshNodeId, CapacityMeshEdge[]> {
  const nodeEdgeMap = new Map<CapacityMeshNodeId, CapacityMeshEdge[]>()

  for (const edge of edges) {
    for (const nodeId of edge.nodeIds) {
      let nodeEdges = nodeEdgeMap.get(nodeId)
      if (!nodeEdges) {
        nodeEdges = []
        nodeEdgeMap.set(nodeId, nodeEdges)
      }
      nodeEdges.push(edge)
    }
  }

  return nodeEdgeMap
}
