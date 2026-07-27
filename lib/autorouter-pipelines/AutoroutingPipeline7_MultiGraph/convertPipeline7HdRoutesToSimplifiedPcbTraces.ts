import type { ConnectivityMap } from "circuit-json-to-connectivity-map"
import type {
  Obstacle,
  SimpleRouteConnection,
  SimplifiedPcbTrace,
  SimplifiedPcbTraces,
} from "lib/types"
import type { HighDensityRoute } from "lib/types/high-density-types"
import { convertHdRouteToSimplifiedRoute } from "lib/utils/convertHdRouteToSimplifiedRoute"

export interface ConvertPipeline7HdRoutesOptions {
  connections: SimpleRouteConnection[]
  originalConnections: SimpleRouteConnection[]
  hdRoutes: HighDensityRoute[]
  layerCount: number
  obstacles: Obstacle[]
  defaultViaHoleDiameter: number
  connMap: ConnectivityMap
  /**
   * When provided, filled with hdRoutes-index → pcb_trace_id (undefined for
   * routes whose connectionName matches no connection — those produce no
   * trace and are invisible to DRC). Used by the incremental DRC delta path
   * to translate dirty route indexes into dirty trace ids.
   */
  traceIdByRouteIndexOut?: Array<string | undefined>
}

/** Converts Pipeline7 routes using the same net and terminal rules as final output. */
export const convertPipeline7HdRoutesToSimplifiedPcbTraces = ({
  connections,
  originalConnections,
  hdRoutes,
  layerCount,
  obstacles,
  defaultViaHoleDiameter,
  connMap,
  traceIdByRouteIndexOut,
}: ConvertPipeline7HdRoutesOptions): SimplifiedPcbTraces => {
  const traces: SimplifiedPcbTraces = []

  // Single-pass grouping replaces the per-connection O(connections × routes)
  // filter. Group order follows the hdRoutes array and the outer loop still
  // follows `connections`, so trace output order matches the filter version
  // exactly.
  const routesByConnectionName = new Map<
    string,
    Array<{ route: HighDensityRoute; routeIndex: number }>
  >()
  for (let routeIndex = 0; routeIndex < hdRoutes.length; routeIndex += 1) {
    const route = hdRoutes[routeIndex]!
    let group = routesByConnectionName.get(route.connectionName)
    if (!group) {
      group = []
      routesByConnectionName.set(route.connectionName, group)
    }
    group.push({ route, routeIndex })
  }

  for (const connection of connections) {
    const netConnectionName =
      connection.__netConnectionName ??
      originalConnections.find(
        (candidate) => candidate.name === connection.name,
      )?.__netConnectionName
    const connectionRoutes = routesByConnectionName.get(connection.name) ?? []

    if (connection.pointsToConnect.length !== 2) {
      throw new Error(
        `Expected Pipeline7 output connection "${connection.name}" to have two points, got ${connection.pointsToConnect.length}`,
      )
    }

    const [startPoint, endPoint] = connection.pointsToConnect
    const connectsTo = [startPoint?.pointId, endPoint?.pointId].filter(
      (pointId): pointId is string => Boolean(pointId),
    )

    for (let index = 0; index < connectionRoutes.length; index += 1) {
      const { route: hdRoute, routeIndex } = connectionRoutes[index]!
      if (traceIdByRouteIndexOut) {
        traceIdByRouteIndexOut[routeIndex] = `${connection.name}_${index}`
      }
      const simplifiedPcbTrace: SimplifiedPcbTrace = {
        type: "pcb_trace",
        pcb_trace_id: `${connection.name}_${index}`,
        connection_name:
          netConnectionName ??
          connection.__rootConnectionNames?.[0] ??
          connection.name,
        connectsTo,
        route: convertHdRouteToSimplifiedRoute(hdRoute, layerCount, {
          connectionPoints: connection.pointsToConnect,
          defaultViaHoleDiameter,
          obstacles,
          connMap,
        }),
      }

      traces.push(simplifiedPcbTrace)
    }
  }

  return traces
}
