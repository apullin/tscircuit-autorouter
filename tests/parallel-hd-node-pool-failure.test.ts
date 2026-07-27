import { expect, test } from "bun:test"
import {
  destroyHdNodePool,
  getHdNodePool,
  HdNodePool,
} from "lib/parallel/hdNodePool"
import { HighDensitySolver } from "lib/solvers/HighDensitySolver/HighDensitySolver"
import type { NodeWithPortPoints } from "lib/types/high-density-types"

const goodNode = (id: string): NodeWithPortPoints => ({
  capacityMeshNodeId: id,
  portPoints: [
    { x: 0, y: 0, z: 0, connectionName: `conn_${id}` },
    { x: 0.5, y: 0.5, z: 0, connectionName: `conn_${id}` },
  ],
  center: { x: 0.25, y: 0.25 },
  width: 1,
  height: 1,
})

test("worker-side node failure surfaces as failed without hanging", () => {
  const savedFlag = process.env.TS_PARALLEL_HD_NODES
  process.env.TS_PARALLEL_HD_NODES = "2"
  try {
    // portPoints: null makes the worker's solver construction throw
    // (for-of over null) — the worker reports status 4 instead of hanging.
    // Cast reason: deliberately malformed input to exercise the error path.
    const badNode = {
      capacityMeshNodeId: "cn_bad",
      portPoints: null,
      center: { x: 0, y: 0 },
      width: 1,
      height: 1,
    } as unknown as NodeWithPortPoints
    const solver = new HighDensitySolver({
      nodePortPoints: [goodNode("cn_good1"), goodNode("cn_good2"), badNode],
    })
    solver.solve()

    expect(solver.failed).toBe(true)
    expect(solver.error).toContain("cn_bad")
    expect(solver.failedSolvers.length).toBe(1)
    expect(
      solver.failedSolvers[0]!.nodeWithPortPoints.capacityMeshNodeId,
    ).toBe("cn_bad")
    expect(solver.nodeSolveMetadataById.get("cn_bad")?.status).toBe("failed")
    expect(solver.nodeSolveMetadataById.get("cn_bad")?.error).toBeTruthy()
    // The healthy nodes still solved and were recorded.
    expect(solver.nodeSolveMetadataById.get("cn_good1")?.status).toBe("solved")
    expect(solver.nodeSolveMetadataById.get("cn_good2")?.status).toBe("solved")
    expect(solver.routes.length).toBeGreaterThan(0)
  } finally {
    if (savedFlag === undefined) delete process.env.TS_PARALLEL_HD_NODES
    else process.env.TS_PARALLEL_HD_NODES = savedFlag
  }
}, 30_000)

test("a worker dying mid-task poisons the pool; a fresh pool is served after destroy", async () => {
  const pool = getHdNodePool(1, {})
  try {
    // Occupy the single worker. busyWith is cleared only when the result is
    // harvested via poll(), so the worker is "mid-task" even if it finished.
    expect(pool.tryDispatch(goodNode("cn_real"))).toBe(true)
    // Cast reason: reaching the pool's private worker handle to simulate an
    // unexpected worker exit (the same hook the close listener uses).
    const workers = (pool as unknown as { workers: { worker: Worker }[] })
      .workers
    const worker = workers[0]!.worker
    // Await the real close event, not a timer. The pool's own close listener
    // was attached in the constructor, so it marks the worker fatal before
    // this listener fires.
    const { promise: closed, resolve: onClosed } =
      Promise.withResolvers<unknown>()
    worker.addEventListener("close", onClosed)
    worker.terminate()
    await closed
    expect(() => pool.poll()).toThrow(/exited mid-task/i)
  } finally {
    destroyHdNodePool()
  }
  // The next solve must get a fresh, usable pool (WINS.md 2026-07-26 item 2).
  const fresh = getHdNodePool(1, {})
  try {
    expect(fresh.size).toBe(1)
    expect(fresh.tryDispatch(goodNode("cn_fresh"))).toBe(true)
  } finally {
    destroyHdNodePool()
  }
}, 30_000)

test("a fatal worker makes every pool operation throw", () => {
  const pool = new HdNodePool(1, {})
  try {
    // Cast reason: white-box injection of the fatal state the error/close
    // listeners would set, to exercise throwIfFatal synchronously.
    const workers = (pool as unknown as { workers: { fatal: Error | null }[] })
      .workers
    workers[0]!.fatal = new Error("injected fatal")
    expect(() => pool.poll()).toThrow("injected fatal")
    expect(() => pool.tryDispatch(goodNode("cn_x"))).toThrow("injected fatal")
    expect(() => pool.waitForAny(1)).toThrow("injected fatal")
  } finally {
    pool.terminate()
  }
})
