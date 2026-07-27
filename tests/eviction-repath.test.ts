import { describe, expect, test } from "bun:test"
import type {
  NodeWithPortPoints,
  PortPoint,
} from "../lib/types/high-density-types"
import {
  applyEvictionPlan,
  buildNodeRectIndex,
  DEFAULT_EVICTION_TUNABLES,
  getEvictableVictims,
  placeNewPointOnEdge,
  selectEvictionPlan,
} from "../lib/solvers/HighDensitySolver/evictionRepath"
import { getConnectionPortPointPairs } from "../lib/utils/getConnectionPortPointPairs"

let ppCounter = 0
const pp = (
  partial: Partial<PortPoint> & { x: number; y: number },
): PortPoint =>
  ({
    portPointId: `pp-${ppCounter++}`,
    z: 0,
    ...partial,
  }) as PortPoint

const node = (
  id: string,
  cx: number,
  cy: number,
  w: number,
  h: number,
  portPoints: PortPoint[] = [],
): NodeWithPortPoints => ({
  capacityMeshNodeId: id,
  center: { x: cx, y: cy },
  width: w,
  height: h,
  portPoints,
})

/**
 * L-tiling: X [0,1]x[0,1]; A (tall right neighbor) [1,2]x[0,2];
 * B (above X) [0,1]x[1,2]. Edges: X|A vertical x=1 y[0,1],
 * X|B horizontal y=1 x[0,1], A|B vertical x=1 y[1,2].
 */
const buildLTiling = () => {
  ppCounter = 0
  // Victim net1 crosses X: enters from A at p1 (1,0.5), leaves to B at p2 (0.5,1).
  const p1x = pp({
    x: 1,
    y: 0.5,
    connectionName: "net1",
    prevPortPointId: "ext-a",
    nextPortPointId: "p2",
  })
  const p2x = pp({
    x: 0.5,
    y: 1,
    connectionName: "net1",
    prevPortPointId: "p1",
    nextPortPointId: "ext-b",
  })
  p1x.portPointId = "p1"
  p2x.portPointId = "p2"
  // Neighbor copies (per-node copies carry the same id).
  const p1a: PortPoint = {
    ...p1x,
    nextPortPointId: undefined,
    prevPortPointId: "ext-a",
  }
  const p2b: PortPoint = {
    ...p2x,
    prevPortPointId: undefined,
    nextPortPointId: "ext-b",
  }
  const X = node("X", 0.5, 0.5, 1, 1, [p1x, p2x])
  X.portPointsInPairs = [[p1x, p2x]]
  const A = node("A", 1.5, 1, 1, 2, [p1a])
  const B = node("B", 0.5, 1.5, 1, 1, [p2b])
  return { X, A, B, p1x, p2x, p1a, p2b }
}

describe("buildNodeRectIndex", () => {
  test("derives shared edges from the node tiling", () => {
    const { X, A, B } = buildLTiling()
    const index = buildNodeRectIndex([X, A, B])
    expect(index.edgeByPair.get("A|X")).toMatchObject({
      orientation: "vertical",
      fixed: 1,
      lo: 0,
      hi: 1,
    })
    expect(index.edgeByPair.get("B|X")).toMatchObject({
      orientation: "horizontal",
      fixed: 1,
      lo: 0,
      hi: 1,
    })
    expect(index.edgeByPair.get("A|B")).toMatchObject({
      orientation: "vertical",
      fixed: 1,
      lo: 1,
      hi: 2,
    })
    expect(index.portOwnerById.get("p1")!.sort()).toEqual(["A", "X"])
    expect(index.portOwnerById.get("p2")!.sort()).toEqual(["B", "X"])
  })

  test("point-touching diagonal nodes are NOT adjacent", () => {
    ppCounter = 0
    const X = node("X", 0.5, 0.5, 1, 1)
    const C = node("C", 1.5, 1.5, 1, 1) // touches X only at corner (1,1)
    const index = buildNodeRectIndex([X, C])
    expect(index.edgeByPair.get("C|X")).toBeUndefined()
    expect(index.edgesByNode.get("X")).toEqual([])
  })
})

describe("getEvictableVictims", () => {
  test("pass-through connection is evictable", () => {
    const { X } = buildLTiling()
    const victims = getEvictableVictims(X)
    expect(victims.map((v) => v.connectionName)).toEqual(["net1"])
    expect(victims[0]!.fragments).toHaveLength(1)
  })

  test("marked terminals excluded here; unmarked chain ends rejected at plan time", () => {
    ppCounter = 0
    const t1 = pp({
      x: 0.5,
      y: 0.5,
      connectionName: "net-term",
      pcb_port_id: "pcb1",
      prevPortPointId: "e1",
      nextPortPointId: "e2",
    })
    const t2 = pp({
      x: 0.6,
      y: 0.6,
      connectionName: "net-term",
      prevPortPointId: "e1",
      nextPortPointId: "e3",
    })
    // Unmarked chain end: e1 has no nextPortPointId and — decisive at plan
    // time — exists in NO other node's list (sole ownership).
    const e1 = pp({
      x: 0.1,
      y: 1,
      connectionName: "net-end",
      prevPortPointId: "out",
    })
    const e2 = pp({
      x: 0.9,
      y: 1,
      connectionName: "net-end",
      prevPortPointId: "out2",
      nextPortPointId: "out3",
    })
    e1.portPointId = "e1p"
    e2.portPointId = "e2p"
    e2.prevPortPointId = "e1p"
    const X = node("X", 0.5, 0.5, 1, 1, [t1, t2, e1, e2])
    // Marked terminal connection is filtered out; the unmarked chain-end
    // connection still surfaces as a candidate here.
    expect(getEvictableVictims(X).map((v) => v.connectionName)).toEqual([
      "net-end",
    ])
    // ...but cannot be planned: its points have no adjacent owner.
    const index = buildNodeRectIndex([X])
    expect(selectEvictionPlan(index, "X", DEFAULT_EVICTION_TUNABLES)).toBeNull()
  })
})

describe("placeNewPointOnEdge", () => {
  test("empty edge: midpoint, respecting end margins", () => {
    const { X, A, B } = buildLTiling()
    const index = buildNodeRectIndex([X, A, B])
    const edge = index.edgeByPair.get("A|B")!
    const at = placeNewPointOnEdge(index, edge, 0, 0.4)!
    expect(at).toEqual({ x: 1, y: 1.5 })
  })

  test("occupied edge: widest gap wins; too-tight edge returns null", () => {
    ppCounter = 0
    const occ = pp({ x: 1, y: 1.2, connectionName: "other", z: 0 })
    occ.portPointId = "occ"
    const A = node("A", 1.5, 1, 1, 2, [occ])
    const B = node("B", 0.5, 1.5, 1, 1)
    const X = node("X", 0.5, 0.5, 1, 1)
    const index = buildNodeRectIndex([X, A, B])
    const edge = index.edgeByPair.get("A|B")! // y in [1,2], occupied at 1.2
    // Gaps: [1.2+0.45, 2-0.225] = [1.65,1.775] -> mid ~1.7125
    const at = placeNewPointOnEdge(index, edge, 0, 0.45)!
    expect(at.x).toBe(1)
    expect(at.y).toBeCloseTo((1.65 + 1.775) / 2, 6)
    // No room at huge spacing.
    expect(placeNewPointOnEdge(index, edge, 0, 2)).toBeNull()
    // The occupant is on z=0; z=1 sees an empty edge.
    expect(placeNewPointOnEdge(index, edge, 1, 0.4)).toEqual({ x: 1, y: 1.5 })
  })
})

describe("selectEvictionPlan + applyEvictionPlan", () => {
  test("direct detour inserts one point on the A|B edge and splices chains", () => {
    const { X, A, B, p1a, p2b } = buildLTiling()
    const index = buildNodeRectIndex([X, A, B])
    const plan = selectEvictionPlan(index, "X", {
      ...DEFAULT_EVICTION_TUNABLES,
      minPortPointSpacing: 0.4,
    })!
    expect(plan).not.toBeNull()
    expect(plan.connectionName).toBe("net1")
    expect(plan.moves).toHaveLength(1)
    expect(plan.moves[0]!.hostIds).toEqual(["A", "B"])
    expect(plan.moves[0]!.insertions).toHaveLength(1)
    expect(plan.moves[0]!.insertions[0]).toMatchObject({ x: 1, y: 1.5, z: 0 })

    let q = 0
    const applied = applyEvictionPlan(index, plan, () => `q-${q++}`)
    expect(applied.recipientNodeIds.sort()).toEqual(["A", "B"])
    expect(applied.newPortPointIds).toEqual(["q-0"])

    // X lost the victim entirely.
    expect(X.portPoints).toHaveLength(0)
    expect(X.portPointsInPairs).toHaveLength(0)

    // A: fragment (p1 -> q-0); B: fragment (q-0 -> p2).
    expect(A.portPoints.map((p) => p.portPointId).sort()).toEqual(["p1", "q-0"])
    expect(B.portPoints.map((p) => p.portPointId).sort()).toEqual(["p2", "q-0"])
    expect(p1a.nextPortPointId).toBe("q-0")
    expect(p2b.prevPortPointId).toBe("q-0")
    const qInA = A.portPoints.find((p) => p.portPointId === "q-0")!
    const qInB = B.portPoints.find((p) => p.portPointId === "q-0")!
    expect(qInA.prevPortPointId).toBe("p1")
    expect(qInA.nextPortPointId).toBeUndefined()
    expect(qInB.nextPortPointId).toBe("p2")
    expect(qInB.prevPortPointId).toBeUndefined()
    expect(qInA.x).toBe(qInB.x)
    expect(qInA.y).toBe(qInB.y)

    // Pairs appended in each recipient; pairing util re-derives the same.
    expect(
      A.portPointsInPairs!.map(([a, b]) => [a.portPointId, b.portPointId]),
    ).toEqual([["p1", "q-0"]])
    expect(
      B.portPointsInPairs!.map(([a, b]) => [a.portPointId, b.portPointId]),
    ).toEqual([["q-0", "p2"]])
    expect(
      getConnectionPortPointPairs(
        A.portPoints.filter((p) => p.connectionName === "net1"),
      ).map(([a, b]) => [a.portPointId, b.portPointId]),
    ).toEqual([["p1", "q-0"]])
    expect(
      getConnectionPortPointPairs(
        B.portPoints.filter((p) => p.connectionName === "net1"),
      ).map(([a, b]) => [a.portPointId, b.portPointId]),
    ).toEqual([["q-0", "p2"]])

    // New point ownership registered for later detours.
    expect(index.portOwnerById.get("q-0")!.sort()).toEqual(["A", "B"])
  })

  test("wholesale move when both endpoints border the same neighbor", () => {
    ppCounter = 0
    // net crosses X with both endpoints on the X|A edge.
    const p3x = pp({
      x: 1,
      y: 0.3,
      connectionName: "net1",
      prevPortPointId: "ext1",
      nextPortPointId: "p4",
    })
    const p4x = pp({
      x: 1,
      y: 0.7,
      connectionName: "net1",
      prevPortPointId: "p3",
      nextPortPointId: "ext2",
    })
    p3x.portPointId = "p3"
    p4x.portPointId = "p4"
    const p3a: PortPoint = { ...p3x, nextPortPointId: undefined }
    const p4a: PortPoint = { ...p4x, prevPortPointId: undefined }
    const X = node("X", 0.5, 0.5, 1, 1, [p3x, p4x])
    X.portPointsInPairs = [[p3x, p4x]]
    const A = node("A", 1.5, 1, 1, 2, [p3a, p4a])
    const index = buildNodeRectIndex([X, A])

    const plan = selectEvictionPlan(index, "X", DEFAULT_EVICTION_TUNABLES)!
    expect(plan.moves[0]!.hostIds).toEqual(["A"])
    expect(plan.moves[0]!.insertions).toHaveLength(0)

    const applied = applyEvictionPlan(index, plan, () => "q-never")
    expect(applied.newPortPointIds).toEqual([])
    expect(X.portPoints).toHaveLength(0)
    expect(A.portPoints).toHaveLength(2) // no insertions, points already present
    expect(p3a.nextPortPointId).toBe("p4")
    expect(p4a.prevPortPointId).toBe("p3")
    expect(
      A.portPointsInPairs!.map(([a, b]) => [a.portPointId, b.portPointId]),
    ).toEqual([["p3", "p4"]])
  })

  test("two-hop detour through an intermediate node when neighbors are diagonal", () => {
    ppCounter = 0
    // 2x2 grid: X bottom-left, A right of X, B above X, C diagonal.
    const p1x = pp({
      x: 1,
      y: 0.5,
      connectionName: "net1",
      prevPortPointId: "ext-a",
      nextPortPointId: "p2",
    })
    const p2x = pp({
      x: 0.5,
      y: 1,
      connectionName: "net1",
      prevPortPointId: "p1",
      nextPortPointId: "ext-b",
    })
    p1x.portPointId = "p1"
    p2x.portPointId = "p2"
    const p1a: PortPoint = { ...p1x, nextPortPointId: undefined }
    const p2b: PortPoint = { ...p2x, prevPortPointId: undefined }
    const X = node("X", 0.5, 0.5, 1, 1, [p1x, p2x])
    X.portPointsInPairs = [[p1x, p2x]]
    const A = node("A", 1.5, 0.5, 1, 1, [p1a])
    const B = node("B", 0.5, 1.5, 1, 1, [p2b])
    const C = node("C", 1.5, 1.5, 1, 1)
    const index = buildNodeRectIndex([X, A, B, C])

    const plan = selectEvictionPlan(index, "X", {
      ...DEFAULT_EVICTION_TUNABLES,
      minPortPointSpacing: 0.4,
    })!
    expect(plan.moves[0]!.hostIds).toEqual(["A", "C", "B"])
    expect(plan.moves[0]!.insertions).toHaveLength(2)

    let q = 0
    applyEvictionPlan(index, plan, () => `q-${q++}`)
    expect(X.portPoints).toHaveLength(0)
    expect(p1a.nextPortPointId).toBe("q-0")
    expect(p2b.prevPortPointId).toBe("q-1")
    expect(C.portPoints.map((p) => p.portPointId).sort()).toEqual([
      "q-0",
      "q-1",
    ])
    expect(
      C.portPointsInPairs!.map(([a, b]) => [a.portPointId, b.portPointId]),
    ).toEqual([["q-0", "q-1"]])
    const cPairs = getConnectionPortPointPairs(C.portPoints)
    expect(cPairs.map(([a, b]) => [a.portPointId, b.portPointId])).toEqual([
      ["q-0", "q-1"],
    ])
  })

  test("layer-changing fragments and cascade-excluded recipients reject", () => {
    ppCounter = 0
    // Fragment changes z inside X -> victim not plannable.
    const p1x = pp({
      x: 1,
      y: 0.5,
      connectionName: "net1",
      z: 0,
      prevPortPointId: "ext-a",
      nextPortPointId: "p2",
    })
    const p2x = pp({
      x: 0.5,
      y: 1,
      connectionName: "net1",
      z: 1,
      prevPortPointId: "p1",
      nextPortPointId: "ext-b",
    })
    p1x.portPointId = "p1"
    p2x.portPointId = "p2"
    const p1a: PortPoint = { ...p1x, nextPortPointId: undefined }
    const p2b: PortPoint = { ...p2x, prevPortPointId: undefined }
    const X = node("X", 0.5, 0.5, 1, 1, [p1x, p2x])
    X.portPointsInPairs = [[p1x, p2x]]
    const A = node("A", 1.5, 1, 1, 2, [p1a])
    const B = node("B", 0.5, 1.5, 1, 1, [p2b])
    const index = buildNodeRectIndex([X, A, B])
    expect(selectEvictionPlan(index, "X", DEFAULT_EVICTION_TUNABLES)).toBeNull()

    // Cascade cap: excluding recipients leaves no plan.
    const tiling2 = buildLTiling()
    const index2 = buildNodeRectIndex([tiling2.X, tiling2.A, tiling2.B])
    expect(
      selectEvictionPlan(
        index2,
        "X",
        DEFAULT_EVICTION_TUNABLES,
        new Set(["A"]),
      ),
    ).toBeNull()
  })
})
