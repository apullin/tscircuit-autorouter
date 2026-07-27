/**
 * Runtime shim between the parallel pools and the two supported worker
 * runtimes.
 *
 * - Bun: the pools' original code path, byte-for-byte — web-API `Worker`
 *   loading the TS worker entry directly, "error"/"close" events,
 *   Bun.sleepSync.
 * - Node: worker_threads.Worker running a PREBUNDLED worker entry
 *   (ensureNodeWorkerBundle), "error"/"exit" events, Atomics.wait sleep.
 *
 * Why prebundle for node instead of running TS directly: the worker graph
 * imports TypeScript SOURCE from git deps inside node_modules
 * (tiny-hypergraph `"module": "index.ts"`, @tscircuit/high-density-a01 and
 * high-density-repair03 `"module": "lib/index.ts"`), and node's type
 * stripping explicitly refuses to strip TypeScript under node_modules; lib/
 * also uses extensionless relative imports, which node's ESM loader rejects.
 * Bundling (Bun.build --target=node via nodeEntry/buildNodeWorkerBundle.ts,
 * which also stubs the bun-only native/ FFI modules) resolves all of it.
 * Bundles are generated lazily at pool creation into
 * <repo>/.parallel-worker-build (gitignored). They are NOT invalidated when
 * sources change — delete that directory or set TS_PARALLEL_WORKER_REBUILD=1
 * to force a rebuild.
 *
 * The pools receive the RAW runtime worker object (Bun's Worker or
 * worker_threads' Worker — postMessage/terminate/unref are name-compatible),
 * so pool logic is not forked; only construction and lifecycle-event wiring
 * differ per runtime, and both runtimes feed the same two callbacks:
 *   onError — script load/eval failure or a worker-side uncaught throw
 *   onClose — the worker exited (Bun "close" / node "exit")
 * Everything else (SharedArrayBuffer result channels, Atomics wait/notify,
 * structured-clone postMessage payloads) behaves identically on both
 * runtimes and stays in the pools.
 */

export type ParallelWorkerEntry = "hdNodeWorker" | "a2BranchWorker"

const PARALLEL_WORKER_ENTRIES: ParallelWorkerEntry[] = [
  "hdNodeWorker",
  "a2BranchWorker",
]

/**
 * The intersection of Bun's Worker and node's worker_threads.Worker that the
 * pools use. Both runtimes implement all three with the same names.
 */
export type ParallelWorkerHandle = {
  postMessage(message: unknown): void
  terminate(): unknown
  unref(): void
}

export type ParallelWorkerHandlers = {
  /** Script load/eval failure or a worker-side uncaught throw. */
  onError: (message: string) => void
  /** The worker exited (Bun "close" event / node "exit" event). */
  onClose: () => void
}

export const isBunRuntime = (): boolean =>
  typeof (globalThis as Record<string, unknown> & { Bun?: unknown }).Bun !==
  "undefined"

/**
 * Node builtin loader that stays importable in browser bundles (this module
 * is reachable from HighDensitySolver's unconditional hdNodePool import, the
 * same constraint autoEnable.detectParallelHardware works under).
 * process.getBuiltinModule (node >= 22.3) works in ESM without require; the
 * require fallback covers bun and CJS-ish contexts.
 */
const nodeBuiltin = (id: string): any => {
  const proc = (globalThis as Record<string, unknown>).process as
    | { getBuiltinModule?: (id: string) => unknown }
    | undefined
  const viaProcess = proc?.getBuiltinModule?.(id)
  if (viaProcess) return viaProcess
  try {
    // biome-ignore lint: lazy require is deliberate (browser import-safety)
    return require(id)
  } catch {
    return undefined
  }
}

let sleepInt32: Int32Array | null = null

/**
 * Synchronous sleep for the pools' polling pumps. Bun keeps Bun.sleepSync
 * (original behavior); node blocks on an Atomics.wait timeout, which node —
 * unlike browsers — permits on the main thread.
 */
export const sleepSyncMs = (ms: number): void => {
  if (isBunRuntime()) {
    Bun.sleepSync(ms)
    return
  }
  sleepInt32 ??= new Int32Array(new SharedArrayBuffer(4))
  Atomics.wait(sleepInt32, 0, 0, ms)
}

const NODE_BUILD_DIR = ".parallel-worker-build"

/**
 * Node worker entries are thin bootstraps that install a web-Worker-style
 * `self` (see nodeEntry/installWorkerSelf.ts) before importing the real
 * worker module unchanged.
 */
const NODE_ENTRY_SOURCES: Record<ParallelWorkerEntry, string> = {
  hdNodeWorker: "lib/parallel/nodeEntry/hdNodeWorker.entry.ts",
  a2BranchWorker: "lib/parallel/nodeEntry/a2BranchWorker.entry.ts",
}

const bundleOutPath = (path: any, root: string, entry: ParallelWorkerEntry) =>
  path.join(root, NODE_BUILD_DIR, `${entry}.node.mjs`)

/**
 * The repo root (the directory holding lib/parallel/) is where entry sources
 * live and where bundles are written. Under node the main program is itself
 * typically a `bun build` bundle at an arbitrary location, so import.meta.url
 * cannot be trusted alone; walk up from both the cwd and this file/bundle.
 */
const findRepoRoot = (fs: any, path: any): string | null => {
  const marker = path.join("lib", "parallel", "hdNodeWorker.ts")
  const starts: string[] = []
  try {
    starts.push(process.cwd())
  } catch {}
  try {
    const url = nodeBuiltin("node:url")
    if (url?.fileURLToPath) {
      starts.push(path.dirname(url.fileURLToPath(import.meta.url)))
    }
  } catch {}
  for (const start of starts) {
    let dir = start
    for (let i = 0; i < 12; i++) {
      if (fs.existsSync(path.join(dir, marker))) return dir
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return null
}

let bunCliCache: boolean | null = null

const bunCliAvailable = (): boolean => {
  if (bunCliCache !== null) return bunCliCache
  const cp = nodeBuiltin("node:child_process")
  if (!cp?.spawnSync) {
    bunCliCache = false
    return bunCliCache
  }
  try {
    const res = cp.spawnSync("bun", ["--version"], { stdio: "ignore" })
    bunCliCache = !res.error && res.status === 0
  } catch {
    bunCliCache = false
  }
  return bunCliCache
}

export type NodeWorkerSupport = { usable: boolean; reason: string }

let nodeWorkerSupportCache: NodeWorkerSupport | null = null

/**
 * Whether AUTO-enable may count on node workers actually starting: needs
 * worker_threads, the repo tree (published dist consumers have no entry
 * sources to bundle), and either prebuilt bundles or a bun CLI to build them.
 * Cached: none of these change mid-process. Explicit env flags bypass this
 * probe entirely and fail loudly at pool creation instead (the caller asked).
 */
export const nodeWorkerSupport = (): NodeWorkerSupport => {
  nodeWorkerSupportCache ??= computeNodeWorkerSupport()
  return nodeWorkerSupportCache
}

export const nodeWorkerRuntimeUsable = (): boolean => nodeWorkerSupport().usable

const computeNodeWorkerSupport = (): NodeWorkerSupport => {
  if (isBunRuntime()) {
    return { usable: false, reason: "bun uses its own Worker path" }
  }
  const wt = nodeBuiltin("node:worker_threads")
  if (!wt?.Worker) {
    return { usable: false, reason: "worker_threads unavailable" }
  }
  const fs = nodeBuiltin("node:fs")
  const path = nodeBuiltin("node:path")
  if (!fs || !path) {
    return { usable: false, reason: "node:fs/node:path unavailable" }
  }
  const root = findRepoRoot(fs, path)
  if (!root) {
    return {
      usable: false,
      reason: "repo root with lib/parallel not found (published dist?)",
    }
  }
  const allBundlesExist = PARALLEL_WORKER_ENTRIES.every((entry) =>
    fs.existsSync(bundleOutPath(path, root, entry)),
  )
  if (allBundlesExist) {
    return { usable: true, reason: "prebuilt worker bundles present" }
  }
  if (bunCliAvailable()) {
    return {
      usable: true,
      reason: "bun CLI available to bundle worker entries",
    }
  }
  return {
    usable: false,
    reason: "no prebuilt worker bundles and no bun CLI to build them",
  }
}

const NODE_BUNDLE_BUILD_SCRIPT =
  "lib/parallel/nodeEntry/buildNodeWorkerBundle.ts"

/**
 * Bundle a worker entry for node, lazily: reuse an existing bundle, else run
 * the bun build script (written to a temp file and renamed so a half-written
 * bundle is never loaded). Throws with the build stderr when bundling is
 * impossible — under explicit TS_PARALLEL_* flags that surfaces as the
 * pool-creation failure it is.
 */
export const ensureNodeWorkerBundle = (entry: ParallelWorkerEntry): string => {
  const fs = nodeBuiltin("node:fs")
  const path = nodeBuiltin("node:path")
  if (!fs || !path) {
    throw new Error("node:fs/node:path unavailable; cannot bundle worker entry")
  }
  const root = findRepoRoot(fs, path)
  if (!root) {
    throw new Error(
      "cannot locate the repo root (lib/parallel/hdNodeWorker.ts) to bundle " +
        "node worker entries; node workers need the repo tree",
    )
  }
  const outPath = bundleOutPath(path, root, entry)
  const force = process.env.TS_PARALLEL_WORKER_REBUILD === "1"
  if (!force && fs.existsSync(outPath)) return outPath
  const cp = nodeBuiltin("node:child_process")
  if (!cp?.spawnSync) {
    throw new Error(
      "node:child_process unavailable; cannot bundle worker entry",
    )
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  const tmpPath = `${outPath}.tmp-${process.pid}`
  const res = cp.spawnSync(
    "bun",
    [NODE_BUNDLE_BUILD_SCRIPT, NODE_ENTRY_SOURCES[entry], tmpPath],
    { cwd: root, encoding: "utf8" },
  )
  if (res.error || res.status !== 0 || !fs.existsSync(tmpPath)) {
    const detail = res.error
      ? String(res.error)
      : `exit ${res.status}: ${res.stderr ?? ""}`
    throw new Error(
      `failed to bundle node worker entry "${entry}" with \`bun build\` ` +
        `(is bun installed?): ${detail}`,
    )
  }
  fs.renameSync(tmpPath, outPath)
  return outPath
}

/**
 * Spawn a pool worker on the current runtime and wire its lifecycle events to
 * the pool's callbacks. Returns the raw runtime worker object; the pools call
 * postMessage/terminate/unref on it directly (identical names on both
 * runtimes).
 */
export const spawnParallelWorker = (
  entry: ParallelWorkerEntry,
  handlers: ParallelWorkerHandlers,
): ParallelWorkerHandle => {
  if (isBunRuntime()) {
    // The pools' original Bun behavior, verbatim: TS entry loaded by URL,
    // ErrorEvent message extraction, "close" on exit.
    const worker = new Worker(bunEntryHref(entry)) as Worker & {
      unref(): void
    }
    worker.addEventListener("error", (e: Event) => {
      handlers.onError((e as ErrorEvent).message ?? "unknown worker error")
    })
    worker.addEventListener("close", () => handlers.onClose())
    return worker
  }
  const wt = nodeBuiltin("node:worker_threads")
  if (!wt?.Worker) {
    throw new Error(
      "worker_threads unavailable; cannot start parallel workers on this runtime",
    )
  }
  const bundlePath = ensureNodeWorkerBundle(entry)
  const worker = new wt.Worker(bundlePath)
  worker.on("error", (err: unknown) => {
    handlers.onError(err instanceof Error ? err.message : String(err))
  })
  worker.on("exit", () => handlers.onClose())
  return worker as ParallelWorkerHandle
}

/** Literal URLs (not template strings) so bundlers can trace the entries. */
const bunEntryHref = (entry: ParallelWorkerEntry): string =>
  entry === "hdNodeWorker"
    ? new URL("./hdNodeWorker.ts", import.meta.url).href
    : new URL("./a2BranchWorker.ts", import.meta.url).href
