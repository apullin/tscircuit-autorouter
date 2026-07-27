/**
 * Node worker entry for the A2 branch pool. Bundled by runtime.ts
 * (ensureNodeWorkerBundle) with `bun build --target=node` — node cannot load
 * the worker graph's TS-source git deps directly. Import order matters: the
 * self shim must install before the worker module's top-level
 * `self.onmessage = ...` assignment runs.
 */
import "./installWorkerSelf"
import "../a2BranchWorker"
