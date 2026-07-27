import { DistanceAwareTinyHyperGraphSolver } from "/tmp/th-after/lib/index"
import type {
  TinyHyperGraphProblem,
  TinyHyperGraphTopology,
} from "/tmp/th-after/lib/index"

// 2x2 grid, 4 regions, 4 ports, single route from port 0 to port 3
const topology: TinyHyperGraphTopology = {
  portCount: 4,
  regionCount: 4,
  regionIncidentPorts: [
    [0, 2], // region (0,0): right port 0, down port 2
    [0, 3], // region (0,1): left port 0, down port 3
    [1, 2], // region (1,0): right port 1, up port 2
    [1, 3], // region (1,1): left port 1, up port 3
  ],
  incidentPortRegion: [
    [0, 1],
    [2, 3],
    [0, 2],
    [1, 3],
  ],
  regionWidth: new Float64Array(4).fill(10),
  regionHeight: new Float64Array(4).fill(10),
  regionCenterX: new Float64Array([5, 15, 5, 15]),
  regionCenterY: new Float64Array([5, 5, 15, 15]),
  portAngleForRegion1: new Int32Array(4),
  portAngleForRegion2: new Int32Array(4),
  portX: new Float64Array([10, 10, 5, 15]),
  portY: new Float64Array([5, 15, 10, 10]),
  portZ: new Int32Array(4),
}
const problem: TinyHyperGraphProblem = {
  routeCount: 1,
  portSectionMask: new Int8Array(4).fill(1),
  routeStartPort: new Int32Array([0]),
  routeEndPort: new Int32Array([3]),
  routeNet: new Int32Array([0]),
  regionNetId: new Int32Array(4).fill(-1),
}
const solver = new DistanceAwareTinyHyperGraphSolver(topology, problem, {
  STATIC_REACHABILITY_PRECHECK: false,
  DISTANCE_TO_COST: 2,
})
for (let i = 0; i < 12 && !solver.solved && !solver.failed; i++) {
  solver.step()
  console.log(
    `step ${i}: iterations=${solver.iterations} queue=${solver.state.candidateQueue.length} routeId=${solver.state.currentRouteId} ripCount=${solver.state.ripCount} solved=${solver.solved} failed=${solver.failed} err=${solver.error}`,
  )
}
console.log("regionSegments:", JSON.stringify(solver.state.regionSegments))
