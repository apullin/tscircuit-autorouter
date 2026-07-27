/**
 * Eviction + re-path machinery for the high-density stage (TS_EVICT_REPATH=1).
 *
 * Design: perf-artifacts/g6-eviction-design.md. Doomed nodes are
 * over-committed, not unroutable (40/40 rescued by one removal, 77% of single
 * removals work — exp/rewrites 270ca10e). Instead of growing the node
 * (GrowShrink 2x/4x/8x, which moves the work to a bigger scale and produces
 * 48x-enriched DRC violations when compressed back), evict ONE connection
 * out of the node: re-path its fragments through adjacent nodes and re-solve
 * the trimmed node at scale 1.
 *
 * Mechanics contract (verified against TinyHypergraphPortPointPathingSolver
 * getOutput + UniformPortDistributionSolver):
 * - Port points on a shared node edge are materialized as PER-NODE COPIES
 *   carrying the same portPointId in both adjacent nodes' lists.
 * - Each copy carries exactly ONE prev/next link: a fragment's start point
 *   has nextPortPointId, its end point has prevPortPointId (verified on
 *   srj18 sample 8: 4834/4834 points have exactly one link, zero have
 *   both). Global chain links are NOT materialized. Terminals are therefore
 *   detected by OWNERSHIP — a chain end exists in exactly one node's list,
 *   while a boundary crossing exists in both adjacent nodes' lists.
 * - getConnectionPortPointPairs resolves links within one list.
 * - HD solvers read only x/y/z/ids/links from port points — a NEW point may
 *   be inserted on an edge without re-running redistribution, as long as
 *   existing points never move (re-redistributing an edge would invalidate
 *   already-solved neighbors).
 *
 * Everything here is pure data transformation; the driver (HighDensitySolver)
 * owns scheduling, re-solves and fallback policy.
 */
import type {
  NodeWithPortPoints,
  PortPoint,
} from "lib/types/high-density-types"
import { getConnectionPortPointPairs } from "lib/utils/getConnectionPortPointPairs"

const EPS = 1e-6
/** Positional tolerance for "point lies on this edge" (post-redistribution). */
const EDGE_HIT_TOLERANCE = 1e-4

export type EvictionTunables = {
  /** Eviction attempts per doomed node before growth proceeds (K). */
  maxAttemptsPerNode: number
  /** 1 = direct shared edge only, 2 = allow one intermediate node. */
  maxDetourHops: number
  /** Min distance of an inserted point to existing points on the edge+z. */
  minPortPointSpacing: number
  /** Max evictions per board. */
  globalBudget: number
  /**
   * Growth failures required before eviction is offered: 0 = evict as soon
   * as the scale-1 portfolio exhausts; 1 = only after the 2x attempt also
   * fails. The measured trade (s8): nodes that 2x-growth rescues cleanly are
   * a net LOSS under eviction (detour violations + recipient re-solves
   * exceed one 2x solve), so the default targets the straggler class
   * (4x/8x growth) where growth is already failing.
   */
  evictAfterGrowthFailures: number
}

export const DEFAULT_EVICTION_TUNABLES: EvictionTunables = {
  maxAttemptsPerNode: 2,
  maxDetourHops: 2,
  minPortPointSpacing: 0.45,
  globalBudget: 64,
  evictAfterGrowthFailures: 1,
}

export const evictionRepathEnabled = (): boolean => {
  if (typeof process === "undefined") return false
  return Number(process.env.TS_EVICT_REPATH ?? 0) > 0
}

export const readEvictionTunables = (): EvictionTunables => {
  const fallback = DEFAULT_EVICTION_TUNABLES
  if (typeof process === "undefined") return fallback
  const num = (name: string, defaultValue: number) => {
    const value = Number(process.env[name])
    return Number.isFinite(value) && value > 0 ? value : defaultValue
  }
  return {
    maxAttemptsPerNode: num(
      "TS_EVICT_MAX_ATTEMPTS",
      fallback.maxAttemptsPerNode,
    ),
    maxDetourHops: num("TS_EVICT_MAX_HOPS", fallback.maxDetourHops),
    minPortPointSpacing: num(
      "TS_EVICT_MIN_SPACING",
      fallback.minPortPointSpacing,
    ),
    globalBudget: num("TS_EVICT_BUDGET", fallback.globalBudget),
    evictAfterGrowthFailures: num(
      "TS_EVICT_AFTER_GROWTH_FAILURES",
      fallback.evictAfterGrowthFailures,
    ),
  }
}

export type DetourEdge = {
  aId: string
  bId: string
  /** "horizontal": line y=fixed, position varies in x. "vertical": x=fixed. */
  orientation: "horizontal" | "vertical"
  fixed: number
  lo: number
  hi: number
}

export type NodeRectIndex = {
  nodesById: Map<string, NodeWithPortPoints>
  /** portPointId -> ids of nodes whose portPoints list contains a copy. */
  portOwnerById: Map<string, string[]>
  edgesByNode: Map<string, DetourEdge[]>
  edgeByPair: Map<string, DetourEdge>
}

const edgePairKey = (a: string, b: string) =>
  a < b ? `${a}|${b}` : `${b}|${a}`

type Rect = { minX: number; maxX: number; minY: number; maxY: number }

/**
 * Builds adjacency + port ownership over the FINAL node set (rects tile the
 * board; grown nodes do not exist at HD input time). O(N^2) rect scan, run
 * once per HD stage — ~1.4M cheap comparisons at 1200 nodes, single-digit ms.
 */
export const buildNodeRectIndex = (
  nodes: NodeWithPortPoints[],
): NodeRectIndex => {
  const nodesById = new Map<string, NodeWithPortPoints>()
  const portOwnerById = new Map<string, string[]>()
  const edgesByNode = new Map<string, DetourEdge[]>()
  const edgeByPair = new Map<string, DetourEdge>()
  const rects: Rect[] = []

  for (const node of nodes) {
    nodesById.set(node.capacityMeshNodeId, node)
    edgesByNode.set(node.capacityMeshNodeId, [])
    rects.push({
      minX: node.center.x - node.width / 2,
      maxX: node.center.x + node.width / 2,
      minY: node.center.y - node.height / 2,
      maxY: node.center.y + node.height / 2,
    })
    for (const point of node.portPoints) {
      if (!point.portPointId) continue
      const owners = portOwnerById.get(point.portPointId)
      if (owners) owners.push(node.capacityMeshNodeId)
      else portOwnerById.set(point.portPointId, [node.capacityMeshNodeId])
    }
  }

  const addEdge = (edge: DetourEdge) => {
    edgeByPair.set(edgePairKey(edge.aId, edge.bId), edge)
    edgesByNode.get(edge.aId)!.push(edge)
    edgesByNode.get(edge.bId)!.push(edge)
  }

  for (let i = 0; i < nodes.length; i++) {
    const a = rects[i]!
    const aId = nodes[i]!.capacityMeshNodeId
    for (let j = i + 1; j < nodes.length; j++) {
      const b = rects[j]!
      const bId = nodes[j]!.capacityMeshNodeId
      // Vertical shared line (x = fixed): a left of b, or b left of a.
      for (const [fixed, swapped] of [
        [a.maxX, false],
        [a.minX, true],
      ] as Array<[number, boolean]>) {
        const other = swapped ? b.maxX : b.minX
        if (Math.abs(fixed - other) > EPS) continue
        const lo = Math.max(a.minY, b.minY)
        const hi = Math.min(a.maxY, b.maxY)
        if (hi - lo <= EPS) continue
        const leftId = swapped ? bId : aId
        const rightId = swapped ? aId : bId
        addEdge({
          aId: leftId,
          bId: rightId,
          orientation: "vertical",
          fixed,
          lo,
          hi,
        })
      }
      // Horizontal shared line (y = fixed): a below b, or b below a.
      for (const [fixed, swapped] of [
        [a.maxY, false],
        [a.minY, true],
      ] as Array<[number, boolean]>) {
        const other = swapped ? b.maxY : b.minY
        if (Math.abs(fixed - other) > EPS) continue
        const lo = Math.max(a.minX, b.minX)
        const hi = Math.min(a.maxX, b.maxX)
        if (hi - lo <= EPS) continue
        const belowId = swapped ? bId : aId
        const aboveId = swapped ? aId : bId
        addEdge({
          aId: belowId,
          bId: aboveId,
          orientation: "horizontal",
          fixed,
          lo,
          hi,
        })
      }
    }
  }

  return { nodesById, portOwnerById, edgesByNode, edgeByPair }
}

export type VictimCandidate = {
  connectionName: string
  rootConnectionName?: string
  fragments: Array<[PortPoint, PortPoint]>
}

/**
 * Connections of the node that can leave it: every fragment is a pass-through
 * (no terminal endpoint inside the node) with complete pairing.
 *
 * A connection whose chain ENDS inside the node cannot be evicted — its
 * endpoint must still be reached. Marked terminals (pcb_port_id) are
 * excluded here; unmarked chain ends are excluded at plan time because a
 * chain end has exactly one owner (no adjacent node shares its portPointId),
 * which fails the soleOtherOwner requirement of every detour.
 *
 * Fragments come from portPointsInPairs (the authoritative pairing consumed
 * by the solvers; every point carries only its own intra-fragment link, so
 * cross-fragment chain walking is impossible here). Each point must appear
 * in exactly ONE fragment: surgery replaces whole fragments (drop-one
 * semantics), and a point shared between fragments would be re-spliced
 * twice.
 */
export const getEvictableVictims = (
  node: NodeWithPortPoints,
): VictimCandidate[] => {
  const byConnection = new Map<string, PortPoint[]>()
  for (const point of node.portPoints) {
    const group = byConnection.get(point.connectionName)
    if (group) group.push(point)
    else byConnection.set(point.connectionName, [point])
  }

  const victims: VictimCandidate[] = []
  for (const [connectionName, points] of byConnection) {
    if (points.some((p) => p.pcb_port_id !== undefined)) continue
    if (points.some((p) => !p.portPointId)) continue
    const fragments = (
      node.portPointsInPairs
        ? node.portPointsInPairs.filter(
            ([a]) => a.connectionName === connectionName,
          )
        : getConnectionPortPointPairs(points)
    ) as Array<[PortPoint, PortPoint]>
    if (fragments.length === 0) continue
    const fragmentCountByPointId = new Map<string, number>()
    for (const [a, b] of fragments) {
      for (const p of [a, b]) {
        if (!p.portPointId) continue
        fragmentCountByPointId.set(
          p.portPointId,
          (fragmentCountByPointId.get(p.portPointId) ?? 0) + 1,
        )
      }
    }
    if (
      !points.every((p) => fragmentCountByPointId.get(p.portPointId!) === 1)
    ) {
      continue
    }
    victims.push({
      connectionName,
      rootConnectionName: points[0]!.rootConnectionName,
      fragments,
    })
  }
  victims.sort((a, b) => a.connectionName.localeCompare(b.connectionName))
  return victims
}

export type DetourMove = {
  /** The doomed node's copies of the fragment endpoints. */
  from: PortPoint
  to: PortPoint
  /**
   * Nodes receiving a fragment for this move, in chain order:
   * [W] (both endpoints border the same node), [Wfrom, Wto] (one inserted
   * point on their shared edge), or [Wfrom, M, Wto] (two-hop detour).
   */
  hostIds: string[]
  insertions: Array<{ edge: DetourEdge; x: number; y: number; z: number }>
}

export type EvictionPlan = {
  doomedNodeId: string
  connectionName: string
  moves: DetourMove[]
  /** Lower is preferred: recipient congestion + insertion penalty. */
  score: number
}

/** Sorted positions (along the edge axis) of existing points on edge+z. */
const occupiedPositionsOnEdge = (
  index: NodeRectIndex,
  edge: DetourEdge,
  z: number,
): number[] => {
  const seen = new Set<string>()
  const positions: number[] = []
  for (const nodeId of [edge.aId, edge.bId]) {
    const node = index.nodesById.get(nodeId)
    if (!node) continue
    for (const point of node.portPoints) {
      if ((point.z ?? 0) !== z) continue
      const fixedCoord = edge.orientation === "horizontal" ? point.y : point.x
      if (Math.abs(fixedCoord - edge.fixed) > EDGE_HIT_TOLERANCE) continue
      const along = edge.orientation === "horizontal" ? point.x : point.y
      if (along < edge.lo - EDGE_HIT_TOLERANCE) continue
      if (along > edge.hi + EDGE_HIT_TOLERANCE) continue
      const key = point.portPointId ?? `${nodeId}:${along.toFixed(6)}`
      if (seen.has(key)) continue
      seen.add(key)
      positions.push(along)
    }
  }
  return positions.sort((a, b) => a - b)
}

/**
 * Picks a position for a NEW point on the edge: midpoint of the widest
 * spacing-respecting interval. Existing points are never moved (that would
 * invalidate solved neighbors); edge ends keep a half-spacing margin,
 * mirroring the uniform redistribution's (2i+1)/2N end margins.
 */
export const placeNewPointOnEdge = (
  index: NodeRectIndex,
  edge: DetourEdge,
  z: number,
  minSpacing: number,
): { x: number; y: number } | null => {
  const occupied = occupiedPositionsOnEdge(index, edge, z)
  const endMargin = minSpacing / 2
  let bestMid: number | null = null
  let bestWidth = 0
  let gapStart = edge.lo + endMargin
  for (const taken of [...occupied, edge.hi]) {
    const isEnd = taken === edge.hi
    const gapEnd = isEnd ? taken - endMargin : taken - minSpacing
    const width = gapEnd - gapStart
    if (width > bestWidth) {
      bestWidth = width
      bestMid = (gapStart + gapEnd) / 2
    }
    gapStart = isEnd ? gapStart : taken + minSpacing
  }
  if (bestMid === null || bestWidth <= EPS) return null
  return edge.orientation === "horizontal"
    ? { x: bestMid, y: edge.fixed }
    : { x: edge.fixed, y: bestMid }
}

const zAllowedOnNode = (
  index: NodeRectIndex,
  nodeId: string,
  z: number,
): boolean => {
  const node = index.nodesById.get(nodeId)
  if (!node) return false
  if (!node.availableZ || node.availableZ.length === 0) return true
  return node.availableZ.includes(z)
}

/** The unique node besides `doomedNodeId` owning a copy of the point. */
const soleOtherOwner = (
  index: NodeRectIndex,
  portPointId: string,
  doomedNodeId: string,
): string | null => {
  const owners = index.portOwnerById.get(portPointId)
  if (!owners) return null
  const others = owners.filter((id) => id !== doomedNodeId)
  return others.length === 1 ? others[0]! : null
}

const neighborIdsOf = (index: NodeRectIndex, nodeId: string): string[] =>
  (index.edgesByNode.get(nodeId) ?? []).map((edge) =>
    edge.aId === nodeId ? edge.bId : edge.aId,
  )

const planFragmentDetour = (
  index: NodeRectIndex,
  doomedNodeId: string,
  from: PortPoint,
  to: PortPoint,
  tunables: EvictionTunables,
): DetourMove | null => {
  // A fragment that changes layer inside the node cannot detour locally.
  if ((from.z ?? 0) !== (to.z ?? 0)) return null
  const z = from.z ?? 0
  const wFrom = soleOtherOwner(index, from.portPointId!, doomedNodeId)
  const wTo = soleOtherOwner(index, to.portPointId!, doomedNodeId)
  if (!wFrom || !wTo) return null
  if (!zAllowedOnNode(index, wFrom, z) || !zAllowedOnNode(index, wTo, z)) {
    return null
  }

  // Both endpoints border the same neighbor: the fragment moves wholesale.
  if (wFrom === wTo) return { from, to, hostIds: [wFrom], insertions: [] }

  // Direct detour: one new point on the shared edge Wfrom|Wto.
  const direct = index.edgeByPair.get(edgePairKey(wFrom, wTo))
  if (direct) {
    const at = placeNewPointOnEdge(
      index,
      direct,
      z,
      tunables.minPortPointSpacing,
    )
    if (at) {
      return {
        from,
        to,
        hostIds: [wFrom, wTo],
        insertions: [{ edge: direct, x: at.x, y: at.y, z }],
      }
    }
  }

  // Two-hop detour through one intermediate node.
  if (tunables.maxDetourHops >= 2) {
    const wToNeighbors = new Set(neighborIdsOf(index, wTo))
    const intermediates = neighborIdsOf(index, wFrom)
      .filter(
        (id) =>
          id !== doomedNodeId &&
          id !== wFrom &&
          id !== wTo &&
          wToNeighbors.has(id) &&
          zAllowedOnNode(index, id, z),
      )
      .sort((a, b) => {
        const loadA = index.nodesById.get(a)!.portPoints.length
        const loadB = index.nodesById.get(b)!.portPoints.length
        return loadA - loadB || a.localeCompare(b)
      })
    for (const m of intermediates) {
      const edge1 = index.edgeByPair.get(edgePairKey(wFrom, m))!
      const edge2 = index.edgeByPair.get(edgePairKey(m, wTo))!
      const at1 = placeNewPointOnEdge(
        index,
        edge1,
        z,
        tunables.minPortPointSpacing,
      )
      if (!at1) continue
      const at2 = placeNewPointOnEdge(
        index,
        edge2,
        z,
        tunables.minPortPointSpacing,
      )
      if (!at2) continue
      return {
        from,
        to,
        hostIds: [wFrom, m, wTo],
        insertions: [
          { edge: edge1, x: at1.x, y: at1.y, z },
          { edge: edge2, x: at2.x, y: at2.y, z },
        ],
      }
    }
  }

  return null
}

export const planEvictionForVictim = (
  index: NodeRectIndex,
  doomedNodeId: string,
  victim: VictimCandidate,
  tunables: EvictionTunables,
): EvictionPlan | null => {
  const moves: DetourMove[] = []
  for (const [from, to] of victim.fragments) {
    const move = planFragmentDetour(index, doomedNodeId, from, to, tunables)
    if (!move) return null
    moves.push(move)
  }
  const hostIds = new Set<string>()
  let insertionCount = 0
  for (const move of moves) {
    for (const hostId of move.hostIds) hostIds.add(hostId)
    insertionCount += move.insertions.length
  }
  let load = 0
  for (const hostId of hostIds) {
    load += index.nodesById.get(hostId)!.portPoints.length
  }
  return {
    doomedNodeId,
    connectionName: victim.connectionName,
    moves,
    score: load + 50 * insertionCount,
  }
}

/**
 * Ranks eviction plans for a doomed node. `excludedRecipients` implements the
 * cascade cap: nodes that already received an evicted connection once are not
 * eligible again (their re-solve must not become a dumping ground).
 */
export const selectEvictionPlan = (
  index: NodeRectIndex,
  doomedNodeId: string,
  tunables: EvictionTunables,
  excludedRecipients: Set<string> = new Set(),
): EvictionPlan | null => {
  const node = index.nodesById.get(doomedNodeId)
  if (!node) return null
  const plans: EvictionPlan[] = []
  for (const victim of getEvictableVictims(node)) {
    const plan = planEvictionForVictim(index, doomedNodeId, victim, tunables)
    if (!plan) continue
    if (
      plan.moves.some((move) =>
        move.hostIds.some((hostId) => excludedRecipients.has(hostId)),
      )
    ) {
      continue
    }
    plans.push(plan)
  }
  plans.sort(
    (a, b) =>
      a.score - b.score || a.connectionName.localeCompare(b.connectionName),
  )
  return plans[0] ?? null
}

export type AppliedEviction = {
  connectionName: string
  recipientNodeIds: string[]
  newPortPointIds: string[]
}

const requirePointCopy = (
  node: NodeWithPortPoints,
  portPointId: string,
): PortPoint => {
  const copy = node.portPoints.find((p) => p.portPointId === portPointId)
  if (!copy) {
    throw new Error(
      `eviction surgery: node ${node.capacityMeshNodeId} has no copy of ${portPointId}`,
    )
  }
  return copy
}

/**
 * Performs the chain surgery of an eviction plan:
 * - the doomed node loses every port point of the victim (all fragments were
 *   planned, so every point belongs to one);
 * - each recipient gains fragment pairs per the detour, with new points
 *   inserted as per-node copies carrying local prev/next links;
 * - existing points' positions are NEVER modified (solved neighbors stay
 *   valid); only link fields on the fragment endpoints change.
 *
 * `makePointId` must return globally unique, deterministic ids.
 */
export const applyEvictionPlan = (
  index: NodeRectIndex,
  plan: EvictionPlan,
  makePointId: () => string,
): AppliedEviction => {
  const doomed = index.nodesById.get(plan.doomedNodeId)!
  doomed.portPoints = doomed.portPoints.filter(
    (p) => p.connectionName !== plan.connectionName,
  )
  if (doomed.portPointsInPairs) {
    doomed.portPointsInPairs = doomed.portPointsInPairs.filter(
      ([a]) => a.connectionName !== plan.connectionName,
    )
  }

  const recipientNodeIds = new Set<string>()
  const newPortPointIds: string[] = []

  for (const move of plan.moves) {
    const fromId = move.from.portPointId!
    const toId = move.to.portPointId!
    for (const hostId of move.hostIds) recipientNodeIds.add(hostId)

    if (move.insertions.length === 0) {
      // Wholesale move: both endpoints already live in the single host.
      const host = index.nodesById.get(move.hostIds[0]!)!
      const fromCopy = requirePointCopy(host, fromId)
      const toCopy = requirePointCopy(host, toId)
      fromCopy.nextPortPointId = toId
      toCopy.prevPortPointId = fromId
      host.portPointsInPairs ??= []
      host.portPointsInPairs.push([fromCopy, toCopy])
      continue
    }

    if (move.insertions.length === 1) {
      const [wFromId, wToId] = move.hostIds as [string, string]
      const wFrom = index.nodesById.get(wFromId)!
      const wTo = index.nodesById.get(wToId)!
      const insertion = move.insertions[0]!
      const qId = makePointId()
      newPortPointIds.push(qId)
      const fromCopy = requirePointCopy(wFrom, fromId)
      const toCopy = requirePointCopy(wTo, toId)
      const qFromSide: PortPoint = {
        portPointId: qId,
        connectionName: plan.connectionName,
        rootConnectionName: move.from.rootConnectionName,
        x: insertion.x,
        y: insertion.y,
        z: insertion.z,
        prevPortPointId: fromId,
      }
      const qToSide: PortPoint = {
        portPointId: qId,
        connectionName: plan.connectionName,
        rootConnectionName: move.from.rootConnectionName,
        x: insertion.x,
        y: insertion.y,
        z: insertion.z,
        nextPortPointId: toId,
      }
      wFrom.portPoints.push(qFromSide)
      wTo.portPoints.push(qToSide)
      fromCopy.nextPortPointId = qId
      toCopy.prevPortPointId = qId
      wFrom.portPointsInPairs ??= []
      wTo.portPointsInPairs ??= []
      wFrom.portPointsInPairs.push([fromCopy, qFromSide])
      wTo.portPointsInPairs.push([qToSide, toCopy])
      index.portOwnerById.set(qId, [wFromId, wToId])
      continue
    }

    // Two-hop: hosts [wFrom, m, wTo], insertions q1 on wFrom|m, q2 on m|wTo.
    const [wFromId, mId, wToId] = move.hostIds as [string, string, string]
    const wFrom = index.nodesById.get(wFromId)!
    const m = index.nodesById.get(mId)!
    const wTo = index.nodesById.get(wToId)!
    const ins1 = move.insertions[0]!
    const ins2 = move.insertions[1]!
    const q1Id = makePointId()
    const q2Id = makePointId()
    newPortPointIds.push(q1Id, q2Id)
    const fromCopy = requirePointCopy(wFrom, fromId)
    const toCopy = requirePointCopy(wTo, toId)
    const q1FromSide: PortPoint = {
      portPointId: q1Id,
      connectionName: plan.connectionName,
      rootConnectionName: move.from.rootConnectionName,
      x: ins1.x,
      y: ins1.y,
      z: ins1.z,
      prevPortPointId: fromId,
    }
    const q1MidSide: PortPoint = {
      portPointId: q1Id,
      connectionName: plan.connectionName,
      rootConnectionName: move.from.rootConnectionName,
      x: ins1.x,
      y: ins1.y,
      z: ins1.z,
      nextPortPointId: q2Id,
    }
    const q2MidSide: PortPoint = {
      portPointId: q2Id,
      connectionName: plan.connectionName,
      rootConnectionName: move.from.rootConnectionName,
      x: ins2.x,
      y: ins2.y,
      z: ins2.z,
      prevPortPointId: q1Id,
    }
    const q2ToSide: PortPoint = {
      portPointId: q2Id,
      connectionName: plan.connectionName,
      rootConnectionName: move.from.rootConnectionName,
      x: ins2.x,
      y: ins2.y,
      z: ins2.z,
      nextPortPointId: toId,
    }
    wFrom.portPoints.push(q1FromSide)
    m.portPoints.push(q1MidSide, q2MidSide)
    wTo.portPoints.push(q2ToSide)
    fromCopy.nextPortPointId = q1Id
    toCopy.prevPortPointId = q2Id
    wFrom.portPointsInPairs ??= []
    m.portPointsInPairs ??= []
    wTo.portPointsInPairs ??= []
    wFrom.portPointsInPairs.push([fromCopy, q1FromSide])
    m.portPointsInPairs.push([q1MidSide, q2MidSide])
    wTo.portPointsInPairs.push([q2ToSide, toCopy])
    index.portOwnerById.set(q1Id, [wFromId, mId])
    index.portOwnerById.set(q2Id, [mId, wToId])
  }

  return {
    connectionName: plan.connectionName,
    recipientNodeIds: [...recipientNodeIds],
    newPortPointIds,
  }
}
