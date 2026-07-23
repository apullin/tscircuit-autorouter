import {
  SelectiveReripTinyHyperGraphSolver,
  type SelectiveReripBlockerResource,
  type TinyHyperGraphProblem,
  type TinyHyperGraphSolverOptions,
  type TinyHyperGraphTopology,
} from "tiny-hypergraph/lib/index"
import type { DistinctOwnerBlockerSearchResult } from "tiny-hypergraph/lib/find-distinct-owner-blocker-path"

const LARGE_PROBLEM_ROUTE_COUNT = 500
const LARGE_PROBLEM_MAX_ITERATIONS = 200_000
const ROUTE_SEARCH_PROBE_ITERATION = 1_000
const FIRST_CLEAR_PATH_EXPANSION_LIMIT = 5_000
const FALLBACK_CLEAR_PATH_EXPANSION_LIMIT = 20_000

type ClearPathSegment = {
  regionId: number
  fromPortId: number
  toPortId: number
}

type ClearPathSearchState = {
  portId: number
  nextRegionId: number
  owners: Set<number>
  distance: number
  score: number
  parent?: ClearPathSearchState
}

type RelaxedSearchState = { portId: number; nextRegionId: number }
type RelaxedSearchHopData = { resources: SelectiveReripBlockerResource[] }
type BaseRelaxedPathResult = DistinctOwnerBlockerSearchResult<
  RelaxedSearchState,
  number,
  RelaxedSearchHopData
>
type RelaxedPathResult = Extract<BaseRelaxedPathResult, { found: true }> & {
  segments: ClearPathSegment[]
}

type SolverInternals = {
  routeAttemptCountByRouteId: Uint32Array
  routeSuccessCountByRouteId: Uint32Array
  getStartingNextRegionId(
    routeId: number,
    startPortId: number,
  ): number | undefined
  getHopId(portId: number, nextRegionId: number): number
  getPortOwners(): Map<number, Set<number>>
  getRelaxedSearchHops(params: {
    state: { portId: number; nextRegionId: number }
    goalPortId: number
    routeNetId: number
    portOwners: ReadonlyMap<number, ReadonlySet<number>>
    forbiddenOwnerRouteIds: ReadonlySet<number>
  }): Array<{
    state: { portId: number; nextRegionId: number }
    distance: number
    owners: number[]
  }>
  appendSegmentToRegionCache(
    regionId: number,
    fromPortId: number,
    toPortId: number,
  ): void
  findRelaxedBlockerPath(
    forbiddenOwnerRouteIds?: ReadonlySet<number>,
  ): unknown
}

const pushHeap = (heap: ClearPathSearchState[], state: ClearPathSearchState) => {
  heap.push(state)
  let index = heap.length - 1
  while (index > 0) {
    const parentIndex = Math.floor((index - 1) / 2)
    if (heap[parentIndex]!.score <= heap[index]!.score) break
    ;[heap[parentIndex], heap[index]] = [heap[index]!, heap[parentIndex]!]
    index = parentIndex
  }
}

const popHeap = (heap: ClearPathSearchState[]) => {
  const first = heap[0]
  const last = heap.pop()
  if (!first || !last) return undefined
  if (heap.length === 0) return first
  heap[0] = last
  let index = 0
  while (true) {
    const leftIndex = index * 2 + 1
    const rightIndex = leftIndex + 1
    let bestIndex = index
    if (
      leftIndex < heap.length &&
      heap[leftIndex]!.score < heap[bestIndex]!.score
    ) {
      bestIndex = leftIndex
    }
    if (
      rightIndex < heap.length &&
      heap[rightIndex]!.score < heap[bestIndex]!.score
    ) {
      bestIndex = rightIndex
    }
    if (bestIndex === index) break
    ;[heap[index], heap[bestIndex]] = [heap[bestIndex]!, heap[index]!]
    index = bestIndex
  }
  return first
}

/**
 * Adds bounded recovery behavior for very large selective-rerip problems.
 *
 * The ordinary candidate search can spend most of its budget exploring a
 * dense component even after the relaxed search can prove a blocker-free
 * route. For large graphs only, this solver reconstructs and commits that
 * clear path after a bounded amount of ordinary search. Paths containing a
 * committed blocker continue through the normal selective-rerip flow.
 */
export class LargeProblemSelectiveReripSolver extends SelectiveReripTinyHyperGraphSolver {
  private routeSearchRouteId?: number
  private routeSearchIterations = 0
  private routeSearchProbed = false
  private committedClearRelaxedPathCount = 0
  private proactiveSelectiveReripCount = 0
  private lastDirectBlockerPath?: {
    routeId: number
    path: RelaxedPathResult
  }

  constructor(
    topology: TinyHyperGraphTopology,
    problem: TinyHyperGraphProblem,
    options?: TinyHyperGraphSolverOptions,
  ) {
    super(topology, problem, options)
    if (problem.routeCount >= LARGE_PROBLEM_ROUTE_COUNT) {
      this.MAX_ITERATIONS = Math.min(
        this.MAX_ITERATIONS,
        LARGE_PROBLEM_MAX_ITERATIONS,
      )
      this.stats = {
        ...this.stats,
        largeProblemMaxIterations: this.MAX_ITERATIONS,
      }
    }
  }

  override computeH(neighborPortId: number) {
    const base = super.computeH(neighborPortId)
    if (this.problem.routeCount < LARGE_PROBLEM_ROUTE_COUNT) return base
    const routeId = this.state.currentRouteId
    if (routeId === undefined) return base
    const internals = this as unknown as SolverInternals
    const attemptCount = internals.routeAttemptCountByRouteId[routeId] ?? 0
    return base * (attemptCount > 1 ? 1_024 : 256)
  }

  override _step() {
    if (this.problem.routeCount < LARGE_PROBLEM_ROUTE_COUNT) {
      super._step()
      return
    }

    const routeId = this.state.currentRouteId
    if (routeId === undefined) {
      this.resetRouteSearchProbe()
      super._step()
      return
    }

    if (this.routeSearchRouteId !== routeId) {
      this.routeSearchRouteId = routeId
      this.routeSearchIterations = 0
      this.routeSearchProbed = false
    }
    this.routeSearchIterations++

    if (
      !this.routeSearchProbed &&
      this.routeSearchIterations >= ROUTE_SEARCH_PROBE_ITERATION
    ) {
      this.routeSearchProbed = true
      const relaxedPath =
        this.findRelaxedPath(FIRST_CLEAR_PATH_EXPANSION_LIMIT, 16) ??
        this.findRelaxedPath(FALLBACK_CLEAR_PATH_EXPANSION_LIMIT, 1)
      if (relaxedPath?.owners.size === 0) {
        this.commitClearRelaxedPath(routeId, relaxedPath.segments)
        this.resetRouteSearchProbe()
        return
      }
      if (relaxedPath && relaxedPath.owners.size > 0) {
        this.startSelectiveReripFromRelaxedPath(relaxedPath)
        this.resetRouteSearchProbe()
        return
      }
    }

    super._step()
  }

  protected override findRelaxedBlockerPath(
    forbiddenOwnerRouteIds: ReadonlySet<number> = new Set<number>(),
  ): BaseRelaxedPathResult {
    if (this.problem.routeCount < LARGE_PROBLEM_ROUTE_COUNT) {
      return super.findRelaxedBlockerPath(forbiddenOwnerRouteIds)
    }

    const boundedPath =
      this.findRelaxedPath(
        FIRST_CLEAR_PATH_EXPANSION_LIMIT,
        16,
        forbiddenOwnerRouteIds,
      ) ??
      this.findRelaxedPath(
        FALLBACK_CLEAR_PATH_EXPANSION_LIMIT,
        1,
        forbiddenOwnerRouteIds,
      )
    if (boundedPath && forbiddenOwnerRouteIds.size === 0) {
      if (
        boundedPath.owners.size > 0 &&
        this.state.currentRouteId !== undefined
      ) {
        this.lastDirectBlockerPath = {
          routeId: this.state.currentRouteId,
          path: boundedPath,
        }
      }
      return boundedPath
    }
    if (boundedPath && boundedPath.owners.size > 0) return boundedPath

    if (forbiddenOwnerRouteIds.size > 0) {
      const lastDirectBlockerPath = this.lastDirectBlockerPath
      if (
        lastDirectBlockerPath !== undefined &&
        lastDirectBlockerPath.routeId === this.state.currentRouteId
      ) {
        return lastDirectBlockerPath.path
      }
      const directPath =
        this.findRelaxedPath(FIRST_CLEAR_PATH_EXPANSION_LIMIT, 16) ??
        this.findRelaxedPath(FALLBACK_CLEAR_PATH_EXPANSION_LIMIT, 1)
      if (directPath?.owners.size) return directPath
    }

    return {
      found: false,
      reason: "expansion_limit",
      expandedLabelCount: FALLBACK_CLEAR_PATH_EXPANSION_LIMIT,
    }
  }

  private resetRouteSearchProbe() {
    this.routeSearchRouteId = undefined
    this.routeSearchIterations = 0
    this.routeSearchProbed = false
  }

  private findRelaxedPath(
    maxExpandedStates: number,
    heuristicWeight: number,
    forbiddenOwnerRouteIds: ReadonlySet<number> = new Set<number>(),
  ): RelaxedPathResult | null {
    const routeId = this.state.currentRouteId
    const routeNetId = this.state.currentRouteNetId
    if (routeId === undefined || routeNetId === undefined) return null

    const startPortId = this.problem.routeStartPort[routeId]!
    const goalPortId = this.problem.routeEndPort[routeId]!
    const internals = this as unknown as SolverInternals
    const startRegionId = internals.getStartingNextRegionId(
      routeId,
      startPortId,
    )
    if (startRegionId === undefined) return null

    const heap: ClearPathSearchState[] = []
    const bestScoreByState = new Map<number, number>()
    const startState: ClearPathSearchState = {
      portId: startPortId,
      nextRegionId: startRegionId,
      owners: new Set(),
      distance: 0,
      score: 0,
    }
    bestScoreByState.set(internals.getHopId(startPortId, startRegionId), 0)
    pushHeap(heap, startState)
    const portOwners = internals.getPortOwners()
    let expandedStateCount = 0

    while (heap.length > 0 && expandedStateCount < maxExpandedStates) {
      const current = popHeap(heap)!
      const currentKey = internals.getHopId(
        current.portId,
        current.nextRegionId,
      )
      if (
        current.score >
        (bestScoreByState.get(currentKey) ?? Number.POSITIVE_INFINITY)
      ) {
        continue
      }
      if (current.portId === goalPortId) {
        return {
          found: true,
          owners: current.owners,
          segments: this.reconstructClearPath(current),
          states: [],
          hops: [],
          distance: current.distance,
          expandedLabelCount: expandedStateCount,
        }
      }
      expandedStateCount++

      const hops = internals.getRelaxedSearchHops({
        state: current,
        goalPortId,
        routeNetId,
        portOwners,
        forbiddenOwnerRouteIds: new Set<number>(),
      })
      for (const hop of hops) {
        if (
          hop.owners.some((ownerRouteId) =>
            forbiddenOwnerRouteIds.has(ownerRouteId),
          )
        ) {
          continue
        }
        const owners = new Set(current.owners)
        for (const ownerRouteId of hop.owners) {
          if (ownerRouteId !== routeId) owners.add(ownerRouteId)
        }
        const distance = current.distance + hop.distance
        const key = internals.getHopId(
          hop.state.portId,
          hop.state.nextRegionId,
        )
        const dx =
          this.topology.portX[hop.state.portId]! -
          this.topology.portX[goalPortId]!
        const dy =
          this.topology.portY[hop.state.portId]! -
          this.topology.portY[goalPortId]!
        const score =
          owners.size +
          distance +
          Math.hypot(dx, dy) * heuristicWeight
        if (
          score >=
          (bestScoreByState.get(key) ?? Number.POSITIVE_INFINITY)
        ) {
          continue
        }
        bestScoreByState.set(key, score)
        pushHeap(heap, {
          portId: hop.state.portId,
          nextRegionId: hop.state.nextRegionId,
          owners,
          distance,
          score,
          parent: current,
        })
      }
    }

    return null
  }

  private reconstructClearPath(goal: ClearPathSearchState) {
    const segments: ClearPathSegment[] = []
    let cursor: ClearPathSearchState | undefined = goal
    while (cursor?.parent) {
      segments.push({
        regionId: cursor.parent.nextRegionId,
        fromPortId: cursor.parent.portId,
        toPortId: cursor.portId,
      })
      cursor = cursor.parent
    }
    segments.reverse()
    return segments
  }

  private startSelectiveReripFromRelaxedPath(
    relaxedPath: RelaxedPathResult,
  ) {
    const internals = this as unknown as SolverInternals
    const originalFindRelaxedBlockerPath =
      internals.findRelaxedBlockerPath.bind(this)
    internals.findRelaxedBlockerPath = () => relaxedPath
    this.state.candidateQueue.clear()
    try {
      super._step()
    } finally {
      internals.findRelaxedBlockerPath = originalFindRelaxedBlockerPath
    }
    this.proactiveSelectiveReripCount++
    this.stats = {
      ...this.stats,
      proactiveSelectiveReripCount: this.proactiveSelectiveReripCount,
    }
  }

  private commitClearRelaxedPath(
    routeId: number,
    segments: ClearPathSegment[],
  ) {
    const internals = this as unknown as SolverInternals
    internals.routeSuccessCountByRouteId[routeId] += 1
    for (const { regionId, fromPortId, toPortId } of segments) {
      this.state.regionSegments[regionId]!.push([
        routeId,
        fromPortId,
        toPortId,
      ])
      this.state.portAssignment[fromPortId] = this.state.currentRouteNetId!
      this.state.portAssignment[toPortId] = this.state.currentRouteNetId!
      internals.appendSegmentToRegionCache(regionId, fromPortId, toPortId)
    }
    this.state.candidateQueue.clear()
    this.state.currentRouteNetId = undefined
    this.state.currentRouteId = undefined
    this.state.goalPortId = -1
    this.committedClearRelaxedPathCount++
    this.stats = {
      ...this.stats,
      committedClearRelaxedPathCount: this.committedClearRelaxedPathCount,
    }
  }
}
