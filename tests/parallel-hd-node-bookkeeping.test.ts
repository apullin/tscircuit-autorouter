import { expect, test } from "bun:test"
import { HighDensitySolver } from "lib/solvers/HighDensitySolver/HighDensitySolver"
import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "lib/types/high-density-types"
import input from "../fixtures/legacy/assets/simpleHighDensityRouteSolverInput.json" with {
  type: "json",
}

// Small, fast subset of an existing HD fixture. Each node is an independent
// intra-node solve, so any slice of it is a valid HighDensitySolver input.
const allNodes = input.flatMap(
  (item: { nodePortPoints: NodeWithPortPoints[] }) => item.nodePortPoints,
)
const NODES = allNodes.slice(0, 6)

const buildSolver = () =>
  new HighDensitySolver({
    nodePortPoints: structuredClone(NODES),
    // Exercises difficultNodePfs (> 0.05) on exactly one node.
    nodePfById: { [NODES[0]!.capacityMeshNodeId]: 0.07 },
  })

test("parallel node path records the same bookkeeping as sequential", () => {
  const savedFlag = process.env.TS_PARALLEL_HD_NODES
  try {
    // Sequential arm: flag unset (auto mode is also off here — bun test sets
    // NODE_ENV=test — and 6 nodes is below the auto board-size gate anyway).
    delete process.env.TS_PARALLEL_HD_NODES
    const seq = buildSolver()
    seq.solve()
    expect(seq.solved).toBe(true)

    process.env.TS_PARALLEL_HD_NODES = "2"
    const par = buildSolver()
    par.solve()
    expect(par.solved).toBe(true)

    // Node metadata: same nodes, same terminal statuses.
    const statusById = (solver: HighDensitySolver) =>
      Object.fromEntries(
        [...solver.nodeSolveMetadataById.entries()].map(([id, meta]) => [
          id,
          meta.status,
        ]),
      )
    expect(par.nodeSolveMetadataById.size).toBe(NODES.length)
    expect(statusById(par)).toEqual(statusById(seq))

    // Worker-computed parity fields are populated and, for this deterministic
    // fixture (cold caches on both sides), identical to the sequential side.
    for (const [id, meta] of par.nodeSolveMetadataById) {
      const seqMeta = seq.nodeSolveMetadataById.get(id)!
      expect(meta.solverType).toBe(seqMeta.solverType)
      expect(meta.iterations).toBe(seqMeta.iterations)
      expect(meta.iterations).toBeGreaterThan(0)
      expect(meta.routeCount).toBe(seqMeta.routeCount)
      expect(meta.nodePf).toBe(seqMeta.nodePf)
    }

    // Routes per connection: same multiset (coverage, not byte equality).
    const routesPerConnection = (routes: HighDensityIntraNodeRoute[]) => {
      const counts: Record<string, number> = {}
      for (const route of routes) {
        counts[route.connectionName] = (counts[route.connectionName] ?? 0) + 1
      }
      return counts
    }
    expect(routesPerConnection(par.routes)).toEqual(
      routesPerConnection(seq.routes),
    )

    // Stats parity.
    const sumValues = (rec: Record<string, number>) =>
      Object.values(rec).reduce((sum, count) => sum + count, 0)
    expect(sumValues(par.stats.solverNodeCount)).toBe(NODES.length)
    expect(sumValues(seq.stats.solverNodeCount)).toBe(NODES.length)
    expect(Object.values(par.stats.difficultNodePfs).flat().sort()).toEqual(
      Object.values(seq.stats.difficultNodePfs).flat().sort(),
    )
    expect(par.stats.highDensityResizeCount).toBe(
      seq.stats.highDensityResizeCount,
    )
    // Worker-aggregated cache counters exist on the parallel path.
    expect(par.stats.intraNodeCacheMisses).toBeGreaterThan(0)

    // visualize() emits the same node-boundary markers on the parallel path
    // (4 boundary lines + 1 center point per solved node).
    const markerCounts = (solver: HighDensitySolver) => {
      const viz = solver.visualize()
      return {
        boundaries:
          viz.lines?.filter((line) => line.layer === "hd_node_boundaries")
            .length ?? 0,
        points:
          viz.points?.filter((point) =>
            point.label?.includes("hd_node_marker"),
          ).length ?? 0,
      }
    }
    expect(markerCounts(par)).toEqual(markerCounts(seq))
    expect(markerCounts(par).boundaries).toBe(4 * NODES.length)
    expect(markerCounts(par).points).toBe(NODES.length)
  } finally {
    if (savedFlag === undefined) delete process.env.TS_PARALLEL_HD_NODES
    else process.env.TS_PARALLEL_HD_NODES = savedFlag
  }
})
