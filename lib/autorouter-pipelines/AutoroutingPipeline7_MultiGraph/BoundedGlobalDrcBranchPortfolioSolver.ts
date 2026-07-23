import {
  GlobalDrcBranchPortfolioSolver,
  type GlobalDrcBranchPortfolioSolverParams,
} from "high-density-repair03/lib"

const LARGE_BOARD_MIN_ROUTE_COUNT = 500
const MAX_EXACT_DRC_WORK_ESTIMATE = 5_000_000

const getExactDrcWorkEstimate = (
  params: GlobalDrcBranchPortfolioSolverParams,
) => {
  const segmentCount = params.hdRoutes.reduce(
    (count, route) => count + Math.max(0, route.route.length - 1),
    0,
  )
  const boardObjectCount =
    params.hdRoutes.length + params.srj.obstacles.length

  return segmentCount * boardObjectCount
}

/**
 * Exact DRC repair is best-effort after the global repair stage. On very large
 * routed geometries, each portfolio candidate can require a full-board exact
 * DRC pass and the branch can spend hours repeatedly rescoring an otherwise
 * usable route. Preserve the global-repair result once that work estimate is
 * beyond the practical portfolio limit; the benchmark still evaluates the
 * returned route independently.
 */
export class BoundedGlobalDrcBranchPortfolioSolver extends GlobalDrcBranchPortfolioSolver {
  readonly exactDrcWorkEstimate: number
  readonly skippedForLargeBoard: boolean

  constructor(params: GlobalDrcBranchPortfolioSolverParams) {
    super(params)
    this.exactDrcWorkEstimate = getExactDrcWorkEstimate(params)
    this.skippedForLargeBoard =
      params.hdRoutes.length >= LARGE_BOARD_MIN_ROUTE_COUNT &&
      this.exactDrcWorkEstimate > MAX_EXACT_DRC_WORK_ESTIMATE
  }

  override _step() {
    if (!this.skippedForLargeBoard) {
      super._step()
      return
    }

    this.outputHdRoutes = this.inputHdRoutes
    this.activeSubSolver = null
    this.progress = 1
    this.stats = {
      exactDrcBranchPortfolioSkippedForLargeBoard: true,
      exactDrcBranchPortfolioWorkEstimate: this.exactDrcWorkEstimate,
      exactDrcBranchPortfolioRouteCount: this.inputHdRoutes.length,
    }
    this.solved = true
  }
}
