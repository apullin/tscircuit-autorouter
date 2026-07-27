/**
 * Node worker_threads bootstrap: the worker modules (hdNodeWorker,
 * a2BranchWorker) are written against the web-Worker API Bun provides —
 * `self.onmessage = fn` with messages wrapped in `{ data }`. Under node
 * worker_threads there is no `self`; this module installs a minimal
 * equivalent backed by parentPort BEFORE the worker module evaluates (the
 * .entry.ts bootstraps import this first; ESM evaluates imports in order).
 *
 * Semantics preserved relative to Bun:
 * - messages posted before the worker module assigns `self.onmessage` are
 *   queued by the MessagePort until the listener below attaches, and message
 *   callbacks only run after module evaluation completes, so the pool's
 *   immediately-posted "init" message cannot be lost.
 * - an uncaught throw inside the handler crashes the worker thread, which the
 *   parent sees as the "error" event followed by exit — the same fatal path
 *   Bun's "error"/"close" events feed (see ../runtime.ts).
 */
import { parentPort } from "node:worker_threads"

type WebishMessageHandler = (event: { data: unknown }) => void

let onmessageHandler: WebishMessageHandler | null = null
;(globalThis as { self?: unknown }).self = {
  get onmessage(): WebishMessageHandler | null {
    return onmessageHandler
  },
  set onmessage(handler: WebishMessageHandler | null) {
    onmessageHandler = handler
  },
  postMessage: (message: unknown): void => {
    parentPort?.postMessage(message)
  },
}

parentPort?.on("message", (data: unknown) => {
  onmessageHandler?.({ data })
})
