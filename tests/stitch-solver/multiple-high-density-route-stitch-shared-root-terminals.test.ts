import { expect, test } from "bun:test"
import { MultipleHighDensityRouteStitchSolver3 } from "lib/solvers/RouteStitchingSolver/MultipleHighDensityRouteStitchSolver3"
import type { HighDensityIntraNodeRoute } from "lib/types/high-density-types"
import type { SimpleRouteConnection } from "lib/types"

const makeRoute = (
  connectionName: string,
  points: Array<{ x: number; y: number; z: number }>,
  terminalIds: {
    startPcbPortId?: string
    endPcbPortId?: string
  } = {},
): HighDensityIntraNodeRoute => ({
  connectionName,
  rootConnectionName: "root",
  traceThickness: 0.15,
  viaDiameter: 0.3,
  route: points,
  vias: [],
  jumpers: [],
  ...terminalIds,
})

const makeConnection = (
  name: string,
  startX: number,
  endX: number,
  startPcbPortId: string,
  endPcbPortId: string,
): SimpleRouteConnection => ({
  name,
  __rootConnectionNames: ["root"],
  pointsToConnect: [
    {
      x: startX,
      y: 0,
      layer: "top",
      pcb_port_id: startPcbPortId,
    },
    {
      x: endX,
      y: 0,
      layer: "top",
      pcb_port_id: endPcbPortId,
    },
  ],
})

test("does not borrow shared-root branches with unrelated PCB terminals", () => {
  const targetConnection = makeConnection(
    "target",
    0,
    10,
    "pcb_port_start",
    "pcb_port_end",
  )
  const siblingConnection = makeConnection(
    "sibling",
    2,
    8,
    "pcb_port_other",
    "pcb_port_shared",
  )

  const solver = new MultipleHighDensityRouteStitchSolver3({
    connections: [targetConnection, siblingConnection],
    hdRoutes: [
      makeRoute(
        "target",
        [
          { x: 0, y: 0, z: 0 },
          { x: 2, y: 0, z: 0 },
        ],
        { startPcbPortId: "pcb_port_start" },
      ),
      makeRoute(
        "target",
        [
          { x: 8, y: 0, z: 0 },
          { x: 10, y: 0, z: 0 },
        ],
        { endPcbPortId: "pcb_port_end" },
      ),
      makeRoute(
        "sibling",
        [
          { x: 2, y: 0, z: 0 },
          { x: 8, y: 0, z: 0 },
        ],
        { startPcbPortId: "pcb_port_other" },
      ),
    ],
    layerCount: 2,
    preserveTerminalPcbPortIds: true,
  })

  expect(
    solver.unsolvedRoutes.filter(
      (route) => route.connectionName === targetConnection.name,
    ),
  ).toHaveLength(2)
})
