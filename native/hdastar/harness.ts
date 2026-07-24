import { HighDensitySolverA01 } from "/home/pullin/personal/awt-r3/node_modules/@tscircuit/high-density-a01/lib/HighDensitySolverA01/HighDensitySolverA01"
import { defaultParams } from "/home/pullin/personal/awt-r3/node_modules/@tscircuit/high-density-a01/lib/default-params"
import { solveA01Native } from "/home/pullin/personal/awt-r3/native/hdastar/a01NativeDriver"

const MODE = process.argv[2] ?? "run"
const sampleFile = process.argv[3] ?? "sample001"
const sample = await import(
  `/home/pullin/personal/awt-r3/node_modules/@tscircuit/high-density-a01/tests/dataset01/${sampleFile}/${sampleFile}.json`
)

const fnv1a = (s: string) => {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

const nodeWithPortPoints = sample.default ?? sample

function makeInput() {
  const node = nodeWithPortPoints as any
  const availableZ =
    node.availableZ ??
    [...new Set(node.portPoints.map((p: any) => p.z))].sort(
      (a: number, b: number) => a - b,
    )
  const cellSizeMm = defaultParams.cellSizeMm
  return {
    rows: Math.floor(node.height / cellSizeMm),
    cols: Math.floor(node.width / cellSizeMm),
    layers: availableZ.length,
    availableZ,
    cellSizeMm,
    viaDiameter: defaultParams.viaDiameter,
    traceThickness: defaultParams.traceThickness,
    traceMargin: defaultParams.traceMargin,
    viaMinDistFromBorder: defaultParams.viaMinDistFromBorder,
    effort: 1,
    maxCellCount: null,
    stepMultiplier: 1,
    hyperParameters: {
      shuffleSeed: 0,
      ripCost: 10,
      ripTracePenalty: 0.5,
      ripViaPenalty: 0.75,
      viaBaseCost: 0.1,
      greedyMultiplier: 1.5,
    },
    gridOrigin: {
      x: node.center.x - node.width / 2,
      y: node.center.y - node.height / 2,
    },
    width: node.width,
    height: node.height,
    regionId: node.capacityMeshNodeId ?? null,
    portPoints: node.portPoints,
    maxIterations: 100e6,
  }
}

if (MODE === "run" || MODE === "compare") {
  const solver = new HighDensitySolverA01({
    ...defaultParams,
    nodeWithPortPoints: nodeWithPortPoints as never,
  })
  solver.MAX_ITERATIONS = 10_000_000
  solver.solve()
  const tsJson = JSON.stringify(solver.getOutput())
  const tsHash = fnv1a(tsJson)
  console.log(
    `TS:   solved=${solver.solved} iters=${solver.iterations} len=${tsJson.length} fnv1a=${tsHash}`,
  )

  const t0 = performance.now()
  const native = solveA01Native(makeInput())
  const t1 = performance.now()
  const rustJson = JSON.stringify(native.routes)
  const rustHash = fnv1a(rustJson)
  console.log(
    `RUST: solved=${native.solved} iters=${native.iterations} len=${rustJson.length} fnv1a=${rustHash} (${(t1 - t0).toFixed(1)}ms incl. JSON)`,
  )
  console.log(tsHash === rustHash ? "IDENTICAL ✓" : "MISMATCH ✗")
  if (tsHash !== rustHash) {
    // locate first difference
    const a = tsJson
    const b = rustJson
    let i = 0
    while (i < Math.min(a.length, b.length) && a[i] === b[i]) i++
    console.log(`first diff at ${i}:`)
    console.log("TS:  ", a.slice(Math.max(0, i - 80), i + 80))
    console.log("RUST:", b.slice(Math.max(0, i - 80), i + 80))
  }
}

if (MODE === "bench") {
  const input = makeInput()
  const N = Number(process.argv[4] ?? 20)
  // warm
  for (let i = 0; i < 3; i++) solveA01Native(input)
  const times: number[] = []
  for (let i = 0; i < N; i++) {
    const t0 = performance.now()
    solveA01Native(input)
    times.push(performance.now() - t0)
  }
  times.sort((a, b) => a - b)
  console.log(`native median: ${times[Math.floor(N / 2)]!.toFixed(2)}ms (min ${times[0]!.toFixed(2)})`)

  const tsTimes: number[] = []
  for (let i = 0; i < N; i++) {
    const solver = new HighDensitySolverA01({
      ...defaultParams,
      nodeWithPortPoints: nodeWithPortPoints as never,
    })
    solver.MAX_ITERATIONS = 10_000_000
    const t0 = performance.now()
    solver.solve()
    tsTimes.push(performance.now() - t0)
  }
  tsTimes.sort((a, b) => a - b)
  console.log(`ts median:     ${tsTimes[Math.floor(N / 2)]!.toFixed(2)}ms (min ${tsTimes[0]!.toFixed(2)})`)
}
