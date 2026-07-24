import {
  HighDensitySolverA03 as HighDensityA03Solver,
  HighDensitySolverA01,
} from "@tscircuit/high-density-a01"
import type {
  HighDensityIntraNodeRoute,
  NodeWithPortPoints,
} from "lib/types/high-density-types"
import { repairDisconnectedSameRootPortPoints } from "./repairDisconnectedSameRootPortPoints"

/**
 * Produces the portfolio's winning routes from a solved candidate solver.
 * Shared by the sequential supervisor path (onSolve) and the parallel race
 * worker so both apply identical post-processing.
 */
export const extractWinningRoutes = (
  solver: object,
  nodeWithPortPoints: NodeWithPortPoints,
): HighDensityIntraNodeRoute[] => {
  let routes: HighDensityIntraNodeRoute[]
  if (
    solver instanceof HighDensitySolverA01 ||
    solver instanceof HighDensityA03Solver
  ) {
    routes = solver.getOutput()
  } else if (
    "solvedRoutes" in solver && Array.isArray(solver.solvedRoutes)
  ) {
    routes = solver.solvedRoutes as HighDensityIntraNodeRoute[]
  } else {
    routes = []
  }

  const routesWithRootConnectionNames = routes.map((route) => {
    const matchingPortPoint = nodeWithPortPoints.portPoints.find(
      (p) => p.connectionName === route.connectionName,
    )
    if (matchingPortPoint?.rootConnectionName) {
      return {
        ...route,
        rootConnectionName: matchingPortPoint.rootConnectionName,
      }
    }
    return route
  })

  return repairDisconnectedSameRootPortPoints(
    routesWithRootConnectionNames,
    nodeWithPortPoints,
  )
}
