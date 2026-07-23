import { expect, test } from "bun:test"
import { ConnectivityMap } from "circuit-json-to-connectivity-map"
import { SameNetViaMergerSolver } from "lib/solvers/SameNetViaMergerSolver/SameNetViaMergerSolver"
import type { HighDensityRoute } from "lib/types/high-density-types"

const makeViaRoute = (connectionName: string, x: number): HighDensityRoute => ({
  connectionName,
  traceThickness: 0.15,
  viaDiameter: 0.3,
  route: [
    { x, y: 0, z: 0 },
    { x, y: 0, z: 1 },
  ],
  vias: [{ x, y: 0 }],
})

test("SameNetViaMergerSolver consolidates a chain within the near-merge radius", () => {
  const solver = new SameNetViaMergerSolver({
    inputHdRoutes: [
      makeViaRoute("route-a", 0),
      makeViaRoute("route-b", 0.25),
      makeViaRoute("route-c", 0.5),
    ],
    obstacles: [],
    colorMap: {},
    layerCount: 2,
    connMap: new ConnectivityMap({
      net0: ["route-a", "route-b", "route-c"],
    }),
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.iterations).toBeLessThan(10)

  const routes = solver.getMergedViaHdRoutes()
  if (!routes) {
    throw new Error("Expected SameNetViaMergerSolver to emit merged routes")
  }
  expect(routes.flatMap((route) => route.vias)).toEqual([
    { x: 0, y: 0 },
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ])
})

test("SameNetViaMergerSolver tolerates rounded via coordinates", () => {
  const roundedRoute = makeViaRoute("route-a", 0)
  roundedRoute.route = roundedRoute.route.map((point) => ({
    ...point,
    x: point.x + 5e-7,
  }))
  const solver = new SameNetViaMergerSolver({
    inputHdRoutes: [roundedRoute, makeViaRoute("route-b", 0.25)],
    obstacles: [],
    colorMap: {},
    layerCount: 2,
    connMap: new ConnectivityMap({ net0: ["route-a", "route-b"] }),
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.getMergedViaHdRoutes()?.flatMap((route) => route.vias)).toEqual(
    [
      { x: 0, y: 0 },
      { x: 0, y: 0 },
    ],
  )
})

test("SameNetViaMergerSolver skips a stale via without a route transition", () => {
  const staleViaRoute = makeViaRoute("route-a", 0)
  staleViaRoute.route = [
    { x: 1, y: 0, z: 0 },
    { x: 1, y: 0, z: 1 },
  ]
  const solver = new SameNetViaMergerSolver({
    inputHdRoutes: [staleViaRoute, makeViaRoute("route-b", 0.25)],
    obstacles: [],
    colorMap: {},
    layerCount: 2,
    connMap: new ConnectivityMap({ net0: ["route-a", "route-b"] }),
  })

  solver.solve()

  expect(solver.failed).toBe(false)
  expect(solver.getMergedViaHdRoutes()?.[0]?.vias).toEqual([{ x: 0, y: 0 }])
})

test("SameNetViaMergerSolver accepts a partially merged large input at its budget", () => {
  const connectionNames = Array.from(
    { length: 500 },
    (_, index) => `route-${index}`,
  )
  const solver = new SameNetViaMergerSolver({
    inputHdRoutes: connectionNames.map((connectionName, index) =>
      makeViaRoute(connectionName, index * 0.25),
    ),
    obstacles: [],
    colorMap: {},
    layerCount: 2,
    connMap: new ConnectivityMap({ net0: connectionNames }),
  })

  expect(solver.MAX_ITERATIONS).toBe(500)
  solver.iterations = solver.MAX_ITERATIONS
  solver.step()

  expect(solver.solved).toBe(true)
  expect(solver.failed).toBe(false)
  expect(solver.stats.acceptedPartiallyMergedLargeInput).toBe(true)
})
