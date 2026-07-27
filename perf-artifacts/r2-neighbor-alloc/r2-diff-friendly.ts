// Differential identity harness: pre-patch (/tmp/th-before) vs post-patch
// (/tmp/th-after) tiny-hypergraph. Drives both DistanceAware (SoA heap path)
// and base TinyHyperGraphSolver (MinHeap fallback path) over seeded random
// grid topologies and compares the full observable solve outcome bit-exactly.
import {
  DistanceAwareTinyHyperGraphSolver as DistanceAwareBefore,
  TinyHyperGraphSolver as BaseBefore,
} from "/tmp/th-before/lib/index"
import {
  DistanceAwareTinyHyperGraphSolver as DistanceAwareAfter,
  TinyHyperGraphSolver as BaseAfter,
} from "/tmp/th-after/lib/index"
import type {
  TinyHyperGraphProblem,
  TinyHyperGraphTopology,
} from "/tmp/th-after/lib/index"

const mulberry32 = (seed: number) => {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const buildCase = (
  seed: number,
): { topology: TinyHyperGraphTopology; problem: TinyHyperGraphProblem } => {
  const rand = mulberry32(seed)
  const rows = 2 + Math.floor(rand() * 3) // 2..4
  const cols = 2 + Math.floor(rand() * 3) // 2..4
  const regionCount = rows * cols
  const cell = 10

  const regionIncidentPorts: number[][] = Array.from(
    { length: regionCount },
    () => [],
  )
  const incidentPortRegion: number[][] = []
  const portX: number[] = []
  const portY: number[] = []
  const portZ: number[] = []
  const portAngle1: number[] = []
  const portAngle2: number[] = []

  const addPort = (regionA: number, regionB: number, x: number, y: number) => {
    const portId = incidentPortRegion.length
    incidentPortRegion.push([regionA, regionB])
    regionIncidentPorts[regionA]!.push(portId)
    regionIncidentPorts[regionB]!.push(portId)
    portX.push(x)
    portY.push(y)
    portZ.push(0)
    portAngle1.push(0)
    portAngle2.push(0)
  }

  const regionId = (r: number, c: number) => r * cols + c
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      if (c + 1 < cols)
        addPort(regionId(r, c), regionId(r, c + 1), (c + 1) * cell, r * cell + 5)
      if (r + 1 < rows)
        addPort(regionId(r, c), regionId(r + 1, c), c * cell + 5, (r + 1) * cell)
    }
  }

  const portCount = incidentPortRegion.length
  const routeCount = 2 + Math.floor(rand() * 4) // 2..5
  const routeStartPort = new Int32Array(routeCount)
  const routeEndPort = new Int32Array(routeCount)
  const routeNet = new Int32Array(routeCount)
  for (let i = 0; i < routeCount; i++) {
    let a = Math.floor(rand() * portCount)
    let b = Math.floor(rand() * portCount)
    if (a === b) b = (b + 1) % portCount
    routeStartPort[i] = a
    routeEndPort[i] = b
    routeNet[i] = i
  }
  const regionNetId = new Int32Array(regionCount).fill(-1)
  for (let r = 0; r < regionCount; r++) {
    // no reserved regions
  }
  const portSectionMask = new Int8Array(portCount).fill(1)
  for (let p = 0; p < portCount; p++) {
    // all ports in section
  }

  const topology: TinyHyperGraphTopology = {
    portCount,
    regionCount,
    regionIncidentPorts,
    incidentPortRegion,
    regionWidth: new Float64Array(regionCount).fill(cell),
    regionHeight: new Float64Array(regionCount).fill(cell),
    regionCenterX: new Float64Array(regionCount).map(
      (_, i) => (i % cols) * cell + 5,
    ),
    regionCenterY: new Float64Array(regionCount).map(
      (_, i) => Math.floor(i / cols) * cell + 5,
    ),
    portAngleForRegion1: new Int32Array(portAngle1),
    portAngleForRegion2: new Int32Array(portAngle2),
    portX: new Float64Array(portX),
    portY: new Float64Array(portY),
    portZ: new Int32Array(portZ),
  }
  const problem: TinyHyperGraphProblem = {
    routeCount,
    portSectionMask,
    routeStartPort,
    routeEndPort,
    routeNet,
    regionNetId,
  }
  return { topology, problem }
}

type SolverLike = {
  solve: () => void
  iterations: number
  solved: boolean
  failed: boolean
  error: unknown
  state: {
    ripCount: number
    unroutedRoutes: number[]
    portAssignment: Int32Array
    regionSegments: Array<[number, number, number][]>
  }
}

const digest = (solver: SolverLike) =>
  JSON.stringify({
    iterations: solver.iterations,
    solved: solver.solved,
    failed: solver.failed,
    error: solver.error === null ? null : String(solver.error),
    ripCount: solver.state.ripCount,
    unroutedRoutes: solver.state.unroutedRoutes,
    portAssignment: Array.from(solver.state.portAssignment),
    regionSegments: solver.state.regionSegments,
  })

const OPTIONS = {
  STATIC_REACHABILITY_PRECHECK: false,
  MAX_ITERATIONS: 20000,
  DISTANCE_TO_COST: 2,
}

type SolverModule = {
  DistanceAwareTinyHyperGraphSolver: new (
    topology: TinyHyperGraphTopology,
    problem: TinyHyperGraphProblem,
    options: typeof OPTIONS,
  ) => SolverLike
  TinyHyperGraphSolver: new (
    topology: TinyHyperGraphTopology,
    problem: TinyHyperGraphProblem,
    options: typeof OPTIONS,
  ) => SolverLike
}

let mismatches = 0
let cases = 0
for (let seed = 1; seed <= 150; seed++) {
  const { topology, problem } = buildCase(seed)
  for (const kind of ["distance-aware", "base"] as const) {
    cases++
    const make = (mod: SolverModule) =>
      kind === "distance-aware"
        ? new mod.DistanceAwareTinyHyperGraphSolver(topology, problem, OPTIONS)
        : new mod.TinyHyperGraphSolver(topology, problem, OPTIONS)
    const before = make({
      DistanceAwareTinyHyperGraphSolver:
        DistanceAwareBefore as unknown as SolverModule["DistanceAwareTinyHyperGraphSolver"],
      TinyHyperGraphSolver:
        BaseBefore as unknown as SolverModule["TinyHyperGraphSolver"],
    })
    const after = make({
      DistanceAwareTinyHyperGraphSolver:
        DistanceAwareAfter as unknown as SolverModule["DistanceAwareTinyHyperGraphSolver"],
      TinyHyperGraphSolver:
        BaseAfter as unknown as SolverModule["TinyHyperGraphSolver"],
    })
    before.solve()
    after.solve()
    const beforeDigest = digest(before)
    const afterDigest = digest(after)
    if (beforeDigest !== afterDigest) {
      mismatches++
      console.log(`MISMATCH seed=${seed} kind=${kind}`)
      console.log(`  before: ${beforeDigest.slice(0, 400)}`)
      console.log(`  after:  ${afterDigest.slice(0, 400)}`)
      if (mismatches > 5) process.exit(1)
    }
  }
}
console.log(
  `${cases} cases (2 solver kinds x 400 seeds): ${mismatches} mismatches`,
)
process.exit(mismatches === 0 ? 0 : 1)
