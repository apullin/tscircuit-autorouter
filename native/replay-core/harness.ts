#!/usr/bin/env bun
/**
 * Replay-parity harness: proves the Rust cdylib reproduces the TS portfolio
 * supervisor's deterministic winner selection over a captured dataset.
 *
 *   bun native/replay-core/harness.ts <dataset.rplyds01> [--verbose] [--lib <so>]
 *   bun native/replay-core/harness.ts --selftest [--verbose]
 *
 * For every node the harness runs (a) a TS replay simulation and (b) the Rust
 * replay via bun:ffi, and compares winners. The TS simulation is a MINIMAL
 * REIMPLEMENTATION, transcribed line-for-line from the offline replay in
 * lib/parallel/replayPool.ts:187-260 — the original is not importable in
 * isolation because runReplayRace() fuses worker dispatch with the
 * simulation. The g-function, however, IS imported from the production module
 * (candidateG, replayPool.ts:64-81), so the fitness arithmetic on the TS side
 * is the shipped code. The only transcription difference is trajectory
 * indexing on the schedule grid, which is bit-exact (datasetFormat.ts doc).
 *
 * Exit codes: 0 parity OK, 1 winner mismatches, 2 load/usage error.
 */

import { dlopen, FFIType, suffix } from "bun:ffi"
import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
// Production g-function (replayPool.ts:64-81). replayPool.ts only has a
// type-only import at module scope, so importing it spawns no workers.
import { candidateG } from "../../lib/parallel/replayPool"
import {
  type DatasetCandidate,
  type DatasetNode,
  SAMPLE_STRIDE,
  decodeDataset,
  encodeDataset,
} from "./datasetFormat"

const GREEDY_MULTIPLIER = 5 // PortfolioSingleIntraNodeSolver.ts:260, replayPool.ts:55
const MIN_SUBSTEPS = 100 // PortfolioSingleIntraNodeSolver.ts:261, replayPool.ts:56
if (MIN_SUBSTEPS !== SAMPLE_STRIDE) {
  throw new Error("MIN_SUBSTEPS must equal dataset SAMPLE_STRIDE")
}

// ---------- TS replay simulation (replayPool.ts:187-260 transcription) ----------

type TsOutcome = { winner: number; expanded: boolean; totalWork: number }

const simulateNodeTs = (node: DatasetNode): TsOutcome => {
  const results = node.candidates
  const initialCount = Math.min(node.initialCount, results.length)
  const v = new Float64Array(results.length) // replayPool.ts:188
  // replayPool.ts:189-192
  const expansionBudget = Math.max(
    1,
    ...results.slice(0, initialCount).map((r) => r.maxIterations),
  )
  let expanded = false
  let totalCandidateWork = 0
  let winnerIndex = -1

  // replayPool.ts:197-207, trajectory reads re-indexed to the schedule grid
  // (bit-exact; see datasetFormat.ts module doc).
  const progressAt = (r: DatasetCandidate, vit: number): number => {
    if (expanded && r.solvedSegments >= 0) {
      // getCandidateProgress clamps to [0, 1] (replayPool.ts:199-200)
      return Math.min(1, r.solvedSegments / node.nodeSegmentCount)
    }
    if (vit <= 0) return 0
    if (r.traj.length === 0) return 0 // original idx === -1 branch
    // Raw progress (can exceed 1 — computeH uses `progress || 0` unclamped)
    const idx = Math.min(Math.ceil(vit / MIN_SUBSTEPS), r.traj.length) - 1
    return r.traj[idx]!
  }

  // replayPool.ts:209-210
  const isFailedAt = (r: DatasetCandidate, vit: number): boolean =>
    !r.solved && vit >= r.iterations

  for (let guard = 0; guard < 50_000_000; guard++) {
    // replayPool.ts:212
    // Expansion condition (replayPool.ts:213-222)
    if (
      !expanded &&
      (totalCandidateWork >= expansionBudget ||
        !results.some(
          (r, i) => i < initialCount && !r.solved && !isFailedAt(r, v[i]!),
        ))
    ) {
      expanded = true
    }

    // Best fitness among viable candidates (replayPool.ts:228-247):
    // first-lowest-f, index order.
    let best = -1
    let bestF = Infinity
    const limit = expanded ? results.length : initialCount
    for (let i = 0; i < limit; i++) {
      const r = results[i]!
      // Solved-at-0 candidates stay selectable at v=0 (replayPool.ts:233-236)
      if (r.solved && v[i]! > 0 && v[i]! >= r.iterations) continue
      if (!r.solved && isFailedAt(r, v[i]!)) continue
      const f =
        v[i]! === 0
          ? candidateG(r.hp, 0, r.maxIterations) // initial f = g(0), replayPool.ts:239-240
          : candidateG(r.hp, v[i]!, r.maxIterations) +
            (1 - progressAt(r, v[i]!)) * GREEDY_MULTIPLIER // replayPool.ts:241-242
      if (f < bestF) {
        bestF = f
        best = i
      }
    }

    if (best === -1) break // replayPool.ts:249

    const r = results[best]!
    const advance = Math.min(MIN_SUBSTEPS, r.iterations - v[best]!) // replayPool.ts:252
    v[best]! += advance
    totalCandidateWork += Math.max(0, advance)

    if (r.solved && v[best]! >= r.iterations) {
      // replayPool.ts:256-259
      winnerIndex = best
      break
    }
  }

  return { winner: winnerIndex, expanded, totalWork: totalCandidateWork }
}

// ---------- Rust side (bun:ffi, pattern from awt-r3/native/hdastar) ----------

const openReplayLib = (libPath: string) => {
  return dlopen(libPath, {
    replay_load: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.u64 },
    replay_node_count: { args: [FFIType.u64], returns: FFIType.i64 },
    replay_run: { args: [FFIType.u64, FFIType.u64], returns: FFIType.i32 },
    replay_run_detail: {
      args: [FFIType.u64, FFIType.u64, FFIType.ptr, FFIType.u64],
      returns: FFIType.i64,
    },
    replay_last_error: { args: [FFIType.ptr, FFIType.u64], returns: FFIType.i64 },
    replay_free: { args: [FFIType.u64], returns: FFIType.void },
  })
}

// ---------- Selftest dataset (covers the four replay subtleties) ----------

const buildSelftestNodes = (): DatasetNode[] => {
  const f32 = (xs: number[]) => new Float32Array(xs)
  const cand = (
    hp: Record<string, unknown>,
    solved: boolean,
    iterations: number,
    maxIterations: number,
    traj: Float32Array,
    solvedSegments = -1,
  ): DatasetCandidate => ({
    hp,
    solved,
    iterations,
    maxIterations,
    solvedSegments,
    traj,
  })
  const nodes: DatasetNode[] = [
    {
      // plain schedule: candidate 1 solves at 250
      nodeId: "selftest-basic",
      nodeSegmentCount: 2,
      initialCount: 3,
      capturedWinnerIndex: -1,
      candidates: [
        cand({}, false, 300, 100_000, f32([0.1, 0.2, 0.3])),
        cand({ SHUFFLE_SEED: 0 }, true, 250, 100_000, f32([0.4, 0.9, 1.0]), 2),
        cand({ HIGH_DENSITY_A01: true }, false, 1000, 1_000_000, f32(Array.from({ length: 10 }, (_, i) => 0.05 * i))),
      ],
    },
    {
      // subtlety (3): solved-at-0 candidate must stay selectable at v=0
      nodeId: "selftest-solved-at-0",
      nodeSegmentCount: 1,
      initialCount: 3,
      capturedWinnerIndex: -1,
      candidates: [
        cand({}, false, 100, 1000, f32([0.0])),
        cand({ SHUFFLE_SEED: 1 }, true, 0, 1000, f32([]), 1),
        cand({ HIGH_DENSITY_A01: true }, false, 500, 1_000_000, f32([0.1, 0.1, 0.1, 0.1, 0.1])),
      ],
    },
    {
      // subtleties (1)+(2): polyline initial f=31000; raw progress > 1 makes
      // candidate 1's f negative so it is re-stepped until it fails
      nodeId: "selftest-negative-f",
      nodeSegmentCount: 3,
      initialCount: 3,
      capturedWinnerIndex: -1,
      candidates: [
        cand(
          { MULTI_HEAD_POLYLINE_SOLVER: true, SEGMENTS_PER_POLYLINE: 6, BOUNDARY_PADDING: 0.05 },
          true,
          200,
          10_000,
          f32([1.0, 1.0]),
          3,
        ),
        cand({}, false, 900, 100_000, f32([1.2, 1.3, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4])),
        cand({ SHUFFLE_SEED: 2 }, true, 800, 100_000, f32([0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.9, 1.0]), 3),
      ],
    },
    {
      // subtlety (4): initial candidates die, expansion candidate wins
      nodeId: "selftest-expansion",
      nodeSegmentCount: 2,
      initialCount: 2,
      capturedWinnerIndex: -1,
      candidates: [
        cand({}, false, 50, 100, f32([0.3])),
        cand({ SHUFFLE_SEED: 0 }, false, 150, 200, f32([0.1, 0.1])),
        cand({ HIGH_DENSITY_A01: true, SHUFFLE_SEED: 1 }, true, 400, 1_000_000, f32([0.2, 0.4, 0.8, 1.0]), 2),
      ],
    },
    {
      // no winner: every candidate failed
      nodeId: "selftest-all-fail",
      nodeSegmentCount: 1,
      initialCount: 2,
      capturedWinnerIndex: -1,
      candidates: [
        cand({}, false, 100, 1000, f32([0.2])),
        cand({ SHUFFLE_SEED: 3 }, false, 220, 1000, f32([0.3, 0.4, 0.4])),
      ],
    },
  ]
  // capturedWinnerIndex for the selftest is simply the TS simulation's answer
  // (in a real capture it is the live runReplayRace winner).
  for (const n of nodes) n.capturedWinnerIndex = simulateNodeTs(n).winner
  return nodes
}

// ---------- Main ----------

const main = () => {
  const args = process.argv.slice(2)
  let datasetPath: string | null = null
  let libPath = path.join(
    import.meta.dir,
    "target",
    "release",
    `libreplay_core.${suffix}`,
  )
  let verbose = false
  let selftest = false
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === "--verbose") verbose = true
    else if (a === "--selftest") selftest = true
    else if (a === "--lib") {
      libPath = args[++i] ?? libPath
    } else if (!a.startsWith("--")) datasetPath = a
    else {
      console.error(`unknown arg: ${a}`)
      process.exit(2)
    }
  }

  if (selftest) {
    const bytes = encodeDataset(buildSelftestNodes())
    datasetPath = path.join(import.meta.dir, "selftest.rplyds01")
    writeFileSync(datasetPath, bytes)
    console.log(`selftest dataset written: ${datasetPath} (${bytes.byteLength} bytes)`)
  }
  if (!datasetPath) {
    console.error(
      "usage: bun native/replay-core/harness.ts <dataset.rplyds01> [--verbose] [--lib <so>]\n" +
        "       bun native/replay-core/harness.ts --selftest [--verbose]",
    )
    process.exit(2)
  }

  // Fresh copy => byteOffset 0, so the payload Float32Array view is aligned.
  const bytes = new Uint8Array(readFileSync(datasetPath))
  const nodes = decodeDataset(bytes)
  const totalCandidates = nodes.reduce((s, n) => s + n.candidates.length, 0)
  console.log(
    `dataset: ${datasetPath}\nnodes: ${nodes.length}, candidates: ${totalCandidates}`,
  )

  const lib = (() => {
    try {
      return openReplayLib(libPath)
    } catch (err) {
      console.error(
        `failed to dlopen ${libPath} — build it first:\n` +
          `  cd ${import.meta.dir} && cargo build --release\n${err}`,
      )
      return process.exit(2)
    }
  })()

  const errBuf = new Uint8Array(4096)
  const detailBuf = new Uint8Array(65536)
  const handle = lib.symbols.replay_load(bytes, bytes.byteLength) as unknown as bigint
  if (handle === 0n) {
    const n = Number(lib.symbols.replay_last_error(errBuf, errBuf.byteLength))
    const msg = n > 0 ? new TextDecoder().decode(errBuf.subarray(0, n)) : "(no error message)"
    console.error(`replay_load failed: ${msg}`)
    process.exit(2)
  }
  const rustNodeCount = Number(lib.symbols.replay_node_count(handle))
  if (rustNodeCount !== nodes.length) {
    console.error(
      `node count disagreement: TS decode ${nodes.length} vs Rust ${rustNodeCount}`,
    )
    lib.symbols.replay_free(handle)
    process.exit(2)
  }

  const rustDetail = (i: number): string => {
    const n = Number(
      lib.symbols.replay_run_detail(handle, BigInt(i), detailBuf, detailBuf.byteLength),
    )
    return n > 0 ? new TextDecoder().decode(detailBuf.subarray(0, n)) : `(detail error ${n})`
  }

  const mismatches: number[] = []
  const capturedDivergences: number[] = []
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!
    const ts = simulateNodeTs(node)
    const rust = lib.symbols.replay_run(handle, BigInt(i)) as number
    if (rust === -2) {
      console.error(`replay_run returned -2 (bad handle/index) at node ${i}`)
      lib.symbols.replay_free(handle)
      process.exit(2)
    }
    if (ts.winner !== rust) mismatches.push(i)
    if (node.capturedWinnerIndex !== ts.winner) capturedDivergences.push(i)
    if (verbose) {
      console.log(
        `node ${i} (${node.nodeId}): ts=${ts.winner} rust=${rust} captured=${node.capturedWinnerIndex} expanded=${ts.expanded} work=${ts.totalWork}`,
      )
    }
  }

  console.log(
    `TS-replay vs Rust-replay winners: ${nodes.length - mismatches.length}/${nodes.length} identical, ${mismatches.length} mismatches`,
  )
  console.log(
    `harness TS-replay vs capture-time winner: ${capturedDivergences.length} divergences (expected 0)`,
  )
  for (const i of mismatches.slice(0, 20)) {
    const node = nodes[i]!
    const ts = simulateNodeTs(node)
    const rust = lib.symbols.replay_run(handle, BigInt(i)) as number
    console.log(`MISMATCH node ${i} (${node.nodeId}): ts=${ts.winner} rust=${rust}`)
    if (ts.winner >= 0) {
      console.log(`  ts hp:   ${JSON.stringify(node.candidates[ts.winner]?.hp)}`)
    }
    if (rust >= 0) {
      console.log(`  rust hp: ${JSON.stringify(node.candidates[rust]?.hp)}`)
    }
    console.log(`  rust detail: ${rustDetail(i)}`)
  }
  if (mismatches.length > 20) {
    console.log(`  ... and ${mismatches.length - 20} more mismatches`)
  }
  for (const i of capturedDivergences.slice(0, 5)) {
    const node = nodes[i]!
    console.log(
      `CAPTURE-DIVERGENCE node ${i} (${node.nodeId}): captured=${node.capturedWinnerIndex} harness-ts=${simulateNodeTs(node).winner} (implicates decimation or replayPool drift, NOT the Rust port)`,
    )
  }

  lib.symbols.replay_free(handle)
  console.log(mismatches.length === 0 ? "PARITY: OK" : "PARITY: FAILED")
  process.exit(mismatches.length === 0 ? 0 : 1)
}

main()
