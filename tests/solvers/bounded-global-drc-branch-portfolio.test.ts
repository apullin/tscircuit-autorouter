import { expect, test } from "bun:test"
import { BoundedGlobalDrcBranchPortfolioSolver } from "lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/BoundedGlobalDrcBranchPortfolioSolver"
import type {
  GlobalDrcBranchPortfolioSolverParams,
  HighDensityRoute,
  SimpleRouteJson,
} from "high-density-repair03/lib"

const srj: SimpleRouteJson = {
  layerCount: 2,
  minTraceWidth: 0.1,
  bounds: { minX: 0, minY: 0, maxX: 100, maxY: 100 },
  obstacles: [],
  connections: [],
}

const makeRoute = (index: number, pointCount: number): HighDensityRoute => ({
  connectionName: `route_${index}`,
  traceThickness: 0.1,
  viaDiameter: 0.3,
  vias: [],
  route: Array.from({ length: pointCount }, (_, pointIndex) => ({
    x: pointIndex * 0.1,
    y: index * 0.1,
    z: 0,
  })),
})

const makeParams = (
  hdRoutes: HighDensityRoute[],
): GlobalDrcBranchPortfolioSolverParams => ({
  srj,
  hdRoutes,
  effort: 1,
  maxIterations: 32,
  broadMaxIterations: 8,
  broadPassMultiplier: 3,
  enableLargeBoardBroadFallback: false,
  enableTargetedErrorSweep: true,
  enablePostSolveClearanceRelaxation: false,
  enableViaInPadLayerMoves: false,
})

test("bounds exact DRC repair for very large routed geometries", () => {
  const routes = Array.from({ length: 500 }, (_, index) => makeRoute(index, 22))
  let evaluationCount = 0
  const solver = new BoundedGlobalDrcBranchPortfolioSolver({
    ...makeParams(routes),
    drcEvaluator: () => {
      evaluationCount += 1
      return { errors: [], errorsWithCenters: [] }
    },
  })

  expect(solver.skippedForLargeBoard).toBe(true)
  solver.step()

  expect(solver.solved).toBe(true)
  expect(solver.getOutput()).toBe(routes)
  expect(solver.stats.exactDrcBranchPortfolioSkippedForLargeBoard).toBe(true)
  expect(evaluationCount).toBe(0)
})

test("keeps the exact DRC portfolio for smaller routed geometries", () => {
  const routes = [makeRoute(0, 2)]
  let evaluationCount = 0
  const solver = new BoundedGlobalDrcBranchPortfolioSolver({
    ...makeParams(routes),
    drcEvaluator: () => {
      evaluationCount += 1
      return { errors: [], errorsWithCenters: [] }
    },
  })

  expect(solver.skippedForLargeBoard).toBe(false)
  solver.step()

  expect(solver.solved).toBe(true)
  expect(evaluationCount).toBe(1)
})
