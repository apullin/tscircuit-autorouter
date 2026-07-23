import { expect, test } from "bun:test"
import {
  selectIslandEndpoints,
  snapIslandEndpointsToDistinctTerminals,
} from "lib/solvers/RouteStitchingSolver/routeStitchingEndpointHelpers"

test("keeps close terminal endpoints assigned to their own layers", () => {
  const topTerminal = {
    x: 15.27,
    y: 4.29,
    z: 0,
    pcb_port_id: "pcb_port_top",
  }
  const bottomTerminal = {
    x: 15.28,
    y: 4.35,
    z: 3,
    pcb_port_id: "pcb_port_bottom",
  }
  const topIslandEndpoint = { x: 15.29, y: 4.32, z: 0 }
  const bottomIslandEndpoint = { x: 15.26, y: 4.31, z: 3 }

  const selected = selectIslandEndpoints({
    possibleEndpoints: [bottomIslandEndpoint, topIslandEndpoint],
    globalStart: topTerminal,
    globalEnd: bottomTerminal,
    matchLayers: true,
  })
  const snapped = snapIslandEndpointsToDistinctTerminals({
    start: selected.start,
    end: selected.end,
    terminals: [topTerminal, bottomTerminal],
  })

  expect(snapped.start).toBe(topTerminal)
  expect(snapped.end).toBe(bottomTerminal)
})

test("does not snap both endpoints of one island to the same terminal", () => {
  const bottomTerminal = {
    x: -0.68,
    y: -8.75,
    z: 3,
    pcb_port_id: "pcb_port_bottom",
  }
  const topTerminal = {
    x: -0.66,
    y: -9.45,
    z: 0,
    pcb_port_id: "pcb_port_top",
  }

  const snapped = snapIslandEndpointsToDistinctTerminals({
    start: { x: -0.68, y: -8.8, z: 3 },
    end: { x: -0.66, y: -9.4, z: 3 },
    terminals: [bottomTerminal, topTerminal],
  })

  expect([snapped.start, snapped.end]).toContain(bottomTerminal)
  expect(
    snapped.start === bottomTerminal && snapped.end === bottomTerminal,
  ).toBe(false)
})
