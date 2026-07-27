/**
 * Build tool, run under BUN (spawned by runtime.ts ensureNodeWorkerBundle and
 * by scripts/node-parallel-smoke.mjs): bundles one TS entry for node with the
 * native/ FFI modules stubbed out.
 *
 * Why the stubs: those modules are only reachable behind lazy requires gated
 * on TS_NATIVE_PORTFOLIO / TS_REPLAY_DUMP / TS_GOLDEN_DUMP
 * (PortfolioSingleIntraNodeSolver keeps the main build "free of native/
 * deps"), but a bundler resolves the require specifiers statically, and
 * native/portfolio-core/driver imports bun:ffi at module top level — an
 * eager import node refuses to load. The stubs throw only if actually
 * invoked; the native runtime is bun-only by design.
 *
 * Usage: bun lib/parallel/nodeEntry/buildNodeWorkerBundle.ts <entry.ts> <outfile>
 */
const [entry, outfile] = process.argv.slice(2)
if (!entry || !outfile) {
  console.error(
    "usage: bun lib/parallel/nodeEntry/buildNodeWorkerBundle.ts <entry.ts> <outfile>",
  )
  process.exit(1)
}

const NATIVE_STUB = `
const bunOnly = (name) => () => {
  throw new Error(
    name +
      " requires the bun-only native runtime (bun:ffi) and is unavailable in node bundles",
  )
}
export const nativePortfolioStep = bunOnly("nativePortfolioStep")
export const recordReplayDump = bunOnly("recordReplayDump")
export const recordGoldenDump = bunOnly("recordGoldenDump")
`

const result = await Bun.build({
  entrypoints: [entry],
  target: "node",
  format: "esm",
  plugins: [
    {
      name: "stub-native-ffi-modules",
      setup(build) {
        build.onResolve(
          {
            filter:
              /(^|\/)native\/(portfolio-core\/driver|replay-core\/(captureDump|goldenDump))$/,
          },
          (args) => ({ path: args.path, namespace: "native-stub" }),
        )
        build.onLoad({ filter: /.*/, namespace: "native-stub" }, () => ({
          contents: NATIVE_STUB,
          loader: "js",
        }))
      },
    },
  ],
})

if (!result.success) {
  for (const log of result.logs) console.error(String(log))
  process.exit(1)
}
const artifact = result.outputs[0]
if (!artifact) {
  console.error("bun build produced no output artifact")
  process.exit(1)
}
await Bun.write(outfile, artifact)
console.log(`bundled ${entry} -> ${outfile}`)
