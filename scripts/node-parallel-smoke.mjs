#!/usr/bin/env node
/**
 * Node-parallel smoke for the runtime-adaptive worker layer
 * (lib/parallel/runtime.ts): proves the pipeline completes under NODE both
 * sequentially and with node worker_threads HD-node parallelism, with equal
 * results.
 *
 * Per sample it runs the bundled harness (scripts/node-parallel-smoke-harness
 * .ts) twice under node:
 *   sequential — TS_PARALLEL_HD_NODES=0 TS_PARALLEL_A2=0
 *   parallel   — TS_PARALLEL_HD_NODES=2 TS_PARALLEL_A2=0
 * For sample 5 it ASSERTS: both complete, equal DRC error counts, equal
 * nodeSolveMetadataById key/status sets, and that the parallel run actually
 * took the worker path. Other samples (8 by default) are reported
 * informationally: completion asserted, wall times and parity printed.
 *
 * Usage:
 *   node scripts/node-parallel-smoke.mjs               # samples 5 and 8
 *   node scripts/node-parallel-smoke.mjs --samples 5   # just the parity gate
 *
 * Needs bun on PATH (bundles the harness and prebuilds the worker entries so
 * parallel wall times exclude bundling).
 */
import { spawnSync } from "node:child_process"
import { mkdirSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const buildDir = join(root, ".parallel-worker-build")
const harnessOut = join(buildDir, "node-parallel-smoke-harness.mjs")

const args = process.argv.slice(2)
const samplesArgIndex = args.indexOf("--samples")
const samples = (samplesArgIndex >= 0 ? args[samplesArgIndex + 1] : "5,8")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0)

const fail = (message) => {
  console.error(`FAIL: ${message}`)
  process.exit(1)
}

// Same build path runtime.ts uses (native/ FFI modules stubbed for node).
const buildScript = "lib/parallel/nodeEntry/buildNodeWorkerBundle.ts"

const bunBuild = (entry, outfile) => {
  const res = spawnSync("bun", [buildScript, entry, outfile], {
    cwd: root,
    encoding: "utf8",
  })
  if (res.error || res.status !== 0) {
    fail(`bun build of ${entry} failed: ${res.error ?? res.stderr}`)
  }
}

mkdirSync(buildDir, { recursive: true })
console.log("bundling harness + worker entries with bun build...")
bunBuild("scripts/node-parallel-smoke-harness.ts", harnessOut)
// Same outputs runtime.ts's ensureNodeWorkerBundle would produce lazily;
// prebuilt here so parallel wall times exclude bundling.
bunBuild(
  "lib/parallel/nodeEntry/hdNodeWorker.entry.ts",
  join(buildDir, "hdNodeWorker.node.mjs"),
)
bunBuild(
  "lib/parallel/nodeEntry/a2BranchWorker.entry.ts",
  join(buildDir, "a2BranchWorker.node.mjs"),
)

const runOne = (label, sample, flags) => {
  const env = { ...process.env, ...flags }
  // Representative user context: no benchmark/CI/test markers, no eviction.
  delete env.NODE_ENV
  delete env.CI
  delete env.TS_BENCHMARK
  delete env.BENCHMARK
  delete env.TS_EVICT_REPATH
  const t0 = Date.now()
  const res = spawnSync(
    process.execPath,
    [harnessOut, "--sample", String(sample)],
    { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, env },
  )
  const spawnWallS = ((Date.now() - t0) / 1000).toFixed(1)
  if (res.error || res.status !== 0) {
    fail(
      `${label}: harness exited ${res.status} (${res.error ?? "no spawn error"})\n` +
        `--- stdout tail ---\n${(res.stdout ?? "").slice(-2000)}\n` +
        `--- stderr tail ---\n${(res.stderr ?? "").slice(-4000)}`,
    )
  }
  const line = (res.stdout ?? "")
    .split("\n")
    .reverse()
    .find((l) => l.startsWith("RESULT "))
  if (!line) fail(`${label}: no RESULT line in harness output`)
  const out = JSON.parse(line.slice("RESULT ".length))
  console.log(
    `${label}: solved=${out.solved} failed=${out.failed} drcErrors=${out.drcErrors} ` +
      `iterations=${out.iterations} hdWorkers=${out.hdParallelWorkerCount} ` +
      `nodes=${out.nodeStatusCount} wallS=${out.wallS} hdStageWallS=${out.hdStageWallS} ` +
      `(process wall ${spawnWallS}s)`,
  )
  if (!out.solved || out.failed) {
    fail(`${label}: run did not complete (error: ${out.error})`)
  }
  return out
}

const compare = (sample, seq, par, { assert }) => {
  const problems = []
  if (seq.drcErrors !== par.drcErrors) {
    problems.push(`drcErrors differ: seq=${seq.drcErrors} par=${par.drcErrors}`)
  }
  const seqSet = seq.nodeStatuses.join("|")
  const parSet = par.nodeStatuses.join("|")
  if (seqSet !== parSet) {
    const seqOnly = seq.nodeStatuses.filter(
      (s) => !par.nodeStatuses.includes(s),
    )
    const parOnly = par.nodeStatuses.filter(
      (s) => !seq.nodeStatuses.includes(s),
    )
    problems.push(
      `nodeSolveMetadataById key/status sets differ: ` +
        `seq-only=[${seqOnly.slice(0, 5)}] par-only=[${parOnly.slice(0, 5)}] ` +
        `(counts seq=${seq.nodeStatuses.length} par=${par.nodeStatuses.length})`,
    )
  }
  if ((par.hdParallelWorkerCount ?? 0) < 1) {
    problems.push(
      `parallel run did not take the worker path (hdParallelWorkerCount=${par.hdParallelWorkerCount})`,
    )
  }
  if (problems.length === 0) {
    console.log(
      `s${sample}: PARITY OK (drc + node status sets equal, parallel path taken)`,
    )
  } else if (assert) {
    fail(`s${sample}: ${problems.join("; ")}`)
  } else {
    console.log(
      `s${sample}: PARITY MISMATCH (informational): ${problems.join("; ")}`,
    )
  }
}

for (const sample of samples) {
  const seq = runOne(`s${sample} sequential`, sample, {
    TS_PARALLEL_HD_NODES: "0",
    TS_PARALLEL_A2: "0",
  })
  const par = runOne(`s${sample} parallel`, sample, {
    TS_PARALLEL_HD_NODES: "2",
    TS_PARALLEL_A2: "0",
  })
  compare(sample, seq, par, { assert: sample === 5 })
  console.log(
    `s${sample} wall: sequential ${seq.wallS}s (hd ${seq.hdStageWallS}s) vs ` +
      `parallel ${par.wallS}s (hd ${par.hdStageWallS}s)`,
  )
}

console.log("node-parallel smoke PASS")
