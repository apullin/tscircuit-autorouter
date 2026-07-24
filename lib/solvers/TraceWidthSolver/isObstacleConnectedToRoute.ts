import type { ConnectivityMap } from "circuit-json-to-connectivity-map"
import type { Obstacle } from "lib/types"

type RouteConnectionIds = {
  connectionName: string
  rootConnectionName?: string
}

export const isObstacleConnectedToRoute = (
  obstacle: Obstacle,
  route: RouteConnectionIds,
  connMap?: ConnectivityMap,
) => {
  const connectionName = route.connectionName
  const rootConnectionName = route.rootConnectionName
  const connectedTo = obstacle.connectedTo

  for (let i = 0; i < connectedTo.length; i++) {
    const connectedId = connectedTo[i]!
    if (connectedId === connectionName || connectedId === rootConnectionName) {
      return true
    }
  }

  if (!connMap) return false

  // Hoist the route-side net lookups out of the loop: they are invariant
  // across connectedTo entries. Mirrors areIdsConnected semantics:
  // connected(id1, id2) iff net1 && net2 && (net1 === net2 || net2 === id1).
  const connectionNetId = connMap.getNetConnectedToId(connectionName)
  const rootNetId =
    rootConnectionName !== undefined
      ? connMap.getNetConnectedToId(rootConnectionName)
      : undefined
  if (!connectionNetId && !rootNetId) return false

  for (let i = 0; i < connectedTo.length; i++) {
    const connectedId = connectedTo[i]!
    const connectedNetId = connMap.getNetConnectedToId(connectedId)
    if (!connectedNetId) continue
    if (
      connectionNetId &&
      (connectionNetId === connectedNetId || connectedNetId === connectionName)
    ) {
      return true
    }
    if (
      rootConnectionName !== undefined &&
      rootNetId &&
      (rootNetId === connectedNetId || connectedNetId === rootConnectionName)
    ) {
      return true
    }
  }

  return false
}
