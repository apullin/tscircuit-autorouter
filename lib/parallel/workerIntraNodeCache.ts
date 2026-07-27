import { InMemoryCache } from "../cache/InMemoryCache"

/**
 * Failure entries written by CachedIntraNodeRouteSolver.saveToCacheSync have
 * the shape `{ success: false, error?: string }`.
 */
const isFailureEntry = (value: unknown): boolean => {
  if (value === null || typeof value !== "object") return false
  if (!("success" in value)) return false
  // `in` narrowing types value.success as unknown — checked access, no cast.
  return value.success === false
}

/**
 * Success-only variant of the process-global intra-node cache. hdNodeWorker
 * installs this at init, so it applies to WORKERS ONLY; sequential behavior
 * (which uses the plain InMemoryCache) is unchanged.
 *
 * Why: CachedIntraNodeRouteSolver also caches FAILED attempts, under a key
 * that provably does not capture everything that affects solvability — see
 * perf-artifacts/pr-staging/issue-failure-cache.md (node cmn_51: the
 * sequential pipeline replayed a cached FAILED attempt while a cold-cache
 * worker solved the byte-identical input successfully). A failure cached
 * under one pipeline state can be served under a different, more permissive
 * state, silently degrading results.
 *
 * The alternative hardening — keying failure entries on fuller state — is not
 * possible worker-side: the missing state is exactly the cross-node/cross-
 * stage pipeline state a worker never sees. So workers cache SUCCESSES only.
 * A success is a deterministic function of the keyed inputs (same geometry,
 * port points and hyperparameters always produce the same routes), while a
 * cached failure is only valid for the state that produced it. Dropping a
 * failure entry costs at most a recomputation of a deterministic failure.
 */
export class SuccessOnlyInMemoryCache extends InMemoryCache {
  override setCachedSolutionSync(
    cacheKey: string,
    cachedSolution: unknown,
  ): void {
    if (isFailureEntry(cachedSolution)) return
    super.setCachedSolutionSync(cacheKey, cachedSolution)
  }

  override getCachedSolutionSync(cacheKey: string): unknown {
    // Defensive: the set-side filter already keeps failure entries out, but
    // never serve one even if it got in. Reported as a miss.
    if (isFailureEntry(this.cache.get(cacheKey))) {
      this.cacheMisses++
      const prefix = cacheKey.split(":")[0]
      this.cacheMissesByPrefix[prefix] =
        (this.cacheMissesByPrefix[prefix] || 0) + 1
      return undefined
    }
    return super.getCachedSolutionSync(cacheKey)
  }
}
