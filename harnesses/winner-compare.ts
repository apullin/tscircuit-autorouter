import { loadScenarioBySampleNumber } from "/home/pullin/personal/awt-r3/scripts/benchmark/scenarios"
import { writeFileSync } from "node:fs"
const { scenario } = await loadScenarioBySampleNumber("srj18" as any, Number(process.env.SAMPLE ?? 5))
const { AutoroutingPipelineSolver7_MultiGraph } = await import("/home/pullin/personal/awt-r3/lib/autorouter-pipelines/AutoroutingPipeline7_MultiGraph/AutoroutingPipelineSolver7_MultiGraph.ts")
const pipeline = new AutoroutingPipelineSolver7_MultiGraph(structuredClone(scenario) as any)
pipeline.solve()
const seq = (globalThis as any).__supervisorStats ?? []
const rep = (globalThis as any).__replayStats ?? []
writeFileSync(process.env.OUT ?? "/tmp/winners.json", JSON.stringify({ seq, rep }))
console.log("seq nodes:", seq.length, "rep nodes:", rep.length)
