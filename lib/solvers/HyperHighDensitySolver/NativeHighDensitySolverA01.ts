import { BaseSolver } from "@tscircuit/solver-utils"
import type { HighDensityIntraNodeRoute } from "lib/types/high-density-types"
import { NativeA01Session } from "../../../native/hdastar/a01NativeDriver"

/**
 * Incremental BaseSolver wrapper for the Rust A01 port (native/hdastar).
 * Mirrors HighDensitySolverA01's step semantics exactly: one stepOnce per
 * _step, iterations incremented per step, progress left unset (TS A01 never
 * sets it — the portfolio reads `progress || 0`), and a
 * solvedConnectionsMap-shaped getter for the post-expansion fitness path.
 * Routes are bit-identical to the TS solver (output-hash verified).
 */
export class NativeHighDensitySolverA01 extends BaseSolver {
  solvedRoutes: HighDensityIntraNodeRoute[] = []
  private session: NativeA01Session | null = null
  private input: Record<string, unknown>
  private solvedSegmentCount = 0
  private cachedMap: Map<string, unknown[]> | null = null

  constructor(
    public props: {
      nodeWithPortPoints: {
        width: number
        height: number
        center: { x: number; y: number }
        capacityMeshNodeId?: string
        availableZ?: number[]
        portPoints: unknown[]
      }
      cellSizeMm: number
      viaDiameter: number
      traceThickness: number
      traceMargin: number
      viaMinDistFromBorder: number
      effort: number
      hyperParameters: {
        shuffleSeed: number
        ripCost?: number
        ripTracePenalty?: number
        ripViaPenalty?: number
        viaBaseCost?: number
        greedyMultiplier?: number
      }
    },
  ) {
    super()
    const node = props.nodeWithPortPoints
    const availableZ =
      node.availableZ ??
      [...new Set(node.portPoints.map((p) => (p as { z: number }).z))].sort(
        (a, b) => a - b,
      )
    this.input = {
      rows: Math.floor(node.height / props.cellSizeMm),
      cols: Math.floor(node.width / props.cellSizeMm),
      layers: availableZ.length,
      availableZ,
      cellSizeMm: props.cellSizeMm,
      viaDiameter: props.viaDiameter,
      traceThickness: props.traceThickness,
      traceMargin: props.traceMargin,
      viaMinDistFromBorder: props.viaMinDistFromBorder,
      effort: props.effort,
      maxCellCount: null,
      stepMultiplier: 1,
      hyperParameters: {
        shuffleSeed: props.hyperParameters.shuffleSeed,
        ripCost: props.hyperParameters.ripCost ?? 10,
        ripTracePenalty: props.hyperParameters.ripTracePenalty ?? 0.5,
        ripViaPenalty: props.hyperParameters.ripViaPenalty ?? 0.75,
        viaBaseCost: props.hyperParameters.viaBaseCost ?? 0.1,
        greedyMultiplier: props.hyperParameters.greedyMultiplier ?? 1.5,
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

  override getSolverName(): string {
    return "NativeHighDensitySolverA01"
  }

  /**
   * Portfolio's getCandidateProgress only sums array lengths over this map —
   * expose a single entry sized to the solved-segment count (refreshed per
   * state read) rather than materializing real route arrays.
   */
  get solvedConnectionsMap(): Map<string, unknown[]> {
    if (this.solvedSegmentCount === 0) return new Map()
    if (!this.cachedMap || this.cachedMap.get("__segments__")!.length !== this.solvedSegmentCount) {
      this.cachedMap = new Map([
        ["__segments__", new Array(this.solvedSegmentCount).fill(null)],
      ])
    }
    return this.cachedMap
  }

  _step(): void {
    if (!this.session) this.session = new NativeA01Session(this.input)
    const { status, solvedSegments } = this.session.stepPacked(1)
    // BaseSolver.step() early-returns when terminal, so _step is only ever
    // called while running — the native step always advances one tick.
    this.iterations += 1
    this.solvedSegmentCount = solvedSegments
    // Mirror the TS A01's post-setup budget so big searches aren't cut off.
    if (this.MAX_ITERATIONS === 1000) {
      this.MAX_ITERATIONS = this.session.maxIterations()
    }
    if (status === 2) {
      this.solvedRoutes =
        this.session.routes() as HighDensityIntraNodeRoute[]
      this.solvedSegmentCount = this.solvedRoutes.length
      this.solved = true
      this.session.destroy()
      this.session = null
    } else if (status === 3) {
      this.failed = true
      this.error = this.session.error() ?? "native A01 failed"
      this.session.destroy()
      this.session = null
    }
  }

  getOutput(): HighDensityIntraNodeRoute[] {
    return this.solvedRoutes
  }
}

export const nativeA01Enabled = (): boolean =>
  typeof process !== "undefined" &&
  !!process.env.TS_NATIVE_A01 &&
  process.env.TS_NATIVE_A01 !== "0"
