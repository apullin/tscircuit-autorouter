import { FlatbushIndex } from "./FlatbushIndex"

interface RoutePoint {
  x: number
  y: number
  z: number
}

export interface IndexedRouteSegment {
  /** Index of the owning route in the array the index was built from. */
  routeIndex: number
  /** Index of the segment within the owning route (segment = [i, i+1]). */
  segIndex: number
  connectionName: string
  /** Same object reference as routes[routeIndex].route[segIndex]. */
  start: RoutePoint
  /** Same object reference as routes[routeIndex].route[segIndex + 1]. */
  end: RoutePoint
}

/**
 * One flatbush R-tree over every segment of every route, built once per
 * MultiSimplifiedPathSolver run and queried once per route.
 *
 * SingleSimplifiedPathSolver5_Deg45's constructor used to scan every segment
 * of every other route (O(routes^2 * segments) across a Multi pass) to
 * collect the segments near the route being simplified. A bbox pre-reject
 * made each candidate cheap, but the scan itself stayed quadratic and
 * dominated the trace-simplification stage. A flatbush query over the
 * expanded route bounds returns exactly the segments that survive that
 * pre-reject (flatbush search bounds are inclusive, matching the strict-<
 * reject comparisons), so downstream filtering is unchanged.
 *
 * The index stores point object references, not copies: it stays valid as
 * long as the route arrays it was built from are not mutated in place, which
 * holds for a MultiSimplifiedPathSolver run (routes are only ever replaced
 * wholesale between phases, never edited in place).
 */
export class SharedRouteSegmentIndex {
  private index: FlatbushIndex<IndexedRouteSegment> | null = null

  constructor(
    routes: ReadonlyArray<{
      connectionName: string
      route: ReadonlyArray<RoutePoint>
    }>,
  ) {
    let segmentCount = 0
    for (const r of routes) segmentCount += Math.max(0, r.route.length - 1)
    // Flatbush cannot index zero items; an absent index just returns no hits.
    if (segmentCount === 0) return

    const index = new FlatbushIndex<IndexedRouteSegment>(segmentCount)
    for (let routeIndex = 0; routeIndex < routes.length; routeIndex++) {
      const { connectionName, route } = routes[routeIndex]
      for (let segIndex = 0; segIndex < route.length - 1; segIndex++) {
        const start = route[segIndex]
        const end = route[segIndex + 1]
        index.insert(
          { routeIndex, segIndex, connectionName, start, end },
          Math.min(start.x, end.x),
          Math.min(start.y, end.y),
          Math.max(start.x, end.x),
          Math.max(start.y, end.y),
        )
      }
    }
    index.finish()
    this.index = index
  }

  /**
   * All segments whose bounding box intersects the query box (inclusive
   * bounds on all four sides). Order is unspecified — callers that need the
   * original scan order must sort by (routeIndex, segIndex).
   */
  search(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): IndexedRouteSegment[] {
    return this.index ? this.index.search(minX, minY, maxX, maxY) : []
  }
}
