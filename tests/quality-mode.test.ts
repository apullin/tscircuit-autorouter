import { expect, test } from "bun:test"
import { AutoroutingPipelineSolver7_MultiGraph } from "../lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph"
import type { SimpleRouteJson } from "../lib/types"

const minimalSrj: SimpleRouteJson = {
  bounds: { minX: 0, minY: 0, maxX: 10, maxY: 10 },
  obstacles: [],
  connections: [],
  layerCount: 2,
  minTraceWidth: 0.15,
} as SimpleRouteJson

test("qualityMode applies { maxNodeDimension: 4, effort: 2 } as defaults", () => {
  const pipeline = new AutoroutingPipelineSolver7_MultiGraph(
    structuredClone(minimalSrj),
    { qualityMode: true },
  )
  expect(pipeline.opts.maxNodeDimension).toBe(4)
  expect(pipeline.opts.effort).toBe(2)
  expect(pipeline.effort).toBe(2)
})

test("explicit opts win over qualityMode defaults", () => {
  const pipeline = new AutoroutingPipelineSolver7_MultiGraph(
    structuredClone(minimalSrj),
    { qualityMode: true, maxNodeDimension: 8, effort: 1.5 },
  )
  expect(pipeline.opts.maxNodeDimension).toBe(8)
  expect(pipeline.opts.effort).toBe(1.5)
})

test("default path unchanged when qualityMode is absent", () => {
  const pipeline = new AutoroutingPipelineSolver7_MultiGraph(
    structuredClone(minimalSrj),
  )
  expect(pipeline.opts.maxNodeDimension).toBeUndefined()
  expect(pipeline.opts.effort).toBeUndefined()
  expect(pipeline.effort).toBe(1)
})
