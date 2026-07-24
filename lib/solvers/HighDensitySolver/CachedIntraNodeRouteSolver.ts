import {
  getGlobalInMemoryCache,
  setupGlobalCaches,
} from "lib/cache/setupGlobalCaches"
import { CachableSolver, CacheProvider } from "lib/cache/types"
import type { HighDensityIntraNodeRoute } from "../../types/high-density-types"

import { IntraNodeRouteSolver } from "./IntraNodeSolver"

type CachedSolvedIntraNodeRouteSolver =
  | { success: true; solvedRoutes: HighDensityIntraNodeRoute[] }
  | { success: false; error?: string }

type CacheToIntraNodeSolverTransform = Record<string, never>

const roundCoord = (n: number) => Math.round(n * 200) / 200

/**
 * Deep clone for plain JSON-ish data (the connection/route payloads cached by
 * this solver). Copies own enumerable properties recursively — equivalent to
 * structuredClone for this data, but without the native serialize/deserialize
 * round trip that showed up in profiles (~60+ candidate solvers per node).
 */
const cloneValue = <T>(value: T): T => {
  if (Array.isArray(value)) {
    const length = value.length
    const out = new Array(length)
    for (let i = 0; i < length; i++) {
      out[i] = cloneValue(value[i])
    }
    return out as T
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value)) {
      out[key] = cloneValue((value as Record<string, unknown>)[key])
    }
    return out as T
  }
  return value
}

setupGlobalCaches()

const INTRA_NODE_CACHE_SCHEMA_VERSION = 4

export class CachedIntraNodeRouteSolver
  extends IntraNodeRouteSolver
  implements
    CachableSolver<
      CacheToIntraNodeSolverTransform,
      CachedSolvedIntraNodeRouteSolver
    >
{
  override getSolverName(): string {
    return "CachedIntraNodeRouteSolver"
  }

  cacheProvider: CacheProvider | null
  cacheHit = false
  hasAttemptedToUseCache = false
  declare cacheKey?: string | undefined
  declare cacheToSolveSpaceTransform?:
    | CacheToIntraNodeSolverTransform
    | undefined
  initialUnsolvedConnections: {
    connectionName: string
    rootConnectionName?: string
    points: { x: number; y: number; z: number }[]
  }[]

  constructor(
    params: ConstructorParameters<typeof IntraNodeRouteSolver>[0] & {
      cacheProvider?: CacheProvider | null
    },
  ) {
    super(params)
    this.cacheProvider =
      params.cacheProvider === undefined
        ? getGlobalInMemoryCache()
        : params.cacheProvider
    this.initialUnsolvedConnections = cloneValue(this.unsolvedConnections)

    if ((this.solved || this.failed) && this.cacheProvider && !this.cacheHit) {
      this.saveToCacheSync()
    }
  }

  _step(): void {
    if (!this.hasAttemptedToUseCache && this.cacheProvider) {
      if (this.attemptToUseCacheSync()) {
        return
      }
    }

    const wasSolved = this.solved
    const wasFailed = this.failed

    super._step()

    if (
      this.cacheProvider &&
      !this.cacheHit &&
      (this.solved || this.failed) &&
      !(wasSolved || wasFailed)
    ) {
      this.saveToCacheSync()
    }
  }

  computeCacheKeyAndTransform(): {
    cacheKey: string
    cacheToSolveSpaceTransform: CacheToIntraNodeSolverTransform
  } {
    const center = this.nodeWithPortPoints.center
    const normalizedConnections = this.initialUnsolvedConnections.map(
      ({ connectionName, rootConnectionName, points }) => ({
        connectionName,
        rootConnectionName,
        points: points.map((point) => ({
          connectionName,
          x: roundCoord(point.x - center.x),
          y: roundCoord(point.y - center.y),
          z: point.z ?? 0,
        })),
      }),
    )
    const normalizedPortPoints = [...this.nodeWithPortPoints.portPoints]
      .sort((a, b) => {
        if (a.connectionName !== b.connectionName) {
          return a.connectionName.localeCompare(b.connectionName)
        }
        if ((a.portPointId ?? "") !== (b.portPointId ?? "")) {
          return (a.portPointId ?? "").localeCompare(b.portPointId ?? "")
        }
        if (a.x !== b.x) return a.x - b.x
        if (a.y !== b.y) return a.y - b.y
        return (a.z ?? 0) - (b.z ?? 0)
      })
      .map((portPoint) => ({
        connectionName: portPoint.connectionName,
        rootConnectionName: portPoint.rootConnectionName,
        portPointId: portPoint.portPointId,
        prevPortPointId: portPoint.prevPortPointId,
        nextPortPointId: portPoint.nextPortPointId,
        x: roundCoord(portPoint.x - center.x),
        y: roundCoord(portPoint.y - center.y),
        z: portPoint.z ?? 0,
      }))

    const normalizedHyperParameters = Object.fromEntries(
      Object.entries(this.hyperParameters ?? {})
        .filter(([, value]) => value !== undefined)
        .sort(([a], [b]) => a.localeCompare(b)),
    )

    const normalizedConnMap = this.connMap
      ? this.initialUnsolvedConnections.map(({ connectionName }) => ({
          connectionName,
          connectedIds: [
            ...new Set(
              this.connMap!.getIdsConnectedToNet(connectionName) ?? [],
            ),
          ].sort(),
        }))
      : undefined

    const keyData = {
      cacheSchemaVersion: INTRA_NODE_CACHE_SCHEMA_VERSION,
      node: {
        width: roundCoord(this.nodeWithPortPoints.width),
        height: roundCoord(this.nodeWithPortPoints.height),
        center: {
          x: roundCoord(this.nodeWithPortPoints.center.x),
          y: roundCoord(this.nodeWithPortPoints.center.y),
        },
        availableZ: this.nodeWithPortPoints.availableZ
          ? [...this.nodeWithPortPoints.availableZ].sort()
          : undefined,
        portPoints: normalizedPortPoints,
      },
      normalizedConnections,
      normalizedHyperParameters,
      minDistBetweenEnteringPoints: roundCoord(
        this.minDistBetweenEnteringPoints,
      ),
      traceWidth: roundCoord(this.traceWidth),
      viaDiameter: roundCoord(this.viaDiameter),
      obstacleMargin: roundCoord(this.obstacleMargin),
      normalizedConnMap,
    }

    // Deterministic serialization instead of objectHash (recursive SHA-1),
    // which dominated cache-key cost across ~60+ portfolio candidates per
    // node. keyData is built with canonical ordering (sorted port points,
    // sorted hyperparameter entries, fixed literal shapes), so structurally
    // equal inputs always serialize identically, and JSON string equality is
    // collision-free — the cache hit/miss pattern (and therefore the routing
    // result) is unchanged. Keys only live in the per-process in-memory cache;
    // no persisted cache depends on the previous hash format.
    const cacheKey = `intranode-solver:${JSON.stringify(keyData)}`
    const cacheToSolveSpaceTransform: CacheToIntraNodeSolverTransform = {}

    this.cacheKey = cacheKey
    this.cacheToSolveSpaceTransform = cacheToSolveSpaceTransform

    return { cacheKey, cacheToSolveSpaceTransform }
  }

  applyCachedSolution(cachedSolution: CachedSolvedIntraNodeRouteSolver): void {
    if (cachedSolution.success) {
      this.solvedRoutes = cloneValue(cachedSolution.solvedRoutes)
      this.solved = true
      this.failed = false
    } else {
      this.solvedRoutes = []
      this.failedSubSolvers = []
      this.solved = false
      this.failed = true
      this.error = cachedSolution.error ?? this.error
    }
    this.unsolvedConnections = []
    this.activeSubSolver = null
    this.cacheHit = true
    this.progress = 1
  }

  attemptToUseCacheSync(): boolean {
    this.hasAttemptedToUseCache = true
    if (!this.cacheProvider?.isSyncCache) {
      return false
    }

    if (!this.cacheKey) {
      try {
        this.computeCacheKeyAndTransform()
      } catch (error) {
        console.error("Error computing cache key:", error)
        return false
      }
    }

    if (!this.cacheKey) {
      console.error("Failed to compute cache key.")
      return false
    }

    try {
      const cachedSolution = this.cacheProvider.getCachedSolutionSync(
        this.cacheKey,
      )

      if (cachedSolution !== undefined && cachedSolution !== null) {
        this.applyCachedSolution(cachedSolution)
        return true
      }
    } catch (error) {
      console.error("Error attempting to use cache:", error)
    }

    return false
  }

  saveToCacheSync(): void {
    if (!this.cacheProvider?.isSyncCache) {
      return
    }

    if (!this.cacheKey) {
      try {
        this.computeCacheKeyAndTransform()
      } catch (error) {
        console.error("Error computing cache key during save:", error)
        return
      }
    }

    if (!this.cacheKey) {
      console.error("Failed to compute cache key before saving.")
      return
    }

    const solutionToCache: CachedSolvedIntraNodeRouteSolver = this.failed
      ? { success: false, error: this.error ?? undefined }
      : { success: true, solvedRoutes: cloneValue(this.solvedRoutes) }

    try {
      this.cacheProvider.setCachedSolutionSync(this.cacheKey, solutionToCache)
    } catch (error) {
      console.error("Error saving solution to cache:", error)
    }
  }
}

export type { CachedSolvedIntraNodeRouteSolver }
