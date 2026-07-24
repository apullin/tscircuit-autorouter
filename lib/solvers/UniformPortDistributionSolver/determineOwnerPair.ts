import { InputNodeWithPortPoints } from "../PortPointPathingSolver/PortPointPathingSolver"
import { normalizeOwnerPair } from "./getOwnerPairKey"
import { OwnerPair } from "./types"

interface DetermineOwnerPairParams {
  portPointId?: string
  currentNodeId: string
  inputNodes: InputNodeWithPortPoints[]
}

/**
 * Cache of portPointId -> connectionNodeIds per inputNodes array.
 * determineOwnerPair runs once per port point, so building this map once
 * per array replaces an O(nodes x portPoints) scan per call. inputNodes are
 * solver inputs treated as immutable for the solver's lifetime.
 * First occurrence wins, mirroring the original scan order (nodes in order,
 * portPoints in order, skipping points without connectionNodeIds).
 */
const connectionNodeIdsLookupCache = new WeakMap<
  InputNodeWithPortPoints[],
  Map<string, [string, string]>
>()

const getConnectionNodeIdsByPortPointId = (
  inputNodes: InputNodeWithPortPoints[],
) => {
  let lookup = connectionNodeIdsLookupCache.get(inputNodes)
  if (!lookup) {
    lookup = new Map<string, [string, string]>()
    for (const node of inputNodes) {
      // Only the FIRST point with a given portPointId within a single node
      // is visible to the scan: the original per-node .find() returns it,
      // and if its connectionNodeIds is falsy the scan moves on to the next
      // node (later same-id points in the same node are never considered).
      const seenInNode = new Set<string>()
      for (const point of node.portPoints) {
        const portPointId = point.portPointId
        if (portPointId === undefined || seenInNode.has(portPointId)) continue
        seenInNode.add(portPointId)
        if (point.connectionNodeIds && !lookup.has(portPointId)) {
          lookup.set(portPointId, point.connectionNodeIds)
        }
      }
    }
    connectionNodeIdsLookupCache.set(inputNodes, lookup)
  }
  return lookup
}

/**
 * Resolves the canonical two-node ownership for a port point so shared-edge
 * redistribution can always operate on a stable family identity.
 */
export const determineOwnerPair = ({
  portPointId,
  currentNodeId,
  inputNodes,
}: DetermineOwnerPairParams): OwnerPair => {
  let connectionNodeIds: [string, string] | undefined

  if (portPointId) {
    connectionNodeIds =
      getConnectionNodeIdsByPortPointId(inputNodes).get(portPointId)
  }

  if (!connectionNodeIds || connectionNodeIds.length !== 2) {
    return [currentNodeId, currentNodeId]
  }

  const [nodeA, nodeB] = connectionNodeIds
  if (!nodeA || !nodeB) return [currentNodeId, currentNodeId]

  return normalizeOwnerPair(nodeA, nodeB)
}
