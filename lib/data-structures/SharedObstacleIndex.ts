import type { Obstacle } from "lib/types"
import { FlatbushIndex } from "./FlatbushIndex"

export interface IndexedObstacle {
  /** Index of the obstacle in the array the index was built from. */
  index: number
  obstacle: Obstacle
}

/**
 * Flatbush R-tree over obstacle bounding boxes, built once per
 * MultiSimplifiedPathSolver run and queried once per route.
 *
 * SingleSimplifiedPathSolver5_Deg45's constructor used to test every obstacle
 * against every route (connectivity lookups plus computeGapBetweenBoxes,
 * O(routes * obstacles) per Multi pass — the largest single constructor
 * cost). computeGapBetweenBoxes is the Euclidean gap hypot(dx, dy) with
 * per-axis gaps dx, dy >= 0, so gap < margin implies dx < margin and
 * dy < margin, i.e. the obstacle's box intersects the route bounds grown by
 * margin on each side. A flatbush query over that grown box therefore
 * returns a superset of every obstacle that can pass the exact gap test;
 * callers re-run the exact test (and the connectivity filter) on the hits,
 * keeping the result set identical.
 */
export class SharedObstacleIndex {
  private index: FlatbushIndex<IndexedObstacle> | null = null

  constructor(obstacles: ReadonlyArray<Obstacle>) {
    // Flatbush cannot index zero items; an absent index just returns no hits.
    if (obstacles.length === 0) return

    const index = new FlatbushIndex<IndexedObstacle>(obstacles.length)
    for (let i = 0; i < obstacles.length; i++) {
      const obstacle = obstacles[i]
      const halfWidth = obstacle.width / 2
      const halfHeight = obstacle.height / 2
      index.insert(
        { index: i, obstacle },
        obstacle.center.x - halfWidth,
        obstacle.center.y - halfHeight,
        obstacle.center.x + halfWidth,
        obstacle.center.y + halfHeight,
      )
    }
    index.finish()
    this.index = index
  }

  /**
   * All obstacles whose bounding box intersects the query box (inclusive
   * bounds on all four sides). Order is unspecified — callers that need the
   * original array order must sort by index.
   */
  search(
    minX: number,
    minY: number,
    maxX: number,
    maxY: number,
  ): IndexedObstacle[] {
    return this.index ? this.index.search(minX, minY, maxX, maxY) : []
  }
}
