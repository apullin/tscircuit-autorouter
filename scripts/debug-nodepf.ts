#!/usr/bin/env bun
/**
 * G10: does nodePf separate doomed nodes? Stops BEFORE the HD stage (cheap)
 * and prints the Pf distribution with the known s8 doomed nodes marked
 * (ids from the G6 eviction runs: 6 rescued + the nodes the resize count
 * implies grew).
 */
import { AutoroutingPipelineSolver7_MultiGraph } from "../lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph"
import { loadScenarioBySampleNumber } from "./benchmark/scenarios"

const KNOWN_DOOMED = new Set([
  "cmn_447",
  "cmn_51",
  "cmn_408",
  "cmn_401",
  "cmn_19",
  "cmn_166",
  "cmn_2", // drop-one experiment nodes
])

const { scenario } = await loadScenarioBySampleNumber("srj18", 8)
const pipeline = new AutoroutingPipelineSolver7_MultiGraph(
  structuredClone(scenario),
)
pipeline.solveUntilPhase("highDensityRouteSolver")

const pathing = pipeline.portPointPathingSolver!
const inputNodes = pathing.getOutput().inputNodeWithPortPoints
const rows: Array<{ id: string; pf: number; doomed: boolean }> = []
for (const node of inputNodes) {
  const pf = pathing.computeNodePf(node)
  if (pf === null) continue
  rows.push({
    id: node.capacityMeshNodeId,
    pf,
    doomed: KNOWN_DOOMED.has(node.capacityMeshNodeId),
  })
}
rows.sort((a, b) => b.pf - a.pf)
console.log(`nodes with Pf: ${rows.length}`)
console.log("top 30 by Pf (D = known doomed):")
for (const r of rows.slice(0, 30)) {
  console.log(`  ${r.doomed ? "D" : " "} ${r.id}  pf=${r.pf.toFixed(3)}`)
}
const ranks = rows.map((r) => (r.doomed ? rows.indexOf(r) : null))
console.log(
  "known-doomed Pf values:",
  rows.filter((r) => r.doomed).map((r) => `${r.id}:${r.pf.toFixed(3)}`),
)
console.log("counts: pf>0.9 =", rows.filter((r) => r.pf > 0.9).length, " pf>0.5 =", rows.filter((r) => r.pf > 0.5).length, " pf>0.2 =", rows.filter((r) => r.pf > 0.2).length)
