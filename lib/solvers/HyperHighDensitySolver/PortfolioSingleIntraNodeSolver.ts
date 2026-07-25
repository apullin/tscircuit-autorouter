import {
  HighDensitySolverA03 as HighDensityA03Solver,
  HighDensitySolverA01,
} from "@tscircuit/high-density-a01"
import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "lib/types/high-density-types"
import { CachedIntraNodeRouteSolver } from "../HighDensitySolver/CachedIntraNodeRouteSolver"
import { IntraNodeRouteSolver } from "../HighDensitySolver/IntraNodeSolver"
import { MultiHeadPolyLineIntraNodeSolver2 } from "../HighDensitySolver/MultiHeadPolyLineIntraNodeSolver/MultiHeadPolyLineIntraNodeSolver2_Optimized"
import { MultiHeadPolyLineIntraNodeSolver3 } from "../HighDensitySolver/MultiHeadPolyLineIntraNodeSolver/MultiHeadPolyLineIntraNodeSolver3_ViaPossibilitiesSolverIntegration"
import { SingleLayerNoDifferentRootIntersectionsIntraNodeSolver } from "../HighDensitySolver/SingleLayerNoDifferentRootIntersectionsIntraNodeSolver"
import { SingleTransitionIntraNodeSolver } from "../HighDensitySolver/SingleTransitionIntraNodeSolver"
import { SingleTransitionThroughObstacleIntraNodeSolver } from "../HighDensitySolver/SingleTransitionThroughObstacleIntraNodeSolver"
import { SingleTransitionCrossingRouteSolver } from "../HighDensitySolver/TwoRouteHighDensitySolver/SingleTransitionCrossingRouteSolver"
import { TwoCrossingRoutesHighDensitySolver } from "../HighDensitySolver/TwoRouteHighDensitySolver/TwoCrossingRoutesHighDensitySolver"
import {
  HyperParameterSupervisorSolver,
  SupervisedSolver,
} from "../HyperParameterSupervisorSolver"
import {
  getGlobalRacePool,
  parallelPortfolioEnabled,
} from "../../parallel/PortfolioRacePool"
import { parallelReplayEnabled, runReplayRace } from "../../parallel/replayPool"
import {
  parallelReplay2Enabled,
  runOnlineReplayRace,
} from "../../parallel/replayPool2"
import {
  NativeHighDensitySolverA01,
  nativeA01Enabled,
} from "./NativeHighDensitySolverA01"
import { extractWinningRoutes } from "./extractWinningRoutes"
import { repairDisconnectedSameRootPortPoints } from "./repairDisconnectedSameRootPortPoints"

// Match the existing six-ordering portfolio used by the other intra-node
// solver. The first ordering remains in the normal portfolio; the remaining
// orderings are introduced only after that portfolio spends its dynamically
// derived exploration budget or exhausts all of its candidates.
const ORDERING_SHUFFLE_SEEDS = Array.from({ length: 6 }, (_, seed) => seed)

/**
 * Lean portfolio (TS_LEAN_PORTFOLIO=1): measured winner distribution on
 * srj18 sample 8 — top ~12 combos cover ~95% of wins; only 43 of ~106
 * combos ever win. Running ~15 candidates instead of ~106 cuts the wasted
 * candidate work (R=9.28 measured). Falls back to the full portfolio on
 * failure so solvability is preserved. NOT result-identical (winner on some
 * nodes differs from the full schedule) — quality-gated on benchmarks.
 */
const LEAN_HYPERPARAMETERS: Array<Record<string, any>> = [
  // instant/special-case solvers (cheap, occasionally unique winners)
  { THROUGH_OBSTACLE: true },
  { SINGLE_LAYER_NO_DIFFERENT_ROOT_INTERSECTIONS: true },
  { CLOSED_FORM_SINGLE_TRANSITION: true },
  // majorCombinations[0] x cellSize 0.5/1 x seeds 0-2 (dominant winners)
  ...[0.5, 1].flatMap((CELL_SIZE_FACTOR) =>
    [0, 1, 2].map((SHUFFLE_SEED) => ({
      CELL_SIZE_FACTOR,
      SHUFFLE_SEED,
      FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR: 2,
      FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR: 1,
      FUTURE_CONNECTION_PROXIMITY_VD: 10,
      MISALIGNED_DIST_PENALTY_FACTOR: 5,
    })),
  ),
  // majorCombinations[1] x cellSize 1 x seed 0
  {
    CELL_SIZE_FACTOR: 1,
    SHUFFLE_SEED: 0,
    FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR: 1,
    FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR: 0.5,
    FUTURE_CONNECTION_PROXIMITY_VD: 5,
    MISALIGNED_DIST_PENALTY_FACTOR: 2,
  },
  // noVias
  { CELL_SIZE_FACTOR: 2, VIA_PENALTY_FACTOR_2: 10 },
  // flip trace alignment
  { FLIP_TRACE_ALIGNMENT_DIRECTION: true, SHUFFLE_SEED: 0 },
  // native kernels
  { HIGH_DENSITY_A01: true, SHUFFLE_SEED: 0 },
  { HIGH_DENSITY_A03: true },
]

/** TS_LEAN_PORTFOLIO=2: only the single dominant combo + instant solvers. */
const DOMINANT_HYPERPARAMETERS: Array<Record<string, any>> = [
  { THROUGH_OBSTACLE: true },
  { SINGLE_LAYER_NO_DIFFERENT_ROOT_INTERSECTIONS: true },
  { CLOSED_FORM_SINGLE_TRANSITION: true },
  {
    CELL_SIZE_FACTOR: 0.5,
    SHUFFLE_SEED: 0,
    FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR: 2,
    FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR: 1,
    FUTURE_CONNECTION_PROXIMITY_VD: 10,
    MISALIGNED_DIST_PENALTY_FACTOR: 5,
  },
]

const leanPortfolioMode = (): number =>
  typeof process !== "undefined"
    ? Number(process.env.TS_LEAN_PORTFOLIO ?? 0) || 0
    : 0

/** TS_NODE_WORK_CAP: max aggregate candidate iterations per node (0 = off). */
const NODE_WORK_CAP =
  typeof process !== "undefined"
    ? Number(process.env.TS_NODE_WORK_CAP ?? 0) || 0
    : 0

/** Coordinates a fitness-scheduled portfolio of intra-node routing solvers. */
export class PortfolioSingleIntraNodeSolver extends HyperParameterSupervisorSolver<
  | IntraNodeRouteSolver
  | TwoCrossingRoutesHighDensitySolver
  | SingleTransitionCrossingRouteSolver
  | SingleTransitionIntraNodeSolver
  | SingleTransitionThroughObstacleIntraNodeSolver
  | SingleLayerNoDifferentRootIntersectionsIntraNodeSolver
  | HighDensityA03Solver
> {
  override getSolverName(): string {
    return "PortfolioSingleIntraNodeSolver"
  }

  constructorParams: ConstructorParameters<typeof CachedIntraNodeRouteSolver>[0]
  solvedRoutes: HighDensityIntraNodeRoute[] = []
  nodeWithPortPoints: NodeWithPortPoints
  connMap?: ConnectivityMap
  effort: number
  adaptiveSearchExpanded = false

  /**
   * Expansion work budget derived from the initial portfolio. Candidate
   * MAX_ITERATIONS values are fixed after construction/setup, so this is
   * computed once instead of re-derived every supervisor step.
   */
  private cachedDynamicExpansionWorkBudget: number | null = null
  /** Incrementally tracked sum of candidate iterations (Σ solver.iterations). */
  private totalCandidateWork = 0
  private lastCountedCandidateIterations = new Map<object, number>()

  private getSolvedSegmentCount(solver: unknown): number | null {
    const solvedConnectionsMap = (solver as any).solvedConnectionsMap
    if (!(solvedConnectionsMap instanceof Map)) return null

    let solvedSegmentCount = 0
    for (const routes of solvedConnectionsMap.values()) {
      if (Array.isArray(routes)) solvedSegmentCount += routes.length
    }
    return solvedSegmentCount
  }

  private getNodeSegmentCount(): number {
    return Math.max(
      1,
      this.nodeWithPortPoints.portPointsInPairs?.length ??
        new Set(
          this.nodeWithPortPoints.portPoints.map(
            (portPoint) => portPoint.connectionName,
          ),
        ).size,
    )
  }

  private getCandidateProgress(solver: { progress: number }): number {
    const solvedSegmentCount = this.getSolvedSegmentCount(solver)
    if (solvedSegmentCount !== null) {
      return Math.min(1, solvedSegmentCount / this.getNodeSegmentCount())
    }
    return Math.max(0, Math.min(1, solver.progress || 0))
  }

  private getTotalCandidateWork(): number {
    return this.totalCandidateWork
  }

  /**
   * Candidate iterations only advance inside super._step() (which steps a
   * single candidate), so tracking the delta of the stepped solver keeps
   * totalCandidateWork equal to Σ solver.iterations without a reduce per step.
   */
  private recordCandidateWork(solver: { iterations: number }) {
    const previousIterations =
      this.lastCountedCandidateIterations.get(solver) ?? 0
    if (solver.iterations !== previousIterations) {
      this.totalCandidateWork += solver.iterations - previousIterations
      this.lastCountedCandidateIterations.set(solver, solver.iterations)
    }
  }

  /**
   * B1 stagnation cap (TS_NODE_WORK_CAP=<iterations>): abandon a node once the
   * portfolio has burned more aggregate candidate work than any node is
   * plausibly worth. Measured on srj18 sample 6: 87.6% of all HD candidate
   * work goes to the 41 nodes that fail anyway (worst: 14.6M iterations),
   * while no node that SOLVED needed more than 3.7M. Capping trades a
   * vanishing tail of late solves for the bulk of the stagnation cost.
   * Not result-identical when the cap bites; quality-gated on benchmarks.
   */
  private checkNodeWorkCap(): boolean {
    if (NODE_WORK_CAP <= 0 || this.solved || this.failed) return false
    if (this.totalCandidateWork <= NODE_WORK_CAP) return false
    this.failed = true
    this.error = `node work cap exceeded (${this.totalCandidateWork} > ${NODE_WORK_CAP})`
    this.stats.nodeWorkCapHit = true
    return true
  }

  private getDynamicExpansionWorkBudget(): number {
    // Give the initial portfolio as much aggregate work as its most expensive
    // candidate could consume alone. This scales with the candidate's own
    // problem- and effort-derived budget without waiting for every candidate
    // to fail or introducing a wall-clock iteration constant.
    return Math.max(
      1,
      ...(this.supervisedSolvers ?? []).map(
        ({ solver }) => solver.MAX_ITERATIONS,
      ),
    )
  }

  constructor(
    opts: ConstructorParameters<typeof CachedIntraNodeRouteSolver>[0] & {
      effort?: number
    },
  ) {
    super()
    this.nodeWithPortPoints = opts.nodeWithPortPoints
    this.connMap = opts.connMap
    this.constructorParams = opts
    this.effort = opts.effort ?? 1
    this.MAX_ITERATIONS = 20_000_000 * this.effort
    this.GREEDY_MULTIPLIER = 5
    this.MIN_SUBSTEPS = 100
  }

  getCombinationDefs() {
    return [
      ["throughObstacle"],
      ["singleLayerNoDifferentRootIntersections"],
      ["multiHeadPolyLine"],
      ["majorCombinations", "orderings6", "cellSizeFactor"],
      ["noVias"],
      ["orderings50"],
      ["flipTraceAlignmentDirection", "orderings6"],
      ["closedFormSingleTrace"],
      // ["closedFormTwoTrace"],
      ["highDensityA01"],
      ["highDensityA03"],
    ]
  }

  getHyperParameterDefs() {
    return [
      {
        name: "singleLayerNoDifferentRootIntersections",
        possibleValues: [
          {
            SINGLE_LAYER_NO_DIFFERENT_ROOT_INTERSECTIONS: true,
          },
        ],
      },
      {
        name: "majorCombinations",
        possibleValues: [
          {
            FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR: 2,
            FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR: 1,
            FUTURE_CONNECTION_PROXIMITY_VD: 10,
            MISALIGNED_DIST_PENALTY_FACTOR: 5,
          },
          {
            FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR: 1,
            FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR: 0.5,
            FUTURE_CONNECTION_PROXIMITY_VD: 5,
            MISALIGNED_DIST_PENALTY_FACTOR: 2,
          },
          {
            FUTURE_CONNECTION_PROX_TRACE_PENALTY_FACTOR: 10,
            FUTURE_CONNECTION_PROX_VIA_PENALTY_FACTOR: 1,
            FUTURE_CONNECTION_PROXIMITY_VD: 5,
            MISALIGNED_DIST_PENALTY_FACTOR: 10,
            VIA_PENALTY_FACTOR_2: 1,
          },
        ],
      },
      {
        name: "orderings6",
        possibleValues: ORDERING_SHUFFLE_SEEDS.map((shuffleSeed) => ({
          SHUFFLE_SEED: shuffleSeed,
        })),
      },
      {
        name: "cellSizeFactor",
        possibleValues: [
          {
            CELL_SIZE_FACTOR: 0.5,
          },
          {
            CELL_SIZE_FACTOR: 1,
          },
        ],
      },
      {
        name: "flipTraceAlignmentDirection",
        possibleValues: [
          {
            FLIP_TRACE_ALIGNMENT_DIRECTION: true,
          },
        ],
      },
      {
        name: "noVias",
        possibleValues: [
          {
            CELL_SIZE_FACTOR: 2,
            VIA_PENALTY_FACTOR_2: 10,
          },
        ],
      },
      {
        name: "orderings50",
        possibleValues: Array.from({ length: 20 }, (_, i) => ({
          SHUFFLE_SEED: 100 + i,
        })),
      },
      // {
      //   name: "closedFormTwoTrace",
      //   possibleValues: [
      //     {
      //       CLOSED_FORM_TWO_TRACE_SAME_LAYER: true,
      //     },
      //     {
      //       CLOSED_FORM_TWO_TRACE_TRANSITION_CROSSING: true,
      //     },
      //   ],
      // },
      {
        name: "throughObstacle",
        possibleValues: [
          {
            THROUGH_OBSTACLE: true,
          },
        ],
      },
      {
        name: "closedFormSingleTrace",
        possibleValues: [
          {
            CLOSED_FORM_SINGLE_TRANSITION: true,
          },
        ],
      },
      {
        name: "multiHeadPolyLine",
        possibleValues: [
          {
            MULTI_HEAD_POLYLINE_SOLVER: true,
            SEGMENTS_PER_POLYLINE: 6,
            BOUNDARY_PADDING: 0.05,
          },
          {
            MULTI_HEAD_POLYLINE_SOLVER: true,
            SEGMENTS_PER_POLYLINE: 6,
            BOUNDARY_PADDING: -0.05, // Allow vias/traces outside the boundary
            ITERATION_PENALTY: 10000,
            MINIMUM_FINAL_ACCEPTANCE_GAP: 0.001,
          },
        ],
      },
      {
        name: "highDensityA01",
        possibleValues: [
          {
            HIGH_DENSITY_A01: true,
            SHUFFLE_SEED: ORDERING_SHUFFLE_SEEDS[0],
          },
        ],
      },
      {
        name: "highDensityA03",
        possibleValues: [
          {
            HIGH_DENSITY_A03: true,
          },
        ],
      },
    ]
  }

  /**
   * Some external solvers expose an idempotent setup phase that calculates
   * their natural iteration budget from the problem. Running setup here does
   * not advance the solver or give it preference in the portfolio.
   */
  private initializeCandidateBudget(solver: unknown) {
    const setup = (solver as any).setup
    if (typeof setup === "function") setup.call(solver)
  }

  private refreshDynamicIterationLimit() {
    const remainingSupervisorIterations = (this.supervisedSolvers ?? []).reduce(
      (total, { solver }) => {
        if (solver.solved || solver.failed) return total
        const remainingCandidateIterations = Math.max(
          0,
          solver.MAX_ITERATIONS - solver.iterations + 1,
        )
        return (
          total + Math.ceil(remainingCandidateIterations / this.MIN_SUBSTEPS)
        )
      },
      0,
    )

    // Keep one supervisor step available to observe that the current
    // portfolio is exhausted and expand it before BaseSolver can fail.
    this.MAX_ITERATIONS = Math.max(
      this.iterations + 1,
      this.iterations + remainingSupervisorIterations,
    )
    this.stats.dynamicSupervisorIterationLimit = this.MAX_ITERATIONS
  }

  private leanMode = false
  private leanRetried = false
  private recordedFailureStats = false

  override initializeSolvers() {
    const mode = leanPortfolioMode()
    if (mode > 0 && !this.leanRetried) {
      this.leanMode = true
      this.supervisedSolvers = []
      const hps = mode === 2 ? DOMINANT_HYPERPARAMETERS : LEAN_HYPERPARAMETERS
      for (const hp of hps) {
        this.addSupervisedCandidate(hp)
      }
    } else {
      super.initializeSolvers()
      for (const { solver } of this.supervisedSolvers ?? []) {
        this.initializeCandidateBudget(solver)
        this.recordCandidateWork(solver)
      }
    }
    this.cachedDynamicExpansionWorkBudget = this.getDynamicExpansionWorkBudget()
    this.stats.dynamicExpansionWorkBudget = this.cachedDynamicExpansionWorkBudget
    this.refreshDynamicIterationLimit()
  }

  private addSupervisedCandidate(hyperParameters: Record<string, any>) {
    const solver = this.generateSolver(hyperParameters)
    this.initializeCandidateBudget(solver)
    this.recordCandidateWork(solver)
    const g = this.computeG(solver)
    this.supervisedSolvers!.push({
      hyperParameters,
      solver,
      h: 0,
      g,
      f: g,
    })
  }

  private expandAdaptiveSearch() {
    if (this.adaptiveSearchExpanded) return

    this.adaptiveSearchExpanded = true
    for (const shuffleSeed of ORDERING_SHUFFLE_SEEDS.slice(1)) {
      this.addSupervisedCandidate({
        HIGH_DENSITY_A01: true,
        SHUFFLE_SEED: shuffleSeed,
      })
    }
    this.refreshDynamicIterationLimit()
    this.stats.adaptiveSearchExpanded = true
    this.stats.adaptiveSearchExpandedAtIteration = this.iterations
    this.stats.candidateWorkAtExpansion = this.getTotalCandidateWork()
    this.stats.bestProgressAtExpansion = Math.max(
      0,
      ...(this.supervisedSolvers ?? []).map(({ solver }) =>
        this.getCandidateProgress(solver),
      ),
    )
  }

  private shouldExpandPortfolio(): boolean {
    if (this.adaptiveSearchExpanded) return false

    const expansionWorkBudget =
      this.cachedDynamicExpansionWorkBudget ??
      this.getDynamicExpansionWorkBudget()
    this.stats.dynamicExpansionWorkBudget = expansionWorkBudget
    return this.getTotalCandidateWork() >= expansionWorkBudget
  }

  /**
   * P1 parallel race (perf-artifacts/parallelism-design.md): dispatch every
   * portfolio candidate to the worker pool and take the first solve. Enabled
   * by TS_PARALLEL_PORTFOLIO=N (worker count). NOT result-identical to the
   * sequential fitness schedule (winner identity can change) — quality-gated.
   */
  private parallelRaceStep() {
    const replay2Workers = parallelReplay2Enabled()
    if (replay2Workers > 0) {
      this.parallelReplay2Step(replay2Workers)
      return
    }
    const replayWorkers = parallelReplayEnabled()
    if (replayWorkers > 0) {
      this.parallelReplayStep(replayWorkers)
      return
    }
    // Compute the same hyperparameter set the sequential supervisor would
    // construct (including adaptive-expansion candidates) without building
    // any solver in-process.
    const defs = this.getHyperParameterDefs()
    const combinationDefs = this.getCombinationDefs() ?? [
      defs.map((def) => def.name),
    ]
    const hyperParameterList: Array<Record<string, any>> = []
    for (const combinationDef of combinationDefs) {
      hyperParameterList.push(
        ...this.getHyperParameterCombinations(
          defs.filter((hpd) => combinationDef.includes(hpd.name)),
        ),
      )
    }
    for (const shuffleSeed of ORDERING_SHUFFLE_SEEDS.slice(1)) {
      hyperParameterList.push({ HIGH_DENSITY_A01: true, SHUFFLE_SEED: shuffleSeed })
    }

    const constructorParams = this.constructorParams as unknown as Record<
      string,
      unknown
    >
    const outcome = getGlobalRacePool().race(
      hyperParameterList.map((hyperParameters) => ({
        hyperParameters,
        constructorParams,
      })),
    )

    if (outcome.status === "solved") {
      // Worker already applied extractWinningRoutes post-processing.
      this.solvedRoutes = outcome.routes
      this.solved = true
      this.progress = 1
      this.stats.parallelRace = true
      this.stats.parallelRaceWinnerIterations = outcome.iterations
    } else {
      this.failed = true
      this.error = `All candidates failed in parallel race. ${outcome.errors
        .slice(0, 3)
        .join("; ")}`
    }
  }

  /**
   * P2-replay (perf-artifacts/parallelism-design.md §5): run all candidates
   * in workers, then replay the sequential fitness schedule over the
   * recorded progress trajectories. Winner (and therefore routes) is
   * bit-identical to the sequential supervisor. Enabled via
   * TS_PARALLEL_REPLAY=N (worker count).
   */
  private parallelReplayStep(workers: number) {
    const defs = this.getHyperParameterDefs()
    const combinationDefs = this.getCombinationDefs() ?? [
      defs.map((def) => def.name),
    ]
    const hyperParameterList: Array<Record<string, any>> = []
    for (const combinationDef of combinationDefs) {
      hyperParameterList.push(
        ...this.getHyperParameterCombinations(
          defs.filter((hpd) => combinationDef.includes(hpd.name)),
        ),
      )
    }
    const initialCount = hyperParameterList.length
    for (const shuffleSeed of ORDERING_SHUFFLE_SEEDS.slice(1)) {
      hyperParameterList.push({ HIGH_DENSITY_A01: true, SHUFFLE_SEED: shuffleSeed })
    }

    const constructorParams = this.constructorParams as unknown as Record<
      string,
      unknown
    >
    const outcome = runReplayRace(
      hyperParameterList.map((hyperParameters) => ({
        hyperParameters,
        constructorParams,
      })),
      {
        workers,
        nodeSegmentCount: this.getNodeSegmentCount(),
        initialCount,
      },
    )

    if (outcome.winnerIndex !== null && outcome.routes) {
      this.solvedRoutes = outcome.routes
      this.solved = true
      this.progress = 1
      this.stats.parallelReplay = true
      this.stats.parallelReplayWinnerIndex = outcome.winnerIndex
      if (typeof process !== "undefined" && process.env.PERF_SUPERVISOR_STATS) {
        const g = globalThis as unknown as {
          __replayStats?: Array<Record<string, unknown>>
        }
        g.__replayStats ??= []
        g.__replayStats.push({
          nodeId: this.nodeWithPortPoints.capacityMeshNodeId,
          winnerIndex: outcome.winnerIndex,
          winnerIterations: outcome.results[outcome.winnerIndex]!.iterations,
          winnerHp: JSON.stringify(hyperParameterList[outcome.winnerIndex]),
        })
      }
    } else {
      this.failed = true
      this.error = "All candidates failed in parallel replay"
    }
  }

  /** Sequential supervisor path (shared by all parallel fallbacks). */
  private parallelRaceStepSequentialFallback() {
    if (!this.supervisedSolvers) this.initializeSolvers()
    while (!this.solved && !this.failed) {
      if (this.iterations >= this.MAX_ITERATIONS) {
        this.failed = true
        return
      }
      this.iterations++
      if (
        !this.adaptiveSearchExpanded &&
        !this.getSupervisedSolverWithBestFitness()
      ) {
        this.expandAdaptiveSearch()
      }
      HyperParameterSupervisorSolver.prototype._step.call(this)
      if (this.activeSubSolver) {
        this.recordCandidateWork(this.activeSubSolver)
      }
      if (this.checkNodeWorkCap()) return
      if (!this.solved && !this.failed && this.shouldExpandPortfolio()) {
        this.expandAdaptiveSearch()
      }
    }
  }

  /**
   * P2-replay stage 2: online deterministic replay with early exit
   * (TS_PARALLEL_REPLAY2=N). Workers stream trajectories; the schedule is
   * replayed online; losers are cancelled as soon as the winner is known.
   */
  private parallelReplay2Step(workers: number) {
    // Hybrid gate: per-node worker dispatch overhead (session broadcast +
    // factory construction per worker + ~100 task messages) only pays off
    // when the node has real work. Small nodes stay sequential.
    const minPoints = Number(process.env.TS_PARALLEL_REPLAY2_MIN_POINTS ?? 6)
    if (
      this.nodeWithPortPoints.portPoints.length < minPoints ||
      !this.connMap
    ) {
      this.parallelRaceStepSequentialFallback()
      return
    }
    const defs = this.getHyperParameterDefs()
    const combinationDefs = this.getCombinationDefs() ?? [
      defs.map((def) => def.name),
    ]
    const hyperParameterList: Array<Record<string, any>> = []
    for (const combinationDef of combinationDefs) {
      hyperParameterList.push(
        ...this.getHyperParameterCombinations(
          defs.filter((hpd) => combinationDef.includes(hpd.name)),
        ),
      )
    }
    const initialCount = hyperParameterList.length
    for (const shuffleSeed of ORDERING_SHUFFLE_SEEDS.slice(1)) {
      hyperParameterList.push({ HIGH_DENSITY_A01: true, SHUFFLE_SEED: shuffleSeed })
    }

    const constructorParams = this.constructorParams as unknown as Record<
      string,
      unknown
    >
    const outcome = runOnlineReplayRace(
      hyperParameterList.map((hyperParameters) => ({
        hyperParameters,
        constructorParams,
      })),
      {
        workers,
        nodeSegmentCount: this.getNodeSegmentCount(),
        initialCount,
        connMap: this.connMap,
      },
    )

    if (outcome.winnerIndex !== null && outcome.routes) {
      this.solvedRoutes = outcome.routes
      this.solved = true
      this.progress = 1
      this.stats.parallelReplay2 = true
      this.stats.parallelReplay2WinnerIndex = outcome.winnerIndex
      this.stats.parallelReplay2Dispatched = outcome.stats.dispatched
      this.stats.parallelReplay2Completed = outcome.stats.completed
      if (typeof process !== "undefined" && process.env.PERF_SUPERVISOR_STATS) {
        const g = globalThis as unknown as {
          __replayStats?: Array<Record<string, unknown>>
        }
        g.__replayStats ??= []
        g.__replayStats.push({
          nodeId: this.nodeWithPortPoints.capacityMeshNodeId,
          winnerIndex: outcome.winnerIndex,
          winnerIterations: -1,
          winnerHp: JSON.stringify(hyperParameterList[outcome.winnerIndex]),
          dispatched: outcome.stats.dispatched,
          completed: outcome.stats.completed,
        })
      }
    } else {
      this.failed = true
      this.error = "All candidates failed in parallel replay2"
    }
  }

  override _step() {
    if (parallelPortfolioEnabled()) {
      this.parallelRaceStep()
      return
    }
    if (!this.supervisedSolvers) this.initializeSolvers()

    if (
      !this.adaptiveSearchExpanded &&
      !this.getSupervisedSolverWithBestFitness()
    ) {
      this.expandAdaptiveSearch()
    }

    super._step()

    // Lean portfolio exhausted: retry this node with the full portfolio so
    // solvability matches the sequential path.
    if (this.failed && this.leanMode && !this.leanRetried) {
      this.leanRetried = true
      this.leanMode = false
      this.failed = false
      this.error = null
      this.supervisedSolvers = undefined
      this.adaptiveSearchExpanded = false
      this.totalCandidateWork = 0
      this.lastCountedCandidateIterations = new Map()
      this.cachedDynamicExpansionWorkBudget = null
      this.initializeSolvers()
      return
    }

    // PERF_SUPERVISOR_STATS: record nodes the portfolio gives up on. The
    // onSolve hook only fires on success, so failures (the stagnation tail)
    // were invisible.
    if (
      this.failed &&
      !this.recordedFailureStats &&
      typeof process !== "undefined" &&
      process.env.PERF_SUPERVISOR_STATS
    ) {
      this.recordedFailureStats = true
      const g = globalThis as unknown as {
        __supervisorStats?: Array<Record<string, unknown>>
      }
      g.__supervisorStats ??= []
      let maxCandidateWorkF = 0
      let sumCandidateWorkF = 0
      for (const iterations of this.lastCountedCandidateIterations.values()) {
        sumCandidateWorkF += iterations
        if (iterations > maxCandidateWorkF) maxCandidateWorkF = iterations
      }
      g.__supervisorStats.push({
        nodeId: this.nodeWithPortPoints.capacityMeshNodeId,
        nodeFailed: true,
        maxCandidateWork: maxCandidateWorkF,
        sumCandidateWork: sumCandidateWorkF,
        points: this.nodeWithPortPoints.portPoints.length,
        totalCandidateWork: this.getTotalCandidateWork(),
        candidates: this.supervisedSolvers?.length ?? 0,
        supervisorIterations: this.iterations,
        expanded: this.adaptiveSearchExpanded,
      })
    }

    // super._step() advanced (at most) one candidate: the one it left in
    // activeSubSolver. Fold its new iterations into totalCandidateWork.
    if (this.activeSubSolver) {
      this.recordCandidateWork(this.activeSubSolver)
    }

    if (this.checkNodeWorkCap()) return

    if (!this.solved && !this.failed && this.shouldExpandPortfolio()) {
      this.expandAdaptiveSearch()
    }
  }

  computeG(solver: IntraNodeRouteSolver) {
    if (
      (solver as any) instanceof HighDensitySolverA01 ||
      (solver as any) instanceof HighDensityA03Solver
    ) {
      return (solver as any).iterations / 1_000_000
    }
    if (solver?.hyperParameters?.MULTI_HEAD_POLYLINE_SOLVER) {
      return (
        1000 +
        ((solver.hyperParameters?.ITERATION_PENALTY ?? 0) + solver.iterations) /
          10_000 +
        10_000 * (solver.hyperParameters.SEGMENTS_PER_POLYLINE! - 3)
      )
    }
    return (
      solver.iterations / 10_000 // + solver.hyperParameters.SHUFFLE_SEED! * 0.05
    )
  }

  computeH(solver: IntraNodeRouteSolver) {
    if (this.adaptiveSearchExpanded) {
      return 1 - this.getCandidateProgress(solver)
    }
    return 1 - (solver.progress || 0)
  }

  generateSolver(hyperParameters: any): IntraNodeRouteSolver {
    if (hyperParameters.SINGLE_LAYER_NO_DIFFERENT_ROOT_INTERSECTIONS) {
      if (
        !SingleLayerNoDifferentRootIntersectionsIntraNodeSolver.isApplicable(
          this.nodeWithPortPoints,
        )
      ) {
        const ineligibleSolver = new IntraNodeRouteSolver({
          nodeWithPortPoints: this.nodeWithPortPoints,
          connMap: this.connMap,
          traceWidth: this.constructorParams.traceWidth,
          viaDiameter: this.constructorParams.viaDiameter,
          obstacleMargin: this.constructorParams.obstacleMargin,
        })
        ineligibleSolver.failed = true
        ineligibleSolver.error =
          "Single-layer no-different-root-intersection solver not applicable"
        return ineligibleSolver as any
      }

      return new SingleLayerNoDifferentRootIntersectionsIntraNodeSolver({
        nodeWithPortPoints: this.nodeWithPortPoints,
        traceWidth: this.constructorParams.traceWidth,
        viaDiameter: this.constructorParams.viaDiameter,
      }) as any
    }

    if (hyperParameters.HIGH_DENSITY_A01) {
      if (nativeA01Enabled()) {
        return new NativeHighDensitySolverA01({
          nodeWithPortPoints: this.nodeWithPortPoints,
          cellSizeMm: 0.1,
          viaDiameter: this.constructorParams.viaDiameter ?? 0.3,
          traceThickness: this.constructorParams.traceWidth ?? 0.15,
          traceMargin: 0.1,
          viaMinDistFromBorder:
            (this.constructorParams.viaDiameter ?? 0.3) / 2,
          effort: this.effort,
          hyperParameters: {
            shuffleSeed: hyperParameters.SHUFFLE_SEED ?? 0,
          },
        }) as any
      }
      const solver = new HighDensitySolverA01({
        nodeWithPortPoints: this.nodeWithPortPoints,
        cellSizeMm: 0.1,
        viaDiameter: this.constructorParams.viaDiameter ?? 0.3,
        viaMinDistFromBorder: (this.constructorParams.viaDiameter ?? 0.3) / 2,
        traceMargin: 0.1,
        traceThickness: this.constructorParams.traceWidth ?? 0.15,
        effort: this.effort,
        hyperParameters: {
          shuffleSeed: hyperParameters.SHUFFLE_SEED ?? 0,
        },
      })
      return solver as any
    }
    if (hyperParameters.HIGH_DENSITY_A03) {
      const solver = new HighDensityA03Solver({
        nodeWithPortPoints: this.nodeWithPortPoints,
        highResolutionCellSize: 0.1,
        highResolutionCellThickness: 8,
        lowResolutionCellSize: 0.4,
        viaDiameter: this.constructorParams.viaDiameter ?? 0.3,
        viaMinDistFromBorder: (this.constructorParams.viaDiameter ?? 0.3) / 2,
        traceMargin: 0.1,
        // This likely needs to be corrected to use the actual trace width-
        // but using anything but 0.1 for traceThickness is causing issues
        // needs more debugging- repro01 in the high-density-a01 repo
        // has a good reproduction
        traceThickness: 0.1, // this.constructorParams.traceWidth ?? 0.15,
        effort: this.effort,
        hyperParameters,
      })
      return solver as any
    }
    if (hyperParameters.CLOSED_FORM_TWO_TRACE_SAME_LAYER) {
      return new TwoCrossingRoutesHighDensitySolver({
        nodeWithPortPoints: this.nodeWithPortPoints,
        viaDiameter: this.constructorParams.viaDiameter,
      }) as any
    }
    if (hyperParameters.CLOSED_FORM_TWO_TRACE_TRANSITION_CROSSING) {
      return new SingleTransitionCrossingRouteSolver({
        nodeWithPortPoints: this.nodeWithPortPoints,
        viaDiameter: this.constructorParams.viaDiameter,
      }) as any
    }
    if (hyperParameters.CLOSED_FORM_SINGLE_TRANSITION) {
      return new SingleTransitionIntraNodeSolver({
        nodeWithPortPoints: this.nodeWithPortPoints,
        viaDiameter: this.constructorParams.viaDiameter,
      }) as any
    }
    if (hyperParameters.THROUGH_OBSTACLE) {
      return new SingleTransitionThroughObstacleIntraNodeSolver({
        nodeWithPortPoints: this.nodeWithPortPoints,
        obstacles: this.constructorParams.obstacles,
        connMap: this.connMap,
        layerCount: this.constructorParams.layerCount,
        viaDiameter: this.constructorParams.viaDiameter,
        traceThickness: this.constructorParams.traceWidth,
      }) as any
    }
    if (hyperParameters.MULTI_HEAD_POLYLINE_SOLVER) {
      return new MultiHeadPolyLineIntraNodeSolver3({
        nodeWithPortPoints: this.nodeWithPortPoints,
        connMap: this.connMap,
        hyperParameters: hyperParameters,
        viaDiameter: this.constructorParams.viaDiameter,
      }) as any
    }
    return new CachedIntraNodeRouteSolver({
      ...this.constructorParams,
      hyperParameters,
    })
  }

  onSolve(solver: SupervisedSolver<IntraNodeRouteSolver>) {
    // PERF_SUPERVISOR_STATS=1: record the sequential-schedule work ratio
    // R = total candidate work / winner work for the parallelism design
    // (perf-artifacts/parallelism-design.md). Stats-only, no behavior change.
    if (typeof process !== "undefined" && process.env.PERF_SUPERVISOR_STATS) {
      const g = globalThis as unknown as {
        __supervisorStats?: Array<Record<string, unknown>>
      }
      g.__supervisorStats ??= []
      if (
        process.env.PERF_CAPTURE_NODE &&
        this.nodeWithPortPoints.capacityMeshNodeId ===
          process.env.PERF_CAPTURE_NODE
      ) {
        ;(globalThis as unknown as { __capturedParams?: unknown })
          .__capturedParams = this.constructorParams
      }
      // Per-candidate work at the moment the winner is known. Sequential cost
      // is the SUM of these; a perfect in-process race costs the MAX (every
      // candidate runs concurrently, losers cancelled once the winner lands).
      // The ratio is the hard ceiling on any racing scheme, measured before
      // committing to one.
      let maxCandidateWork = 0
      let sumCandidateWork = 0
      let countedCandidates = 0
      for (const iterations of this.lastCountedCandidateIterations.values()) {
        sumCandidateWork += iterations
        countedCandidates++
        if (iterations > maxCandidateWork) maxCandidateWork = iterations
      }
      g.__supervisorStats.push({
        nodeId: this.nodeWithPortPoints.capacityMeshNodeId,
        winnerHp: JSON.stringify(solver.hyperParameters),
        winnerIterations: solver.solver.iterations,
        winnerKind: solver.solver.constructor.name,
        totalCandidateWork: this.getTotalCandidateWork(),
        maxCandidateWork,
        sumCandidateWork,
        countedCandidates,
        candidates: this.supervisedSolvers?.length ?? 0,
        supervisorIterations: this.iterations,
        expanded: this.adaptiveSearchExpanded,
      })
    }
    this.solvedRoutes = extractWinningRoutes(
      solver.solver,
      this.nodeWithPortPoints,
    )
  }
}
