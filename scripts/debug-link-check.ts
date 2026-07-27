#!/usr/bin/env bun
/** Debug: inspect port-point link completeness at the HD stage input (s8). */
import { AutoroutingPipelineSolver7_MultiGraph } from "../lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph"
import { loadScenarioBySampleNumber } from "./benchmark/scenarios"

const { scenario } = await loadScenarioBySampleNumber("srj18", 8)
const pipeline = new AutoroutingPipelineSolver7_MultiGraph(
  structuredClone(scenario),
)
pipeline.solveUntilPhase("highDensityRouteSolver")

const nodes =
  pipeline.uniformPortDistributionSolver?.getOutput() ??
  pipeline.portPointPathingSolver?.getOutput().nodesWithPortPoints ??
  []

let total = 0
let withId = 0
let withPrev = 0
let withNext = 0
let withBothLinks = 0
let withPcb = 0
let withPairsField = 0
for (const n of nodes) {
  if (n.portPointsInPairs?.length) withPairsField++
  for (const p of n.portPoints) {
    total++
    if (p.portPointId) withId++
    if (p.prevPortPointId) withPrev++
    if (p.nextPortPointId) withNext++
    if (p.prevPortPointId && p.nextPortPointId) withBothLinks++
    if (p.pcb_port_id) withPcb++
  }
}
console.log({
  nodes: nodes.length,
  nodesWithPairsField: withPairsField,
  totalPoints: total,
  withId: withId,
  withPrev,
  withNext,
  withBothLinks,
  withPcb,
})
