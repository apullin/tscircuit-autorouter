import { GlobalDrcForceImproveSolver } from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/GlobalDrcForceImproveSolver"
import { GlobalDrcBranchPortfolioSolver } from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/GlobalDrcBranchPortfolioSolver"
import { getDrcSnapshot } from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/drc-snapshot"
import {
  DRC_EVAL_STATS_ENABLED,
  noteDrcEval,
} from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/drcEvalStats"
import { BROAD_FALLBACK_SMALL_ROUTE_LIMIT } from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/solverConfig"
import type { DrcSnapshot } from "high-density-repair03/lib/solvers/GlobalDrcForceImproveSolver/types"
import type { HighDensityRoute } from "high-density-repair03/lib/types/high-density-types"
import { resolveA2Parallelism } from "../../parallel/autoEnable"
import { runA2Branches } from "../../parallel/a2Pool"

/**
 * Parallel (A2) variant of GlobalDrcBranchPortfolioSolver: runs the baseline
 * and broad branches CONCURRENTLY in two workers, then applies the exact
 * sequential selection semantics (perf-artifacts/parallelism-design.md §A2).
 * Deterministic: branch selection is a pure data decision (snapshot counts),
 * so output is bit-identical to the sequential solver. The broad solver runs
 * speculatively even when sequential would skip it (free: parallel).
 *
 * Enabled via TS_PARALLEL_A2=1; otherwise _step delegates to the sequential
 * implementation. Requires the extra `a2EvaluatorConfig` constructor param
 * (serializable inputs for rebuilding the DRC evaluator inside workers).
 */
export class ParallelGlobalDrcBranchPortfolioSolver extends GlobalDrcBranchPortfolioSolver {
  private a2EvaluatorConfig?: Record<string, unknown>
  private a2Done = false
  private a2Decision: boolean | null = null

  constructor(
    params: ConstructorParameters<typeof GlobalDrcBranchPortfolioSolver>[0] & {
      a2EvaluatorConfig?: Record<string, unknown>
    },
  ) {
    super(params)
    this.a2EvaluatorConfig = params.a2EvaluatorConfig
  }

  private finishA2(
    routes: HighDensityRoute[],
    counts: {
      initialCount?: number
      baselineCount?: number
      broadInputCount?: number
      broadFinalCount?: number
      finalCount?: number
    },
    selectedStats: Record<string, unknown>,
  ) {
    this.outputHdRoutes = routes
    ;(this as unknown as { phase: string }).phase = "done"
    this.progress = 1
    this.stats = {
      ...selectedStats,
      drcBranchPortfolioInitialDrcIssueCount: counts.initialCount,
      drcBranchPortfolioBaselineDrcIssueCount: counts.baselineCount,
      drcBranchPortfolioBroadInitialDrcIssueCount: counts.broadInputCount,
      drcBranchPortfolioBroadFinalDrcIssueCount: counts.broadFinalCount,
      drcBranchPortfolioBroadMaxIterations: this.broadMaxIterations,
      drcBranchPortfolioViaInPadMaxIterations:
        this.params.viaInPadMaxIterations,
      drcBranchPortfolioFinalDrcIssueCount: counts.finalCount,
    }
    this.solved = true
    this.a2Done = true
  }

  /**
   * Replicates the sequential via-in-pad phase exactly (in-process).
   * `routesSnapshot`, when given, must be the params.drcEvaluator snapshot of
   * exactly `routes`; it substitutes for the gate snapshot when the
   * via-in-pad evaluator IS the drc evaluator (the pipeline passes one
   * shared closure), mirroring the sequential portfolio's snapshot reuse.
   */
  private runViaInPadPhase(
    routes: HighDensityRoute[],
    countsSoFar: Parameters<ParallelGlobalDrcBranchPortfolioSolver["finishA2"]>[1],
    routesSnapshot?: DrcSnapshot,
  ) {
    const params = this.params
    if (!params.enableViaInPadLayerMoves || !params.viaInPadDrcEvaluator) {
      this.finishA2(routes, countsSoFar, {})
      return
    }
    let viaInPadInputSnapshot: DrcSnapshot
    if (routesSnapshot && params.viaInPadDrcEvaluator === params.drcEvaluator) {
      viaInPadInputSnapshot = routesSnapshot
    } else {
      if (DRC_EVAL_STATS_ENABLED) noteDrcEval("boundary.viaInPadGate")
      viaInPadInputSnapshot = getDrcSnapshot(
        params.srj,
        routes,
        params.viaInPadDrcEvaluator,
        params.connMap,
      )
    }
    if (
      this.inputHdRoutes.length > BROAD_FALLBACK_SMALL_ROUTE_LIMIT &&
      viaInPadInputSnapshot.count > 3
    ) {
      this.finishA2(routes, countsSoFar, {})
      return
    }
    const viaInPadSolver = new GlobalDrcForceImproveSolver({
      ...params,
      hdRoutes: routes,
      drcEvaluator: params.viaInPadDrcEvaluator,
      maxIterations: params.viaInPadMaxIterations ?? params.maxIterations,
      enableLargeBoardBroadFallback: false,
      enableTargetedErrorSweep: false,
      enablePostSolveClearanceRelaxation: false,
      enableViaInPadLayerMoves: true,
      // The viaInPadDrcEvaluator snapshot of `routes` (directly computed, or
      // routesSnapshot when the evaluators are the same closure).
      initialSnapshot: viaInPadInputSnapshot,
    })
    viaInPadSolver.solve()
    if (viaInPadSolver.failed) {
      throw new Error(`via-in-pad DRC repair branch failed: ${viaInPadSolver.error}`)
    }
    const viaInPadRoutes = viaInPadSolver.getOutput()
    // The solved solver's outputSnapshot matches what a recompute over
    // viaInPadRoutes with params.viaInPadDrcEvaluator would produce.
    let viaInPadSnapshot = viaInPadSolver.getOutputSnapshot()
    if (!viaInPadSnapshot) {
      if (DRC_EVAL_STATS_ENABLED) noteDrcEval("boundary.viaInPadFinal")
      viaInPadSnapshot = getDrcSnapshot(
        params.srj,
        viaInPadRoutes,
        params.viaInPadDrcEvaluator,
        params.connMap,
      )
    }
    this.finishA2(
      viaInPadRoutes,
      { ...countsSoFar, finalCount: viaInPadSnapshot.count },
      viaInPadSolver.stats ?? {},
    )
  }

  /**
   * Flag plumbing (G9 auto-enable): explicit TS_PARALLEL_A2 always wins (and
   * keeps the missing-config throw in _step, surfacing setup errors as
   * before); AUTO mode additionally requires a2EvaluatorConfig — a solver
   * constructed without it was sequential before auto-enable existed, so
   * auto mode must not turn that previously-working configuration into a
   * throw. Cached per instance: env must not be re-probed every pump.
   */
  private isA2Enabled(): boolean {
    if (this.a2Decision !== null) return this.a2Decision
    const decision = resolveA2Parallelism()
    this.a2Decision =
      decision.enabled && (decision.explicit || !!this.a2EvaluatorConfig)
    return this.a2Decision
  }

  override _step() {
    if (!this.isA2Enabled() || this.a2Done) {
      super._step()
      return
    }

    const params = this.params
    if (!this.a2EvaluatorConfig) {
      throw new Error(
        "ParallelGlobalDrcBranchPortfolioSolver requires a2EvaluatorConfig",
      )
    }

    // 1. Input snapshot (in-process, as sequential "start" phase)
    let inputSnapshot = params.initialSnapshot
    if (!inputSnapshot) {
      if (DRC_EVAL_STATS_ENABLED) noteDrcEval("boundary.input")
      inputSnapshot = getDrcSnapshot(
        params.srj,
        this.inputHdRoutes,
        params.drcEvaluator,
        params.connMap,
      )
    }
    if (inputSnapshot.count === 0) {
      this.runViaInPadPhase(
        this.inputHdRoutes,
        {
          initialCount: 0,
          finalCount: 0,
        },
        inputSnapshot,
      )
      return
    }

    // 2. Run baseline ∥ broad in workers (broad is speculative).
    //    solverParams must exclude non-cloneable fields (functions) and
    //    initialSnapshot (only valid for the input routes under the parent's
    //    evaluator closure; workers rebuild their own evaluator and the broad
    //    branch runs on different routes).
    const {
      drcEvaluator: _d1,
      viaInPadDrcEvaluator: _d2,
      srj: _s,
      hdRoutes: _h,
      connMap: _c,
      initialSnapshot: _i,
      ...solverParamsRest
    } = params as Record<string, unknown>
    const baselineSolverParams = {
      ...solverParamsRest,
      enableViaInPadLayerMoves: false,
    }
    const broadSolverParams = {
      ...solverParamsRest,
      maxIterations: this.broadMaxIterations,
      enableViaInPadLayerMoves: false,
    }

    const { baseline, broad } = runA2Branches({
      baseline: {
        srj: params.srj,
        hdRoutes: this.inputHdRoutes,
        connMap: params.connMap,
        evaluatorConfig: this.a2EvaluatorConfig,
        solverParams: baselineSolverParams,
        effort: params.effort ?? 1,
        broadPassMultiplier: this.broadPassMultiplier,
      },
      broad: {
        srj: params.srj,
        hdRoutes: this.inputHdRoutes,
        connMap: params.connMap,
        evaluatorConfig: this.a2EvaluatorConfig,
        solverParams: broadSolverParams,
        effort: params.effort ?? 1,
        broadPassMultiplier: this.broadPassMultiplier,
      },
    })

    // 3. Exact sequential selection semantics.
    const baselineRoutes = baseline.routes as HighDensityRoute[]
    const baselineCount = baseline.count
    const counts = {
      initialCount: inputSnapshot.count,
      baselineCount,
      broadInputCount: broad.broadInputCount,
      broadFinalCount: broad.count,
    }

    if (baselineCount === 0) {
      this.runViaInPadPhase(baselineRoutes, counts)
      return
    }
    if ((broad.broadInputCount ?? Infinity) >= baselineCount) {
      this.runViaInPadPhase(baselineRoutes, counts)
      return
    }
    if (broad.count < baselineCount) {
      this.runViaInPadPhase(broad.routes as HighDensityRoute[], counts)
      return
    }
    this.runViaInPadPhase(baselineRoutes, counts)
  }
}
