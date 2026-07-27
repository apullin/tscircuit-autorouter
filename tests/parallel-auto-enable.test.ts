import { describe, expect, test } from "bun:test"
import {
  gateHdNodeDecisionOnBoardSize,
  MIN_PARALLEL_HD_NODE_COUNT,
  type ParallelHardware,
  resolveA2Parallelism,
  resolveHdNodeParallelism,
} from "lib/parallel/autoEnable"

const healthyHardware: ParallelHardware = {
  cores: 64,
  freeMemBytes: 64 * 1024 ** 3,
  hasWorker: true,
  hasSharedArrayBuffer: true,
}

describe("resolveHdNodeParallelism", () => {
  test("explicit env always wins, over every gate", () => {
    expect(
      resolveHdNodeParallelism({ TS_PARALLEL_HD_NODES: "0" }, healthyHardware),
    ).toEqual({
      workerCount: 0,
      explicit: true,
      reason: "explicit TS_PARALLEL_HD_NODES",
    })
    expect(
      resolveHdNodeParallelism({ TS_PARALLEL_HD_NODES: "2" }, healthyHardware)
        .workerCount,
    ).toBe(2)
    // capped at 32
    expect(
      resolveHdNodeParallelism(
        { TS_PARALLEL_HD_NODES: "64" },
        healthyHardware,
      ).workerCount,
    ).toBe(32)
    // wins over benchmark/CI contexts
    expect(
      resolveHdNodeParallelism(
        { TS_PARALLEL_HD_NODES: "2", TS_BENCHMARK: "1", CI: "1" },
        healthyHardware,
      ).workerCount,
    ).toBe(2)
    // wins over missing Worker/SAB (the caller asked; failure is theirs)
    expect(
      resolveHdNodeParallelism(
        { TS_PARALLEL_HD_NODES: "2" },
        { ...healthyHardware, hasWorker: false },
      ).workerCount,
    ).toBe(2)
  })

  test("browser-like contexts auto-disable", () => {
    expect(
      resolveHdNodeParallelism({}, { ...healthyHardware, hasWorker: false })
        .workerCount,
    ).toBe(0)
    expect(
      resolveHdNodeParallelism(
        {},
        { ...healthyHardware, hasSharedArrayBuffer: false },
      ).workerCount,
    ).toBe(0)
  })

  test("benchmark/CI/test contexts auto-disable", () => {
    for (const env of [
      { TS_BENCHMARK: "1" },
      { BENCHMARK: "1" },
      { CI: "true" },
      { NODE_ENV: "test" },
    ]) {
      expect(resolveHdNodeParallelism(env, healthyHardware).workerCount).toBe(0)
    }
    // "0" means explicitly off, not set
    expect(
      resolveHdNodeParallelism(
        { TS_BENCHMARK: "0", CI: "0" },
        healthyHardware,
      ).workerCount,
    ).toBe(4)
  })

  test("hardware formula: min(4, floor(cores/4)), memory escape", () => {
    expect(
      resolveHdNodeParallelism({}, { ...healthyHardware, cores: 64 })
        .workerCount,
    ).toBe(4)
    expect(
      resolveHdNodeParallelism({}, { ...healthyHardware, cores: 16 })
        .workerCount,
    ).toBe(4)
    expect(
      resolveHdNodeParallelism({}, { ...healthyHardware, cores: 9 })
        .workerCount,
    ).toBe(2)
    expect(
      resolveHdNodeParallelism({}, { ...healthyHardware, cores: 4 })
        .workerCount,
    ).toBe(1)
    expect(
      resolveHdNodeParallelism({}, { ...healthyHardware, cores: 3 })
        .workerCount,
    ).toBe(0)
    expect(
      resolveHdNodeParallelism(
        {},
        { ...healthyHardware, freeMemBytes: 2 * 1024 ** 3 },
      ).workerCount,
    ).toBe(0)
  })
})

describe("resolveA2Parallelism", () => {
  test("explicit env always wins", () => {
    expect(
      resolveA2Parallelism({ TS_PARALLEL_A2: "1" }, healthyHardware).enabled,
    ).toBe(true)
    expect(
      resolveA2Parallelism({ TS_PARALLEL_A2: "0" }, healthyHardware).enabled,
    ).toBe(false)
    expect(
      resolveA2Parallelism({ TS_PARALLEL_A2: "" }, healthyHardware).enabled,
    ).toBe(false)
    expect(
      resolveA2Parallelism({ TS_PARALLEL_A2: "1", CI: "1" }, healthyHardware)
        .enabled,
    ).toBe(true)
  })

  test("auto mode gates on context and hardware (needs >= 8 threads)", () => {
    expect(resolveA2Parallelism({}, healthyHardware).enabled).toBe(true)
    expect(
      resolveA2Parallelism({ TS_BENCHMARK: "1" }, healthyHardware).enabled,
    ).toBe(false)
    expect(resolveA2Parallelism({ NODE_ENV: "test" }, healthyHardware).enabled).toBe(
      false,
    )
    expect(
      resolveA2Parallelism({}, { ...healthyHardware, cores: 4 }).enabled,
    ).toBe(false)
    expect(
      resolveA2Parallelism({}, { ...healthyHardware, cores: 8 }).enabled,
    ).toBe(true)
    expect(
      resolveA2Parallelism(
        {},
        { ...healthyHardware, freeMemBytes: 1 * 1024 ** 3 },
      ).enabled,
    ).toBe(false)
    expect(
      resolveA2Parallelism({}, { ...healthyHardware, hasWorker: false })
        .enabled,
    ).toBe(false)
  })
})

describe("gateHdNodeDecisionOnBoardSize", () => {
  test("auto mode requires >= MIN_PARALLEL_HD_NODE_COUNT nodes", () => {
    const auto = resolveHdNodeParallelism({}, healthyHardware)
    expect(auto.workerCount).toBeGreaterThan(0)
    expect(
      gateHdNodeDecisionOnBoardSize(auto, MIN_PARALLEL_HD_NODE_COUNT - 1)
        .workerCount,
    ).toBe(0)
    expect(
      gateHdNodeDecisionOnBoardSize(auto, MIN_PARALLEL_HD_NODE_COUNT)
        .workerCount,
    ).toBe(auto.workerCount)
  })

  test("explicit mode bypasses the board-size gate", () => {
    const explicit = resolveHdNodeParallelism(
      { TS_PARALLEL_HD_NODES: "2" },
      healthyHardware,
    )
    expect(gateHdNodeDecisionOnBoardSize(explicit, 1).workerCount).toBe(2)
  })

  test("disabled decisions pass through unchanged", () => {
    const disabled = resolveHdNodeParallelism(
      { TS_BENCHMARK: "1" },
      healthyHardware,
    )
    expect(
      gateHdNodeDecisionOnBoardSize(disabled, 100).workerCount,
    ).toBe(0)
  })
})
